# Media Upload Hub

A headless Linux application designed to automatically copy photos and videos from inserted USB drives and upload them to Google Photos.

It features a modern, responsive Web UI to monitor USB insertions, view local copy progress, track cloud upload status in real-time, and configure settings.

## Features

- **Plug-and-Play USB Detection**: Automatically detects USB drives via `udev` rules.
- **Session-based Copying**: Copies media into dated folders (e.g., `YYYY-MM-DD_run_1`) preserving original directory structures.
- **Live Progress Dashboard**: Real-time progress updates via WebSockets.
- **Storage Monitoring**: Shows available and used local storage space.
- **Settings Configuration**: Encrypted storage of Google Photos auth data and upload preferences.
- **History Logs**: Keeps a persistent log of all past copy and upload sessions.

## Installation

This project includes an `install.sh` script that automatically sets up the Python virtual environment, installs dependencies, and configures the `systemd` service and `udev` rules for your Linux machine.

### Prerequisites
- Debian/Ubuntu-based Linux (e.g., Raspberry Pi OS)
- Python 3.11+
- `systemd` and `udev`

### Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/mniroy/media-upload.git
   cd media-upload
   ```

2. **Run the installation script:**
   ```bash
   sudo ./install.sh
   ```
   *Note: `sudo` is required because the script copies files to `/etc/systemd/system/` and `/etc/udev/rules.d/`.*

3. **Check the service status:**
   The service will start automatically on boot and after installation. You can check its status using:
   ```bash
   sudo systemctl status usb-hub.service
   ```

## Usage

Once the service is running, you can access the Web UI from any device on your local network:

```
http://<your-device-ip>:8000
```

1. **Configure Settings**: Go to the Settings tab to enter your Google Photos Auth Data and upload preferences.
2. **Insert a USB Drive**: The system will automatically detect the drive, copy its contents locally, and begin uploading to the cloud.
3. **Monitor Progress**: Watch the Dashboard for real-time file copy and upload progress.
