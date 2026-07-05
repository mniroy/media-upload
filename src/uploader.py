import os
from gpmc import Client
from src.database import SessionLocal, Setting, decrypt_val

def get_auth_data():
    db = SessionLocal()
    setting = db.query(Setting).filter_by(key="GP_AUTH_DATA").first()
    db.close()
    if setting and setting.value:
        return decrypt_val(setting.value)
    return None

def upload_file(filepath: str) -> tuple[bool, str]:
    auth_data = get_auth_data()
    if not auth_data:
        return False, "Google Photos Auth Data not set in settings"
        
    print(f"Uploading {filepath} via gpmc Python Client...")
    try:
        client = Client(auth_data=auth_data)
        output = client.upload(target=filepath, show_progress=False)
        # `output` is a dict: {"/absolute/path": "media_key"}
        abs_path = os.path.abspath(filepath)
        if abs_path in output or filepath in output:
            return True, ""
        else:
            return False, f"Failed to upload: {output}"
    except Exception as e:
        return False, str(e)
