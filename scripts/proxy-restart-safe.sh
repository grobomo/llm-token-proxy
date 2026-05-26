#!/usr/bin/env bash
# Safe Proxy Restart — coordinates with all Claude Code sessions
#
# Steps:
#   1. Inventory alive sessions
#   2. Signal sessions (write marker files)
#   3. Wait for sessions to quiesce (transcript mtime stops changing)
#   4. Pre-flight new proxy on temp port
#   5. Kill old proxy, start new
#   6. Verify new proxy healthy
#   7. Respawn all sessions from inventory
#   8. Verify sessions are alive (transcript growing)
#
# Usage:
#   bash scripts/proxy-restart-safe.sh            # full restart
#   bash scripts/proxy-restart-safe.sh --dry-run  # show what would happen
#
# Safety:
#   - If pre-flight fails: abort, no changes made
#   - If new proxy fails health check: rollback to last-known-good
#   - The calling session restarts itself LAST

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PROXY_PORT=4100
PREFLIGHT_PORT=14199
SESSIONS_DIR="$HOME/.claude/sessions"
INVENTORY="$HOME/.token-proxy/restart-inventory.json"
LOG="$HOME/.token-proxy/proxy-restart.log"
MARKER="$HOME/.claude/.proxy-restart-pending"
CONTEXT_RESET="$HOME/Documents/ProjectsCL1/_grobomo/context-reset/new_session.py"
QUIESCE_TIMEOUT=60
HEALTH_TIMEOUT=15
DRY_RUN=false
MY_PID="$$"

[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# --- Logging ---
rotate_log() {
  local max_bytes=$((10 * 1024 * 1024))
  if [[ -f "$LOG" ]] && [[ $(stat -c%s "$LOG" 2>/dev/null || echo 0) -gt $max_bytes ]]; then
    mv -f "$LOG" "${LOG}.1"
  fi
}

log() {
  local msg="[$(date '+%Y-%m-%dT%H:%M:%S')] $*"
  echo "$msg" | tee -a "$LOG"
}

rotate_log
log "=== proxy-restart-safe begin (dry_run=$DRY_RUN) ==="

# --- Step 1: Inventory alive sessions ---
log "Step 1: Inventorying active Claude Code sessions..."

alive_sessions="[]"
for f in "$SESSIONS_DIR"/*.json; do
  [[ -f "$f" ]] || continue
  pid=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('pid',''))" 2>/dev/null || echo "")
  [[ -z "$pid" ]] && continue
  kill -0 "$pid" 2>/dev/null || continue

  session_data=$(python3 -c "
import json
d = json.load(open('$f'))
print(json.dumps({'pid': d.get('pid'), 'sessionId': d.get('sessionId',''), 'cwd': d.get('cwd',''), 'project': d.get('cwd','').split('/')[-1]}))
" 2>/dev/null)
  alive_sessions=$(echo "$alive_sessions" | python3 -c "
import json, sys
arr = json.load(sys.stdin)
arr.append($session_data)
print(json.dumps(arr))
")
done

session_count=$(echo "$alive_sessions" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))")
log "  Found $session_count alive sessions"
echo "$alive_sessions" | python3 -c "
import json, sys
for s in json.load(sys.stdin):
    print(f\"  - PID {s['pid']}: {s['project']} ({s['cwd']})\")
" | tee -a "$LOG"

mkdir -p "$(dirname "$INVENTORY")"
echo "$alive_sessions" > "$INVENTORY"

if $DRY_RUN; then
  log "DRY RUN — would proceed with steps 2-8. Exiting."
  log "  Inventory written to: $INVENTORY"
  exit 0
fi

# --- Step 2: Signal sessions to save state ---
log "Step 2: Signaling sessions to save state..."
touch "$MARKER"
echo "$alive_sessions" | python3 -c "
import json, sys, os
for s in json.load(sys.stdin):
    cwd = s['cwd']
    marker = os.path.join(cwd, '.claude', '.proxy-restart-pending')
    os.makedirs(os.path.dirname(marker), exist_ok=True)
    with open(marker, 'w') as f:
        f.write('proxy restart pending\n')
    print(f'  Marker written: {marker}')
" 2>&1 | tee -a "$LOG"

# --- Step 3: Wait for sessions to quiesce ---
log "Step 3: Waiting for sessions to quiesce (max ${QUIESCE_TIMEOUT}s)..."

waited=0
while [[ $waited -lt $QUIESCE_TIMEOUT ]]; do
  all_quiet=true
  for f in "$SESSIONS_DIR"/*.json; do
    [[ -f "$f" ]] || continue
    pid=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('pid',''))" 2>/dev/null || echo "")
    [[ -z "$pid" ]] && continue
    kill -0 "$pid" 2>/dev/null || continue

    session_id=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('sessionId',''))" 2>/dev/null)
    cwd=$(python3 -c "import json; d=json.load(open('$f')); print(d.get('cwd',''))" 2>/dev/null)
    slug=$(echo "$cwd" | sed 's|/|-|g; s|^-||')
    transcript=$(find "$HOME/.claude/projects/$slug/" -name "${session_id}.jsonl" 2>/dev/null | head -1)
    if [[ -n "$transcript" ]]; then
      age=$(python3 -c "import os,time; print(int(time.time() - os.path.getmtime('$transcript')))" 2>/dev/null || echo 999)
      if [[ $age -lt 10 ]]; then
        all_quiet=false
        break
      fi
    fi
  done
  if $all_quiet; then
    log "  All sessions quiesced after ${waited}s"
    break
  fi
  sleep 2
  waited=$((waited + 2))
done
if [[ $waited -ge $QUIESCE_TIMEOUT ]]; then
  log "  WARNING: Timeout reached, some sessions may still be active. Proceeding anyway."
fi

# --- Step 4: Pre-flight new proxy on temp port ---
log "Step 4: Pre-flight testing on port $PREFLIGHT_PORT..."
cd "$PROJECT_DIR"

cleanup_preflight() {
  local pf_pid=$(lsof -ti :$PREFLIGHT_PORT 2>/dev/null)
  [[ -n "$pf_pid" ]] && kill "$pf_pid" 2>/dev/null
}
trap cleanup_preflight EXIT

PORT=$PREFLIGHT_PORT node proxy.js &>/tmp/proxy-preflight.log &
PF_PID=$!
sleep 3

if curl -sf "http://127.0.0.1:$PREFLIGHT_PORT/health" >/dev/null 2>&1; then
  log "  Pre-flight PASSED on port $PREFLIGHT_PORT"
  kill $PF_PID 2>/dev/null; wait $PF_PID 2>/dev/null
else
  log "  ABORT: Pre-flight FAILED. Current proxy left running. No changes made."
  log "  Pre-flight log: /tmp/proxy-preflight.log"
  kill $PF_PID 2>/dev/null; wait $PF_PID 2>/dev/null
  rm -f "$MARKER"
  exit 1
fi

# --- Step 5: Kill old proxy, start new ---
log "Step 5: Stopping old proxy..."
systemctl --user stop token-proxy 2>/dev/null || true

# Also kill any rogue proxy on port 4100
rogue_pid=$(lsof -ti :$PROXY_PORT 2>/dev/null || echo "")
if [[ -n "$rogue_pid" ]]; then
  log "  Killing rogue process on port $PROXY_PORT (PID $rogue_pid)"
  kill "$rogue_pid" 2>/dev/null
  sleep 2
fi

log "  Starting new proxy via systemd..."
systemctl --user start token-proxy

# --- Step 6: Verify new proxy healthy ---
log "Step 6: Verifying new proxy health..."
health_ok=false
for i in $(seq 1 $HEALTH_TIMEOUT); do
  if curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    health_ok=true
    break
  fi
  sleep 1
done

if ! $health_ok; then
  log "  CRITICAL: New proxy failed health check after ${HEALTH_TIMEOUT}s"
  log "  Attempting rollback..."
  if [[ -f "$PROJECT_DIR/.last-known-good-commit" ]]; then
    lkg=$(cat "$PROJECT_DIR/.last-known-good-commit")
    git -C "$PROJECT_DIR" stash 2>/dev/null
    git -C "$PROJECT_DIR" checkout "$lkg" 2>/dev/null
    systemctl --user restart token-proxy
    sleep 3
    if curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
      log "  Rollback successful — proxy running on LKG commit $lkg"
    else
      log "  FATAL: Rollback also failed. Manual intervention required."
    fi
  else
    log "  No .last-known-good-commit file. Cannot rollback."
  fi
  rm -f "$MARKER"
  exit 1
fi

log "  Proxy healthy on port $PROXY_PORT"
rm -f "$MARKER"

# --- Step 7: Respawn all sessions from inventory ---
log "Step 7: Respawning sessions from inventory..."

my_cwd=$(python3 -c "
import json, os
inv = json.load(open('$INVENTORY'))
my_pid = $MY_PID
# Find calling session by checking parent PIDs
import subprocess
ppid = os.getppid()
for s in inv:
    if s['pid'] == ppid or s['pid'] == my_pid:
        print(s['cwd'])
        break
" 2>/dev/null || echo "")

echo "$alive_sessions" | python3 -c "
import json, sys, subprocess, os, time

sessions = json.load(sys.stdin)
my_cwd = '$my_cwd'
context_reset = '$CONTEXT_RESET'

# Respawn other sessions first
for s in sessions:
    if s['cwd'] == my_cwd:
        continue  # skip calling session — do it last
    print(f\"  Respawning: {s['project']} ({s['cwd']})\")
    subprocess.Popen(
        ['python3', context_reset, '--project-dir', s['cwd']],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    time.sleep(2)  # stagger launches

# Respawn calling session last (this kills current tab)
if my_cwd:
    print(f'  Respawning self: {my_cwd} (will close this tab)')
    subprocess.Popen(
        ['python3', context_reset, '--close-old-tab', '--project-dir', my_cwd],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
" 2>&1 | tee -a "$LOG"

# --- Step 8: Verify (runs async — the calling session may already be dead) ---
log "Step 8: Session respawn initiated. Verification will be done by new sessions reading TODO.md."
log "=== proxy-restart-safe complete ==="
