from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.websockets import WebSocketDisconnect
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Dict
from src.database import SessionLocal, Run, FileRecord, Setting, encrypt_val, decrypt_val
from src.usb_handler import process_usb

main_loop = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio
    global main_loop
    main_loop = asyncio.get_running_loop()
    yield

app = FastAPI(lifespan=lifespan)

# Redirect root to the main UI
@app.get("/")
def root():
    return RedirectResponse(url="/static/index.html")

app.mount("/static", StaticFiles(directory="static"), name="static")

class UsbEvent(BaseModel):
    action: str
    device: str

class SettingsPayload(BaseModel):
    settings: Dict[str, str]

@app.post("/api/settings")
def save_settings(payload: SettingsPayload):
    db = SessionLocal()
    for k, v in payload.settings.items():
        # Only encrypt auth data
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

@app.post("/api/usb_event")
async def handle_usb_event(event: UsbEvent, background_tasks: BackgroundTasks):
    if event.action == "add":
        background_tasks.add_task(process_usb, event.device)
    return {"status": "received"}

@app.post("/api/trigger_local_upload")
async def trigger_local_upload(background_tasks: BackgroundTasks):
    from src.usb_handler import process_local_directory
    background_tasks.add_task(process_local_directory)
    return {"status": "started"}

@app.get("/api/runs")
def get_runs():
    db = SessionLocal()
    runs = db.query(Run).order_by(Run.id.desc()).all()
    
    result = []
    for run in runs:
        total_files = db.query(FileRecord).filter(FileRecord.run_id == run.id).count()
        copied_files = db.query(FileRecord).filter(FileRecord.run_id == run.id, FileRecord.copy_status == "success").count()
        uploaded_files = db.query(FileRecord).filter(FileRecord.run_id == run.id, FileRecord.upload_status == "success").count()
        
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

@app.get("/api/files")
def get_files(path: str = ""):
    import os
    staging_dir = "/var/lib/media_upload/staging"
    target_dir = os.path.join(staging_dir, path)
    
    if not os.path.exists(target_dir):
        return []
    
    items = []
    # If not at root, add an option to go back
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

@app.get("/api/system/storage")
def get_storage():
    import shutil
    total, used, free = shutil.disk_usage("/var/lib/media_upload")
    return {
        "total": total,
        "used": used,
        "free": free
    }

active_websockets = []

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
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

async def broadcast_event(event_type: str, data: dict):
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
