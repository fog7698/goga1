#!/bin/sh
set -e

# The VPN tunnel (xray) runs on its own VPS now, not in this container - see service/src/xray.js.
# VPN_UUID still identifies the owner's client uuid in the links this app generates, and needs to
# persist across restarts.
if [ -z "$VPN_UUID" ]; then
  VPN_UUID="$(cat /proc/sys/kernel/random/uuid)"
  echo "=================================================================="
  echo "[vpn] No VPN_UUID set - generated one for this boot: $VPN_UUID"
  echo "[vpn] Save it as a Railway service Variable to keep the same owner"
  echo "[vpn] link across restarts."
  echo "=================================================================="
fi

export VPN_UUID

exec node /app/src/index.js
