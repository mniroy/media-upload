"""
download_station_handler.py
===========================
Handles the Download Station workflow:
  1. In-page browser (noVNC + native Chrome) integration with session persistence.
  2. Automated directory watcher on /mnt/external_drive/Downloads.
  3. Automatic streaming cloud upload to Google Photos upon download completion.
  4. Real-time telemetry (speed, progress, active file) via WebSocket events.
  5. Persistent SQLite logging (DownloadStationRun and DownloadStationFile).
"""

import os
import re
import time
import datetime
import threading
import subprocess
import urllib.request
import urllib.parse
import urllib.error
from typing import List, Optional, Tuple, Dict
from pathlib import Path
from src.database import SessionLocal, DownloadStationRun, DownloadStationFile, Setting, register_uploaded_media, is_media_already_uploaded

# ---------------------------------------------------------------------------
# Storage & Directories
# ---------------------------------------------------------------------------

PRIMARY_LOCAL_STAGING = "/var/lib/media_upload/download_staging"
FALLBACK_LOCAL_STAGING = "/tmp/media_upload_download_staging"

def get_download_dest_dir() -> str:
    """
    Returns the target destination directory on the external drive (e.g. /mnt/external_drive/Downloads).
    Falls back to local staging if the external drive is unmounted or unwritable.
    """
    ext_path = "/mnt/external_drive"
    try:
        db = SessionLocal()
        s = db.query(Setting).filter(Setting.key == "EXT_DRIVE_PATH").first()
        if s and s.value and s.value.strip():
            ext_path = s.value.strip()
        db.close()
    except Exception:
        pass

    target_downloads = os.path.join(ext_path, "Downloads")
    try:
        os.makedirs(target_downloads, exist_ok=True)
        test_file = os.path.join(target_downloads, ".perm_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
        return target_downloads
    except Exception:
        pass

    try:
        os.makedirs(PRIMARY_LOCAL_STAGING, exist_ok=True)
        test_file = os.path.join(PRIMARY_LOCAL_STAGING, ".perm_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
        return PRIMARY_LOCAL_STAGING
    except Exception:
        os.makedirs(FALLBACK_LOCAL_STAGING, exist_ok=True)
        return FALLBACK_LOCAL_STAGING

# ---------------------------------------------------------------------------
# Control events & state
# ---------------------------------------------------------------------------

_download_stop_event = threading.Event()
_download_pause_event = threading.Event()
_download_lock = threading.Lock()
_is_processing = False

def download_station_stop():
    _download_stop_event.set()

def download_station_pause():
    _download_pause_event.set()

def download_station_resume():
    _download_stop_event.clear()
    _download_pause_event.clear()

def is_download_station_active() -> bool:
    return _is_processing

def _broadcast(event: str, data: dict):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"[download_station] broadcast error: {e}")

# ---------------------------------------------------------------------------
# Browser Control Helpers
# ---------------------------------------------------------------------------

def browser_navigate_url(target_url: str) -> dict:
    url = target_url.strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url
    try:
        # Send URL to the running Chrome instance on DISPLAY=:99
        cmd = [
            "sudo", "-u", "mniroy", "env", "DISPLAY=:99",
            "google-chrome",
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--user-data-dir=/var/lib/media_upload/chrome_profile",
            url
        ]
        subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return {"status": "success", "url": url}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def browser_restart_service() -> dict:
    try:
        subprocess.run(["sudo", "systemctl", "restart", "download-browser.service"], check=True)
        return {"status": "success", "message": "Browser service restarted"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

def browser_get_status() -> dict:
    try:
        res = subprocess.run(["systemctl", "is-active", "download-browser.service"], capture_output=True, text=True)
        is_active = res.stdout.strip() == "active"
        return {"active": is_active, "status": res.stdout.strip()}
    except Exception as e:
        return {"active": False, "error": str(e)}

# ---------------------------------------------------------------------------
# Download Folder Watcher & Auto-Uploader
# ---------------------------------------------------------------------------

_watcher_thread: Optional[threading.Thread] = None
_watcher_running = False
_file_stability_map: Dict[str, Tuple[int, float, int]] = {} # path -> (last_size, last_mtime, stable_checks)
_active_uploads = set()
_active_uploads_lock = threading.Lock()

TEMP_EXTENSIONS = (
    ".crdownload", ".tmp", ".part", ".download", ".aria2", ".!ut", ".opdownload"
)

def start_download_folder_watcher():
    """Starts the background directory watcher if not already running."""
    global _watcher_thread, _watcher_running
    if _watcher_running and _watcher_thread and _watcher_thread.is_alive():
        return
    _watcher_running = True
    _watcher_thread = threading.Thread(target=_folder_watcher_loop, daemon=True, name="DownloadStationWatcher")
    _watcher_thread.start()
    print("[download_station] Background download folder watcher started.")

def _folder_watcher_loop():
    while _watcher_running:
        try:
            download_dir = get_download_dest_dir()
            if os.path.exists(download_dir):
                _scan_and_process_downloads(download_dir)
        except Exception as e:
            print(f"[download_station_watcher] loop error: {e}")
        time.sleep(3)

def _scan_and_process_downloads(folder_path: str):
    global _file_stability_map
    now = time.time()

    try:
        entries = os.listdir(folder_path)
    except Exception:
        return

    for entry in entries:
        if entry.startswith("."):
            continue
        full_path = os.path.join(folder_path, entry)
        if not os.path.isfile(full_path):
            continue

        lower_name = entry.lower()
        if any(lower_name.endswith(ext) for ext in TEMP_EXTENSIONS):
            # Incomplete download in progress -> reset tracking
            if full_path in _file_stability_map:
                del _file_stability_map[full_path]
            continue

        try:
            stat = os.stat(full_path)
            cur_size = stat.st_size
            cur_mtime = stat.st_mtime
        except Exception:
            continue

        if cur_size == 0:
            continue

        with _active_uploads_lock:
            if full_path in _active_uploads:
                continue

        # Check file stability (size and mtime stable across 2 checks >= 3 seconds)
        if full_path in _file_stability_map:
            prev_size, prev_mtime, checks = _file_stability_map[full_path]
            if prev_size == cur_size and prev_mtime == cur_mtime:
                checks += 1
                _file_stability_map[full_path] = (cur_size, cur_mtime, checks)
                if checks >= 2:
                    # File is complete! Start background upload pipeline
                    with _active_uploads_lock:
                        _active_uploads.add(full_path)
                    del _file_stability_map[full_path]
                    threading.Thread(
                        target=_process_completed_downloaded_file,
                        args=(full_path, cur_size),
                        daemon=True
                    ).start()
            else:
                _file_stability_map[full_path] = (cur_size, cur_mtime, 0)
        else:
            _file_stability_map[full_path] = (cur_size, cur_mtime, 0)

def _process_completed_downloaded_file(filepath: str, filesize: int):
    filename = os.path.basename(filepath)
    db = SessionLocal()
    try:
        # Check if already processed in database
        existing = db.query(DownloadStationFile).filter(
            DownloadStationFile.local_filepath == filepath,
            DownloadStationFile.upload_status.in_(["uploaded", "completed", "already_in_photos", "skipped"])
        ).first()

        if existing:
            return

        if is_media_already_uploaded(db, filename=filename, filepath=filepath, filesize=filesize):
            print(f"[download_station] File {filename} already in cloud database. Skipping.")
            return

        print(f"[download_station] New completed download detected: {filename} ({filesize} bytes). Starting auto-upload.")

        # Create or reuse an active run
        run = db.query(DownloadStationRun).filter(
            DownloadStationRun.source == "browser_download",
            DownloadStationRun.overall_status.in_(["in_progress", "uploading"])
        ).order_by(DownloadStationRun.id.desc()).first()

        if not run:
            run = DownloadStationRun(
                source="browser_download",
                source_url=f"file://{filepath}",
                total_files=1,
                downloaded_files=1,
                overall_status="uploading",
                start_time=datetime.datetime.now(datetime.timezone.utc),
                downloaded_bytes=filesize,
            )
            db.add(run)
            db.commit()
            db.refresh(run)
        else:
            run.total_files = (run.total_files or 0) + 1
            run.downloaded_files = (run.downloaded_files or 0) + 1
            run.downloaded_bytes = (run.downloaded_bytes or 0) + filesize
            db.commit()

        # Create file record
        file_rec = DownloadStationFile(
            run_id=run.id,
            filename=filename,
            source_url=f"file://{filepath}",
            local_filepath=filepath,
            file_size_bytes=filesize,
            download_status="completed",
            upload_status="uploading"
        )
        db.add(file_rec)
        db.commit()
        db.refresh(file_rec)

        _broadcast("download_station_file_started", {
            "run_id": run.id,
            "file_id": file_rec.id,
            "filename": filename,
            "phase": "upload",
            "filesize": filesize,
            "source": "browser"
        })

        # Upload via uploader module
        from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED

        last_report = [0.0]
        def progress_cb(sent_bytes, total_bytes):
            now_t = time.time()
            if now_t - last_report[0] > 0.4 or sent_bytes >= total_bytes:
                last_report[0] = now_t
                pct = int((sent_bytes / max(1, total_bytes)) * 100)
                _broadcast("download_station_upload_progress", {
                    "run_id": run.id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "sent_bytes": sent_bytes,
                    "total_bytes": total_bytes,
                    "percent": pct
                })

        up_status, up_msg, duration = upload_file(filepath, on_progress=progress_cb, source_station="download_station")

        if up_status == UPLOAD_NEW:
            file_rec.upload_status = "completed"
            run.uploaded_files = (run.uploaded_files or 0) + 1
            run.uploaded_bytes = (run.uploaded_bytes or 0) + filesize
            _broadcast("download_station_file_completed", {
                "run_id": run.id,
                "file_id": file_rec.id,
                "filename": filename,
                "status": "uploaded",
                "filesize": filesize
            })
        elif up_status in (UPLOAD_DUPLICATE, UPLOAD_SKIPPED):
            file_rec.upload_status = "skipped" if up_status == UPLOAD_SKIPPED else "duplicate"
            run.skipped_files = (run.skipped_files or 0) + 1
            _broadcast("download_station_file_completed", {
                "run_id": run.id,
                "file_id": file_rec.id,
                "filename": filename,
                "status": file_rec.upload_status,
                "filesize": filesize
            })
        else:
            file_rec.upload_status = "failed"
            file_rec.error_message = up_msg
            run.failed_files = (run.failed_files or 0) + 1
            _broadcast("download_station_file_failed", {
                "run_id": run.id,
                "file_id": file_rec.id,
                "filename": filename,
                "phase": "upload",
                "error": up_msg
            })

        db.commit()

    except Exception as e:
        print(f"[download_station] auto-upload error for {filepath}: {e}")
    finally:
        with _active_uploads_lock:
            _active_uploads.discard(filepath)
        db.close()

# ---------------------------------------------------------------------------
# Direct URL Ingestion & Google Drive Resolution
# ---------------------------------------------------------------------------

GOOGLE_DRIVE_ID_PATTERNS = [
    r"drive\.google\.com/file/d/([a-zA-Z0-9_-]+)",
    r"drive\.google\.com/open\?id=([a-zA-Z0-9_-]+)",
    r"drive\.google\.com/uc\?.*id=([a-zA-Z0-9_-]+)",
    r"docs\.google\.com/file/d/([a-zA-Z0-9_-]+)",
]

def resolve_download_url(raw_url: str) -> Tuple[str, Optional[str]]:
    """
    Transforms URLs into direct download streams.
    Extracts Google Drive file IDs and converts them to direct download URLs.
    """
    url = raw_url.strip()
    if not url.startswith("http://") and not url.startswith("https://"):
        url = "https://" + url

    for pattern in GOOGLE_DRIVE_ID_PATTERNS:
        match = re.search(pattern, url)
        if match:
            file_id = match.group(1)
            direct_url = f"https://drive.google.com/uc?export=download&id={file_id}&confirm=t"
            return direct_url, f"gdrive_{file_id}"

    return url, None

def extract_filename_from_headers_or_url(url: str, headers) -> str:
    cd = headers.get("Content-Disposition", "")
    if cd:
        match = re.search(r'filename\*?=(?:UTF-8\'\')?["\']?([^"\';\r\n]+)["\']?', cd, re.IGNORECASE)
        if match:
            fn = urllib.parse.unquote(match.group(1).strip())
            if fn:
                return os.path.basename(fn)

    parsed = urllib.parse.urlparse(url)
    base = os.path.basename(parsed.path)
    if base and "." in base:
        return urllib.parse.unquote(base)

    return f"media_download_{int(time.time())}.bin"

# ---------------------------------------------------------------------------
# Direct Queue Worker Pipeline
# ---------------------------------------------------------------------------

def process_download_station_queue(items: List[dict], source_url: Optional[str] = None, source_run_id: Optional[int] = None):
    """
    Background worker that downloads items directly to external drive,
    then automatically streams them to Google Photos.
    """
    global _is_processing
    with _download_lock:
        if _is_processing:
            print("[download_station] Processing already in progress.")
            return
        _is_processing = True

    _download_stop_event.clear()
    _download_pause_event.clear()

    db = SessionLocal()
    run = None
    try:
        total_items = len(items)
        if source_run_id:
            run = db.query(DownloadStationRun).filter(DownloadStationRun.id == source_run_id).first()

        if not run:
            run = DownloadStationRun(
                source="url_ingest" if source_url else "direct_queue",
                source_url=source_url,
                total_files=total_items,
                downloaded_files=0,
                uploaded_files=0,
                failed_files=0,
                skipped_files=0,
                overall_status="in_progress",
                start_time=datetime.datetime.now(datetime.timezone.utc),
            )
            db.add(run)
            db.commit()
            db.refresh(run)

        run_id = run.id
        dest_dir = get_download_dest_dir()
        os.makedirs(dest_dir, exist_ok=True)

        _broadcast("download_station_started", {
            "run_id": run_id,
            "total_files": total_items,
            "dest_dir": dest_dir,
            "source_url": source_url
        })

        downloaded_count = 0
        uploaded_count = 0
        failed_count = 0
        skipped_count = 0
        cum_bytes_downloaded = 0
        cum_bytes_uploaded = 0

        for idx, item in enumerate(items):
            if _download_stop_event.is_set():
                break

            while _download_pause_event.is_set():
                if _download_stop_event.is_set():
                    break
                time.sleep(0.5)

            raw_url = item.get("url", "").strip()
            custom_fn = item.get("filename", "").strip()
            if not raw_url:
                continue

            dl_url, suggested_fn = resolve_download_url(raw_url)
            filename = custom_fn or suggested_fn or f"download_{idx+1}_{int(time.time())}"

            file_rec = DownloadStationFile(
                run_id=run_id,
                filename=filename,
                source_url=raw_url,
                download_status="pending",
                upload_status="pending"
            )
            db.add(file_rec)
            db.commit()
            db.refresh(file_rec)

            _broadcast("download_station_file_started", {
                "run_id": run_id,
                "file_id": file_rec.id,
                "filename": filename,
                "phase": "download",
                "url": raw_url
            })

            # Download phase
            target_path = os.path.join(dest_dir, filename)
            dl_success = False
            file_size = 0

            try:
                file_rec.download_status = "downloading"
                db.commit()

                req = urllib.request.Request(dl_url, headers={
                    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
                    "Accept": "*/*"
                })

                with urllib.request.urlopen(req, timeout=30) as resp:
                    headers = resp.headers
                    if not custom_fn:
                        resolved_fn = extract_filename_from_headers_or_url(dl_url, headers)
                        if resolved_fn and resolved_fn != filename:
                            filename = resolved_fn
                            target_path = os.path.join(dest_dir, filename)
                            file_rec.filename = filename

                    total_len = int(headers.get("Content-Length", 0))
                    downloaded_bytes = 0
                    start_time = time.time()
                    last_speed_check = start_time
                    bytes_since_check = 0

                    with open(target_path, "wb") as f:
                        while True:
                            if _download_stop_event.is_set():
                                break
                            while _download_pause_event.is_set():
                                if _download_stop_event.is_set():
                                    break
                                time.sleep(0.5)

                            chunk = resp.read(65536) # 64KB chunk
                            if not chunk:
                                break
                            f.write(chunk)
                            chunk_len = len(chunk)
                            downloaded_bytes += chunk_len
                            bytes_since_check += chunk_len

                            now_t = time.time()
                            if now_t - last_speed_check >= 0.4:
                                dt = now_t - last_speed_check
                                speed_bps = bytes_since_check / max(dt, 0.001)
                                pct = int((downloaded_bytes / max(1, total_len)) * 100) if total_len > 0 else 0
                                _broadcast("download_station_download_progress", {
                                    "run_id": run_id,
                                    "file_id": file_rec.id,
                                    "filename": filename,
                                    "downloaded_bytes": downloaded_bytes,
                                    "total_bytes": total_len,
                                    "speed_bps": speed_bps,
                                    "percent": pct
                                })
                                last_speed_check = now_t
                                bytes_since_check = 0

                    if not _download_stop_event.is_set():
                        dl_success = True
                        file_size = downloaded_bytes
                        file_rec.file_size_bytes = file_size
                        file_rec.local_filepath = target_path
                        file_rec.download_status = "completed"
                        downloaded_count += 1
                        cum_bytes_downloaded += file_size
                        db.commit()

            except Exception as e:
                file_rec.download_status = "failed"
                file_rec.error_message = str(e)
                failed_count += 1
                db.commit()
                _broadcast("download_station_file_failed", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "phase": "download",
                    "error": str(e)
                })
                continue

            if not dl_success:
                continue

            # Upload phase
            file_rec.upload_status = "uploading"
            db.commit()

            _broadcast("download_station_file_started", {
                "run_id": run_id,
                "file_id": file_rec.id,
                "filename": filename,
                "phase": "upload",
                "filesize": file_size
            })

            from src.uploader import upload_file, UPLOAD_NEW, UPLOAD_DUPLICATE, UPLOAD_SKIPPED

            last_up_report = [0.0]
            def upload_progress(sent_bytes, total_bytes):
                now_t = time.time()
                if now_t - last_up_report[0] > 0.4 or sent_bytes >= total_bytes:
                    last_up_report[0] = now_t
                    pct = int((sent_bytes / max(1, total_bytes)) * 100)
                    _broadcast("download_station_upload_progress", {
                        "run_id": run_id,
                        "file_id": file_rec.id,
                        "filename": filename,
                        "sent_bytes": sent_bytes,
                        "total_bytes": total_bytes,
                        "percent": pct
                    })

            up_status, up_msg, duration = upload_file(target_path, on_progress=upload_progress, source_station="download_station")

            if up_status == UPLOAD_NEW:
                file_rec.upload_status = "completed"
                uploaded_count += 1
                cum_bytes_uploaded += file_size
                _broadcast("download_station_file_completed", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": "uploaded",
                    "filesize": file_size
                })
            elif up_status in (UPLOAD_DUPLICATE, UPLOAD_SKIPPED):
                file_rec.upload_status = "skipped" if up_status == UPLOAD_SKIPPED else "duplicate"
                skipped_count += 1
                _broadcast("download_station_file_completed", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "status": file_rec.upload_status,
                    "filesize": file_size
                })
            else:
                file_rec.upload_status = "failed"
                file_rec.error_message = up_msg
                failed_count += 1
                _broadcast("download_station_file_failed", {
                    "run_id": run_id,
                    "file_id": file_rec.id,
                    "filename": filename,
                    "phase": "upload",
                    "error": up_msg
                })

            db.commit()

            run.downloaded_files = downloaded_count
            run.uploaded_files = uploaded_count
            run.failed_files = failed_count
            run.skipped_files = skipped_count
            run.downloaded_bytes = cum_bytes_downloaded
            run.uploaded_bytes = cum_bytes_uploaded
            db.commit()

        # Session completion
        if not _download_stop_event.is_set():
            if failed_count > 0 and uploaded_count == 0:
                run.overall_status = "failed"
            elif failed_count > 0:
                run.overall_status = "partial_failure"
            else:
                run.overall_status = "completed"
            run.end_time = datetime.datetime.now(datetime.timezone.utc)
            db.commit()

            _broadcast("download_station_completed", {
                "run_id": run_id,
                "status": run.overall_status,
                "total_files": total_items,
                "downloaded_files": downloaded_count,
                "uploaded_files": uploaded_count,
                "failed_files": failed_count,
                "skipped_files": skipped_count,
                "downloaded_bytes": cum_bytes_downloaded,
                "uploaded_bytes": cum_bytes_uploaded,
            })

    except Exception as e:
        print(f"[download_station] queue processing error: {e}")
        if run:
            run.overall_status = "failed"
            run.end_time = datetime.datetime.now(datetime.timezone.utc)
            db.commit()
            _broadcast("download_station_completed", {
                "run_id": run_id,
                "status": "failed",
                "error": str(e)
            })
    finally:
        db.close()
        with _download_lock:
            _is_processing = False

# ---------------------------------------------------------------------------
# In-Page Web Browser Proxy Engine (Legacy fallback)
# ---------------------------------------------------------------------------

def fetch_proxied_web_resource(target_url: str, incoming_headers: dict = None) -> Tuple[bytes, int, Dict[str, str]]:
    if not target_url.startswith("http://") and not target_url.startswith("https://"):
        target_url = "https://" + target_url

    req = urllib.request.Request(target_url)
    req.add_header("User-Agent", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
    req.add_header("Accept-Language", "en-US,en;q=0.9")

    if incoming_headers:
        if "cookie" in incoming_headers:
            req.add_header("Cookie", incoming_headers["cookie"])
        if "accept" in incoming_headers:
            req.add_header("Accept", incoming_headers["accept"])

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            content = resp.read()
            status_code = resp.status
            raw_headers = dict(resp.headers)

            out_headers = {}
            for k, v in raw_headers.items():
                k_lower = k.lower()
                if k_lower in ("x-frame-options", "content-security-policy", "content-security-policy-report-only", "strict-transport-security"):
                    continue
                out_headers[k] = v

            out_headers["Access-Control-Allow-Origin"] = "*"
            return content, status_code, out_headers
    except urllib.error.HTTPError as e:
        return e.read(), e.code, {"Content-Type": "text/html"}
    except Exception as e:
        error_html = f"<html><body><h3>Could not load {target_url}: {e}</h3></body></html>"
        return error_html.encode("utf-8"), 502, {"Content-Type": "text/html"}
