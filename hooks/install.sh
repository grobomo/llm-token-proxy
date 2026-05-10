#!/usr/bin/env bash
# install.sh — Install spirit-check hooks into ~/.claude/hooks/run-modules/
#
# Usage: bash hooks/install.sh
#
# Installs:
#   PostToolUse/spirit-check.js  — Haiku spirit auditor (async, non-blocking)
#   PreToolUse/violation-gate.js — Reads violation state, blocks if needed
#   spirit-rules.yaml            — Already in ~/.claude/proxy/ (edit to add rules)
#
# Safe: creates .pending files first, verifies syntax, then activates.

set -euo pipefail

HOOKS_DIR="$HOME/.claude/hooks/run-modules"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Spirit Check Hook Installer ==="

# PostToolUse: spirit-check.js
SRC="$SCRIPT_DIR/PostToolUse/spirit-check.js"
DST="$HOOKS_DIR/PostToolUse/spirit-check.js"
if [ -f "$DST" ]; then
    echo "SKIP: $DST already exists"
else
    echo "Installing: spirit-check.js → PostToolUse/"
    cp "$SRC" "${DST}.pending"
    node -c "${DST}.pending" && mv "${DST}.pending" "$DST"
    echo "  ✓ Installed"
fi

# PreToolUse: violation-gate.js
SRC="$SCRIPT_DIR/PreToolUse/violation-gate.js"
DST="$HOOKS_DIR/PreToolUse/violation-gate.js"
if [ -f "$DST" ]; then
    echo "SKIP: $DST already exists"
else
    echo "Installing: violation-gate.js → PreToolUse/"
    cp "$SRC" "${DST}.pending"
    node -c "${DST}.pending" && mv "${DST}.pending" "$DST"
    echo "  ✓ Installed"
fi

# Verify spirit-rules.yaml exists
RULES="$HOME/.claude/proxy/spirit-rules.yaml"
if [ -f "$RULES" ]; then
    echo "  ✓ Spirit rules found: $RULES"
else
    echo "WARN: No spirit rules at $RULES — spirit-check will do nothing"
fi

echo ""
echo "Done. Restart Claude Code to activate."
echo "Edit rules: $RULES"
echo "Architecture: docs/hook-architecture.md"
