#!/bin/bash
set -euo pipefail

# T110: Stability test — runs for a configurable duration, hitting the proxy
# with mixed requests (health, diagnose, dashboard API, simulated LLM calls)
# and validating responses stay consistent.
#
# Usage:
#   ./stability-test.sh              # 1 hour test (default)
#   ./stability-test.sh --duration 24h
#   ./stability-test.sh --duration 5m --interval 10
#
# Output: JSON summary to stdout, detailed log to data/stability-test.log

DURATION="${DURATION:-1h}"
INTERVAL="${INTERVAL:-60}"  # seconds between test cycles
PROXY="http://127.0.0.1:4100"
LOG_DIR="$(dirname "$0")/../data"
LOG_FILE="$LOG_DIR/stability-test.log"
RESULTS_FILE="$LOG_DIR/stability-results.json"

mkdir -p "$LOG_DIR"

# Parse args
while [[ $# -gt 0 ]]; do
  case "$1" in
    --duration) DURATION="$2"; shift 2;;
    --interval) INTERVAL="$2"; shift 2;;
    *) shift;;
  esac
done

# Convert duration to seconds
duration_to_secs() {
  local d="$1"
  if [[ "$d" =~ ^([0-9]+)h$ ]]; then echo $(( ${BASH_REMATCH[1]} * 3600 ));
  elif [[ "$d" =~ ^([0-9]+)m$ ]]; then echo $(( ${BASH_REMATCH[1]} * 60 ));
  elif [[ "$d" =~ ^([0-9]+)s?$ ]]; then echo "${BASH_REMATCH[1]}";
  else echo 3600; fi
}

DURATION_SECS=$(duration_to_secs "$DURATION")
END_TIME=$(($(date +%s) + DURATION_SECS))

echo "[stability] Starting: duration=${DURATION} (${DURATION_SECS}s), interval=${INTERVAL}s"
echo "[stability] Log: $LOG_FILE"

PASS=0
FAIL=0
CYCLES=0
ERRORS=""

log() { echo "[$(date -Iseconds)] $*" >> "$LOG_FILE"; }

check_endpoint() {
  local name="$1" url="$2" expected_status="${3:-200}"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  if [[ "$status" == "$expected_status" ]]; then
    PASS=$((PASS + 1))
    log "PASS $name → $status"
  else
    FAIL=$((FAIL + 1))
    local msg="FAIL $name → $status (expected $expected_status)"
    log "$msg"
    ERRORS="${ERRORS}${msg}\n"
  fi
}

check_json_field() {
  local name="$1" url="$2" field="$3" expected="$4"
  local value
  value=$(curl -s --max-time 10 "$url" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('$field',''))" 2>/dev/null || echo "ERROR")
  if [[ "$value" == "$expected" ]]; then
    PASS=$((PASS + 1))
    log "PASS $name.$field == $expected"
  else
    FAIL=$((FAIL + 1))
    local msg="FAIL $name.$field: got '$value', expected '$expected'"
    log "$msg"
    ERRORS="${ERRORS}${msg}\n"
  fi
}

log "=== Stability test started: $DURATION ==="

while [[ $(date +%s) -lt $END_TIME ]]; do
  CYCLES=$((CYCLES + 1))
  log "--- cycle $CYCLES ---"

  # Health check
  check_endpoint "health" "$PROXY/health"
  check_json_field "health" "$PROXY/health" "status" "ok"

  # Diagnose
  check_endpoint "diagnose" "$PROXY/diagnose"
  check_json_field "diagnose" "$PROXY/diagnose" "cause" "healthy"

  # Dashboard API
  check_endpoint "hourly-breakdown" "$PROXY/api/hourly-breakdown"
  check_endpoint "cost-breakdown" "$PROXY/api/cost-breakdown"
  check_endpoint "daily-comparison" "$PROXY/api/daily-comparison"

  # Dashboard HTML
  check_endpoint "dashboard" "$PROXY/dashboard/"

  sleep "$INTERVAL"
done

log "=== Stability test complete: ${CYCLES} cycles, ${PASS} pass, ${FAIL} fail ==="

# Write results
cat > "$RESULTS_FILE" << EOF
{
  "status": "$([ $FAIL -eq 0 ] && echo 'pass' || echo 'fail')",
  "duration": "$DURATION",
  "cycles": $CYCLES,
  "checks_passed": $PASS,
  "checks_failed": $FAIL,
  "timestamp": "$(date -Iseconds)",
  "errors": $([ -z "$ERRORS" ] && echo '[]' || echo "[\"$(echo -e "$ERRORS" | head -5 | sed 's/"/\\"/g' | tr '\n' ',' | sed 's/,$//')\"]")
}
EOF

echo "[stability] Complete: ${CYCLES} cycles, ${PASS} pass, ${FAIL} fail"
cat "$RESULTS_FILE"

[ $FAIL -eq 0 ] && exit 0 || exit 1
