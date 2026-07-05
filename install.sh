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

# Setup systemd service
sed "s|WORKING_DIRECTORY|$PWD|g" usb-hub.service | sed "s|USER_NAME|$USER|g" > /tmp/usb-hub.service
sudo cp /tmp/usb-hub.service /etc/systemd/system/usb-hub.service
sudo systemctl daemon-reload
sudo systemctl enable usb-hub.service

echo "Install complete. Run 'sudo systemctl start usb-hub.service' to begin."
