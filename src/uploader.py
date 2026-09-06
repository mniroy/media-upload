import os
import mimetypes
import time
from pathlib import Path
from gpmc import Client
from gpmc.client import calculate_sha1_hash
from rich.progress import Progress
from src.database import SessionLocal, Setting, decrypt_val, register_uploaded_media, is_media_already_uploaded

# Status constants returned by upload_file()
UPLOAD_NEW          = "uploaded"           # actually sent to Google Photos
UPLOAD_DUPLICATE    = "already_in_photos"  # hash already in Google Photos
UPLOAD_SKIPPED      = "skipped"            # non-media file (THM, LRF, XML, etc.)
UPLOAD_FAILED       = "failed"             # network/API error

# MIME prefixes gpmc considers valid
_VALID_MIME_PREFIXES = ("image/", "video/")

# Register common camera RAW, modern photo, and video MIME types missing from standard Linux mimetypes
_ADDITIONAL_MIME_TYPES = {
    ".dng": "image/x-adobe-dng",
    ".arw": "image/x-sony-arw",
    ".cr2": "image/x-canon-cr2",
    ".cr3": "image/x-canon-cr3",
    ".nef": "image/x-nikon-nef",
    ".orf": "image/x-olympus-orf",
    ".rw2": "image/x-panasonic-rw2",
    ".pef": "image/x-pentax-pef",
    ".srw": "image/x-samsung-srw",
    ".raf": "image/x-fuji-raf",
    ".raw": "image/x-raw",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".3gp": "video/3gpp",
    ".mts": "video/mp2t",
    ".m2ts": "video/mp2t",
}

for ext, mime in _ADDITIONAL_MIME_TYPES.items():
    mimetypes.add_type(mime, ext)
    mimetypes.add_type(mime, ext.upper())


def _is_media_file(filepath: str) -> bool:
    """Return True if the file has a MIME type that Google Photos accepts."""
    mime, _ = mimetypes.guess_type(filepath)
    if mime is None:
        return False
    return any(mime.startswith(prefix) for prefix in _VALID_MIME_PREFIXES)


def get_auth_data():
    db = SessionLocal()
    setting = db.query(Setting).filter_by(key="GP_AUTH_DATA").first()
    db.close()
    if setting and setting.value:
        return decrypt_val(setting.value)
    return None


def upload_file(filepath: str, on_progress=None, source_station: str = "unknown") -> tuple[str, str, float]:
    """
    Upload a file to Google Photos with cross-station duplicate checking and registration.

    Returns a (status, message, upload_duration_seconds) tuple where status is one of:
      - UPLOAD_NEW          – file was successfully uploaded for the first time
      - UPLOAD_DUPLICATE    – file already exists in Google Photos or was uploaded by another station
      - UPLOAD_SKIPPED      – not a supported media file (THM, LRF, XML, etc.)
      - UPLOAD_FAILED       – upload attempt failed

    upload_duration_seconds is the wall-clock time of the actual HTTP upload (0 for skip/duplicate).
    """
    # 1. Fast path: skip non-media files immediately (no network call)
    if not _is_media_file(filepath):
        ext = Path(filepath).suffix.upper()
        return UPLOAD_SKIPPED, f"Not a media file ({ext or 'unknown type'})", 0.0

    auth_data = get_auth_data()
    if not auth_data:
        return UPLOAD_FAILED, "Google Photos Auth Data not set in settings", 0.0

    file_path = Path(filepath)
    if not file_path.exists():
        return UPLOAD_FAILED, f"File not found: {filepath}", 0.0

    file_size = file_path.stat().st_size

    # Check local cross-station database first
    db = SessionLocal()
    try:
        if is_media_already_uploaded(db, filename=file_path.name, filepath=str(file_path), filesize=file_size):
            print(f"  → Already recorded in cross-station local database: {filepath}")
            db.close()
            return UPLOAD_DUPLICATE, "already_uploaded_locally", 0.0
    except Exception as e:
        print(f"Cross-station DB check error: {e}")
    finally:
        db.close()

    print(f"Uploading {filepath} via gpmc (source: {source_station})…")
    try:
        client = Client(auth_data=auth_data)

        # 2. Compute SHA-1 hash (same as gpmc does internally)
        _dummy_progress = Progress()
        _dummy_task = _dummy_progress.add_task("", total=None)
        hash_bytes, hash_b64 = calculate_sha1_hash(
            file_path, _dummy_progress, _dummy_task
        )

        # Check local DB by SHA-1 hash
        db = SessionLocal()
        try:
            if is_media_already_uploaded(db, filename=file_path.name, filepath=str(file_path), filesize=file_size, sha1_hash=hash_b64):
                print(f"  → Found matching SHA-1 hash in local database: {filepath}")
                register_uploaded_media(db, filename=file_path.name, filepath=str(file_path), filesize=file_size, sha1_hash=hash_b64, source_station=source_station)
                db.close()
                return UPLOAD_DUPLICATE, "hash_match_local", 0.0
        finally:
            db.close()

        # 3. Check if already in Google Photos BEFORE uploading (no upload cost)
        remote_key = client.api.find_remote_media_by_hash(hash_bytes)
        if remote_key:
            print(f"  → Already in Google Photos: {filepath}")
            db = SessionLocal()
            try:
                register_uploaded_media(db, filename=file_path.name, filepath=str(file_path), filesize=file_size, sha1_hash=hash_b64, source_station=source_station, remote_key=remote_key)
            finally:
                db.close()
            return UPLOAD_DUPLICATE, remote_key, 0.0

        # 4. Not in Photos → stream upload with byte progress
        t0 = time.monotonic()
        upload_token = client.api.get_upload_token(hash_b64, file_size)

        class ProgressStream:
            def __init__(self, path_str, total, cb):
                self.f = open(path_str, "rb")
                self.total = total
                self.uploaded = 0
                self.cb = cb
                self.last_update = 0

            def read(self, size=-1):
                chunk = self.f.read(size)
                if chunk:
                    self.uploaded += len(chunk)
                    now = time.monotonic()
                    if self.cb and (now - self.last_update >= 0.2 or self.uploaded == self.total):
                        self.last_update = now
                        try:
                            self.cb(self.uploaded, self.total)
                        except Exception:
                            pass
                return chunk

            def __len__(self):
                return self.total

            def close(self):
                self.f.close()

        stream = ProgressStream(filepath, file_size, on_progress)
        try:
            upload_response = client.api.upload_file(file=stream, upload_token=upload_token)
        finally:
            stream.close()

        last_modified = int(file_path.stat().st_mtime)
        media_key = client.api.commit_upload(
            upload_response_decoded=upload_response,
            file_name=file_path.name,
            sha1_hash=hash_bytes,
            quality="original",
            model="Pixel XL",
            upload_timestamp=last_modified,
        )
        t1 = time.monotonic()
        duration = t1 - t0
        print(f"  → Uploaded OK in {duration:.1f}s: {filepath}")

        # Register in cross-station database
        db = SessionLocal()
        try:
            register_uploaded_media(db, filename=file_path.name, filepath=str(file_path), filesize=file_size, sha1_hash=hash_b64, source_station=source_station, remote_key=media_key or "")
        finally:
            db.close()

        return UPLOAD_NEW, media_key or "", duration

    except ValueError as e:
        # gpmc raises ValueError for unsupported MIME types
        return UPLOAD_SKIPPED, str(e), 0.0
    except Exception as e:
        print(f"  → Upload error: {e}")
        return UPLOAD_FAILED, str(e), 0.0
