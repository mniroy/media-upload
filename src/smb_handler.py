import os
import socket
import shutil
import subprocess
import logging
from typing import Dict, Any, List
from src.ext_drive_handler import get_ext_drive_path

logger = logging.getLogger("smb_handler")

def get_lan_ip() -> str:
    """Retrieve primary LAN IPv4 address of the host."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Does not actually send data over the wire, but determines default routing interface
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip

def get_hostname() -> str:
    """Get system hostname without trailing .local suffix."""
    try:
        name = socket.gethostname()
        if name.endswith(".local"):
            name = name[:-6]
        return name
    except Exception:
        return "media-hub"

def is_smb_installed() -> bool:
    """Check if Samba (smbd) binary is installed on the host."""
    return shutil.which("smbd") is not None or os.path.exists("/usr/sbin/smbd") or os.path.exists("/usr/bin/smbd")

def is_smb_service_running() -> bool:
    """Check if smbd systemd service is active."""
    for service_name in ["smbd", "samba", "smb"]:
        try:
            res = subprocess.run(
                ["systemctl", "is-active", service_name],
                capture_output=True,
                text=True,
                timeout=2
            )
            if res.returncode == 0 and "active" in res.stdout.strip():
                return True
        except Exception:
            pass
    return False

def get_smb_status() -> Dict[str, Any]:
    """Return complete status of SMB server, configured shares, and connection URLs."""
    installed = is_smb_installed()
    running = is_smb_service_running()
    lan_ip = get_lan_ip()
    hostname = get_hostname()

    internal_path = "/var/lib/media_upload"
    internal_exists = os.path.exists(internal_path)
    
    external_path = get_ext_drive_path()
    external_exists = os.path.exists(external_path) and os.path.ismount(external_path) if hasattr(os.path, 'ismount') else os.path.exists(external_path)

    shares: List[Dict[str, Any]] = [
        {
            "name": "Internal",
            "path": internal_path,
            "comment": "Internal Storage & Staging",
            "available": internal_exists,
            "mac_url": f"smb://{lan_ip}/Internal",
            "win_url": f"\\\\{lan_ip}\\Internal",
            "host_mac_url": f"smb://{hostname}.local/Internal",
            "host_win_url": f"\\\\{hostname}\\Internal",
        },
        {
            "name": "External",
            "path": external_path,
            "comment": "Permanent External HDD",
            "available": external_exists,
            "mac_url": f"smb://{lan_ip}/External",
            "win_url": f"\\\\{lan_ip}\\External",
            "host_mac_url": f"smb://{hostname}.local/External",
            "host_win_url": f"\\\\{hostname}\\External",
        }
    ]

    return {
        "installed": installed,
        "running": running,
        "lan_ip": lan_ip,
        "hostname": hostname,
        "port": 445,
        "guest_enabled": True,
        "shares": shares,
        "summary": {
            "mac_root": f"smb://{lan_ip}",
            "win_root": f"\\\\{lan_ip}",
            "mac_host_root": f"smb://{hostname}.local",
            "win_host_root": f"\\\\{hostname}",
        }
    }

def restart_smb_service() -> Dict[str, Any]:
    """Trigger restart of the Samba daemon."""
    for service_name in ["smbd", "samba"]:
        try:
            res = subprocess.run(
                ["sudo", "systemctl", "restart", service_name],
                capture_output=True,
                text=True,
                timeout=10
            )
            if res.returncode == 0:
                return {"success": True, "message": f"Successfully restarted {service_name} service."}
        except Exception as e:
            logger.warning(f"Failed to restart {service_name}: {e}")

    # Fallback to direct service command
    try:
        res = subprocess.run(
            ["sudo", "service", "smbd", "restart"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if res.returncode == 0:
            return {"success": True, "message": "Successfully restarted smbd service via sysvinit."}
    except Exception as e:
        logger.error(f"Error restarting SMB service: {e}")

    return {"success": False, "message": "Could not restart SMB service. Check system permissions or systemctl status."}
