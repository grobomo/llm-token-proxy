#!/bin/bash
# Sync usage.db to the Lightsail dashboard instance.
# Run via systemd timer every 5 minutes.

set -euo pipefail

INSTANCE="token-proxy-dashboard"
REMOTE_PATH="/opt/dashboard/usage.db"
LOCAL_DB="${USAGE_DB:-$HOME/.token-proxy/usage.db}"

if [ ! -f "$LOCAL_DB" ]; then
  echo "[sync] usage.db not found at $LOCAL_DB"
  exit 1
fi

rsync -az --timeout=30 "$LOCAL_DB" "${INSTANCE}:${REMOTE_PATH}" 2>/dev/null && \
  echo "[sync] $(date -Iseconds) OK ($(stat -c%s "$LOCAL_DB") bytes)" || \
  echo "[sync] $(date -Iseconds) FAILED"
