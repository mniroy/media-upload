import time

def upload_file(filepath: str) -> tuple[bool, str]:
    # Mocking upload process
    # In real integration, call google_photos_mobile_client here
    print(f"Uploading {filepath}...")
    time.sleep(1) # simulate network delay
    return True, ""
