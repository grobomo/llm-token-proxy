#!/usr/bin/env bash
# visual-test.sh — Headless Chromium screenshot of dashboard for visual verification.
#
# Usage:
#   bash visual-test.sh                    # take screenshot, open in viewer
#   bash visual-test.sh --compare          # compare against baseline
#   bash visual-test.sh --update-baseline  # save current as new baseline
#
# Requires: chromium-browser (apt install chromium-browser)
# Screenshots saved to: data/screenshots/

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$SCRIPT_DIR/../data/screenshots"
DASHBOARD_URL="${DASHBOARD_URL:-http://127.0.0.1:4100/dashboard}"
SCREENSHOT="$DATA_DIR/dashboard-latest.png"
BASELINE="$DATA_DIR/dashboard-baseline.png"

mkdir -p "$DATA_DIR"

echo "[visual-test] Capturing $DASHBOARD_URL ..."

chromium-browser \
  --headless \
  --no-sandbox \
  --disable-gpu \
  --window-size=1400,900 \
  --screenshot="$SCREENSHOT" \
  "$DASHBOARD_URL" 2>/dev/null

if [[ ! -f "$SCREENSHOT" ]]; then
  echo "[visual-test] FAIL: screenshot not captured"
  exit 1
fi

SIZE=$(stat -c %s "$SCREENSHOT" 2>/dev/null || echo 0)
echo "[visual-test] Captured: $SCREENSHOT ($SIZE bytes)"

case "${1:-}" in
  --update-baseline)
    cp "$SCREENSHOT" "$BASELINE"
    echo "[visual-test] Baseline updated: $BASELINE"
    ;;
  --compare)
    if [[ ! -f "$BASELINE" ]]; then
      echo "[visual-test] No baseline — run with --update-baseline first"
      exit 1
    fi
    # Simple byte-size comparison (crude but catches major changes)
    BASE_SIZE=$(stat -c %s "$BASELINE")
    DIFF_PCT=$(echo "scale=1; (($SIZE - $BASE_SIZE) * 100) / $BASE_SIZE" | bc 2>/dev/null || echo "0")
    echo "[visual-test] Baseline: $BASE_SIZE bytes, Current: $SIZE bytes, Delta: ${DIFF_PCT}%"
    if (( $(echo "${DIFF_PCT#-} > 20" | bc 2>/dev/null || echo 0) )); then
      echo "[visual-test] WARNING: >20% size difference — visual change detected"
      exit 1
    fi
    echo "[visual-test] PASS: within tolerance"
    ;;
  *)
    echo "[visual-test] View: $SCREENSHOT"
    ;;
esac
