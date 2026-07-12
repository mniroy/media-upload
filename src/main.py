from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.websockets import WebSocketDisconnect
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Dict, List, Optional
from src.database import SessionLocal, Run, FileRecord, Setting, encrypt_val, decrypt_val
from src.usb_handler import (
    process_usb, process_local_directory, upload_selected_folders,
    get_staged_folders, get_device_info, get_mount_status, unmount_device,
    copy_stop, copy_resume, copy_pause, upload_stop, upload_resume,
    MOUNT_BASE
)
from src.ext_drive_handler import (
    get_ext_drive_status, scan_top_level_folders, start_ext_drive_upload,
    ext_stop, ext_pause, ext_resume,
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
}

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
    
    # Clean up any ext drive sessions left as "running" from a previous
    # service crash or restart — they will never complete now.
    db2 = SessionLocal()
    from src.database import ExtDriveRun as _EDR
    import datetime as _dt
    stale = db2.query(_EDR).filter(_EDR.overall_status == "running").all()
    for s in stale:
        s.overall_status = "interrupted"
        s.end_time = _dt.datetime.now(_dt.timezone.utc)
    if stale:
        db2.commit()
        print(f"[startup] Marked {len(stale)} stale ext drive session(s) as 'interrupted'")
    db2.close()

    yield

app = FastAPI(lifespan=lifespan)

# Redirect root to the main UI
@app.get("/")
def root():
    return RedirectResponse(url="/static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")

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
# File Explorer
# ---------------------------------------------------------------------------

@app.get("/api/files")
def get_files(path: str = ""):
    import os
    staging_dir = "/var/lib/media_upload/staging"
    target_dir = os.path.join(staging_dir, path)

    if not os.path.exists(target_dir):
        return []

    items = []
    if path:
        items.append({"name": "..", "type": "directory", "size": 0})

    for f in sorted(os.listdir(target_dir)):
        full_path = os.path.join(target_dir, f)
        if os.path.isdir(full_path):
            items.append({"name": f, "type": "directory", "size": 0})
        elif os.path.isfile(full_path):
            size = os.path.getsize(full_path)
            items.append({"name": f, "type": "file", "size": size})
    return items

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

@app.get("/api/system/storage")
def get_storage():
    import shutil
    total, used, free = shutil.disk_usage("/var/lib/media_upload")
    return {"total": total, "used": used, "free": free}

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
