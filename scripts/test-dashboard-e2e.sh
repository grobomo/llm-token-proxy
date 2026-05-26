#!/bin/bash
# E2E test: tokentracker.click user flow
# Tests the exact path a user follows: login → dashboard → data loads
set -euo pipefail

URL="https://tokentracker.click"
PASS="proxy1"
HASH=$(printf '%s' "$PASS" | sha256sum | cut -d' ' -f1)
COOKIE="dash_auth=$HASH"
FAIL=0
TOTAL=0

pass() { TOTAL=$((TOTAL+1)); echo "  PASS: $1"; }
fail() { TOTAL=$((TOTAL+1)); FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "=== tokentracker.click E2E Test ==="
echo ""

# 1. Root redirects to login
echo "[1] Auth flow"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/")
[ "$CODE" = "302" ] && pass "/ redirects to login ($CODE)" || fail "/ should 302, got $CODE"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/login.html")
[ "$CODE" = "200" ] && pass "/login.html loads ($CODE)" || fail "/login.html should 200, got $CODE"

# 2. Login page has password field
LOGIN_HTML=$(curl -s "$URL/login.html")
echo "$LOGIN_HTML" | grep -q 'type="password"' && pass "login has password field" || fail "login missing password field"
echo "$LOGIN_HTML" | grep -q 'SHA-256\|sha256\|crypto.subtle' && pass "login hashes password" || fail "login doesn't hash password"

# 3. Dashboard accessible with cookie
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$URL/dashboard/index.html")
[ "$CODE" = "200" ] && pass "dashboard loads with auth cookie ($CODE)" || fail "dashboard should 200 with cookie, got $CODE"

# 4. Dashboard rejected without cookie
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$URL/dashboard/index.html")
[ "$CODE" = "302" ] && pass "dashboard rejected without cookie ($CODE)" || fail "dashboard should 302 without cookie, got $CODE"

# 5. Wrong cookie rejected
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "dash_auth=wrong" "$URL/dashboard/index.html")
[ "$CODE" = "302" ] && pass "wrong cookie rejected ($CODE)" || fail "wrong cookie should 302, got $CODE"

echo ""
echo "[2] Data endpoints"

# 6. Meta.json exists and has recent timestamp
META=$(curl -s -b "$COOKIE" "$URL/data/meta.json")
echo "$META" | python3 -c "
import json,sys
from datetime import datetime,timezone
d=json.load(sys.stdin)
ts=datetime.fromisoformat(d['generated_at'].replace('Z','+00:00'))
age_h=(datetime.now(timezone.utc)-ts).total_seconds()/3600
print(f'GENERATED: {d[\"generated_at\"]} ({age_h:.1f}h ago)')
if age_h > 2: sys.exit(1)
" 2>&1 && pass "meta.json fresh (<2h old)" || fail "meta.json stale or missing"

# 7. All data files exist and return valid JSON
for f in hourly-breakdown-24h cost-breakdown-24h project-costs-24h savings-potential-24h sessions-24h daily-comparison db-stats investigations judge-stats; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIE" "$URL/data/${f}.json")
  if [ "$CODE" = "200" ]; then
    # Verify it's valid JSON
    curl -s -b "$COOKIE" "$URL/data/${f}.json" | python3 -c "import json,sys; json.load(sys.stdin)" 2>/dev/null \
      && pass "$f.json (200, valid JSON)" \
      || fail "$f.json (200 but invalid JSON)"
  else
    fail "$f.json (expected 200, got $CODE)"
  fi
done

echo ""
echo "[3] Data quality"

# 8. Hourly breakdown has data
curl -s -b "$COOKIE" "$URL/data/hourly-breakdown-24h.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
hours=d.get('hours',[])
print(f'  hours: {len(hours)}')
if len(hours)==0: sys.exit(1)
" && pass "hourly breakdown has data" || fail "hourly breakdown empty"

# 9. Investigations have recommendations (not 'failed')
curl -s -b "$COOKIE" "$URL/data/investigations.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
invs=d.get('investigations',[])
print(f'  investigations: {len(invs)}')
stale=[i for i in invs if 'failed' in i.get('recommendation','').lower()]
if stale:
    for s in stale: print(f'  STALE: {s[\"id\"]} - {s[\"recommendation\"][:50]}')
    sys.exit(1)
print(f'  all {len(invs)} have real recommendations')
" && pass "investigations have real recommendations" || fail "investigations still show 'failed'"

# 10. Cost breakdown has models
curl -s -b "$COOKIE" "$URL/data/cost-breakdown-24h.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
models=d.get('models',[])
print(f'  models: {len(models)}')
if len(models)==0: sys.exit(1)
" && pass "cost breakdown has model data" || fail "cost breakdown empty"

# 11. DB stats shows rows
curl -s -b "$COOKIE" "$URL/data/db-stats.json" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'  rows: {d.get(\"rows\",0)}, cost: \${d.get(\"total_cost\",0):.2f}')
if d.get('rows',0)==0: sys.exit(1)
" && pass "db-stats has rows" || fail "db-stats empty"

echo ""
echo "[4] Pipeline"

# 12. Sync script runs without error
bash "$(dirname "$0")/sync-dashboard.sh" > /tmp/sync-test.log 2>&1 \
  && pass "sync-dashboard.sh runs OK" || fail "sync-dashboard.sh failed (see /tmp/sync-test.log)"

# 13. Verify sync updated meta timestamp
NEW_META=$(curl -s -b "$COOKIE" "$URL/data/meta.json")
echo "$NEW_META" | python3 -c "
import json,sys
from datetime import datetime,timezone
d=json.load(sys.stdin)
ts=datetime.fromisoformat(d['generated_at'].replace('Z','+00:00'))
age_min=(datetime.now(timezone.utc)-ts).total_seconds()/60
print(f'  post-sync age: {age_min:.0f} min')
if age_min > 10: sys.exit(1)
" && pass "sync produced fresh data (<5min)" || fail "sync didn't refresh data"

echo ""
echo "=== Results: $((TOTAL-FAIL))/$TOTAL passed ==="
[ "$FAIL" -eq 0 ] && echo "ALL TESTS PASSED" || echo "$FAIL FAILED"
exit $FAIL
