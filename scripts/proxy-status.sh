#!/usr/bin/env bash
# Unified proxy + watchdog status check.
# Exit 0 = all healthy. Exit 1 = something needs attention.
set +e

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
PASS=0; WARN=0; FAIL=0

ok()   { echo -e "  ${GREEN}✓${NC} $1"; ((PASS++)); }
warn() { echo -e "  ${YELLOW}⚠${NC} $1"; ((WARN++)); }
fail() { echo -e "  ${RED}✗${NC} $1"; ((FAIL++)); }

echo "=== Token Proxy Status ==="
echo ""

# 1. Proxy health
echo "Proxy:"
HEALTH=$(curl -s --max-time 3 http://127.0.0.1:4100/health 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('status','?'))" 2>/dev/null || echo "?")
  UPTIME=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('uptime_human','?'))" 2>/dev/null || echo "?")
  REQS=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('requests',0))" 2>/dev/null || echo "?")
  if [ "$STATUS" = "ok" ]; then
    ok "Running (uptime: $UPTIME, requests: $REQS)"
  else
    warn "Degraded — upstream may be unreachable"
  fi
else
  fail "NOT RUNNING on port 4100"
fi

# 2. Routing config
echo ""
echo "Routing:"
BASE_URL=$(python3 ~/.claude/proxy/switch_llm_provider.py verify 2>&1 | grep ANTHROPIC_BASE_URL | awk -F= '{print $2}' | xargs)
if echo "$BASE_URL" | grep -q "127.0.0.1:4100"; then
  ok "ANTHROPIC_BASE_URL → proxy (127.0.0.1:4100)"
else
  fail "ANTHROPIC_BASE_URL → $BASE_URL (BYPASSING PROXY)"
fi

# 3. systemd service
echo ""
echo "Linux (systemd):"
if systemctl --user is-active token-proxy.service >/dev/null 2>&1; then
  ok "token-proxy.service: active"
else
  SVC_STATE=$(systemctl --user is-active token-proxy.service 2>&1 || true)
  fail "token-proxy.service: $SVC_STATE"
fi

if systemctl --user is-active token-proxy-watchdog.timer >/dev/null 2>&1; then
  NEXT=$(systemctl --user status token-proxy-watchdog.timer 2>&1 | grep -oP 'Trigger: \K.*' || echo "?")
  ok "watchdog timer: active (next: $NEXT)"
else
  TIMER_STATE=$(systemctl --user is-active token-proxy-watchdog.timer 2>&1 || true)
  warn "watchdog timer: $TIMER_STATE"
fi

# 4. Windows watchdog (best-effort from WSL)
echo ""
echo "Windows:"
WIN_TASK=$(powershell.exe -c "Get-ScheduledTask -TaskName 'TokenProxyWatchdog' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty State" 2>/dev/null | tr -d '\r\n' || echo "")
if [ "$WIN_TASK" = "Running" ] || [ "$WIN_TASK" = "Ready" ]; then
  ok "Task Scheduler: $WIN_TASK"
elif [ -n "$WIN_TASK" ]; then
  warn "Task Scheduler: $WIN_TASK (not running)"
else
  warn "Task Scheduler: TokenProxyWatchdog not found"
fi

# 5. Summary
echo ""
echo "─────────────────────────"
if [ $FAIL -gt 0 ]; then
  echo -e "${RED}UNHEALTHY${NC} — $FAIL failures, $WARN warnings"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo -e "${YELLOW}DEGRADED${NC} — $WARN warnings"
  exit 0
else
  echo -e "${GREEN}ALL HEALTHY${NC} — $PASS checks passed"
  exit 0
fi
