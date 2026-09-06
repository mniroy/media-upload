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

---

## Permanent External Drive Setup (5.5TB HDD)

The **Ext Drive** tab provides a separate upload path for the permanently attached external HDD. This is completely independent from the USB copy workflow — it uploads media directly from the drive to Google Photos without staging.

### 1. Find the drive UUID

```bash
lsblk -f
# Or:
sudo blkid
# Look for your drive's partition (e.g. LABEL="Media Drive", UUID="6A4B-B5F8", TYPE="exfat")
```

Copy the UUID value.

### 2. Create the mount point

```bash
sudo mkdir -p /mnt/external_drive
```

### 3. Add to `/etc/fstab` for permanent mounting

```bash
sudo nano /etc/fstab
```

Add this line (replace `<UUID>` with the actual UUID from step 1):

```
UUID=<UUID>  /mnt/external_drive  exfat  defaults,nofail,x-systemd.automount,x-systemd.device-timeout=60  0  0
```

> **`nofail`** — the system will still boot if the drive is disconnected.
> **`x-systemd.device-timeout=60`** — gives large mechanical HDDs sufficient time to spin up upon boot/wake.

### 4. Mount now and verify

```bash
sudo mount -a
df -h /mnt/external_drive
```

You should see the 5.5TB drive listed.

### 5. (Optional) Configure custom mount path in app

If you use a different mount path, set it in the app's **Settings** tab via the `EXT_DRIVE_PATH` key, or directly in the SQLite DB:

```bash
sqlite3 /var/lib/media_upload/data.db \
  "INSERT OR REPLACE INTO settings (key, value) VALUES ('EXT_DRIVE_PATH', '/mnt/your_path');"
```

### 6. Use the Ext Drive tab

- Click **Drive Station** in the sidebar.
- The drive status card shows mount status and disk usage.
- Click **▶ Upload to Google Photos** to start scanning and uploading all media on the drive.
- Files already uploaded in previous sessions are automatically skipped (tracked in `ext_drive_files` DB table).
- Use **⏸ Pause / ▶ Resume / ✕ Stop** to control the upload independently from USB operations.

---

## Download Station (In-Page Browser & Web Download Hub)

The **Download Station** allows you to browse the web, cloud storage (Google Drive, iCloud, OneDrive, Dropbox, WeTransfer), or paste direct links to download media directly to the External Drive (`/mnt/external_drive/Downloads`). Once a download is complete, it is **automatically uploaded to Google Photos**.

- **In-Page Embedded Browser**: Built-in browser with address bar, back/forward, bookmarks, and full-screen toggle.
- **Save directly to External Drive**: Files are written straight to `/mnt/external_drive/Downloads` (or configured drive path).
- **Auto-Upload to Google Photos**: Streams downloaded media to Google Photos as soon as download completes with cross-station duplicate prevention.
- **Live Dual-Telemetry**: Live percent hero, download speed, upload speed, and active file progress.
- **Persistent SQLite Audit History**: Detailed logs of every downloaded & uploaded file with retry controls.

---

## Network File Sharing (SMB / Windows & Mac Share)

Media Upload Hub automatically shares both the **Internal Storage** and **External HDD** over the local network via Samba (SMB), allowing you to copy files to and from the server from any Mac, Windows PC, iPhone/iPad, or Android phone without opening a terminal.

### Configured Network Shares

| Share Name | Linux Mount Path | Access Permission | Best For |
|---|---|---|---|
| `Internal` | `/var/lib/media_upload` | Read / Write (Guest & User) | Internal staging, app DB, and local runs |
| `External` | `/mnt/external_drive` | Read / Write (Guest & User) | 5.5TB External HDD, Downloads, and large media libraries |

### Connecting from Your Devices

#### 🍏 macOS
1. Open **Finder**.
2. Press <kbd>Cmd</kbd> + <kbd>K</kbd> (or click **Go** &rarr; **Connect to Server...** in the top menu).
3. Enter the server URL:
   - For External HDD: `smb://<device-ip>/External` (e.g. `smb://192.168.1.50/External`)
   - For Internal Storage: `smb://<device-ip>/Internal`
4. Click **Connect** and select **Guest** (or enter your Linux user credentials).

#### 🪟 Windows PC
1. Press <kbd>Win</kbd> + <kbd>R</kbd> to open the Run dialog.
2. Enter the UNC path:
   - For External HDD: `\\<device-ip>\External` (e.g. `\\192.168.1.50\External`)
   - For Internal Storage: `\\<device-ip>\Internal`
3. Press **Enter**. (Optionally right-click the folder and select **Map network drive...** to assign a drive letter like `Z:`).

#### 📱 iPhone / iPad (iOS Files App)
1. Open the built-in **Files** app.
2. Tap the **`...`** button in the top right of the Browse tab.
3. Tap **Connect to Server**.
4. Enter `smb://<device-ip>` and tap **Connect**. Select **Guest** and tap **Next**.

#### 🤖 Android
1. Open your favorite file manager (e.g., **VLC**, **CX File Explorer**, **Solid Explorer**, or **FX File Explorer**).
2. Add a new **Network / SMB** connection and enter `<device-ip>`.

### Managing SMB Service
You can check live SMB status, copy connection URLs with 1-click, and restart the Samba daemon directly in the Web UI under the **Settings** tab &rarr; **SMB Network File Sharing** card, or via terminal:
```bash
sudo systemctl status smbd
sudo systemctl restart smbd
```
