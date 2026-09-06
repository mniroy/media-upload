from sqlalchemy import create_engine, Column, Integer, String, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
import datetime
import os
from cryptography.fernet import Fernet

DATA_DIR = "/var/lib/media_upload"
try:
    os.makedirs(DATA_DIR, exist_ok=True)
    test_file = os.path.join(DATA_DIR, ".perm_test")
    with open(test_file, "w") as f:
        f.write("ok")
    os.remove(test_file)
except Exception:
    DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")
    os.makedirs(DATA_DIR, exist_ok=True)

DATABASE_URL = f"sqlite:///{os.path.join(DATA_DIR, 'data.db')}"
SECRET_KEY_FILE = os.path.join(DATA_DIR, "secret.key")

if not os.path.exists(SECRET_KEY_FILE):
    with open(SECRET_KEY_FILE, "wb") as f:
        f.write(Fernet.generate_key())

with open(SECRET_KEY_FILE, "rb") as f:
    cipher_suite = Fernet(f.read())

def encrypt_val(val: str) -> str:
    if not val: return val
    return cipher_suite.encrypt(val.encode()).decode()

def decrypt_val(val: str) -> str:
    if not val:
        return val
    try:
        return cipher_suite.decrypt(val.encode()).decode()
    except Exception:
        # Fallback: value was stored as plaintext (e.g., before encryption was enabled)
        return val

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()

class Setting(Base):
    __tablename__ = "settings"
    key = Column(String, primary_key=True, index=True)
    value = Column(String)

class Run(Base):
    __tablename__ = "runs"
    id = Column(Integer, primary_key=True, index=True)
    usb_identifier = Column(String)
    start_time = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    overall_status = Column(String, default="running")

class FileRecord(Base):
    __tablename__ = "file_records"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer)
    filename = Column(String)
    copy_status = Column(String)
    upload_status = Column(String, default="pending")
    error_message = Column(String, nullable=True)

# ---------------------------------------------------------------------------
# External Drive tables — completely separate from USB run/file tracking
# ---------------------------------------------------------------------------

class ExtDriveRun(Base):
    """One upload session from the permanently-mounted external HDD."""
    __tablename__ = "ext_drive_runs"
    id = Column(Integer, primary_key=True, index=True)
    start_time = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    end_time = Column(DateTime, nullable=True)
    overall_status = Column(String, default="running")  # running | completed | failed | stopped
    total_files = Column(Integer, default=0)
    uploaded_files = Column(Integer, default=0)
    failed_files = Column(Integer, default=0)
    skipped_files = Column(Integer, default=0)

class ExtDriveFile(Base):
    """Per-file record for an external drive upload session."""
    __tablename__ = "ext_drive_files"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    filepath = Column(String)   # full absolute path on the external drive
    upload_status = Column(String, default="pending")  # pending | success | failed | skipped
    error_message = Column(String, nullable=True)

# ---------------------------------------------------------------------------
# Upload Station tables — Direct web drag & drop uploads
# ---------------------------------------------------------------------------

class UploadStationRun(Base):
    """One drag-and-drop batch upload session."""
    __tablename__ = "upload_station_runs"
    id = Column(Integer, primary_key=True, index=True)
    start_time = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    end_time = Column(DateTime, nullable=True)
    overall_status = Column(String, default="running")  # running | completed | failed | stopped | paused
    total_files = Column(Integer, default=0)
    uploaded_files = Column(Integer, default=0)
    failed_files = Column(Integer, default=0)
    skipped_files = Column(Integer, default=0)
    total_bytes = Column(Integer, default=0)
    uploaded_bytes = Column(Integer, default=0)

class UploadStationFile(Base):
    """Per-file record for a drag-and-drop upload session."""
    __tablename__ = "upload_station_files"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    filename = Column(String)
    filepath = Column(String, nullable=True)
    filesize = Column(Integer, default=0)
    upload_status = Column(String, default="pending")  # pending | uploading | success | duplicate | failed | skipped
    error_message = Column(String, nullable=True)
    duration_seconds = Column(Integer, default=0)

# ---------------------------------------------------------------------------
# Download Station tables — In-page browser & Web download pipeline
# ---------------------------------------------------------------------------

class DownloadStationRun(Base):
    """One web/browser download & auto-upload session."""
    __tablename__ = "download_station_runs"
    id = Column(Integer, primary_key=True, index=True)
    source_url = Column(String, nullable=True)
    start_time = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))
    end_time = Column(DateTime, nullable=True)
    overall_status = Column(String, default="running")  # running | completed | failed | stopped | paused
    total_files = Column(Integer, default=0)
    downloaded_files = Column(Integer, default=0)
    uploaded_files = Column(Integer, default=0)
    failed_files = Column(Integer, default=0)
    skipped_files = Column(Integer, default=0)
    total_bytes = Column(Integer, default=0)
    downloaded_bytes = Column(Integer, default=0)
    uploaded_bytes = Column(Integer, default=0)

class DownloadStationFile(Base):
    """Per-file record for a downloaded and auto-uploaded media file."""
    __tablename__ = "download_station_files"
    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(Integer, index=True)
    source_url = Column(String, nullable=True)
    filename = Column(String)
    filepath = Column(String, nullable=True)     # Saved path on external drive (or fallback staging)
    filesize = Column(Integer, default=0)
    download_status = Column(String, default="downloading")  # downloading | downloaded | failed | cancelled
    upload_status = Column(String, default="pending")      # pending | uploading | success | duplicate | failed | skipped
    error_message = Column(String, nullable=True)
    download_duration = Column(Integer, default=0)
    upload_duration = Column(Integer, default=0)

# ---------------------------------------------------------------------------
# Unified Uploaded Media Registry (Cross-station deduplication)
# ---------------------------------------------------------------------------

class UploadedMediaRegistry(Base):
    """Central index of all media files successfully uploaded across any station."""
    __tablename__ = "uploaded_media_registry"
    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String, index=True)
    filepath = Column(String, nullable=True)
    filesize = Column(Integer, nullable=True)
    sha1_hash = Column(String, nullable=True, index=True)
    source_station = Column(String, default="unknown")  # "usb" | "extdrive" | "upload_station" | "download_station"
    remote_key = Column(String, nullable=True)
    uploaded_at = Column(DateTime, default=lambda: datetime.datetime.now(datetime.timezone.utc))

Base.metadata.create_all(bind=engine)

def is_media_already_uploaded(db, filename: str, filepath: str = None, filesize: int = None, sha1_hash: str = None) -> bool:
    """
    Check if a file was uploaded by ANY station (USB Station, Drive Station, Upload Station, or Download Station).
    """
    if sha1_hash:
        rec = db.query(UploadedMediaRegistry).filter(UploadedMediaRegistry.sha1_hash == sha1_hash).first()
        if rec:
            return True

    if filepath:
        if db.query(UploadedMediaRegistry).filter(UploadedMediaRegistry.filepath == filepath).first():
            return True
        if db.query(ExtDriveFile).filter(ExtDriveFile.filepath == filepath, ExtDriveFile.upload_status == "success").first():
            return True

    base_name = os.path.basename(filename) if filename else (os.path.basename(filepath) if filepath else "")
    if base_name:
        # Check central registry
        q = db.query(UploadedMediaRegistry).filter(UploadedMediaRegistry.filename == base_name)
        if filesize and filesize > 0:
            match = q.filter(UploadedMediaRegistry.filesize == filesize).first()
            if match:
                return True
        elif q.first():
            return True

        # Check FileRecord (USB Station)
        if db.query(FileRecord).filter(
            FileRecord.upload_status == "success",
            FileRecord.filename.endswith(base_name)
        ).first():
            return True

        # Check UploadStationFile (Upload Station)
        if db.query(UploadStationFile).filter(
            UploadStationFile.filename == base_name,
            UploadStationFile.upload_status.in_(["success", "duplicate"])
        ).first():
            return True

        # Check DownloadStationFile (Download Station)
        if db.query(DownloadStationFile).filter(
            DownloadStationFile.filename == base_name,
            DownloadStationFile.upload_status.in_(["success", "duplicate"])
        ).first():
            return True

        # Check ExtDriveFile by filename
        if db.query(ExtDriveFile).filter(
            ExtDriveFile.upload_status == "success",
            ExtDriveFile.filepath.endswith(base_name)
        ).first():
            return True

    return False

def register_uploaded_media(db, filename: str, filepath: str = None, filesize: int = None, sha1_hash: str = None, source_station: str = "upload_station", remote_key: str = None):
    """Record an uploaded file in the central cross-station registry."""
    base_name = os.path.basename(filename) if filename else (os.path.basename(filepath) if filepath else "")
    if not base_name:
        return None
    try:
        q = db.query(UploadedMediaRegistry)
        if sha1_hash:
            existing = q.filter(UploadedMediaRegistry.sha1_hash == sha1_hash).first()
            if existing:
                return existing
        existing = q.filter(UploadedMediaRegistry.filename == base_name).first()
        if existing and (not filesize or existing.filesize == filesize):
            return existing

        new_reg = UploadedMediaRegistry(
            filename=base_name,
            filepath=filepath,
            filesize=filesize,
            sha1_hash=sha1_hash,
            source_station=source_station,
            remote_key=remote_key
        )
        db.add(new_reg)
        db.commit()
        db.refresh(new_reg)
        return new_reg
    except Exception as e:
        print(f"[database] register_uploaded_media failed: {e}")
        db.rollback()
        return None

