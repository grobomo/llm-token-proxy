#!/usr/bin/env bash
# Token Proxy Watchdog — End-to-End Self-Test
#
# Runs as a systemd user timer (recommended: every 5 min). Each tick:
#   1. Sends a real LLM call through the proxy (default: 1-token Haiku
#      completion, ~8 input + 1 output tokens, with Accept-Encoding so
#      curl --compressed validates Content-Encoding/body integrity).
#      This is the only way to catch failure modes where the proxy is up
#      (HTTP /health = 200) but real LLM forwarding is broken (auth
#      misconfig, body parsing, schema mismatch, encoding mismatch).
#   2. On PASS: clears any stale alert.
#   3. On FAIL: writes ~/.token-proxy-watchdog-alert with diagnostic info.
#      Optionally executes $WATCHDOG_ON_FAIL_HOOK if set (e.g., to flip
#      consumer configs to direct-routing mode in your own setup).
#
# Cost estimate (2026-05-08): ~$0.000013 per tick at default settings.
#   Anthropic public pricing for Haiku 4.5: $1/M input, $5/M output.
#   At 5-min interval: 288 ticks/day → ~$0.0037/day → ~$1.37/year.
#
# Operator overrides (file flags in $HOME):
#   .token-proxy-watchdog-disabled  → full off, no decisions made
#   .token-proxy-maintenance        → defer for ${MAINTENANCE_TTL_SECONDS}s
#
# Required env (or in watchdog.conf):
#   TEST_API_KEY    The API key the proxy expects (Authorization: Bearer ...)
#                   If not set, watchdog will look for the var named in
#                   $TEST_API_KEY_VAR inside $RUNTIME_ENV_FILE.

set -uo pipefail

# --- Defaults (override via env or watchdog.conf) ---
PROXY_HEALTH_URL="${PROXY_HEALTH_URL:-http://127.0.0.1:4100/health}"
PROXY_CHAT_URL="${PROXY_CHAT_URL:-http://127.0.0.1:4100/v1/chat/completions}"
TEST_MODEL="${TEST_MODEL:-claude-haiku-4-5}"
TEST_TIMEOUT="${TEST_TIMEOUT:-12}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-5}"

# Auth: either pass TEST_API_KEY directly, or point at a key=value env file
# and tell us the var name to look up there.
TEST_API_KEY="${TEST_API_KEY:-}"
TEST_API_KEY_VAR="${TEST_API_KEY_VAR:-LLM_API_KEY}"
RUNTIME_ENV_FILE="${RUNTIME_ENV_FILE:-$HOME/.config/llm-token-proxy/runtime.env}"

# Optional hook: invoked on state transitions (PASS→FAIL or FAIL→PASS).
# Receives one arg: PASS or FAIL. Use this to flip consumer configs in your
# own stack. Watchdog never aborts the tick if the hook fails.
WATCHDOG_ON_FAIL_HOOK="${WATCHDOG_ON_FAIL_HOOK:-}"
WATCHDOG_ON_PASS_HOOK="${WATCHDOG_ON_PASS_HOOK:-}"

MAINTENANCE_FLAG="${MAINTENANCE_FLAG:-$HOME/.token-proxy-maintenance}"
MAINTENANCE_TTL_SECONDS="${MAINTENANCE_TTL_SECONDS:-300}"
DISABLE_FLAG="${DISABLE_FLAG:-$HOME/.token-proxy-watchdog-disabled}"

LOG_FILE="${LOG_FILE:-$HOME/.token-proxy-watchdog.log}"
ALERT_FILE="${ALERT_FILE:-$HOME/.token-proxy-watchdog-alert}"
LAST_RESULT_FILE="${LAST_RESULT_FILE:-$HOME/.token-proxy-watchdog-last}"

# Source runtime config last so it can override anything above.
CONF_FILE="${CONF_FILE:-$HOME/.config/llm-token-proxy/watchdog.conf}"
if [[ -f "$CONF_FILE" ]]; then
    # shellcheck source=/dev/null
    source "$CONF_FILE"
fi

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG_FILE"
}

resolve_api_key() {
    if [[ -n "$TEST_API_KEY" ]]; then
        echo "$TEST_API_KEY"; return 0
    fi
    if [[ -f "$RUNTIME_ENV_FILE" ]]; then
        local v
        v=$(grep -E "^${TEST_API_KEY_VAR}=" "$RUNTIME_ENV_FILE" | head -1 | cut -d= -f2-)
        if [[ -n "$v" ]]; then echo "$v"; return 0; fi
    fi
    return 1
}

verify_proxy_functional() {
    local api_key
    if ! api_key=$(resolve_api_key); then
        log "[verify] no API key (set TEST_API_KEY or put $TEST_API_KEY_VAR in $RUNTIME_ENV_FILE)"
        return 1
    fi

    # --compressed: curl sends Accept-Encoding AND auto-decompresses the
    # response. If the proxy ever ships a Content-Encoding mismatch (e.g.
    # gzip header over a plain body), curl exits non-zero — caught here.
    local body http_code response
    response=$(curl -sS --compressed --max-time "$TEST_TIMEOUT" \
        -w '\n__HTTP_CODE__%{http_code}' \
        -H "Authorization: Bearer $api_key" \
        -H "Content-Type: application/json" \
        -d "{\"model\":\"${TEST_MODEL}\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":1}" \
        "$PROXY_CHAT_URL" 2>/dev/null)
    local rc=$?
    if [[ $rc -ne 0 ]]; then
        log "[verify] curl failed (rc=$rc) — proxy unreachable, timeout, or compression mismatch"
        return 1
    fi

    http_code="${response##*__HTTP_CODE__}"
    body="${response%__HTTP_CODE__*}"

    if [[ "$http_code" != "200" ]]; then
        log "[verify] HTTP $http_code from proxy: $(echo "$body" | head -c 200)"
        return 1
    fi
    # Validate response shape (OpenAI-compat).
    if ! echo "$body" | jq -e '.choices[0].message.content' >/dev/null 2>&1; then
        log "[verify] HTTP 200 but invalid response shape: $(echo "$body" | head -c 200)"
        return 1
    fi
    log "[verify] ✅ end-to-end ${TEST_MODEL} call OK (with compression)"
    return 0
}

write_alert() {
    cat > "$ALERT_FILE" <<ALERT
TOKEN PROXY WATCHDOG — FAIL
===========================
Time: $(date '+%Y-%m-%d %H:%M:%S %Z')
Reason: End-to-end ${TEST_MODEL} call through ${PROXY_CHAT_URL} failed.

Investigate:
  - Service: systemctl --user status token-proxy.service --no-pager -l
  - Recent: journalctl --user -u token-proxy.service --no-pager -n 50
  - Test:   curl -sS --compressed -H "Authorization: Bearer <key>" \\
              -H 'Content-Type: application/json' \\
              -d '{"model":"${TEST_MODEL}","max_tokens":1,"messages":[{"role":"user","content":"ok"}]}' \\
              ${PROXY_CHAT_URL}

Log: $LOG_FILE
ALERT
    log "[alert] wrote $ALERT_FILE"
}

run_hook() {
    local hook="$1" arg="$2"
    [[ -z "$hook" || ! -x "$hook" ]] && return 0
    log "[hook] running $hook $arg"
    "$hook" "$arg" >> "$LOG_FILE" 2>&1 || log "[hook] returned non-zero (continuing)"
}

# --- Main ---

if [[ -f "$DISABLE_FLAG" ]]; then
    exit 0  # operator override
fi

if [[ -f "$MAINTENANCE_FLAG" ]]; then
    flag_age=$(( $(date +%s) - $(stat -c %Y "$MAINTENANCE_FLAG" 2>/dev/null || echo 0) ))
    if [[ "$flag_age" -lt "$MAINTENANCE_TTL_SECONDS" ]]; then
        log "[maintenance] active (age=${flag_age}s) — skipping tick"
        exit 0
    else
        log "[maintenance] flag stale (age=${flag_age}s) — ignoring"
    fi
fi

prev_state=""
[[ -f "$LAST_RESULT_FILE" ]] && prev_state=$(awk '{print $1}' "$LAST_RESULT_FILE")

if verify_proxy_functional; then
    [[ -f "$ALERT_FILE" ]] && { rm -f "$ALERT_FILE"; log "[main] cleared stale alert"; }
    echo "PASS $(date -Iseconds)" > "$LAST_RESULT_FILE"
    if [[ "$prev_state" == "FAIL" ]]; then
        log "[main] state transition FAIL → PASS"
        run_hook "$WATCHDOG_ON_PASS_HOOK" PASS
    fi
else
    write_alert
    echo "FAIL $(date -Iseconds)" > "$LAST_RESULT_FILE"
    if [[ "$prev_state" != "FAIL" ]]; then
        log "[main] state transition ${prev_state:-NEW} → FAIL"
        run_hook "$WATCHDOG_ON_FAIL_HOOK" FAIL
    fi
fi

exit 0
