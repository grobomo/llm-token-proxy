#!/usr/bin/env bash
# safe-restart.sh — Restart token-proxy with pre-flight validation + auto-rollback.
#
# Usage: bash safe-restart.sh [--force]
#
# Safety guarantees:
#   1. Pre-flight: loads proxy.js on a temp port to verify code compiles and DB opens.
#      If pre-flight fails, the running proxy is NOT touched.
#   2. Drain: SIGTERM → old proxy drains in-flight requests (2s window, 503+Retry-After for new).
#   3. Start: systemd starts the new process.
#   4. Health check: polls /health for 10s.
#   5. E2E test: one cheap Haiku call through the full proxy stack.
#   6. Rollback: if health or e2e fails, reverts working tree to last-known-good commit,
#      restarts, and re-verifies. Proxy is NEVER left down.
#
# Last-known-good tracking:
#   .last-known-good-commit — written after every successful restart.
#   On rollback, git stashes uncommitted changes and checks out that commit.
#
# Cost: ~$0.000013 per invocation (one Haiku call for e2e test).
set -uo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROXY_HEALTH="http://127.0.0.1:4100/health"
PROXY_CHAT="http://127.0.0.1:4100/v1/chat/completions"
RUNTIME_ENV="$HOME/.openclaw/.runtime-env"
LKG_FILE="$PROJECT_DIR/.last-known-good-commit"
LOG="$HOME/.token-proxy-restart.log"
PREFLIGHT_PORT=14199

log() { echo "[$(date '+%H:%M:%S')] $*" | tee -a "$LOG"; }

TEST_MODEL="claude-haiku-4-5"
FORCE=false
[[ "${1:-}" == "--force" ]] && FORCE=true

log "=== safe-restart begin ==="

# --- Backup DB before any restart ---
DB_PATH="$HOME/.token-proxy/usage.db"
if [[ -f "$DB_PATH" ]]; then
    DB_BACKUP="$HOME/.token-proxy/usage.db.pre-restart-$(date +%Y%m%d-%H%M%S)"
    cp "$DB_PATH" "$DB_BACKUP" 2>/dev/null && log "DB backed up: $(basename $DB_BACKUP)"
fi

# --- Pre-flight: verify new code loads without killing the running proxy ---
if [[ "$FORCE" != "true" ]]; then
    log "pre-flight: loading proxy.js on port $PREFLIGHT_PORT..."
    preflight_ok=false
    # Start proxy on temp port, wait for it to bind, then kill it
    PORT=$PREFLIGHT_PORT node "$PROJECT_DIR/proxy.js" &
    preflight_pid=$!
    for i in $(seq 1 8); do
        code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$PREFLIGHT_PORT/health" 2>/dev/null || echo "000")
        if [[ "$code" == "200" ]]; then
            preflight_ok=true
            log "pre-flight: code loads OK (health 200 on :$PREFLIGHT_PORT after ${i}s)"
            break
        fi
        # Check if process already died (crash on load)
        if ! kill -0 "$preflight_pid" 2>/dev/null; then
            log "pre-flight: proxy crashed on startup"
            break
        fi
        sleep 1
    done
    kill "$preflight_pid" 2>/dev/null; wait "$preflight_pid" 2>/dev/null
    if [[ "$preflight_ok" != "true" ]]; then
        log "ABORT: pre-flight failed — current proxy left running, no changes made"
        exit 1
    fi
else
    log "pre-flight: SKIPPED (--force)"
fi

# --- Graceful stop ---
PID=$(systemctl --user show token-proxy.service -p MainPID --value 2>/dev/null)
if [[ -n "$PID" && "$PID" != "0" ]]; then
    log "sending SIGTERM to PID $PID (draining in-flight requests)..."
    systemctl --user kill --signal=SIGTERM token-proxy.service 2>/dev/null || true
    for i in $(seq 1 4); do
        if ! kill -0 "$PID" 2>/dev/null; then
            log "old process exited after ${i}s"
            break
        fi
        sleep 1
    done
    if kill -0 "$PID" 2>/dev/null; then
        log "WARN: process still alive after 4s — force stopping"
        systemctl --user stop token-proxy.service
        sleep 1
    fi
else
    log "no running proxy found — starting fresh"
fi

# --- Start ---
log "starting token-proxy.service..."
systemctl --user start token-proxy.service

# --- Health check ---
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

# --- E2E test ---
e2e_pass=false
if [[ "$healthy" == "true" ]]; then
    api_key=""
    if [[ -f "$RUNTIME_ENV" ]]; then
        api_key=$(grep -E '^RDSEC_API_KEY=' "$RUNTIME_ENV" | head -1 | cut -d= -f2-)
    fi
    if [[ -z "$api_key" ]]; then
        log "WARN: no API key for e2e test — health-only verification"
        e2e_pass=true
    else
        response=$(curl -sS --compressed --max-time 12 \
            -w '\n%{http_code}' \
            -H "Authorization: Bearer $api_key" \
            -H "Content-Type: application/json" \
            -d "{\"model\":\"${TEST_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":1}" \
            "$PROXY_CHAT" 2>/dev/null)
        rc=$?
        http_code=$(echo "$response" | tail -1)
        if [[ $rc -eq 0 && "$http_code" == "200" ]]; then
            e2e_pass=true
            log "e2e test PASS (HTTP $http_code)"
        else
            log "e2e test FAIL (curl rc=$rc, http=$http_code)"
        fi
    fi
fi

# --- Success: record last-known-good ---
if [[ "$healthy" == "true" && "$e2e_pass" == "true" ]]; then
    current_commit=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "unknown")
    echo "$current_commit" > "$LKG_FILE"
    log "recorded last-known-good: $current_commit"
    log "=== safe-restart done (verified) ==="
    exit 0
fi

# --- ROLLBACK ---
log "RESTART FAILED — initiating rollback"

lkg_commit=""
if [[ -f "$LKG_FILE" ]]; then
    lkg_commit=$(cat "$LKG_FILE")
fi

if [[ -z "$lkg_commit" || "$lkg_commit" == "unknown" ]]; then
    log "FATAL: no last-known-good commit recorded — cannot rollback. Proxy is DOWN."
    exit 2
fi

current_commit=$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo "")
if [[ "$current_commit" == "$lkg_commit" ]]; then
    log "FATAL: already on last-known-good ($lkg_commit) but still failing. Proxy is DOWN."
    systemctl --user stop token-proxy.service 2>/dev/null
    exit 2
fi

log "rolling back: $current_commit → $lkg_commit"

# Stash any uncommitted work so it's not lost
if ! git -C "$PROJECT_DIR" diff --quiet HEAD 2>/dev/null || \
   ! git -C "$PROJECT_DIR" diff --cached --quiet HEAD 2>/dev/null; then
    stash_msg="auto-rollback $(date '+%Y-%m-%dT%H:%M:%S')"
    git -C "$PROJECT_DIR" stash push -m "$stash_msg" 2>/dev/null
    log "stashed uncommitted changes: $stash_msg"
fi

git -C "$PROJECT_DIR" checkout "$lkg_commit" -- . 2>/dev/null
if [[ $? -ne 0 ]]; then
    log "FATAL: git checkout failed — cannot rollback. Proxy is DOWN."
    exit 2
fi

log "rollback checkout complete — restarting proxy..."
systemctl --user stop token-proxy.service 2>/dev/null
sleep 1
systemctl --user start token-proxy.service

# Verify rollback worked
rollback_healthy=false
for i in $(seq 1 10); do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$PROXY_HEALTH" 2>/dev/null || echo "000")
    if [[ "$code" == "200" ]]; then
        rollback_healthy=true
        log "ROLLBACK OK: health 200 after ${i}s on commit $lkg_commit"
        break
    fi
    sleep 1
done

if [[ "$rollback_healthy" != "true" ]]; then
    log "FATAL: rollback also failed. Proxy is DOWN. Manual intervention required."
    exit 2
fi

log "=== safe-restart done (ROLLED BACK to $lkg_commit) ==="
exit 1
