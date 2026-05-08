#!/usr/bin/env bash
# sync-to-onedrive.sh — Daily sync of portable artifacts to OneDrive folder.
# OneDrive client handles cloud upload automatically.
#
# Usage:
#   bash sync-to-onedrive.sh           # full sync
#   bash sync-to-onedrive.sh --dry-run # preview only
#
# Cron (recommended: daily at 23:50):
#   50 23 * * * bash ~/Documents/ProjectsCL1/_grobomo/llm-token-proxy/scripts/sync-to-onedrive.sh >> ~/.sync-onedrive.log 2>&1

set -uo pipefail

HOME="${HOME:-/home/ubu}"
ONEDRIVE="/mnt/c/Users/joelg/OneDrive"
DEST="$ONEDRIVE/wsl-sync"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

if [[ ! -d "$ONEDRIVE" ]]; then
  log "ERROR: OneDrive folder not found at $ONEDRIVE"
  exit 1
fi

# --- Sync manifest ---
# Format: source -> dest_subdir (relative to $DEST)
# Uses rsync for incremental copy; falls back to cp if rsync unavailable.
declare -A SYNC_MAP=(
  # Chat exports
  ["$HOME/Downloads/claude-exports"]="claude-exports"
  # Claude Code settings + memory
  ["$HOME/.claude/settings.json"]="claude-config/settings.json"
  ["$HOME/.claude/settings.local.json"]="claude-config/settings.local.json"
  # Hook runner (modules, workflows, configs — no node_modules)
  ["$HOME/.claude/hooks/run-modules"]="claude-config/hooks/run-modules"
  ["$HOME/.claude/hooks/workflows"]="claude-config/hooks/workflows"
  ["$HOME/.claude/hooks/hook-log.jsonl"]="claude-config/hooks/hook-log.jsonl"
  # Proxy data
  ["$HOME/.openclaw/workspace/token-proxy/config.yaml"]="token-proxy/config.yaml"
  ["$HOME/.openclaw/workspace/token-proxy/usage.db"]="token-proxy/usage.db"
  ["$HOME/.openclaw/workspace/token-proxy/data"]="token-proxy/data"
  # Logs
  ["$HOME/.openclaw/workspace/logs"]="logs"
  ["$HOME/.token-proxy-watchdog.log"]="logs/watchdog.log"
  ["$HOME/.token-proxy-restart.log"]="logs/restart.log"
  # Openclaw memory
  ["$HOME/.openclaw/workspace/memory"]="openclaw-memory"
  # TODO files from all projects
)

sync_item() {
  local src="$1" dest_rel="$2"
  local dest="$DEST/$dest_rel"

  if [[ ! -e "$src" ]]; then
    return 0
  fi

  if [[ "$DRY_RUN" == "true" ]]; then
    log "[dry] $src → $dest"
    return 0
  fi

  if [[ -d "$src" ]]; then
    mkdir -p "$dest"
    if command -v rsync &>/dev/null; then
      rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='*.bak.*' "$src/" "$dest/"
    else
      cp -ru "$src/." "$dest/" 2>/dev/null || true
    fi
  else
    mkdir -p "$(dirname "$dest")"
    cp -u "$src" "$dest" 2>/dev/null || cp "$src" "$dest"
  fi
}

log "=== sync-to-onedrive begin$([[ "$DRY_RUN" == "true" ]] && echo ' (DRY RUN)') ==="

for src in "${!SYNC_MAP[@]}"; do
  sync_item "$src" "${SYNC_MAP[$src]}"
done

# Collect all TODO.md files from projects
TODO_DEST="$DEST/todos"
if [[ "$DRY_RUN" == "true" ]]; then
  log "[dry] TODO.md files → $TODO_DEST/"
else
  mkdir -p "$TODO_DEST"
  find "$HOME/Documents/ProjectsCL1" "$HOME/.openclaw/workspace" -maxdepth 3 -name "TODO.md" 2>/dev/null | while read -r f; do
    # Derive a unique name from path
    name=$(echo "$f" | sed "s|$HOME/||; s|/|__|g")
    cp -u "$f" "$TODO_DEST/$name" 2>/dev/null || true
  done
fi

# Collect project memories
MEMORY_DEST="$DEST/claude-memories"
if [[ "$DRY_RUN" == "true" ]]; then
  log "[dry] Project memories → $MEMORY_DEST/"
else
  mkdir -p "$MEMORY_DEST"
  find "$HOME/.claude/projects" -type d -name "memory" 2>/dev/null | while read -r d; do
    proj=$(basename "$(dirname "$d")")
    dest_dir="$MEMORY_DEST/$proj"
    mkdir -p "$dest_dir"
    cp -u "$d"/*.md "$dest_dir/" 2>/dev/null || true
  done
fi

log "=== sync-to-onedrive done ==="
