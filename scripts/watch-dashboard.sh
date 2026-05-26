#!/bin/bash
# Auto-deploy dashboard/index.html to S3 whenever it changes.
# Polls file mtime every 10s (inotify doesn't work on WSL Windows mounts).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD="$PROJECT_DIR/dashboard/index.html"
BUCKET="${BUCKET:-tokentracker-data}"
CF_DIST="${CF_DISTRIBUTION_ID:-E9NULDLVDW9ZJ}"

LAST_MTIME=$(stat -c %Y "$DASHBOARD" 2>/dev/null || echo 0)
echo "[watch] Watching $DASHBOARD (poll every 10s)..."

while true; do
  sleep 10
  CURRENT_MTIME=$(stat -c %Y "$DASHBOARD" 2>/dev/null || echo 0)

  if [ "$CURRENT_MTIME" != "$LAST_MTIME" ]; then
    LAST_MTIME="$CURRENT_MTIME"
    echo "[watch] $(date -Iseconds) Change detected, deploying..."

    aws s3 cp "$DASHBOARD" "s3://${BUCKET}/dashboard/index.html" \
      --content-type "text/html" --region us-east-1 2>/dev/null && \
      echo "[watch] $(date -Iseconds) S3 OK" || \
      { echo "[watch] $(date -Iseconds) S3 FAILED"; continue; }

    aws cloudfront create-invalidation --distribution-id "$CF_DIST" \
      --paths "/dashboard/*" --region us-east-1 >/dev/null 2>&1 && \
      echo "[watch] $(date -Iseconds) CloudFront invalidated" || \
      echo "[watch] $(date -Iseconds) CF invalidation failed"
  fi
done
