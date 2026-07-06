import os
import mimetypes
import time
from pathlib import Path
from gpmc import Client
from gpmc.client import calculate_sha1_hash
from rich.progress import Progress
from src.database import SessionLocal, Setting, decrypt_val

# Status constants returned by upload_file()
UPLOAD_NEW          = "uploaded"           # actually sent to Google Photos
UPLOAD_DUPLICATE    = "already_in_photos"  # hash already in Google Photos
UPLOAD_SKIPPED      = "skipped"            # non-media file (THM, LRF, XML, etc.)
UPLOAD_FAILED       = "failed"             # network/API error

# MIME prefixes gpmc considers valid
_VALID_MIME_PREFIXES = ("image/", "video/")


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


def upload_file(filepath: str) -> tuple[str, str, float]:
    """
    Upload a file to Google Photos.

    Returns a (status, message, upload_duration_seconds) tuple where status is one of:
      - UPLOAD_NEW          – file was successfully uploaded for the first time
      - UPLOAD_DUPLICATE    – file already exists in Google Photos (hash match)
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

    print(f"Uploading {filepath} via gpmc…")
    try:
        client = Client(auth_data=auth_data)

        # 2. Compute SHA-1 hash (same as gpmc does internally)
        _dummy_progress = Progress()
        _dummy_task    = _dummy_progress.add_task("", total=None)
        hash_bytes, hash_b64 = calculate_sha1_hash(
            Path(filepath), _dummy_progress, _dummy_task
        )

        # 3. Check if already in Google Photos BEFORE uploading (no upload cost)
        remote_key = client.api.find_remote_media_by_hash(hash_bytes)
        if remote_key:
            print(f"  → Already in Google Photos: {filepath}")
            return UPLOAD_DUPLICATE, remote_key, 0.0

        # 4. Not in Photos → actually upload and time it
        t0 = time.monotonic()
        output = client.upload(target=filepath, show_progress=False)
        t1 = time.monotonic()
        duration = t1 - t0

        abs_path = os.path.abspath(filepath)
        if abs_path in output or filepath in output:
            print(f"  → Uploaded OK in {duration:.1f}s: {filepath}")
            return UPLOAD_NEW, "", duration
        else:
            return UPLOAD_FAILED, f"Unexpected response: {output}", duration

    except ValueError as e:
        # gpmc raises ValueError for unsupported MIME types
        return UPLOAD_SKIPPED, str(e), 0.0
    except Exception as e:
        print(f"  → Upload error: {e}")
        return UPLOAD_FAILED, str(e), 0.0
