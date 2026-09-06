"""
upload_station_handler.py
=========================
Handles direct drag-and-drop media file uploads to Google Photos.
Features:
  - Multi-file and folder ingestion
  - Dedicated staging area with automatic cleanup after cloud upload
  - Granular byte-level progress and real-time upload speed calculation
  - Pause, Resume, Stop controls
  - Persistent SQLite logging via UploadStationRun and UploadStationFile
  - Real-time WebSocket telemetry prefix: upload_station_*
"""

import os
import time
import datetime
import threading
import shutil
from typing import List, Optional
from src.database import SessionLocal, UploadStationRun, UploadStationFile

# Staging directory for dropped files
PRIMARY_STAGING = "/var/lib/media_upload/upload_station_staging"
FALLBACK_STAGING = "/tmp/media_upload_upload_station_staging"

def get_upload_staging_dir() -> str:
    try:
        os.makedirs(PRIMARY_STAGING, exist_ok=True)
        test_file = os.path.join(PRIMARY_STAGING, ".perm_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
        return PRIMARY_STAGING
    except Exception:
        os.makedirs(FALLBACK_STAGING, exist_ok=True)
        return FALLBACK_STAGING

# Control events
_station_stop_event = threading.Event()
_station_pause_event = threading.Event()
_station_lock = threading.Lock()
_is_processing = False

def upload_station_stop():
    _station_stop_event.set()

def upload_station_pause():
    _station_pause_event.set()

def upload_station_resume():
    _station_stop_event.clear()
    _station_pause_event.clear()

def is_upload_station_active() -> bool:
    return _is_processing

def _broadcast(event: str, data: dict):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"[upload_station] broadcast failed: {e}")

def process_upload_station_queue(file_infos: List[dict], source_run_id: Optional[int] = None):
    """
    Process a batch of uploaded files.
    file_infos is a list of dicts:
      [{'filename': 'photo.jpg', 'filepath': '/path/to/staged_photo.jpg', 'filesize': 12345}, ...]
    """
    global _is_processing
    with _station_lock:
        if _is_processing:
            print("[upload_station] Already processing a batch, appending or waiting...")
        _is_processing = True

    from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED, UPLOAD_FAILED

    _station_stop_event.clear()
    _station_pause_event.clear()

    db = SessionLocal()
    run = None
    if source_run_id:
        run = db.query(UploadStationRun).filter(UploadStationRun.id == source_run_id).first()
    
    if not run:
        total_bytes = sum(f.get("filesize", 0) for f in file_infos)
        run = UploadStationRun(
            total_files=len(file_infos),
            total_bytes=total_bytes,
            overall_status="running"
        )
        db.add(run)
        db.commit()
        db.refresh(run)

    run_id = run.id
    total_files = len(file_infos)
    total_bytes = run.total_bytes or sum(f.get("filesize", 0) for f in file_infos)

    _broadcast("upload_station_run_started", {
        "run_id": run_id,
        "total_files": total_files,
        "total_bytes": total_bytes,
    })

    uploaded_count = run.uploaded_files or 0
    failed_count = run.failed_files or 0
    skipped_count = run.skipped_files or 0
    cum_bytes_uploaded = run.uploaded_bytes or 0

    try:
        for idx, f_info in enumerate(file_infos, 1):
            if _station_stop_event.is_set():
                run.overall_status = "stopped"
                run.end_time = datetime.datetime.now(datetime.timezone.utc)
                db.commit()
                _broadcast("upload_station_stopped", {
                    "run_id": run_id,
                    "at": idx - 1,
                    "total": total_files,
                })
                break

            while _station_pause_event.is_set():
                if _station_stop_event.is_set():
                    break
                time.sleep(0.5)

            filename = f_info.get("filename")
            filepath = f_info.get("filepath")
            filesize = f_info.get("filesize") or (os.path.getsize(filepath) if filepath and os.path.exists(filepath) else 0)

            # Look up or create file record
            file_rec = db.query(UploadStationFile).filter(
                UploadStationFile.run_id == run_id,
                UploadStationFile.filename == filename
            ).first()

            if not file_rec:
                file_rec = UploadStationFile(
                    run_id=run_id,
                    filename=filename,
                    filepath=filepath,
                    filesize=filesize,
                    upload_status="uploading"
                )
                db.add(file_rec)
            else:
                file_rec.upload_status = "uploading"
            db.commit()
            db.refresh(file_rec)

            _broadcast("upload_station_file_start", {
                "run_id": run_id,
                "file_id": file_rec.id,
                "filename": filename,
                "filesize": filesize,
                "current": idx,
                "total": total_files,
            })

            last_speed_time = [time.monotonic()]
            last_bytes = [0]

            def on_progress(bytes_sent, total_size):
                now = time.monotonic()
                dt = now - last_speed_time[0]
                if dt >= 0.5:
                    speed = ((bytes_sent - last_bytes[0]) / dt) / (1024 * 1024)
                    speed_mbps = round(speed * 8, 2)
                    last_speed_time[0] = now
                    last_bytes[0] = bytes_sent
                    _broadcast("upload_station_speed", {
                        "run_id": run_id,
                        "speed_mbps": speed_mbps,
                    })

                _broadcast("upload_station_progress", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "bytes_sent": bytes_sent,
                    "filesize": total_size,
                    "current": idx,
                    "total": total_files,
                    "uploaded_files": uploaded_count,
                    "failed_files": failed_count,
                    "cum_bytes": cum_bytes_uploaded + bytes_sent,
                    "total_bytes": total_bytes,
                })

            status, msg, duration = upload_file(filepath, on_progress=on_progress, source_station="upload_station")

            if status == UPLOAD_NEW:
                file_rec.upload_status = "success"
                file_rec.duration_seconds = int(duration)
                uploaded_count += 1
                cum_bytes_uploaded += filesize
                _broadcast("upload_station_file_done", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": "success",
                    "filesize": filesize,
                    "duration": duration,
                })
            elif status == UPLOAD_DUPLICATE:
                file_rec.upload_status = "duplicate"
                file_rec.error_message = "Already in Google Photos"
                uploaded_count += 1
                cum_bytes_uploaded += filesize
                _broadcast("upload_station_file_done", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": "duplicate",
                    "filesize": filesize,
                })
            elif status == UPLOAD_SKIPPED:
                file_rec.upload_status = "skipped"
                file_rec.error_message = msg
                skipped_count += 1
                _broadcast("upload_station_file_done", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": "skipped",
                    "filesize": filesize,
                    "error": msg,
                })
            else:  # UPLOAD_FAILED
                file_rec.upload_status = "failed"
                file_rec.error_message = msg
                failed_count += 1
                _broadcast("upload_station_file_failed", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": "failed",
                    "filesize": filesize,
                    "error": msg,
                })

            db.commit()

            # Clean up local staged file to conserve disk space
            if filepath and os.path.exists(filepath):
                try:
                    os.remove(filepath)
                except Exception as e:
                    print(f"[upload_station] cleanup error: {e}")

            # Update run record
            run.uploaded_files = uploaded_count
            run.failed_files = failed_count
            run.skipped_files = skipped_count
            run.uploaded_bytes = cum_bytes_uploaded
            db.commit()

        # Session finished
        if not _station_stop_event.is_set():
            if failed_count > 0 and uploaded_count == 0:
                run.overall_status = "failed"
            elif failed_count > 0:
                run.overall_status = "partial_failure"
            else:
                run.overall_status = "completed"
            run.end_time = datetime.datetime.now(datetime.timezone.utc)
            db.commit()

            _broadcast("upload_station_completed", {
                "run_id": run_id,
                "status": run.overall_status,
                "total_files": total_files,
                "uploaded_files": uploaded_count,
                "failed_files": failed_count,
                "skipped_files": skipped_count,
                "total_bytes": total_bytes,
                "uploaded_bytes": cum_bytes_uploaded,
            })

    except Exception as e:
        print(f"[upload_station] run error: {e}")
        run.overall_status = "failed"
        run.end_time = datetime.datetime.now(datetime.timezone.utc)
        db.commit()
        _broadcast("upload_station_completed", {
            "run_id": run_id,
            "status": "failed",
            "error": str(e),
        })
    finally:
        db.close()
        with _station_lock:
            _is_processing = False
