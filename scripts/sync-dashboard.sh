#!/bin/bash
# Sync usage.db + dashboard HTML to S3 for Lambda data generation.
# Run via systemd timer every hour.

set -euo pipefail

BUCKET="${BUCKET:-tokentracker-data}"
LOCAL_DB="${USAGE_DB:-$HOME/.token-proxy/usage.db}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DASHBOARD_HTML="${PROJECT_DIR}/dashboard/index.html"

if [ ! -f "$LOCAL_DB" ]; then
  echo "[sync] usage.db not found at $LOCAL_DB"
  exit 1
fi

# Checkpoint WAL so all data is in the main DB file before upload
sqlite3 "$LOCAL_DB" "PRAGMA wal_checkpoint(PASSIVE);" 2>/dev/null

aws s3 cp "$LOCAL_DB" "s3://${BUCKET}/usage.db" --region us-east-1 2>/dev/null && \
  echo "[sync] $(date -Iseconds) S3 OK ($(stat -c%s "$LOCAL_DB") bytes)" || \
  { echo "[sync] $(date -Iseconds) S3 FAILED"; exit 1; }

# Deploy dashboard HTML on every sync (ensures public site stays current)
if [ -f "$DASHBOARD_HTML" ]; then
  aws s3 cp "$DASHBOARD_HTML" "s3://${BUCKET}/dashboard/index.html" \
    --content-type "text/html" --region us-east-1 2>/dev/null && \
    echo "[sync] $(date -Iseconds) HTML deployed" || \
    echo "[sync] $(date -Iseconds) HTML deploy FAILED"
fi

# Invoke Lambda to regenerate dashboard JSON from the uploaded DB
aws lambda invoke --function-name tokentracker-generate-data --region us-east-1 /tmp/sync-lambda-out.json 2>/dev/null && \
  echo "[sync] $(date -Iseconds) Lambda OK ($(cat /tmp/sync-lambda-out.json))" || \
  echo "[sync] $(date -Iseconds) Lambda FAILED"

# Invalidate CloudFront cache so users see fresh data immediately
CF_DIST="${CF_DISTRIBUTION_ID:-E9NULDLVDW9ZJ}"
aws cloudfront create-invalidation --distribution-id "$CF_DIST" --paths "/data/*" --region us-east-1 2>/dev/null && \
  echo "[sync] $(date -Iseconds) CloudFront invalidation OK" || \
  echo "[sync] $(date -Iseconds) CloudFront invalidation FAILED"
