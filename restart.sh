#!/bin/bash
if [ -f .env ]; then
  export $(cat .env | grep -v '^#' | xargs)
fi
echo "$SSH_PASS" | sudo -S systemctl restart usb-hub.service
