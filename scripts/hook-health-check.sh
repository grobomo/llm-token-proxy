#!/bin/bash
# Periodic health check for the stop hook system.
# Verifies: rules load, Haiku responds, decision is valid.
# Run via cron every hour. Writes alert file on failure.

set -euo pipefail

ALERT_FILE="$HOME/.token-proxy-hook-alert"
LOG_FILE="$HOME/.claude/hooks/hook-health.log"
HOOK_SCRIPT="$HOME/.claude/hooks/run-stop.js"

# Simulated input that SHOULD trigger a block (todo-awareness or suggest-next-step)
cat > /tmp/hook-health-input.json << 'JSON'
{
  "last_assistant_message": "Done. Committed and pushed the changes. Let me know if there's anything else you need.",
  "user_message": "looks good",
  "transcript_path": "",
  "stop_hook_active": false
}
JSON

export HOOK_INPUT_FILE=/tmp/hook-health-input.json
cd "$HOME/Documents/ProjectsCL1/_grobomo/llm-token-proxy"

STDOUT=$(timeout 20 node "$HOOK_SCRIPT" 2>/dev/null)
EXIT_CODE=$?
TS=$(date -Iseconds)

# Check results — exit 1 means hook blocked (Haiku returned NEXT/CONTINUE)
if [ $EXIT_CODE -eq 124 ]; then
  STATUS="TIMEOUT"
elif [ $EXIT_CODE -eq 1 ]; then
  STATUS="OK_BLOCKED"
elif [ $EXIT_CODE -eq 0 ]; then
  STATUS="OK_PASSED"
else
  STATUS="ERROR_${EXIT_CODE}"
fi

echo "$TS $STATUS" >> "$LOG_FILE"

# Alert on failures
case "$STATUS" in
  OK_BLOCKED|OK_PASSED)
    rm -f "$ALERT_FILE"
    ;;
  *)
    echo "$TS HOOK_HEALTH_FAIL: $STATUS" > "$ALERT_FILE"
    echo "[$TS] ALERT: Stop hook health check failed: $STATUS" >&2
    ;;
esac
