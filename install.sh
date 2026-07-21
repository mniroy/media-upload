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

echo "Install complete. Run 'sudo systemctl start usb-hub.service' to begin."
