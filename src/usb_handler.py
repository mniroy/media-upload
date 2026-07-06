import os
import shutil
import time
import threading
import subprocess
from src.database import SessionLocal, Run, FileRecord
from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED, UPLOAD_FAILED

STAGING_DIR = "/var/lib/media_upload/staging"
MOUNT_BASE = "/var/lib/media_upload/mnt"

# ---------------------------------------------------------------------------
# Global state flags
# ---------------------------------------------------------------------------

# Copy pause/stop control
_copy_stop_event = threading.Event()   # set → stop copy immediately
_copy_pause_event = threading.Event()  # set → copy is paused (loop waits)

# Upload pause/stop control
_upload_stop_event = threading.Event()
_upload_pause_event = threading.Event()

# Live upload speed tracking
_upload_speed_lock = threading.Lock()
_upload_current_speed_bps = 0.0  # bytes per second, updated by speed-tracker thread


def copy_stop():
    _copy_stop_event.set()

def copy_resume():
    _copy_stop_event.clear()
    _copy_pause_event.clear()

def copy_pause():
    _copy_pause_event.set()

def copy_is_paused():
    return _copy_pause_event.is_set()

def upload_stop():
    _upload_stop_event.set()

def upload_resume():
    _upload_stop_event.clear()
    _upload_pause_event.clear()


# ---------------------------------------------------------------------------
# Broadcast helper
# ---------------------------------------------------------------------------

def sync_broadcast(event, data):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"Broadcast failed: {e}")


# ---------------------------------------------------------------------------
# Mount / Unmount helpers
# ---------------------------------------------------------------------------

def mount_device(device_name: str) -> str | None:
    """Mount /dev/<device_name> and return the mount path, or None on failure."""
    device_path = f"/dev/{device_name}"
    mount_point = os.path.join(MOUNT_BASE, device_name)
    os.makedirs(mount_point, exist_ok=True)

    # Check if already mounted
    result = subprocess.run(["findmnt", "-n", "-o", "TARGET", device_path],
                            capture_output=True, text=True)
    if result.stdout.strip():
        existing = result.stdout.strip()
        print(f"Device {device_path} already mounted at {existing}")
        return existing

    result = subprocess.run(["mount", "-o", "ro", device_path, mount_point],
                            capture_output=True, text=True)
    if result.returncode != 0:
        print(f"Failed to mount {device_path}: {result.stderr}")
        return None

    print(f"Mounted {device_path} at {mount_point}")
    return mount_point


def unmount_device(mount_point: str):
    """Unmount the device."""
    subprocess.run(["umount", mount_point], capture_output=True)
    print(f"Unmounted {mount_point}")


def get_device_info(device_name: str) -> dict:
    """Return disk info for a mounted device (size, used, free in bytes)."""
    mount_point = os.path.join(MOUNT_BASE, device_name)
    # Try the known mount point first, then ask findmnt
    device_path = f"/dev/{device_name}"
    result = subprocess.run(["findmnt", "-n", "-o", "TARGET", device_path],
                            capture_output=True, text=True)
    mp = result.stdout.strip() or mount_point
    try:
        total, used, free = shutil.disk_usage(mp)
        return {"total": total, "used": used, "free": free, "mount_point": mp, "mounted": True}
    except Exception:
        return {"total": 0, "used": 0, "free": 0, "mount_point": None, "mounted": False}


def get_mount_status(device_name: str) -> dict:
    device_path = f"/dev/{device_name}"
    result = subprocess.run(["findmnt", "-n", "-o", "TARGET", device_path],
                            capture_output=True, text=True)
    mp = result.stdout.strip()
    return {"mounted": bool(mp), "mount_point": mp or None}


# ---------------------------------------------------------------------------
# USB copy & upload process
# ---------------------------------------------------------------------------

def process_usb(device_name: str):
    """Called when a USB disk is inserted. Copies files and then broadcasts
    folder list for user to select what to upload."""
    print(f"Processing USB {device_name}")
    _copy_stop_event.clear()
    _copy_pause_event.clear()

    sync_broadcast("run_started", {"device": device_name})
    db = SessionLocal()

    run = Run(usb_identifier=device_name)
    db.add(run)
    db.commit()
    db.refresh(run)

    # Broadcast USB disk info
    info = get_device_info(device_name)
    sync_broadcast("usb_info", {"device": device_name, **info})

    usb_mount_path = mount_device(device_name)
    if not usb_mount_path:
        run.overall_status = "failed"
        db.commit()
        db.close()
        sync_broadcast("run_completed", {"error": f"Failed to mount /dev/{device_name}"})
        return

    # Collect files
    files_to_process = []
    for root, dirs, files in os.walk(usb_mount_path):
        dirs[:] = [d for d in dirs if not d.startswith('.')
                   and d not in ('System Volume Information', 'RECYCLER', '$RECYCLE.BIN')]
        for file in files:
            if file.startswith('.'):
                continue
            rel_dir = os.path.relpath(root, usb_mount_path)
            rel_file = file if rel_dir == '.' else os.path.join(rel_dir, file)
            record = FileRecord(run_id=run.id, filename=rel_file, copy_status="pending")
            db.add(record)
            files_to_process.append(record)

    db.commit()
    print(f"Found {len(files_to_process)} files to process")

    # Copy files with pause/stop support
    date_str = run.start_time.strftime('%Y-%m-%d')
    session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run.id}")

    for i, record in enumerate(files_to_process):
        # Handle stop
        if _copy_stop_event.is_set():
            sync_broadcast("copy_stopped", {"at": i, "total": len(files_to_process)})
            break
        # Handle pause (block until resumed or stopped)
        while _copy_pause_event.is_set():
            if _copy_stop_event.is_set():
                break
            time.sleep(0.5)

        sync_broadcast("copy_progress", {
            "filename": record.filename,
            "current": i + 1,
            "total": len(files_to_process),
            "paused": False
        })
        try:
            src_path = os.path.join(usb_mount_path, record.filename)
            dst_path = os.path.join(session_dir, record.filename)
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            shutil.copy2(src_path, dst_path)
            record.copy_status = "success"
        except Exception as e:
            record.copy_status = "failed"
            record.error_message = str(e)
            print(f"Copy error for {record.filename}: {e}")
        db.commit()

    unmount_device(usb_mount_path)
    sync_broadcast("copy_done", {})

    # Collect top-level folders in the staging session dir
    folders = _list_session_folders(session_dir)
    sync_broadcast("copy_done_select", {
        "run_id": run.id,
        "session_dir": session_dir,
        "folders": folders,
        "auto_upload_seconds": 30
    })

    db.close()


def _list_session_folders(session_dir: str) -> list[dict]:
    """Return top-level entries (dirs and loose files) in a session dir."""
    folders = []
    if not os.path.exists(session_dir):
        return folders
    for name in sorted(os.listdir(session_dir)):
        full = os.path.join(session_dir, name)
        if os.path.isdir(full):
            # Count files recursively
            count = sum(len(files) for _, _, files in os.walk(full))
            size = sum(
                os.path.getsize(os.path.join(r, f))
                for r, _, files in os.walk(full) for f in files
                if not f.startswith('.')
            )
            folders.append({"name": name, "type": "folder", "file_count": count, "size": size})
        elif os.path.isfile(full) and not name.startswith('.'):
            folders.append({"name": name, "type": "file", "file_count": 1,
                            "size": os.path.getsize(full)})
    return folders


def get_staged_folders(run_id: int) -> list[dict]:
    """Public helper called by the API to list folders for a run."""
    db = SessionLocal()
    run = db.query(Run).filter(Run.id == run_id).first()
    db.close()
    if not run:
        return []
    date_str = run.start_time.strftime('%Y-%m-%d')
    session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run_id}")
    return _list_session_folders(session_dir)



# ---------------------------------------------------------------------------
# Upload selected folders (called from API)
# ---------------------------------------------------------------------------

def upload_selected_folders(run_id: int, selected_folders: list[str]):
    """Upload only files under selected top-level folders for a given run."""
    _upload_stop_event.clear()
    _upload_pause_event.clear()

    db = SessionLocal()
    run = db.query(Run).filter(Run.id == run_id).first()
    if not run:
        db.close()
        return

    date_str = run.start_time.strftime('%Y-%m-%d')
    session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run_id}")

    # Build set of already-successfully-uploaded relative paths (across ALL runs)
    already_uploaded = set(
        r.filename
        for r in db.query(FileRecord).filter(FileRecord.upload_status == "success").all()
    )

    # Gather files from selected folders
    files_to_upload = []  # list of (FileRecord, full_path)
    for folder in selected_folders:
        folder_path = os.path.join(session_dir, folder)
        if not os.path.exists(folder_path):
            continue
        walker = [(folder_path, [], [folder])] if os.path.isfile(folder_path) else os.walk(folder_path)
        for root, _, files in walker:
            for file in files:
                if file.startswith('.'):
                    continue
                full_path = os.path.join(root, file)
                rel = os.path.relpath(full_path, session_dir)

                # Deduplication: skip if already uploaded successfully
                if rel in already_uploaded:
                    print(f"Skipping already-uploaded: {rel}")
                    continue

                # Find existing FileRecord for this file in this run
                record = db.query(FileRecord).filter(
                    FileRecord.run_id == run_id,
                    FileRecord.filename == rel
                ).first()
                if not record:
                    # File came from local staging; create a record
                    record = FileRecord(run_id=run_id, filename=rel, copy_status="success")
                    db.add(record)
                    db.commit()
                    db.refresh(record)

                files_to_upload.append((record, full_path))

    db.commit()
    total = len(files_to_upload)
    print(f"Uploading {total} files for run {run_id}, folders: {selected_folders}")

    sync_broadcast("upload_started", {"run_id": run_id, "total": total})

    for i, (record, full_path) in enumerate(files_to_upload):
        # Stop check
        if _upload_stop_event.is_set():
            sync_broadcast("upload_stopped", {"at": i, "total": total})
            break
        # Pause check
        while _upload_pause_event.is_set():
            if _upload_stop_event.is_set():
                break
            time.sleep(0.5)

        file_size = os.path.getsize(full_path) if os.path.exists(full_path) else 0
        sync_broadcast("upload_progress", {
            "filename": record.filename,
            "current": i + 1,
            "total": total,
            "file_size": file_size,
            "status": "uploading"
        })

        upload_status, err, duration = upload_file(full_path)

        if upload_status == UPLOAD_NEW:
            # Real upload — compute accurate speed from file size and actual duration
            speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
            
            record.upload_status = "success"
            sync_broadcast("upload_speed", {
                "filename": record.filename,
                "speed_mbps": round(speed_mbps, 2),
                "live": False
            })
            sync_broadcast("upload_progress", {
                "filename": record.filename,
                "current": i + 1,
                "total": total,
                "file_size": file_size,
                "status": "uploaded"
            })
        elif upload_status == UPLOAD_DUPLICATE:
            record.upload_status = "success"
            record.error_message = "already_in_photos"
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename,
                "current": i + 1,
                "total": total,
                "status": "already_in_photos"
            })
        elif upload_status == UPLOAD_SKIPPED:
            record.upload_status = "skipped"
            record.error_message = err
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename,
                "current": i + 1,
                "total": total,
                "status": "skipped",
                "reason": err
            })
        else:  # UPLOAD_FAILED
            record.upload_status = "failed"
            record.error_message = err
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename,
                "current": i + 1,
                "total": total,
                "status": "failed",
                "reason": err
            })
        db.commit()

    sync_broadcast("upload_done", {"run_id": run_id})
    run.overall_status = "completed"
    db.commit()
    db.close()
    sync_broadcast("run_completed", {"run_id": run_id})


# ---------------------------------------------------------------------------
# Local directory upload (triggered manually from UI)
# ---------------------------------------------------------------------------

def process_local_directory(folder_path: str | None = None):
    """Upload files from staging dir. If folder_path is given, upload only that folder."""
    print("Processing local staging directory for uploads")
    _upload_stop_event.clear()
    _upload_pause_event.clear()

    db = SessionLocal()

    run = Run(usb_identifier="local_disk")
    db.add(run)
    db.commit()
    db.refresh(run)

    sync_broadcast("run_started", {"device": "local_disk", "run_id": run.id})

    walk_root = folder_path if folder_path else STAGING_DIR

    # Build set of already-successfully-uploaded relative paths
    already_uploaded = set(
        r.filename
        for r in db.query(FileRecord).filter(FileRecord.upload_status == "success").all()
    )

    files_to_process = []
    for root, dirs, files in os.walk(walk_root):
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for file in files:
            if file.startswith('.'):
                continue
            full_path = os.path.join(root, file)
            rel_file = os.path.relpath(full_path, STAGING_DIR)

            # Deduplication
            if rel_file in already_uploaded:
                print(f"Skipping already-uploaded: {rel_file}")
                continue

            record = FileRecord(run_id=run.id, filename=rel_file, copy_status="success")
            db.add(record)
            files_to_process.append((record, full_path))

    db.commit()
    total = len(files_to_process)
    print(f"Found {total} local files to process (after dedup)")

    sync_broadcast("copy_done", {})

    for i, (record, full_path) in enumerate(files_to_process):
        if _upload_stop_event.is_set():
            sync_broadcast("upload_stopped", {"at": i, "total": total})
            break
        while _upload_pause_event.is_set():
            if _upload_stop_event.is_set():
                break
            time.sleep(0.5)

        file_size = os.path.getsize(full_path) if os.path.exists(full_path) else 0
        sync_broadcast("upload_progress", {
            "filename": record.filename,
            "current": i + 1,
            "total": total,
            "file_size": file_size,
            "status": "uploading"
        })

        upload_status, err, duration = upload_file(full_path)

        if upload_status == UPLOAD_NEW:
            speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
            record.upload_status = "success"
            sync_broadcast("upload_speed", {
                "filename": record.filename,
                "speed_mbps": round(speed_mbps, 2),
                "live": False
            })
            sync_broadcast("upload_progress", {
                "filename": record.filename, "current": i + 1, "total": total,
                "status": "uploaded"
            })
        elif upload_status == UPLOAD_DUPLICATE:
            record.upload_status = "success"
            record.error_message = "already_in_photos"
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename, "current": i + 1, "total": total,
                "status": "already_in_photos"
            })
        elif upload_status == UPLOAD_SKIPPED:
            record.upload_status = "skipped"
            record.error_message = err
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename, "current": i + 1, "total": total,
                "status": "skipped", "reason": err
            })
        else:  # UPLOAD_FAILED
            record.upload_status = "failed"
            record.error_message = err
            sync_broadcast("upload_speed", {"speed_mbps": None, "live": False})
            sync_broadcast("upload_progress", {
                "filename": record.filename, "current": i + 1, "total": total,
                "status": "failed", "reason": err
            })
        db.commit()

    sync_broadcast("upload_done", {"run_id": run.id})
    run.overall_status = "completed"
    db.commit()
    db.close()
    sync_broadcast("run_completed", {"run_id": run.id})
