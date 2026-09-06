import os
import time
import asyncio
import datetime
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, BackgroundTasks, File, UploadFile, Form, Request, Response, Body
from fastapi.staticfiles import StaticFiles
from fastapi.websockets import WebSocketDisconnect
from fastapi.responses import RedirectResponse, FileResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
from src.database import (
    SessionLocal, Run, FileRecord, Setting, encrypt_val, decrypt_val,
    UploadStationRun, UploadStationFile,
    DownloadStationRun, DownloadStationFile
)
from src.usb_handler import (
    process_usb, process_local_directory, upload_selected_folders,
    get_staged_folders, get_device_info, get_mount_status, unmount_device,
    copy_stop, copy_resume, copy_pause, upload_stop, upload_resume,
    MOUNT_BASE
)
from src.ext_drive_handler import (
    get_ext_drive_path, get_ext_drive_status, scan_top_level_folders, start_ext_drive_upload,
    ext_stop, ext_pause, ext_resume, reupload_failed_files,
)
from src.upload_station_handler import (
    upload_station_stop, upload_station_pause, upload_station_resume,
    process_upload_station_queue, get_upload_staging_dir, is_upload_station_active
)
from src.download_station_handler import (
    download_station_stop, download_station_pause, download_station_resume,
    process_download_station_queue, get_download_dest_dir, is_download_station_active,
    fetch_proxied_web_resource, start_download_folder_watcher,
    browser_navigate_url, browser_restart_service, browser_get_status
)

main_loop = None

# ---------------------------------------------------------------------------
# Live state — persists between client connections so any new browser
# that opens (or refreshes) immediately sees the current process state.
# ---------------------------------------------------------------------------
_live_state = {
    "phase": "idle",          # idle | copying | copy_paused | copy_done_select | uploading | upload_paused | completed | failed
    "device": None,           # USB device name or "local_disk"
    "run_id": None,
    "current_file": None,
    "copy_current": 0,
    "copy_total": 0,
    "upload_current": 0,
    "upload_total": 0,
    "speed_mbps": None,
    "usb_info": None,         # {total, used, free, mounted, mount_point}
    "folders": [],            # folder list pending selection after copy
    "auto_upload_seconds": 30,
    "error": None,
    "auto_copy_enabled": True,
    # --- External Drive (separate workflow) ---
    "ext_phase": "idle",       # idle | scanning | uploading | upload_paused | completed | failed | stopped
    "ext_run_id": None,
    "ext_current_file": None,
    "ext_upload_current": 0,
    "ext_upload_total": 0,
    "ext_speed_mbps": None,
    "ext_error": None,
    # --- Upload Station (Drag & Drop web upload) ---
    "upload_station_phase": "idle",       # idle | uploading | paused | completed | failed | stopped
    "upload_station_run_id": None,
    "upload_station_current_file": None,
    "upload_station_current": 0,
    "upload_station_total": 0,
    "upload_station_uploaded": 0,
    "upload_station_failed": 0,
    "upload_station_skipped": 0,
    "upload_station_bytes_done": 0,
    "upload_station_bytes_total": 0,
    "upload_station_speed_mbps": None,
    "upload_station_error": None,
    # --- Download Station (In-page Browser & Web Media Ingestion) ---
    "download_station_phase": "idle",     # idle | downloading | uploading | paused | completed | failed | stopped
    "download_station_subphase": "idle",  # downloading | uploading
    "download_station_run_id": None,
    "download_station_current_file": None,
    "download_station_current": 0,
    "download_station_total": 0,
    "download_station_downloaded": 0,
    "download_station_uploaded": 0,
    "download_station_failed": 0,
    "download_station_skipped": 0,
    "download_station_bytes_done": 0,
    "download_station_bytes_total": 0,
    "download_station_speed_mbps": None,
    "download_station_dest_dir": "/mnt/external_drive/Downloads",
    "download_station_error": None,
    # --- Live System Network Throughput ---
    "net_rx_mb_s": 0.0,        # Download MB/s
    "net_tx_mb_s": 0.0,        # Upload MB/s
}

class NetworkMonitor:
    def __init__(self):
        self.last_time = time.time()
        self.last_rx, self.last_tx = self._read_bytes()

    def _read_bytes(self):
        rx, tx = 0, 0
        try:
            with open("/proc/net/dev", "r") as f:
                lines = f.readlines()[2:]
            for line in lines:
                parts = line.strip().split()
                if not parts:
                    continue
                iface = parts[0].rstrip(":")
                if iface == "lo" or iface.startswith("docker") or iface.startswith("veth") or iface.startswith("br-"):
                    continue
                rx += int(parts[1])
                tx += int(parts[9])
        except Exception:
            pass
        return rx, tx

    def get_speed(self):
        now = time.time()
        rx, tx = self._read_bytes()
        dt = max(now - self.last_time, 0.001)
        rx_speed = max(0.0, (rx - self.last_rx) / dt / (1024 * 1024))
        tx_speed = max(0.0, (tx - self.last_tx) / dt / (1024 * 1024))
        self.last_time = now
        self.last_rx = rx
        self.last_tx = tx
        return rx_speed, tx_speed

net_monitor = NetworkMonitor()

@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    global main_loop
    main_loop = asyncio.get_running_loop()
    
    # Init auto_copy_enabled from DB
    db = SessionLocal()
    setting = db.query(Setting).filter(Setting.key == "AUTO_COPY_ENABLED").first()
    _live_state["auto_copy_enabled"] = setting.value != "false" if setting else True
    db.close()
    
    # Clean up any ext drive, upload station & download station sessions left as "running" from a previous
    # service crash or restart — they will never complete now.
    db2 = SessionLocal()
    from src.database import ExtDriveRun as _EDR, UploadStationRun as _USR, DownloadStationRun as _DSR
    import datetime as _dt
    stale = db2.query(_EDR).filter(_EDR.overall_status == "running").all()
    for s in stale:
        s.overall_status = "interrupted"
        s.end_time = _dt.datetime.now(_dt.timezone.utc)
    stale_upload = db2.query(_USR).filter(_USR.overall_status == "running").all()
    for su in stale_upload:
        su.overall_status = "interrupted"
        su.end_time = _dt.datetime.now(_dt.timezone.utc)
    stale_download = db2.query(_DSR).filter(_DSR.overall_status == "running").all()
    for sd in stale_download:
        sd.overall_status = "interrupted"
        sd.end_time = _dt.datetime.now(_dt.timezone.utc)
    if stale or stale_upload or stale_download:
        db2.commit()
        print(f"[startup] Marked {len(stale)} stale ext drive, {len(stale_upload)} stale upload station & {len(stale_download)} stale download station session(s) as 'interrupted'")
    # Start background download folder auto-uploader watcher
    start_download_folder_watcher()

    # Background real-time network throughput sampler (1s interval)
    async def _net_stats_loop():
        while True:
            try:
                await asyncio.sleep(1.0)
                rx, tx = net_monitor.get_speed()
                _live_state["net_rx_mb_s"] = round(rx, 2)
                _live_state["net_tx_mb_s"] = round(tx, 2)
                if active_websockets:
                    await broadcast_event("net_speed", {
                        "rx_mb_s": _live_state["net_rx_mb_s"],
                        "tx_mb_s": _live_state["net_tx_mb_s"],
                    })
            except asyncio.CancelledError:
                break
            except Exception as e:
                pass

    net_task = asyncio.create_task(_net_stats_loop())

    yield

    net_task.cancel()

app = FastAPI(lifespan=lifespan)

# Redirect root to the main UI
@app.api_route("/", methods=["GET", "HEAD"])
def root():
    return RedirectResponse(url="/static/index.html")

@app.api_route("/favicon.ico", methods=["GET", "HEAD"], include_in_schema=False)
def favicon():
    return FileResponse("static/favicon.ico")

@app.api_route("/apple-touch-icon.png", methods=["GET", "HEAD"], include_in_schema=False)
def apple_touch_icon():
    return FileResponse("static/apple-touch-icon.png")

@app.api_route("/manifest.json", methods=["GET", "HEAD"], include_in_schema=False)
def manifest():
    return FileResponse("static/manifest.json", media_type="application/manifest+json")

@app.api_route("/sw.js", methods=["GET", "HEAD"], include_in_schema=False)
def service_worker():
    return FileResponse("static/sw.js", media_type="application/javascript", headers={"Service-Worker-Allowed": "/"})

app.mount("/static", StaticFiles(directory="static"), name="static")

# NOTE: /novnc static files mount is intentionally registered AFTER all websocket routes
# at the bottom of this file. This ensures Starlette's route matcher sees the explicit
# @app.websocket("/novnc/websockify") route before the StaticFiles sub-app intercepts it.
NOVNC_DIR = "/usr/share/novnc"

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class UsbEvent(BaseModel):
    action: str
    device: str

class SettingsPayload(BaseModel):
    settings: Dict[str, str]

class UploadSelectedPayload(BaseModel):
    run_id: int
    folders: List[str]

class DownloadStationDownloadPayload(BaseModel):
    urls: Optional[List[str]] = None
    url: Optional[str] = None
    filename: Optional[str] = None

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

@app.post("/api/settings")
def save_settings(payload: SettingsPayload):
    db = SessionLocal()
    for k, v in payload.settings.items():
        val_to_store = encrypt_val(v) if k == "GP_AUTH_DATA" else v
        setting = db.query(Setting).filter(Setting.key == k).first()
        if setting:
            setting.value = val_to_store
        else:
            db.add(Setting(key=k, value=val_to_store))
    db.commit()
    db.close()
    return {"status": "saved"}

@app.get("/api/settings")
def get_settings():
    db = SessionLocal()
    settings = db.query(Setting).all()
    db.close()
    result = {}
    for s in settings:
        result[s.key] = decrypt_val(s.value) if s.key == "GP_AUTH_DATA" else s.value
    return result

# ---------------------------------------------------------------------------
# USB Events
# ---------------------------------------------------------------------------

@app.post("/api/usb_event")
async def handle_usb_event(event: UsbEvent, background_tasks: BackgroundTasks):
    import subprocess
    device_path = f"/dev/{event.device}"
    is_ext_drive = False

    try:
        res = subprocess.run(["lsblk", "-no", "UUID", device_path], capture_output=True, text=True, timeout=5)
        uuid = res.stdout.strip()
        if uuid:
            try:
                with open("/etc/fstab", "r") as f:
                    fstab = f.read()
                if uuid in fstab and "external_drive" in fstab:
                    is_ext_drive = True
            except Exception:
                pass
            if not is_ext_drive and uuid == "6A4B-B5F8":
                is_ext_drive = True
    except Exception:
        pass

    if is_ext_drive:
        ext_path = get_ext_drive_path()
        if event.action == "add":
            try:
                subprocess.run(["mount", ext_path], capture_output=True, timeout=10)
            except Exception:
                pass
        status = get_ext_drive_status()
        trigger_broadcast("ext_drive_status", status)
        return {"status": "ext_drive_event_handled", "device": event.device, "action": event.action}

    db = SessionLocal()
    setting = db.query(Setting).filter(Setting.key == "AUTO_COPY_ENABLED").first()
    is_enabled = setting.value != "false" if setting else True
    db.close()

    if is_enabled and event.action == "add":
        background_tasks.add_task(process_usb, event.device)
    return {"status": "received", "ignored": not is_enabled}

# ---------------------------------------------------------------------------
# USB Device Info
# ---------------------------------------------------------------------------

@app.get("/api/usb/{device}/info")
def usb_info(device: str):
    return get_device_info(device)

@app.get("/api/usb/{device}/status")
def usb_status(device: str):
    return get_mount_status(device)

@app.post("/api/usb/{device}/unmount")
def usb_unmount(device: str):
    import os
    mount_point = os.path.join(MOUNT_BASE, device)
    status = get_mount_status(device)
    mp = status.get("mount_point") or mount_point
    unmount_device(mp)
    return {"status": "unmounted", "mount_point": mp}

# ---------------------------------------------------------------------------
# Copy control
# ---------------------------------------------------------------------------

@app.post("/api/copy/stop")
def api_copy_stop():
    copy_stop()
    return {"status": "copy_stopped"}

@app.post("/api/copy/pause")
def api_copy_pause():
    copy_pause()
    return {"status": "copy_paused"}

@app.post("/api/copy/resume")
def api_copy_resume():
    copy_resume()
    return {"status": "copy_resumed"}

# ---------------------------------------------------------------------------
# Upload control
# ---------------------------------------------------------------------------

@app.post("/api/upload/stop")
def api_upload_stop():
    upload_stop()
    return {"status": "upload_stopped"}

@app.post("/api/upload/resume")
def api_upload_resume():
    upload_resume()
    return {"status": "upload_resumed"}

# ---------------------------------------------------------------------------
# Local upload trigger (manual "Upload Staged Files" button)
# ---------------------------------------------------------------------------

class TriggerLocalUploadPayload(BaseModel):
    folder: Optional[str] = None

@app.post("/api/trigger_local_upload")
async def trigger_local_upload(background_tasks: BackgroundTasks, payload: TriggerLocalUploadPayload = TriggerLocalUploadPayload()):
    import os
    folder_path = os.path.join("/var/lib/media_upload/staging", payload.folder) if payload.folder else None
    background_tasks.add_task(process_local_directory, folder_path)
    return {"status": "started", "folder": payload.folder}

@app.get("/api/staging/folders")
def get_staging_folders():
    """List top-level directories in the staging dir with size/count info."""
    from src.usb_handler import _list_session_folders, STAGING_DIR
    return _list_session_folders(STAGING_DIR)

# ---------------------------------------------------------------------------
# Upload selected folders after USB copy
# ---------------------------------------------------------------------------

@app.get("/api/runs/{run_id}/folders")
def get_run_folders(run_id: int):
    return get_staged_folders(run_id)

@app.post("/api/upload_selected")
async def api_upload_selected(payload: UploadSelectedPayload, background_tasks: BackgroundTasks):
    background_tasks.add_task(upload_selected_folders, payload.run_id, payload.folders)
    return {"status": "started", "run_id": payload.run_id, "folders": payload.folders}

# ---------------------------------------------------------------------------
# Runs / History
# ---------------------------------------------------------------------------

@app.get("/api/runs")
def get_runs():
    db = SessionLocal()
    runs = db.query(Run).order_by(Run.id.desc()).all()

    result = []
    for run in runs:
        total_files = db.query(FileRecord).filter(FileRecord.run_id == run.id).count()
        copied_files = db.query(FileRecord).filter(
            FileRecord.run_id == run.id, FileRecord.copy_status == "success").count()
        uploaded_files = db.query(FileRecord).filter(
            FileRecord.run_id == run.id, FileRecord.upload_status == "success").count()

        result.append({
            "id": run.id,
            "usb_identifier": run.usb_identifier,
            "start_time": run.start_time,
            "overall_status": run.overall_status,
            "total_files": total_files,
            "copied_files": copied_files,
            "uploaded_files": uploaded_files
        })

    db.close()
    return result

@app.get("/api/runs/{run_id}")
def get_run_details(run_id: int):
    db = SessionLocal()
    files = db.query(FileRecord).filter(FileRecord.run_id == run_id).all()
    db.close()
    return files

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

@app.get("/api/system/storage")
def get_storage():
    import shutil
    total, used, free = shutil.disk_usage("/var/lib/media_upload")
    return {"total": total, "used": used, "free": free}

@app.get("/api/system/network")
def get_network_speed():
    """Return real-time download and upload speed in MB/s."""
    return {
        "rx_mb_s": _live_state.get("net_rx_mb_s", 0.0),
        "tx_mb_s": _live_state.get("net_tx_mb_s", 0.0)
    }

# ---------------------------------------------------------------------------
# External Drive — completely separate from USB workflow
# ---------------------------------------------------------------------------

@app.get("/api/extdrive/status")
def extdrive_status():
    """Mount status + disk usage of the permanently attached external HDD."""
    return get_ext_drive_status()

@app.get("/api/extdrive/folders")
def extdrive_folders():
    """List top-level folders/files on the external drive (non-recursive, fast)."""
    return scan_top_level_folders()

@app.post("/api/extdrive/upload")
async def extdrive_start_upload(background_tasks: BackgroundTasks):
    """Start a full-drive upload session (streams all media to Google Photos)."""
    if _live_state.get("ext_phase") in ("scanning", "uploading"):
        return {"status": "already_running"}
    background_tasks.add_task(start_ext_drive_upload)
    return {"status": "started"}

@app.post("/api/extdrive/stop")
def extdrive_stop():
    ext_stop()
    return {"status": "stopping"}

@app.post("/api/extdrive/pause")
def extdrive_pause():
    ext_pause()
    return {"status": "paused"}

@app.post("/api/extdrive/resume")
def extdrive_resume_upload():
    ext_resume()
    return {"status": "resumed"}

@app.get("/api/extdrive/runs")
def extdrive_runs():
    """List all past external drive upload sessions."""
    from src.database import ExtDriveRun as EDR
    db = SessionLocal()
    runs = db.query(EDR).order_by(EDR.id.desc()).all()
    result = [
        {
            "id": r.id,
            "start_time": r.start_time,
            "end_time": r.end_time,
            "overall_status": r.overall_status,
            "total_files": r.total_files,
            "uploaded_files": r.uploaded_files,
            "failed_files": r.failed_files,
            "skipped_files": r.skipped_files,
        }
        for r in runs
    ]
    db.close()
    return result

@app.get("/api/extdrive/runs/{run_id}/files")
def extdrive_run_files(run_id: int, status: Optional[str] = None, limit: int = 200, offset: int = 0):
    """Files for an ext drive run, with optional status filter and pagination."""
    from src.database import ExtDriveFile as EDF
    db = SessionLocal()
    q = db.query(EDF).filter(EDF.run_id == run_id)
    if status:
        q = q.filter(EDF.upload_status == status)
    files = q.order_by(EDF.id).offset(offset).limit(limit).all()
    result = [
        {
            "id": f.id,
            "filepath": f.filepath,
            "filename": f.filepath.split("/")[-1] if f.filepath else "",
            "upload_status": f.upload_status,
            "error_message": f.error_message,
        }
        for f in files
    ]
    db.close()
    return result

@app.get("/api/extdrive/live_files")
def extdrive_live_files(limit: int = 150):
    """Return recent files from the current (or most recent) ext drive session for persistence."""
    from src.database import ExtDriveRun as EDR, ExtDriveFile as EDF
    db = SessionLocal()
    run = None
    if _live_state.get("ext_run_id"):
        run = db.query(EDR).filter(EDR.id == _live_state["ext_run_id"]).first()
    if not run:
        run = db.query(EDR).order_by(EDR.id.desc()).first()
    if not run:
        db.close()
        return {"run_id": None, "files": []}

    files = db.query(EDF).filter(
        EDF.run_id == run.id
    ).order_by(EDF.id.desc()).limit(limit).all()

    result = [
        {
            "id": f.id,
            "filepath": f.filepath,
            "filename": f.filepath.split("/")[-1] if f.filepath else "",
            "upload_status": f.upload_status,
            "error_message": f.error_message,
        }
        for f in files
    ]
    db.close()
    return {
        "run_id": run.id,
        "run_status": run.overall_status,
        "files": result
    }

@app.post("/api/extdrive/runs/{run_id}/reupload")
async def extdrive_reupload_failed(run_id: int, background_tasks: BackgroundTasks):
    """Re-upload all failed files from a specific ext drive session."""
    if _live_state.get("ext_phase") in ("scanning", "uploading"):
        return {"status": "already_running"}
    background_tasks.add_task(reupload_failed_files, run_id)
    return {"status": "started", "source_run_id": run_id}

# ---------------------------------------------------------------------------
# Upload Station — Direct Drag & Drop Web Upload
# ---------------------------------------------------------------------------

@app.post("/api/upload_station/upload")
async def upload_station_files(
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...)
):
    """
    Accepts one or more files from the drag-and-drop web interface,
    stages them locally, and starts background streaming upload to Google Photos.
    """
    staging_dir = get_upload_staging_dir()
    file_infos = []

    for file in files:
        safe_name = os.path.basename(file.filename or f"upload_{int(time.time())}")
        dest_path = os.path.join(staging_dir, safe_name)
        if os.path.exists(dest_path):
            name_parts = os.path.splitext(safe_name)
            safe_name = f"{name_parts[0]}_{int(time.time()*1000)}{name_parts[1]}"
            dest_path = os.path.join(staging_dir, safe_name)

        size = 0
        with open(dest_path, "wb") as f_out:
            while chunk := await file.read(1024 * 1024):
                f_out.write(chunk)
                size += len(chunk)

        file_infos.append({
            "filename": file.filename or safe_name,
            "filepath": dest_path,
            "filesize": size
        })

    background_tasks.add_task(process_upload_station_queue, file_infos)

    return {
        "status": "queued",
        "count": len(file_infos),
        "files": [f["filename"] for f in file_infos]
    }

@app.post("/api/upload_station/stop")
def api_upload_station_stop():
    upload_station_stop()
    return {"status": "stopping"}

@app.post("/api/upload_station/pause")
def api_upload_station_pause():
    upload_station_pause()
    return {"status": "paused"}

@app.post("/api/upload_station/resume")
def api_upload_station_resume():
    upload_station_resume()
    return {"status": "resumed"}

@app.get("/api/upload_station/status")
def api_upload_station_status():
    return {
        "phase": _live_state.get("upload_station_phase", "idle"),
        "run_id": _live_state.get("upload_station_run_id"),
        "current_file": _live_state.get("upload_station_current_file"),
        "current": _live_state.get("upload_station_current", 0),
        "total": _live_state.get("upload_station_total", 0),
        "uploaded": _live_state.get("upload_station_uploaded", 0),
        "failed": _live_state.get("upload_station_failed", 0),
        "skipped": _live_state.get("upload_station_skipped", 0),
        "bytes_done": _live_state.get("upload_station_bytes_done", 0),
        "bytes_total": _live_state.get("upload_station_bytes_total", 0),
        "speed_mbps": _live_state.get("upload_station_speed_mbps"),
        "error": _live_state.get("upload_station_error"),
    }

@app.get("/api/upload_station/runs")
def api_upload_station_runs():
    db = SessionLocal()
    runs = db.query(UploadStationRun).order_by(UploadStationRun.id.desc()).all()
    result = [
        {
            "id": r.id,
            "start_time": r.start_time,
            "end_time": r.end_time,
            "overall_status": r.overall_status,
            "total_files": r.total_files,
            "uploaded_files": r.uploaded_files,
            "failed_files": r.failed_files,
            "skipped_files": r.skipped_files,
            "total_bytes": r.total_bytes,
            "uploaded_bytes": r.uploaded_bytes,
        }
        for r in runs
    ]
    db.close()
    return result

@app.get("/api/upload_station/runs/{run_id}/files")
def api_upload_station_run_files(run_id: int, status: Optional[str] = None, limit: int = 200, offset: int = 0):
    db = SessionLocal()
    q = db.query(UploadStationFile).filter(UploadStationFile.run_id == run_id)
    if status:
        q = q.filter(UploadStationFile.upload_status == status)
    files = q.order_by(UploadStationFile.id).offset(offset).limit(limit).all()
    result = [
        {
            "id": f.id,
            "filename": f.filename,
            "filepath": f.filepath,
            "filesize": f.filesize,
            "upload_status": f.upload_status,
            "error_message": f.error_message,
            "duration_seconds": f.duration_seconds,
        }
        for f in files
    ]
    db.close()
    return result

@app.get("/api/upload_station/live_files")
def api_upload_station_live_files(limit: int = 150):
    db = SessionLocal()
    run = None
    if _live_state.get("upload_station_run_id"):
        run = db.query(UploadStationRun).filter(UploadStationRun.id == _live_state["upload_station_run_id"]).first()
    if not run:
        run = db.query(UploadStationRun).order_by(UploadStationRun.id.desc()).first()
    if not run:
        db.close()
        return {"run_id": None, "files": []}

    files = db.query(UploadStationFile).filter(
        UploadStationFile.run_id == run.id
    ).order_by(UploadStationFile.id.desc()).limit(limit).all()

    result = [
        {
            "id": f.id,
            "filename": f.filename,
            "filesize": f.filesize,
            "upload_status": f.upload_status,
            "error_message": f.error_message,
            "duration_seconds": f.duration_seconds,
        }
        for f in files
    ]
    db.close()
    return {
        "run_id": run.id,
        "run_status": run.overall_status,
        "total_files": run.total_files,
        "uploaded_files": run.uploaded_files,
        "failed_files": run.failed_files,
        "files": result
    }

@app.post("/api/upload_station/runs/{run_id}/reupload")
async def api_upload_station_reupload(run_id: int, background_tasks: BackgroundTasks):
    if _live_state.get("upload_station_phase") == "uploading":
        return {"status": "already_running"}
    db = SessionLocal()
    failed = db.query(UploadStationFile).filter(
        UploadStationFile.run_id == run_id,
        UploadStationFile.upload_status == "failed"
    ).all()
    file_infos = []
    for f in failed:
        if f.filepath and os.path.exists(f.filepath):
            file_infos.append({
                "filename": f.filename,
                "filepath": f.filepath,
                "filesize": f.filesize
            })
    db.close()
    if not file_infos:
        return {"status": "no_reuploadable_files", "message": "Original staged files were already processed or cleaned up."}
    background_tasks.add_task(process_upload_station_queue, file_infos, run_id)
    return {"status": "started", "count": len(file_infos)}

# ---------------------------------------------------------------------------
# Download Station — In-Page Web Browser & Cloud Ingestion
# ---------------------------------------------------------------------------

@app.post("/api/download_station/download")
async def api_download_station_download(
    payload: DownloadStationDownloadPayload,
    background_tasks: BackgroundTasks
):
    """
    Queue one or more URLs for download to the external drive,
    followed by automatic streaming upload to Google Photos upon completion.
    """
    items = []
    if payload.urls:
        for u in payload.urls:
            if u and u.strip():
                items.append({"url": u.strip()})
    elif payload.url and payload.url.strip():
        items.append({
            "url": payload.url.strip(),
            "filename": payload.filename
        })

    if not items:
        return {"status": "error", "message": "No valid URLs provided"}

    source_url = items[0]["url"] if len(items) == 1 else f"{len(items)} URLs"
    background_tasks.add_task(process_download_station_queue, items, source_url)

    return {
        "status": "queued",
        "count": len(items),
        "items": items,
        "dest_dir": get_download_dest_dir()
    }

@app.post("/api/download_station/stop")
def api_download_station_stop():
    download_station_stop()
    return {"status": "stopping"}

@app.post("/api/download_station/pause")
def api_download_station_pause():
    download_station_pause()
    return {"status": "paused"}

@app.post("/api/download_station/resume")
def api_download_station_resume():
    download_station_resume()
    return {"status": "resumed"}

@app.get("/api/download_station/status")
def api_download_station_status():
    return {
        "phase": _live_state.get("download_station_phase", "idle"),
        "subphase": _live_state.get("download_station_subphase", "idle"),
        "run_id": _live_state.get("download_station_run_id"),
        "current_file": _live_state.get("download_station_current_file"),
        "current": _live_state.get("download_station_current", 0),
        "total": _live_state.get("download_station_total", 0),
        "downloaded": _live_state.get("download_station_downloaded", 0),
        "uploaded": _live_state.get("download_station_uploaded", 0),
        "failed": _live_state.get("download_station_failed", 0),
        "skipped": _live_state.get("download_station_skipped", 0),
        "bytes_done": _live_state.get("download_station_bytes_done", 0),
        "bytes_total": _live_state.get("download_station_bytes_total", 0),
        "speed_mbps": _live_state.get("download_station_speed_mbps"),
        "dest_dir": _live_state.get("download_station_dest_dir", get_download_dest_dir()),
        "error": _live_state.get("download_station_error"),
    }

@app.get("/api/download_station/runs")
def api_download_station_runs():
    db = SessionLocal()
    runs = db.query(DownloadStationRun).order_by(DownloadStationRun.id.desc()).all()
    result = [
        {
            "id": r.id,
            "source_url": r.source_url,
            "start_time": r.start_time,
            "end_time": r.end_time,
            "overall_status": r.overall_status,
            "total_files": r.total_files,
            "downloaded_files": r.downloaded_files,
            "uploaded_files": r.uploaded_files,
            "failed_files": r.failed_files,
            "skipped_files": r.skipped_files,
            "downloaded_bytes": r.downloaded_bytes,
            "uploaded_bytes": r.uploaded_bytes,
        }
        for r in runs
    ]
    db.close()
    return result

@app.get("/api/download_station/runs/{run_id}/files")
def api_download_station_run_files(run_id: int, status: Optional[str] = None, limit: int = 200, offset: int = 0):
    db = SessionLocal()
    q = db.query(DownloadStationFile).filter(DownloadStationFile.run_id == run_id)
    if status:
        q = q.filter((DownloadStationFile.download_status == status) | (DownloadStationFile.upload_status == status))
    files = q.order_by(DownloadStationFile.id).offset(offset).limit(limit).all()
    result = [
        {
            "id": f.id,
            "filename": f.filename,
            "filepath": f.filepath,
            "source_url": f.source_url,
            "filesize": f.filesize,
            "download_status": f.download_status,
            "upload_status": f.upload_status,
            "error_message": f.error_message,
            "download_duration": f.download_duration,
            "upload_duration": f.upload_duration,
        }
        for f in files
    ]
    db.close()
    return result

@app.get("/api/download_station/live_files")
def api_download_station_live_files(limit: int = 150):
    db = SessionLocal()
    run = None
    if _live_state.get("download_station_run_id"):
        run = db.query(DownloadStationRun).filter(DownloadStationRun.id == _live_state["download_station_run_id"]).first()
    if not run:
        run = db.query(DownloadStationRun).order_by(DownloadStationRun.id.desc()).first()
    if not run:
        db.close()
        return {"run_id": None, "files": []}

    files = db.query(DownloadStationFile).filter(
        DownloadStationFile.run_id == run.id
    ).order_by(DownloadStationFile.id.desc()).limit(limit).all()

    result = [
        {
            "id": f.id,
            "filename": f.filename,
            "source_url": f.source_url,
            "filesize": f.filesize,
            "download_status": f.download_status,
            "upload_status": f.upload_status,
            "error_message": f.error_message,
            "download_duration": f.download_duration,
            "upload_duration": f.upload_duration,
        }
        for f in files
    ]
    db.close()
    return {
        "run_id": run.id,
        "run_status": run.overall_status,
        "total_files": run.total_files,
        "downloaded_files": run.downloaded_files,
        "uploaded_files": run.uploaded_files,
        "failed_files": run.failed_files,
        "dest_dir": get_download_dest_dir(),
        "files": result
    }

@app.post("/api/download_station/runs/{run_id}/retry")
async def api_download_station_retry(run_id: int, background_tasks: BackgroundTasks):
    if _live_state.get("download_station_phase") in ("downloading", "uploading"):
        return {"status": "already_running"}
    db = SessionLocal()
    failed = db.query(DownloadStationFile).filter(
        DownloadStationFile.run_id == run_id,
        (DownloadStationFile.download_status == "failed") | (DownloadStationFile.upload_status == "failed")
    ).all()
    items = []
    for f in failed:
        if f.source_url:
            items.append({
                "url": f.source_url,
                "filename": f.filename
            })
    db.close()
    if not items:
        return {"status": "no_retryable_files", "message": "No failed files to retry."}
    background_tasks.add_task(process_download_station_queue, items, f"retry_run_{run_id}", run_id)
    return {"status": "started", "count": len(items)}

@app.get("/api/download_station/browser/proxy")
async def api_download_station_browser_proxy(url: str, request: Request):
    """
    Proxies web pages and media assets for the in-page embedded browser,
    stripping restrictive iframe headers (X-Frame-Options, CSP) and providing CORS.
    """
    if not url:
        return Response(content="No URL provided", status_code=400)
    
    headers_dict = dict(request.headers)
    content, status_code, out_headers = fetch_proxied_web_resource(url, headers_dict)
    
    response_headers = {}
    for k, v in out_headers.items():
        k_lower = k.lower()
        if k_lower in ("content-type", "access-control-allow-origin", "last-modified", "etag", "cache-control"):
            response_headers[k] = v
            
    return Response(
        content=content,
        status_code=status_code,
        headers=response_headers,
        media_type=response_headers.get("Content-Type", "text/html")
    )

@app.post("/api/download_station/browser/navigate")
def api_download_station_browser_navigate(body: dict = Body(...)):
    url = body.get("url", "").strip()
    if not url:
        return {"status": "error", "message": "No URL provided"}
    return browser_navigate_url(url)

@app.post("/api/download_station/browser/restart")
def api_download_station_browser_restart():
    return browser_restart_service()

@app.get("/api/download_station/browser/status")
def api_download_station_browser_status():
    return browser_get_status()

# ---------------------------------------------------------------------------
# System Controls
# ---------------------------------------------------------------------------

@app.post("/api/system/stop")
def system_stop():
    db = SessionLocal()
    setting = db.query(Setting).filter(Setting.key == "AUTO_COPY_ENABLED").first()
    if setting:
        setting.value = "false"
    else:
        db.add(Setting(key="AUTO_COPY_ENABLED", value="false"))
    db.commit()
    db.close()
    _live_state["auto_copy_enabled"] = False
    trigger_broadcast("auto_copy_toggled", {"enabled": False})
    return {"status": "stopped"}

@app.post("/api/system/start")
def system_start():
    db = SessionLocal()
    setting = db.query(Setting).filter(Setting.key == "AUTO_COPY_ENABLED").first()
    if setting:
        setting.value = "true"
    else:
        db.add(Setting(key="AUTO_COPY_ENABLED", value="true"))
    db.commit()
    db.close()
    _live_state["auto_copy_enabled"] = True
    trigger_broadcast("auto_copy_toggled", {"enabled": True})
    return {"status": "started"}

@app.post("/api/system/shutdown")
def system_shutdown():
    import subprocess
    subprocess.Popen(["sudo", "shutdown", "now"])
    return {"status": "shutting_down"}

@app.post("/api/system/restart")
def system_restart():
    import subprocess
    subprocess.Popen(["sudo", "reboot"])
    return {"status": "restarting"}


# ---------------------------------------------------------------------------
# WebSocket
# ---------------------------------------------------------------------------

active_websockets = []

@app.get("/api/state")
def get_live_state():
    """Return the current live process state for polling fallback."""
    return _live_state

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
    # Immediately push current state to the new client so it can
    # restore the UI without waiting for the next broadcast event.
    try:
        await websocket.send_json({"event": "state_sync", "data": _live_state})
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        if websocket in active_websockets:
            active_websockets.remove(websocket)

@app.websocket("/websockify")
@app.websocket("/novnc/websockify")
async def websocket_vnc_proxy(websocket: WebSocket):
    """
    Direct WebSocket-to-TCP proxy for VNC (port 5900).
    Enables noVNC to work seamlessly over same-origin HTTP/HTTPS and Cloudflare Tunnels
    without requiring separate external ports or dealing with mixed-content blocks.
    """
    subprotocols = websocket.scope.get("subprotocols", [])
    selected_subprotocol = "binary" if "binary" in subprotocols else (subprotocols[0] if subprotocols else None)
    await websocket.accept(subprotocol=selected_subprotocol)

    try:
        reader, writer = await asyncio.open_connection("127.0.0.1", 5900)
    except Exception as e:
        print(f"[vnc_proxy] Failed to connect to local VNC server 127.0.0.1:5900: {e}")
        await websocket.close()
        return

    async def ws_to_tcp():
        try:
            while True:
                data = await websocket.receive_bytes()
                writer.write(data)
                await writer.drain()
        except Exception:
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def tcp_to_ws():
        try:
            while True:
                data = await reader.read(65536)
                if not data:
                    break
                await websocket.send_bytes(data)
        except Exception:
            pass
        finally:
            try:
                await websocket.close()
            except Exception:
                pass

    await asyncio.gather(ws_to_tcp(), tcp_to_ws())

# ---------------------------------------------------------------------------
# Mount noVNC AFTER all websocket routes so that Starlette's route matcher
# evaluates @app.websocket("/novnc/websockify") before the StaticFiles mount.
# StaticFiles asserts scope["type"]=="http" and would crash on WS upgrades.
# ---------------------------------------------------------------------------
if os.path.exists(NOVNC_DIR):
    app.mount("/novnc", StaticFiles(directory=NOVNC_DIR, html=True), name="novnc")

def _update_state(event_type: str, data: dict):
    """Keep _live_state in sync with broadcast events."""
    s = _live_state
    if event_type == "run_started":
        s["phase"] = "copying" if data.get("device") != "local_disk" else "uploading"
        s["device"] = data.get("device")
        s["run_id"] = data.get("run_id")
        s["current_file"] = None
        s["copy_current"] = 0; s["copy_total"] = 0
        s["upload_current"] = 0; s["upload_total"] = 0
        s["speed_mbps"] = None; s["usb_info"] = None
        s["folders"] = []; s["error"] = None
    elif event_type == "usb_info":
        s["usb_info"] = {k: data[k] for k in ("total", "used", "free", "mounted", "mount_point") if k in data}
        s["device"] = data.get("device", s["device"])
    elif event_type == "copy_progress":
        s["phase"] = "copying"
        s["current_file"] = data.get("filename")
        s["copy_current"] = data.get("current", 0)
        s["copy_total"] = data.get("total", 0)
    elif event_type == "copy_stopped":
        s["phase"] = "copy_paused"
    elif event_type == "copy_done":
        s["phase"] = "copy_done"
        s["current_file"] = None
    elif event_type == "copy_done_select":
        s["phase"] = "copy_done_select"
        s["run_id"] = data.get("run_id")
        s["folders"] = data.get("folders", [])
        s["auto_upload_seconds"] = data.get("auto_upload_seconds", 30)
    elif event_type == "upload_started":
        s["phase"] = "uploading"
        s["upload_total"] = data.get("total", 0)
        s["current_file"] = None
    elif event_type == "upload_progress":
        s["phase"] = "uploading"
        s["current_file"] = data.get("filename")
        s["upload_current"] = data.get("current", 0)
        s["upload_total"] = data.get("total", 0)
    elif event_type == "upload_speed":
        s["speed_mbps"] = data.get("speed_mbps")
    elif event_type == "upload_stopped":
        s["phase"] = "upload_paused"
    elif event_type == "upload_done":
        s["phase"] = "upload_done"
        s["current_file"] = None
        s["speed_mbps"] = None
    elif event_type == "run_completed":
        s["phase"] = "completed"
        s["current_file"] = None
        s["speed_mbps"] = None
        if data.get("error"):
            s["phase"] = "failed"
            s["error"] = data["error"]
    elif event_type == "auto_copy_toggled":
        s["auto_copy_enabled"] = data.get("enabled", True)
    # --- External Drive events ---
    elif event_type == "ext_run_started":
        s["ext_phase"] = "scanning"
        s["ext_run_id"] = data.get("run_id")
        s["ext_upload_current"] = 0
        s["ext_upload_total"] = 0
        s["ext_current_file"] = None
        s["ext_speed_mbps"] = None
        s["ext_error"] = None
    elif event_type == "ext_scan_done":
        s["ext_phase"] = "scanning"
        s["ext_upload_total"] = data.get("total", 0)
    elif event_type == "ext_upload_started":
        s["ext_phase"] = "uploading"
        s["ext_upload_total"] = data.get("total", 0)
    elif event_type == "ext_upload_progress":
        s["ext_phase"] = "uploading"
        s["ext_current_file"] = data.get("filename") or data.get("filepath", "")
        s["ext_upload_current"] = data.get("current", 0)
        s["ext_upload_total"] = data.get("total", 0)
    elif event_type == "ext_upload_speed":
        s["ext_speed_mbps"] = data.get("speed_mbps")
    elif event_type == "ext_upload_stopped":
        s["ext_phase"] = "upload_paused"
    elif event_type == "ext_upload_done":
        s["ext_phase"] = "upload_done"
        s["ext_current_file"] = None
        s["ext_speed_mbps"] = None
    elif event_type == "ext_run_completed":
        s["ext_phase"] = "completed" if not data.get("error") else "failed"
        s["ext_current_file"] = None
        s["ext_speed_mbps"] = None
        if data.get("error"):
            s["ext_error"] = data["error"]
    # --- Upload Station events ---
    elif event_type == "upload_station_run_started":
        s["upload_station_phase"] = "uploading"
        s["upload_station_run_id"] = data.get("run_id")
        s["upload_station_total"] = data.get("total_files", 0)
        s["upload_station_bytes_total"] = data.get("total_bytes", 0)
        s["upload_station_current"] = 0
        s["upload_station_uploaded"] = 0
        s["upload_station_failed"] = 0
        s["upload_station_skipped"] = 0
        s["upload_station_bytes_done"] = 0
        s["upload_station_current_file"] = None
        s["upload_station_speed_mbps"] = None
        s["upload_station_error"] = None
    elif event_type == "upload_station_file_start":
        s["upload_station_phase"] = "uploading"
        s["upload_station_current_file"] = data.get("filename")
        s["upload_station_current"] = data.get("current", 0)
        s["upload_station_total"] = data.get("total", s["upload_station_total"])
    elif event_type == "upload_station_progress":
        s["upload_station_phase"] = "uploading"
        s["upload_station_current_file"] = data.get("filename")
        s["upload_station_current"] = data.get("current", 0)
        s["upload_station_uploaded"] = data.get("uploaded_files", s["upload_station_uploaded"])
        s["upload_station_failed"] = data.get("failed_files", s["upload_station_failed"])
        s["upload_station_bytes_done"] = data.get("cum_bytes", 0)
        s["upload_station_bytes_total"] = data.get("total_bytes", s["upload_station_bytes_total"])
    elif event_type == "upload_station_speed":
        s["upload_station_speed_mbps"] = data.get("speed_mbps")
    elif event_type == "upload_station_file_done":
        s["upload_station_current_file"] = None
        if data.get("status") in ("success", "duplicate"):
            s["upload_station_uploaded"] = s.get("upload_station_uploaded", 0) + 1
        elif data.get("status") == "skipped":
            s["upload_station_skipped"] = s.get("upload_station_skipped", 0) + 1
    elif event_type == "upload_station_file_failed":
        s["upload_station_current_file"] = None
        s["upload_station_failed"] = s.get("upload_station_failed", 0) + 1
    elif event_type == "upload_station_stopped":
        s["upload_station_phase"] = "stopped"
        s["upload_station_current_file"] = None
        s["upload_station_speed_mbps"] = None
    elif event_type == "upload_station_completed":
        status_val = data.get("status", "completed")
        s["upload_station_phase"] = "completed" if status_val in ("completed", "partial_failure") else "failed"
        s["upload_station_current_file"] = None
        s["upload_station_speed_mbps"] = None
        s["upload_station_uploaded"] = data.get("uploaded_files", s["upload_station_uploaded"])
        s["upload_station_failed"] = data.get("failed_files", s["upload_station_failed"])
        s["upload_station_skipped"] = data.get("skipped_files", s["upload_station_skipped"])
        if data.get("error"):
            s["upload_station_error"] = data["error"]
    # --- Download Station events ---
    elif event_type == "download_station_run_started":
        s["download_station_phase"] = "downloading"
        s["download_station_subphase"] = "downloading"
        s["download_station_run_id"] = data.get("run_id")
        s["download_station_total"] = data.get("total_files", 0)
        s["download_station_current"] = 0
        s["download_station_downloaded"] = 0
        s["download_station_uploaded"] = 0
        s["download_station_failed"] = 0
        s["download_station_skipped"] = 0
        s["download_station_bytes_done"] = 0
        s["download_station_bytes_total"] = 0
        s["download_station_current_file"] = None
        s["download_station_speed_mbps"] = None
        s["download_station_dest_dir"] = data.get("dest_dir", s["download_station_dest_dir"])
        s["download_station_error"] = None
    elif event_type == "download_station_file_start":
        s["download_station_phase"] = "downloading"
        s["download_station_subphase"] = "downloading"
        s["download_station_current_file"] = data.get("filename")
        s["download_station_current"] = data.get("current", 0)
        s["download_station_total"] = data.get("total", s["download_station_total"])
    elif event_type == "download_station_download_progress":
        s["download_station_phase"] = "downloading"
        s["download_station_subphase"] = "downloading"
        s["download_station_current_file"] = data.get("filename")
        s["download_station_current"] = data.get("current", 0)
        s["download_station_bytes_done"] = data.get("bytes_downloaded", 0)
        s["download_station_bytes_total"] = data.get("total_bytes", s["download_station_bytes_total"])
    elif event_type == "download_station_download_done":
        s["download_station_downloaded"] = s.get("download_station_downloaded", 0) + 1
    elif event_type == "download_station_upload_start":
        s["download_station_phase"] = "uploading"
        s["download_station_subphase"] = "uploading"
        s["download_station_current_file"] = data.get("filename")
        s["download_station_current"] = data.get("current", 0)
    elif event_type == "download_station_upload_progress":
        s["download_station_phase"] = "uploading"
        s["download_station_subphase"] = "uploading"
        s["download_station_current_file"] = data.get("filename")
        s["download_station_current"] = data.get("current", 0)
        s["download_station_uploaded"] = data.get("uploaded_files", s["download_station_uploaded"])
        s["download_station_failed"] = data.get("failed_files", s["download_station_failed"])
    elif event_type == "download_station_speed":
        s["download_station_speed_mbps"] = data.get("speed_mbps")
        if data.get("phase"):
            s["download_station_subphase"] = data.get("phase")
    elif event_type == "download_station_file_done":
        s["download_station_current_file"] = None
        if data.get("status") in ("success", "duplicate"):
            s["download_station_uploaded"] = s.get("download_station_uploaded", 0) + 1
        elif data.get("status") == "skipped":
            s["download_station_skipped"] = s.get("download_station_skipped", 0) + 1
    elif event_type == "download_station_file_failed":
        s["download_station_current_file"] = None
        s["download_station_failed"] = s.get("download_station_failed", 0) + 1
    elif event_type == "download_station_stopped":
        s["download_station_phase"] = "stopped"
        s["download_station_current_file"] = None
        s["download_station_speed_mbps"] = None
    elif event_type == "download_station_completed":
        status_val = data.get("status", "completed")
        s["download_station_phase"] = "completed" if status_val in ("completed", "partial_failure") else "failed"
        s["download_station_current_file"] = None
        s["download_station_speed_mbps"] = None
        s["download_station_downloaded"] = data.get("downloaded_files", s["download_station_downloaded"])
        s["download_station_uploaded"] = data.get("uploaded_files", s["download_station_uploaded"])
        s["download_station_failed"] = data.get("failed_files", s["download_station_failed"])
        s["download_station_skipped"] = data.get("skipped_files", s["download_station_skipped"])
        if data.get("error"):
            s["download_station_error"] = data["error"]

async def broadcast_event(event_type: str, data: dict):
    _update_state(event_type, data)
    message = {"event": event_type, "data": data}
    for ws in list(active_websockets):
        try:
            await ws.send_json(message)
        except Exception:
            if ws in active_websockets:
                active_websockets.remove(ws)

def trigger_broadcast(event_type: str, data: dict):
    import asyncio
    if main_loop and main_loop.is_running():
        asyncio.run_coroutine_threadsafe(broadcast_event(event_type, data), main_loop)
