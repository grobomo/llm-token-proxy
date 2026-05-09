#!/bin/bash
# Install haiku gates into Claude Code hooks.
# Usage: ./install.sh [gate-name]
#   ./install.sh stop          — install stop-analysis-gate
#   ./install.sh post-tool-use — install post-tool-use-gate
#   ./install.sh all           — install all gates
#
# Prereqs: proxy running at :4100, LLM_PROXY_AUTH set in ~/.claude/settings.json

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOOKS_DIR="$HOME/.claude/hooks"
STOP_MODULES="$HOOKS_DIR/run-modules/Stop"
PTU_MODULES="$HOOKS_DIR/run-modules/PostToolUse"

install_haiku_client() {
  echo "→ Installing haiku-client.js to $HOOKS_DIR/"
  cp "$SCRIPT_DIR/haiku-client.js" "$HOOKS_DIR/haiku-client.js"
}

install_stop() {
  echo "→ Installing stop-analysis-gate.js to $STOP_MODULES/"
  mkdir -p "$STOP_MODULES"
  cp "$SCRIPT_DIR/stop-analysis-gate.js" "$STOP_MODULES/stop-analysis-gate.js"
  echo "  Done. Gate will fire on every Stop event."
  echo "  Analysis written to: $HOOKS_DIR/stop-analysis.md"
  echo "  Rules: ~/.claude/proxy/stop-haiku-rules.yaml (create if missing)"
}

install_post_tool_use() {
  echo "→ Installing post-tool-use-gate.js to $PTU_MODULES/"
  mkdir -p "$PTU_MODULES"
  cp "$SCRIPT_DIR/post-tool-use-gate.js" "$PTU_MODULES/post-tool-use-gate.js"
  echo "  Done. Gate will fire on every PostToolUse event (30% sample + always for Bash/Write/Edit)."
  echo "  Analysis written to: $HOOKS_DIR/post-tool-analysis.md"
  echo "  Decision log: $HOOKS_DIR/tool-audit-decisions.jsonl"
  echo "  Rules (optional): ~/.claude/proxy/tool-audit-rules.yaml"
}

case "${1:-all}" in
  stop)
    install_haiku_client
    install_stop
    ;;
  post-tool-use|ptu)
    install_haiku_client
    install_post_tool_use
    ;;
  all)
    install_haiku_client
    install_stop
    install_post_tool_use
    ;;
  *)
    echo "Usage: $0 [stop|post-tool-use|all]"
    exit 1
    ;;
esac

echo ""
echo "✓ Gates installed. Verify proxy is running: curl -s http://127.0.0.1:4100/health"
echo "  Logs: $HOOKS_DIR/hook-log.jsonl"
