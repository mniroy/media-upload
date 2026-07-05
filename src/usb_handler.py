import os
import shutil
import time
from src.database import SessionLocal, Run, FileRecord
from src.uploader import upload_file

STAGING_DIR = "/tmp/media_upload/staging"

def sync_broadcast(event, data):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"Broadcast failed: {e}")

def process_usb(device_name: str):
    print(f"Processing USB {device_name}")
    sync_broadcast("run_started", {"device": device_name})
    db = SessionLocal()
    
    run = Run(usb_identifier=device_name)
    db.add(run)
    db.commit()
    db.refresh(run)

    # Mocking mount and copy for now
    usb_mount_path = f"/tmp/mock_usb_{device_name}"
    if os.path.exists(usb_mount_path):
        shutil.rmtree(usb_mount_path)
    os.makedirs(usb_mount_path, exist_ok=True)
    os.makedirs(f"{usb_mount_path}/DCIM/Camera", exist_ok=True)
    
    # Create some mock files
    mock_files = [
        "test1.jpg", 
        "DCIM/test2.mp4", 
        "DCIM/Camera/test3.png"
    ]
    for mf in mock_files:
        with open(f"{usb_mount_path}/{mf}", "w") as f:
            f.write("mock")
            
    files_to_process = []
    for root, dirs, files in os.walk(usb_mount_path):
        for file in files:
            rel_dir = os.path.relpath(root, usb_mount_path)
            rel_file = file if rel_dir == '.' else os.path.join(rel_dir, file)
            record = FileRecord(run_id=run.id, filename=rel_file, copy_status="pending")
            db.add(record)
            files_to_process.append(record)
    
    db.commit()

    # Copy files
    for i, record in enumerate(files_to_process):
        sync_broadcast("copy_progress", {"filename": record.filename, "current": i+1, "total": len(files_to_process)})
        time.sleep(1) # mock delay to see it in UI
        try:
            src_path = os.path.join(usb_mount_path, record.filename)
            date_str = run.start_time.strftime('%Y-%m-%d')
            session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run.id}")
            dst_path = os.path.join(session_dir, record.filename)
            os.makedirs(os.path.dirname(dst_path), exist_ok=True)
            shutil.copy2(src_path, dst_path)
            record.copy_status = "success"
        except Exception as e:
            record.copy_status = "failed"
            record.error_message = str(e)
        db.commit()
    sync_broadcast("copy_done", {})

    # Upload files
    for i, record in enumerate(files_to_process):
        if record.copy_status == "success":
            sync_broadcast("upload_progress", {"filename": record.filename, "current": i+1, "total": len(files_to_process)})
            date_str = run.start_time.strftime('%Y-%m-%d')
            session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run.id}")
            upload_success, err = upload_file(os.path.join(session_dir, record.filename))
            if upload_success:
                record.upload_status = "success"
            else:
                record.upload_status = "failed"
                record.error_message = err
            db.commit()
    
    sync_broadcast("upload_done", {})
    run.overall_status = "completed"
    db.commit()
    db.close()
    sync_broadcast("run_completed", {})
