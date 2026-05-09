#!/usr/bin/env bash
# safe-restart.sh — Graceful restart of token-proxy with drain + verification.
#
# Usage: bash safe-restart.sh
#
# Steps:
#   1. Send SIGTERM to running proxy (triggers 5s drain of in-flight requests)
#   2. Wait for old process to exit (up to 7s)
#   3. Start new process
#   4. Wait for health endpoint (up to 10s)
#   5. Run e2e test (real Haiku call)
#   6. If either fails: stop proxy, log failure, exit 1
#
# During drain window, the old proxy returns 503 + Retry-After: 2 for new
# requests. Claude Code retries automatically on 503.
#
# Cost: ~$0.000013 per invocation (one Haiku call for e2e test).
# This script is the ONLY authorized way to restart the proxy mid-session.
set -uo pipefail

PROXY_HEALTH="http://127.0.0.1:4100/health"
PROXY_CHAT="http://127.0.0.1:4100/v1/chat/completions"
WATCHDOG_CONF="$HOME/.openclaw/workspace/token-proxy/watchdog.conf"
RUNTIME_ENV="$HOME/.openclaw/.runtime-env"
LOG="$HOME/.token-proxy-restart.log"

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

TEST_MODEL="claude-haiku-4-5"
[[ -f "$WATCHDOG_CONF" ]] && source "$WATCHDOG_CONF"

log "=== safe-restart begin ==="

# 1. Graceful stop: SIGTERM triggers drain, then process exits cleanly
PID=$(systemctl --user show token-proxy.service -p MainPID --value 2>/dev/null)
if [[ -n "$PID" && "$PID" != "0" ]]; then
    log "sending SIGTERM to PID $PID (draining in-flight requests)..."
    systemctl --user kill --signal=SIGTERM token-proxy.service 2>/dev/null || true
    # Wait for process to exit (drain timeout is 2s in proxy, give 4s total)
    for i in $(seq 1 4); do
        if ! kill -0 "$PID" 2>/dev/null; then
            log "old process exited after ${i}s"
            break
        fi
        sleep 1
    done
    # Force kill if still alive
    if kill -0 "$PID" 2>/dev/null; then
        log "WARN: process still alive after 7s — force stopping"
        systemctl --user stop token-proxy.service
        sleep 1
    fi
else
    log "no running proxy found — starting fresh"
fi

# 2. Start new process
log "starting token-proxy.service..."
systemctl --user start token-proxy.service

# 3. Wait for health (up to 10s)
healthy=false
for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$PROXY_HEALTH" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
        healthy=true
        log "health OK after ${i}s"
        break
    fi
    sleep 1
done

if [[ "$healthy" != "true" ]]; then
    log "FAIL: health not 200 after 10s — stopping proxy"
    systemctl --user stop token-proxy.service
    exit 1
fi

# 4. E2E test
api_key=""
if [[ -f "$RUNTIME_ENV" ]]; then
    api_key=$(grep -E '^RDSEC_API_KEY=' "$RUNTIME_ENV" | head -1 | cut -d= -f2-)
fi
if [[ -z "$api_key" ]]; then
    log "WARN: no API key for e2e test — skipping (health-only verification)"
    log "=== safe-restart done (health-only) ==="
    exit 0
fi

response=$(curl -sS --compressed --max-time 12 \
    -w '\n%{http_code}' \
    -H "Authorization: Bearer $api_key" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"${TEST_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":1}" \
    "$PROXY_CHAT" 2>/dev/null)
rc=$?
http_code=$(echo "$response" | tail -1)

if [[ $rc -ne 0 || "$http_code" != "200" ]]; then
    log "FAIL: e2e test failed (curl rc=$rc, http=$http_code) — stopping proxy"
    systemctl --user stop token-proxy.service
    exit 1
fi

log "e2e test PASS (HTTP $http_code)"
log "=== safe-restart done (verified) ==="
exit 0
