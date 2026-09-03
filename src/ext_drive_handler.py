"""
ext_drive_handler.py
====================
Handles the permanently-mounted external HDD → Google Photos upload pipeline.
This module is completely independent from usb_handler.py:
  - No shared state, no shared stop/pause events
  - Separate DB tables (ext_drive_runs / ext_drive_files)
  - Separate WebSocket event prefix: ext_*

Memory strategy
---------------
The drive can hold 1TB+ of media.  To avoid blowing the 4 GB server RAM:
  * We never build a list of all file paths in memory.
  * We yield files one at a time from a generator.
  * The DB query to check already-uploaded paths uses a per-file lookup
    (one SELECT per file) rather than loading all paths into a Python set.
  * The ExtDriveFile row is inserted just-in-time, right before upload.
"""

import os
import threading
import time
import datetime
import subprocess
import shutil

from src.database import SessionLocal, ExtDriveRun, ExtDriveFile

# ---------------------------------------------------------------------------
# Configuration (can be overridden via Settings DB key EXT_DRIVE_PATH)
# ---------------------------------------------------------------------------

EXT_DRIVE_ROOT_DEFAULT = "/mnt/external_drive"

MEDIA_EXTENSIONS = {
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif',
    '.heic', '.heif', '.raw', '.arw', '.cr2', '.cr3', '.nef', '.orf',
    '.rw2', '.dng', '.pef', '.srw',
    '.mp4', '.mov', '.avi', '.mkv', '.m4v', '.3gp', '.wmv', '.flv',
    '.mts', '.m2ts', '.ts',
}

# Directories to always skip — Windows system, macOS metadata, exFAT junk
SKIP_DIRS = {
    '$RECYCLE.BIN',
    'RECYCLER',
    '$RECYCLER',
    'System Volume Information',
    'SYSTEM~1',
    '.Spotlight-V100',
    '.fseventsd',
    '.Trashes',
    '.TemporaryItems',
    '.DocumentRevisions-V100',
    'FOUND.000',
    'lost+found',
}

# ---------------------------------------------------------------------------
# Stop / Pause control (separate from USB workflow)
# ---------------------------------------------------------------------------

_ext_stop_event = threading.Event()
_ext_pause_event = threading.Event()


def ext_stop():
    _ext_stop_event.set()


def ext_pause():
    _ext_pause_event.set()


def ext_resume():
    _ext_stop_event.clear()
    _ext_pause_event.clear()


# ---------------------------------------------------------------------------
# Broadcast helper
# ---------------------------------------------------------------------------

def _broadcast(event: str, data: dict):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"[ext_drive] broadcast failed: {e}")


# ---------------------------------------------------------------------------
# Drive helpers
# ---------------------------------------------------------------------------

def get_ext_drive_path() -> str:
    """Return the configured ext drive path (from DB or default)."""
    try:
        db = SessionLocal()
        from src.database import Setting
        s = db.query(Setting).filter(Setting.key == "EXT_DRIVE_PATH").first()
        db.close()
        if s and s.value:
            return s.value
    except Exception:
        pass
    return EXT_DRIVE_ROOT_DEFAULT


def get_ext_drive_status() -> dict:
    """Return mount status and disk usage for the external drive."""
    root = get_ext_drive_path()

    # 1. Check if mount point is mounted with a real filesystem (not just autofs)
    mounted = False
    try:
        res = subprocess.run(
            ["findmnt", "-n", "-o", "FSTYPE,TARGET", "-M", root],
            capture_output=True, text=True, timeout=5
        )
        lines = [line.strip() for line in res.stdout.strip().splitlines() if line.strip()]
        for line in lines:
            fstype = line.split()[0] if line else ""
            if fstype and fstype != "autofs":
                mounted = True
                break
    except Exception:
        pass

    # 2. If not mounted, try mounting it (triggers systemd or /etc/fstab entry)
    if not mounted:
        try:
            subprocess.run(["mount", root], capture_output=True, timeout=10)
        except Exception:
            pass

    # 3. Check disk usage & mount verification
    try:
        total, used, free = shutil.disk_usage(root)
        if os.path.ismount(root) and total > 0:
            return {
                "mounted": True,
                "mount_point": root,
                "total": total,
                "used": used,
                "free": free,
            }
    except Exception:
        pass

    return {
        "mounted": False,
        "mount_point": root,
        "total": 0,
        "used": 0,
        "free": 0,
    }


def scan_top_level_folders() -> list:
    """
    List top-level entries in the ext drive with file count and size.
    Only counts media files (by extension).
    Returns quickly without walking the full tree by just listing one level.
    """
    root = get_ext_drive_path()
    if not os.path.exists(root):
        return []

    result = []
    try:
        entries = sorted(os.listdir(root))
    except PermissionError:
        return []

    for name in entries:
        if name.startswith('.') or name in SKIP_DIRS:
            continue
        full = os.path.join(root, name)
        if os.path.isdir(full):
            result.append({
                "name": name,
                "type": "folder",
                "path": full,
            })
        elif os.path.isfile(full):
            ext = os.path.splitext(name)[1].lower()
            if ext in MEDIA_EXTENSIONS:
                result.append({
                    "name": name,
                    "type": "file",
                    "path": full,
                    "size": os.path.getsize(full),
                })
    return result


def count_media_files(root: str) -> int:
    """Count media files under root without building a list in memory."""
    count = 0
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [
            d for d in dirnames
            if not d.startswith('.') and d not in SKIP_DIRS
        ]
        for fname in filenames:
            if fname.startswith('.'):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext in MEDIA_EXTENSIONS:
                count += 1
    return count


# ---------------------------------------------------------------------------
# File generator (memory-safe walk)
# ---------------------------------------------------------------------------

def _iter_media_files(root: str):
    """
    Yield absolute file paths for all media files under root.
    Uses os.walk — never builds a full list in memory.
    Skips system directories (SKIP_DIRS), hidden dirs/files, and non-media files.
    """
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        # Skip system and hidden directories in-place (prunes the walk)
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith('.') and d not in SKIP_DIRS
        )
        for fname in sorted(filenames):
            if fname.startswith('.'):
                continue
            ext = os.path.splitext(fname)[1].lower()
            if ext not in MEDIA_EXTENSIONS:
                continue
            yield os.path.join(dirpath, fname)


# ---------------------------------------------------------------------------
# Already-uploaded helpers
# ---------------------------------------------------------------------------

def _get_uploaded_set(db) -> set:
    """Return a set of all file paths successfully uploaded in any previous run."""
    rows = db.query(ExtDriveFile.filepath).filter(
        ExtDriveFile.upload_status == "success"
    ).all()
    return {r[0] for r in rows}


def _is_already_uploaded(db, filepath: str) -> bool:
    """Return True if this filepath has been successfully uploaded in any previous run."""
    record = db.query(ExtDriveFile).filter(
        ExtDriveFile.filepath == filepath,
        ExtDriveFile.upload_status == "success"
    ).first()
    return record is not None


# ---------------------------------------------------------------------------
# Main upload task
# ---------------------------------------------------------------------------

def start_ext_drive_upload():
    """
    Entry point called from the API (runs in a BackgroundTask thread).
    Pre-loads previously uploaded files from local SQLite database into memory (< 0.5s),
    filters the disk scan to only pending files, and uploads them to Google Photos.
    """
    from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED, UPLOAD_FAILED

    _ext_stop_event.clear()
    _ext_pause_event.clear()

    drive_root = get_ext_drive_path()

    if not os.path.exists(drive_root):
        _broadcast("ext_run_completed", {
            "error": f"External drive not found at {drive_root}. Is it mounted?"
        })
        return

    db = SessionLocal()

    # Create a new run record
    run = ExtDriveRun()
    db.add(run)
    db.commit()
    db.refresh(run)
    run_id = run.id

    _broadcast("ext_run_started", {"run_id": run_id, "drive_root": drive_root})

    # Phase 1: Pre-load already uploaded paths from DB & scan disk
    _broadcast("ext_scan_started", {"run_id": run_id})
    print(f"[ext_drive] Pre-loading uploaded paths from database...")
    uploaded_set = _get_uploaded_set(db)
    print(f"[ext_drive] Loaded {len(uploaded_set)} uploaded paths from DB.")

    print(f"[ext_drive] Scanning media files in {drive_root}...")
    pending_files = []
    total_disk_files = 0
    already_uploaded_count = 0

    for filepath in _iter_media_files(drive_root):
        total_disk_files += 1
        if filepath in uploaded_set:
            already_uploaded_count += 1
        else:
            pending_files.append(filepath)

        if _ext_stop_event.is_set():
            break

    if _ext_stop_event.is_set():
        run.overall_status = "stopped"
        run.end_time = datetime.datetime.now(datetime.timezone.utc)
        db.commit()
        db.close()
        _broadcast("ext_run_completed", {"run_id": run_id, "error": "Stopped during scan"})
        return

    total_pending = len(pending_files)
    run.total_files = total_pending
    run.skipped_files = already_uploaded_count
    db.commit()

    print(f"[ext_drive] Found {total_disk_files} files on disk: {already_uploaded_count} already in local DB, {total_pending} pending to upload.")

    _broadcast("ext_scan_done", {
        "run_id": run_id,
        "total": total_pending,
        "total_disk": total_disk_files,
        "already_uploaded": already_uploaded_count,
    })

    if total_pending == 0:
        run.overall_status = "completed"
        run.end_time = datetime.datetime.now(datetime.timezone.utc)
        db.commit()
        db.close()
        _broadcast("ext_upload_done", {
            "run_id": run_id,
            "uploaded": 0,
            "failed": 0,
            "skipped": already_uploaded_count,
            "total": 0,
            "total_disk": total_disk_files,
        })
        _broadcast("ext_run_completed", {
            "run_id": run_id,
            "status": "completed",
        })
        return

    # Phase 2: Upload pending files
    uploaded = 0
    failed = 0
    skipped = 0

    _broadcast("ext_upload_started", {
        "run_id": run_id,
        "total": total_pending,
        "total_disk": total_disk_files,
        "already_uploaded": already_uploaded_count,
    })

    for current_idx, filepath in enumerate(pending_files, 1):
        # Stop check
        if _ext_stop_event.is_set():
            _broadcast("ext_upload_stopped", {"at": current_idx, "total": total_pending})
            break

        # Pause check
        while _ext_pause_event.is_set():
            if _ext_stop_event.is_set():
                break
            time.sleep(0.5)

        # Create a DB record for this file
        record = ExtDriveFile(run_id=run_id, filepath=filepath, upload_status="pending")
        db.add(record)
        db.commit()
        db.refresh(record)

        # Flush live counters to run row periodically
        if current_idx % 25 == 0:
            run.uploaded_files = uploaded
            run.failed_files = failed
            run.skipped_files = already_uploaded_count + skipped
            db.commit()

        file_size = os.path.getsize(filepath) if os.path.exists(filepath) else 0

        _broadcast("ext_upload_progress", {
            "run_id": run_id,
            "filepath": filepath,
            "filename": os.path.basename(filepath),
            "current": current_idx,
            "total": total_pending,
            "already_uploaded": already_uploaded_count,
            "total_disk": total_disk_files,
            "file_size": file_size,
            "status": "uploading",
        })

        def _on_byte_progress(bytes_sent, total_bytes):
            pct = round((bytes_sent / max(total_bytes, 1)) * 100, 1)
            _broadcast("ext_file_byte_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "bytes_sent": bytes_sent,
                "total_bytes": total_bytes,
                "pct": pct,
                "current": current_idx,
                "total": total_pending,
            })

        upload_status, err, duration = upload_file(filepath, on_progress=_on_byte_progress)

        if upload_status == UPLOAD_NEW:
            speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
            record.upload_status = "success"
            uploaded_set.add(filepath)
            uploaded += 1
            _broadcast("ext_upload_speed", {
                "speed_mbps": round(speed_mbps, 2),
            })
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total_pending,
                "already_uploaded": already_uploaded_count,
                "total_disk": total_disk_files,
                "file_size": file_size,
                "status": "uploaded",
            })

        elif upload_status == UPLOAD_DUPLICATE:
            record.upload_status = "success"
            record.error_message = "already_in_photos"
            uploaded_set.add(filepath)
            uploaded += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total_pending,
                "already_uploaded": already_uploaded_count,
                "total_disk": total_disk_files,
                "file_size": file_size,
                "status": "already_in_photos",
            })

        elif upload_status == UPLOAD_SKIPPED:
            record.upload_status = "skipped"
            record.error_message = err
            skipped += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total_pending,
                "already_uploaded": already_uploaded_count,
                "total_disk": total_disk_files,
                "file_size": file_size,
                "status": "skipped",
                "reason": err,
            })

        else:  # UPLOAD_FAILED
            record.upload_status = "failed"
            record.error_message = err
            failed += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total_pending,
                "already_uploaded": already_uploaded_count,
                "total_disk": total_disk_files,
                "file_size": file_size,
                "status": "failed",
                "reason": err,
            })

        db.commit()

    # Finalize run
    run.uploaded_files = uploaded
    run.failed_files = failed
    run.skipped_files = already_uploaded_count + skipped
    run.end_time = datetime.datetime.now(datetime.timezone.utc)

    if _ext_stop_event.is_set():
        run.overall_status = "stopped"
    elif failed > 0:
        run.overall_status = "completed_with_errors"
    else:
        run.overall_status = "completed"

    db.commit()
    db.close()

    _broadcast("ext_upload_done", {
        "run_id": run_id,
        "uploaded": uploaded,
        "failed": failed,
        "skipped": already_uploaded_count + skipped,
        "total": total_pending,
        "total_disk": total_disk_files,
    })
    _broadcast("ext_run_completed", {
        "run_id": run_id,
        "status": run.overall_status,
    })
    print(f"[ext_drive] Run {run_id} complete: {uploaded} uploaded, {failed} failed, {skipped} skipped.")


# ---------------------------------------------------------------------------
# Re-upload failed files from a previous run
# ---------------------------------------------------------------------------

def reupload_failed_files(source_run_id: int):
    """
    Re-upload only the files that failed in a previous ext drive run.
    Creates a brand-new ExtDriveRun and attempts each failed filepath again.
    """
    from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED, UPLOAD_FAILED

    _ext_stop_event.clear()
    _ext_pause_event.clear()

    db = SessionLocal()

    # Fetch failed files from the source run
    failed_records = db.query(ExtDriveFile).filter(
        ExtDriveFile.run_id == source_run_id,
        ExtDriveFile.upload_status == "failed"
    ).all()

    filepaths = [r.filepath for r in failed_records if r.filepath]
    total = len(filepaths)

    if total == 0:
        db.close()
        _broadcast("ext_run_completed", {"error": "No failed files found for that session."})
        return

    # Create a new run record
    run = ExtDriveRun()
    run.total_files = total
    db.add(run)
    db.commit()
    db.refresh(run)
    run_id = run.id

    _broadcast("ext_run_started", {"run_id": run_id, "drive_root": f"reupload from session #{source_run_id}"})
    _broadcast("ext_scan_done", {"run_id": run_id, "total": total})
    _broadcast("ext_upload_started", {"run_id": run_id, "total": total})

    uploaded = 0
    failed = 0
    skipped = 0
    current_idx = 0

    for filepath in filepaths:
        if _ext_stop_event.is_set():
            _broadcast("ext_upload_stopped", {"at": current_idx, "total": total})
            break

        while _ext_pause_event.is_set():
            if _ext_stop_event.is_set():
                break
            time.sleep(0.5)

        current_idx += 1

        if not os.path.exists(filepath):
            # File no longer exists on the drive
            record = ExtDriveFile(run_id=run_id, filepath=filepath, upload_status="failed",
                                  error_message="File not found on drive")
            db.add(record)
            db.commit()
            failed += 1
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total,
                "status": "failed",
                "reason": "File not found on drive",
            })
            continue

        file_size = os.path.getsize(filepath)

        record = ExtDriveFile(run_id=run_id, filepath=filepath, upload_status="pending")
        db.add(record)
        db.commit()
        db.refresh(record)

        _broadcast("ext_upload_progress", {
            "run_id": run_id,
            "filepath": filepath,
            "filename": os.path.basename(filepath),
            "current": current_idx,
            "total": total,
            "file_size": file_size,
            "status": "uploading",
        })

        def _on_byte_progress(bytes_sent, total_bytes):
            pct = round((bytes_sent / max(total_bytes, 1)) * 100, 1)
            _broadcast("ext_file_byte_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "bytes_sent": bytes_sent,
                "total_bytes": total_bytes,
                "pct": pct,
                "current": current_idx,
                "total": total,
            })

        upload_status, err, duration = upload_file(filepath, on_progress=_on_byte_progress)

        if upload_status == UPLOAD_NEW:
            speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
            record.upload_status = "success"
            uploaded += 1
            _broadcast("ext_upload_speed", {"speed_mbps": round(speed_mbps, 2)})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total,
                "status": "uploaded",
            })
        elif upload_status == UPLOAD_DUPLICATE:
            record.upload_status = "success"
            record.error_message = "already_in_photos"
            uploaded += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total,
                "status": "already_in_photos",
            })
        elif upload_status == UPLOAD_SKIPPED:
            record.upload_status = "skipped"
            record.error_message = err
            skipped += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total,
                "status": "skipped",
                "reason": err,
            })
        else:  # UPLOAD_FAILED
            record.upload_status = "failed"
            record.error_message = err
            failed += 1
            _broadcast("ext_upload_speed", {"speed_mbps": None})
            _broadcast("ext_upload_progress", {
                "run_id": run_id,
                "filepath": filepath,
                "filename": os.path.basename(filepath),
                "current": current_idx,
                "total": total,
                "status": "failed",
                "reason": err,
            })

        db.commit()

    # Finalize run
    run.uploaded_files = uploaded
    run.failed_files = failed
    run.skipped_files = skipped
    run.end_time = datetime.datetime.now(datetime.timezone.utc)

    if _ext_stop_event.is_set():
        run.overall_status = "stopped"
    elif failed > 0:
        run.overall_status = "completed_with_errors"
    else:
        run.overall_status = "completed"

    db.commit()
    db.close()

    _broadcast("ext_upload_done", {
        "run_id": run_id,
        "uploaded": uploaded,
        "failed": failed,
        "skipped": skipped,
        "total": total,
    })
    _broadcast("ext_run_completed", {
        "run_id": run_id,
        "status": run.overall_status,
    })
    print(f"[ext_drive] Re-upload run {run_id} (from #{source_run_id}): {uploaded} uploaded, {failed} failed, {skipped} skipped.")
