#!/usr/bin/env bash
# Blueprint MCP Relay — ensures the Windows-side relay is running.
# Called by hook or manually before sessions that need browser automation.
#
# Architecture:
#   WSL Claude Code → stdio → Windows node MCP server → ws://localhost:5555 → relay → Chrome extension
#
# The MCP server runs ON WINDOWS (via node.exe --child) so it can reach
# the relay at Windows localhost. Claude Code talks to it via cross-boundary stdio.
# This script just ensures the relay process is alive on Windows.

# Resolve paths dynamically
WIN_HOME=$(wslpath "$(powershell.exe -Command 'Write-Host $env:USERPROFILE' 2>/dev/null | tr -d '\r')")
RELAY_SCRIPT="${WIN_HOME}/Documents/ProjectsCL1/_shared/MCP/blueprint-extra-mcp/start-relay.js"
WIN_RELAY_SCRIPT=$(wslpath -w "$RELAY_SCRIPT")

check_relay() {
  powershell.exe -Command "Test-NetConnection -ComputerName localhost -Port 5555 -InformationLevel Quiet -WarningAction SilentlyContinue" 2>/dev/null | grep -qi "true"
}

start_relay() {
  echo "[blueprint-relay] Starting relay on Windows..."
  powershell.exe -Command "Start-Process -FilePath 'node' -ArgumentList '\"$WIN_RELAY_SCRIPT\"' -WindowStyle Hidden" 2>/dev/null
  sleep 2
}

status() {
  if check_relay; then
    echo "[blueprint-relay] Relay is RUNNING on Windows localhost:5555"
    return 0
  else
    echo "[blueprint-relay] Relay is NOT running"
    return 1
  fi
}

ensure() {
  if check_relay; then
    echo "[blueprint-relay] Relay already running"
    return 0
  fi
  start_relay
  if check_relay; then
    echo "[blueprint-relay] Relay started successfully"
    return 0
  else
    echo "[blueprint-relay] ERROR: Failed to start relay" >&2
    return 1
  fi
}

stop() {
  echo "[blueprint-relay] Stopping relay..."
  powershell.exe -Command "Get-Process node | Where-Object { \$_.MainWindowTitle -eq '' } | ForEach-Object { Stop-Process -Id \$_.Id -Force }" 2>/dev/null
  echo "[blueprint-relay] Stopped"
}

case "${1:-ensure}" in
  ensure) ensure ;;
  start)  start_relay ;;
  stop)   stop ;;
  status) status ;;
  *)      echo "Usage: $0 {ensure|start|stop|status}" ;;
esac
