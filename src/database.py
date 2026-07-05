from sqlalchemy import create_engine, Column, Integer, String, DateTime
from sqlalchemy.orm import declarative_base, sessionmaker
import datetime
import os
from cryptography.fernet import Fernet

DATABASE_URL = "sqlite:////var/lib/media_upload/data.db"
SECRET_KEY_FILE = "/var/lib/media_upload/secret.key"

os.makedirs("/var/lib/media_upload", exist_ok=True)
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

Base.metadata.create_all(bind=engine)
