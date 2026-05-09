#!/usr/bin/env bash
# watchdog-ctl — operator interface to the token-proxy watchdog.
#
# Usage:
#   watchdog-ctl status              show current state
#   watchdog-ctl maintenance [secs]  defer rollback for a planned restart
#                                    (default 300s; bumps existing flag)
#   watchdog-ctl resume              clear maintenance flag now
#   watchdog-ctl disable             stop watchdog from doing anything
#   watchdog-ctl enable              re-enable a previously disabled watchdog
#   watchdog-ctl tick                run one watchdog cycle right now
#   watchdog-ctl audit               dry-run: report config drift, no edits
#   watchdog-ctl enforce-now         alias for tick (forces enforcement pass)
#   watchdog-ctl tail                tail -f the watchdog log
#
# Maintenance and disable are filesystem flags; the watchdog reads them on
# every tick.

set -euo pipefail

CONF="${WATCHDOG_CONF:-$HOME/.config/llm-token-proxy/watchdog.conf}"
[[ -f "$CONF" ]] && source "$CONF"
WATCHDOG_SCRIPT="${WATCHDOG_SCRIPT:-$(dirname "$0")/watchdog.sh}"

MAINTENANCE_FLAG="${MAINTENANCE_FLAG:-$HOME/.token-proxy-maintenance}"
DISABLE_FLAG="${DISABLE_FLAG:-$HOME/.token-proxy-watchdog-disabled}"
MAINTENANCE_TTL_SECONDS="${MAINTENANCE_TTL_SECONDS:-300}"
LOG_FILE="$HOME/.token-proxy-watchdog.log"

cmd="${1:-status}"

case "$cmd" in
    status)
        echo "watchdog config: $CONF"
        echo "  proxy health:    ${PROXY_HEALTH_URL:-http://127.0.0.1:4100/health}"
        echo "  proxy chat:      ${PROXY_CHAT_URL:-http://127.0.0.1:4100/v1/chat/completions}"
        echo "  test model:      ${TEST_MODEL:-claude-haiku-4-5}"
        echo "  maintenance ttl: ${MAINTENANCE_TTL_SECONDS}s"
        echo "  on-fail hook:    ${WATCHDOG_ON_FAIL_HOOK:-(none)}"
        echo "  on-pass hook:    ${WATCHDOG_ON_PASS_HOOK:-(none)}"
        echo
        if [[ -f "$DISABLE_FLAG" ]]; then
            echo "STATE: DISABLED  (rm $DISABLE_FLAG to re-enable, or: watchdog-ctl enable)"
        elif [[ -f "$MAINTENANCE_FLAG" ]]; then
            age=$(( $(date +%s) - $(stat -c %Y "$MAINTENANCE_FLAG") ))
            remaining=$(( MAINTENANCE_TTL_SECONDS - age ))
            if (( remaining > 0 )); then
                echo "STATE: MAINTENANCE  (${remaining}s remaining)"
            else
                echo "STATE: ARMED  (maintenance flag stale, age=${age}s)"
            fi
        else
            echo "STATE: ARMED"
        fi
        echo
        echo "current proxy health:"
        printf '  '
        curl -s -o /dev/null -w 'HTTP %{http_code} (%{time_total}s)\n' --max-time 3 "${PROXY_HEALTH_URL:-http://127.0.0.1:4100/health}" || true
        echo
        if [[ -f "$HOME/.token-proxy-watchdog-last" ]]; then
            echo "last result: $(cat "$HOME/.token-proxy-watchdog-last")"
        fi
        if [[ -f "$HOME/.token-proxy-watchdog-alert" ]]; then
            echo
            echo "ALERT FILE PRESENT:"
            sed 's/^/  /' "$HOME/.token-proxy-watchdog-alert"
        fi
        ;;
    maintenance)
        ttl="${2:-$MAINTENANCE_TTL_SECONDS}"
        touch "$MAINTENANCE_FLAG"
        echo "Maintenance flag set: $MAINTENANCE_FLAG"
        echo "Watchdog will skip rollback for the next ${ttl}s (TTL from config)."
        ;;
    resume)
        rm -f "$MAINTENANCE_FLAG"
        echo "Maintenance flag cleared. Watchdog re-armed."
        ;;
    disable)
        touch "$DISABLE_FLAG"
        echo "Watchdog disabled: $DISABLE_FLAG"
        echo "Note: timer keeps running but every tick is a no-op until re-enabled."
        ;;
    enable)
        rm -f "$DISABLE_FLAG"
        echo "Watchdog re-enabled."
        ;;
    tick)
        exec "$WATCHDOG_SCRIPT"
        ;;
    tail)
        exec tail -f "$LOG_FILE"
        ;;
    *)
        echo "Unknown command: $cmd" >&2
        sed -n '3,15p' "$0" >&2
        exit 2
        ;;
esac
