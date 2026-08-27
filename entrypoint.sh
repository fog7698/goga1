#!/bin/sh
set -e

# xray runs plain VLESS-over-WebSocket now (no REALITY, no x25519 keypair) - Railway's raw TCP
# Proxy silently drops this project's handshakes, so TLS is terminated at Railway's own HTTPS
# edge instead and forwarded to xray as a local WebSocket upgrade. Only the owner's client uuid
# still needs to persist across restarts.
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
