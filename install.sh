#!/bin/bash
set -e

# Setup directories
sudo mkdir -p /var/lib/media_upload/staging
sudo chown -R $USER:$USER /var/lib/media_upload

# Setup python venv
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Setup udev rule
sudo cp 99-usb-hub.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger

# Setup systemd service for main app
sed "s|WORKING_DIRECTORY|$PWD|g" usb-hub.service | sed "s|USER_NAME|$USER|g" > /tmp/usb-hub.service
sudo cp /tmp/usb-hub.service /etc/systemd/system/usb-hub.service
sudo systemctl daemon-reload
sudo systemctl enable usb-hub.service

# Setup filebrowser
echo "Installing Filebrowser..."
curl -fsSL https://raw.githubusercontent.com/filebrowser/get/master/get.sh | sudo bash
sudo mkdir -p /var/lib/media_upload/fb_root
sudo ln -sf /var/lib/media_upload/staging /var/lib/media_upload/fb_root/internal
sudo ln -sf /mnt/external_drive /var/lib/media_upload/fb_root/external
sudo chown -R $USER:$USER /var/lib/media_upload/fb_root

if [ ! -f /var/lib/media_upload/filebrowser.db ]; then
    filebrowser config init -d /var/lib/media_upload/filebrowser.db --auth.method=noauth
    filebrowser users add admin adminadminadmin -d /var/lib/media_upload/filebrowser.db --perm.admin || true
    sudo chown $USER:$USER /var/lib/media_upload/filebrowser.db
fi

# Setup systemd service for filebrowser
sed "s|USER_NAME|$USER|g" filebrowser.service > /tmp/filebrowser.service
sudo cp /tmp/filebrowser.service /etc/systemd/system/filebrowser.service
sudo systemctl daemon-reload
sudo systemctl enable filebrowser.service

# Setup Samba (SMB) network file sharing for Internal & External drives
echo "Setting up Samba (SMB) Network File Sharing..."
if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y || true
    sudo apt-get install -y samba smbclient wsdd || sudo apt-get install -y samba smbclient || true
fi

# Ensure mount paths and permissions
sudo mkdir -p /mnt/external_drive
sudo chown -R $USER:$USER /mnt/external_drive 2>/dev/null || true
sudo chmod -R 0775 /var/lib/media_upload 2>/dev/null || true

# Configure smb.conf
if [ -f /etc/samba/smb.conf ] && [ ! -f /etc/samba/smb.conf.backup ]; then
    sudo cp /etc/samba/smb.conf /etc/samba/smb.conf.backup
fi

sed "s|USER_NAME|$USER|g" smb.conf.template > /tmp/smb.conf
sudo cp /tmp/smb.conf /etc/samba/smb.conf

# Restart and enable Samba services
sudo systemctl restart smbd 2>/dev/null || sudo service smbd restart 2>/dev/null || true
sudo systemctl enable smbd 2>/dev/null || true
sudo systemctl restart nmbd 2>/dev/null || sudo service nmbd restart 2>/dev/null || true
sudo systemctl enable nmbd 2>/dev/null || true
# Setup wsdd service for Windows network discovery
if [ -f wsdd.service ]; then
    sudo cp wsdd.service /etc/systemd/system/wsdd.service
    sudo systemctl daemon-reload
    sudo systemctl enable --now wsdd.service 2>/dev/null || true
fi

echo "Install complete. Run 'sudo systemctl start usb-hub.service' to begin."

