import os
import shutil
import time
import subprocess
from src.database import SessionLocal, Run, FileRecord
from src.uploader import upload_file

STAGING_DIR = "/var/lib/media_upload/staging"
MOUNT_BASE = "/var/lib/media_upload/mnt"

def sync_broadcast(event, data):
    try:
        from src.main import trigger_broadcast
        trigger_broadcast(event, data)
    except Exception as e:
        print(f"Broadcast failed: {e}")

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

def process_usb(device_name: str):
    print(f"Processing USB {device_name}")
    sync_broadcast("run_started", {"device": device_name})
    db = SessionLocal()
    
    run = Run(usb_identifier=device_name)
    db.add(run)
    db.commit()
    db.refresh(run)

    usb_mount_path = mount_device(device_name)
    if not usb_mount_path:
        run.overall_status = "failed"
        db.commit()
        db.close()
        sync_broadcast("run_completed", {"error": f"Failed to mount /dev/{device_name}"})
        return

    files_to_process = []
    for root, dirs, files in os.walk(usb_mount_path):
        # Skip hidden/system dirs
        dirs[:] = [d for d in dirs if not d.startswith('.') and d not in ('System Volume Information', 'RECYCLER', '$RECYCLE.BIN')]
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

    # Copy files
    for i, record in enumerate(files_to_process):
        sync_broadcast("copy_progress", {"filename": record.filename, "current": i+1, "total": len(files_to_process)})
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
            print(f"Copy error for {record.filename}: {e}")
        db.commit()
    
    unmount_device(usb_mount_path)
    sync_broadcast("copy_done", {})

    # Upload files
    for i, record in enumerate(files_to_process):
        if record.copy_status == "success":
            sync_broadcast("upload_progress", {"filename": record.filename, "current": i+1, "total": len(files_to_process)})
            date_str = run.start_time.strftime('%Y-%m-%d')
            session_dir = os.path.join(STAGING_DIR, f"{date_str}_run_{run.id}")
            full_path = os.path.join(session_dir, record.filename)
            
            start_t = time.time()
            upload_success, err = upload_file(full_path)
            end_t = time.time()
            
            duration = end_t - start_t
            file_size = os.path.getsize(full_path) if os.path.exists(full_path) else 0
            speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
            sync_broadcast("upload_speed", {"filename": record.filename, "speed_mbps": round(speed_mbps, 2)})
            
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

def process_local_directory():
    print("Processing local staging directory for uploads")
    sync_broadcast("run_started", {"device": "local_disk"})
    db = SessionLocal()
    
    run = Run(usb_identifier="local_disk")
    db.add(run)
    db.commit()
    db.refresh(run)
    
    files_to_process = []
    for root, dirs, files in os.walk(STAGING_DIR):
        for file in files:
            if file.startswith('.'):
                continue
            full_path = os.path.join(root, file)
            # Use relative path for display/DB purposes
            rel_file = os.path.relpath(full_path, STAGING_DIR)
            record = FileRecord(run_id=run.id, filename=rel_file, copy_status="success")
            db.add(record)
            files_to_process.append((record, full_path))
            
    db.commit()
    print(f"Found {len(files_to_process)} local files to process")
    
    sync_broadcast("copy_done", {}) # skip copy phase
    
    for i, (record, full_path) in enumerate(files_to_process):
        sync_broadcast("upload_progress", {"filename": record.filename, "current": i+1, "total": len(files_to_process)})
        
        start_t = time.time()
        upload_success, err = upload_file(full_path)
        end_t = time.time()
        
        duration = end_t - start_t
        file_size = os.path.getsize(full_path) if os.path.exists(full_path) else 0
        speed_mbps = (file_size / (1024 * 1024)) / duration if duration > 0 else 0
        sync_broadcast("upload_speed", {"filename": record.filename, "speed_mbps": round(speed_mbps, 2)})
        
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
