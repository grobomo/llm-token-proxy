#!/usr/bin/env node
'use strict';

/**
 * Token Proxy Watchdog — Windows Edition
 *
 * Persistent process that monitors the WSL-hosted proxy and restarts it
 * when it goes down. Designed to run at login via Windows Task Scheduler.
 *
 * Usage:
 *   node scripts/watchdog-win.js          # foreground (for testing)
 *   node scripts/watchdog-win.js --install # register Task Scheduler job
 *   node scripts/watchdog-win.js --remove  # unregister Task Scheduler job
 *   node scripts/watchdog-win.js --status  # show current state
 *
 * Behavior:
 *   - Checks http://127.0.0.1:4100/health every CHECK_INTERVAL_MS (30s)
 *   - After FAIL_THRESHOLD consecutive failures (3), restarts proxy in WSL
 *   - After restart, waits RESTART_COOLDOWN_MS (60s) before checking again
 *   - Logs to ~/.token-proxy/watchdog-win.log
 *   - Writes ~/.token-proxy/watchdog-state.json with current status
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── Config ──────────────────────────────────────────────────────────────
const HEALTH_URL         = process.env.PROXY_HEALTH_URL || 'http://127.0.0.1:4100/health';
const CHECK_INTERVAL_MS  = parseInt(process.env.CHECK_INTERVAL_MS, 10) || 30_000;
const FAIL_THRESHOLD     = parseInt(process.env.FAIL_THRESHOLD, 10) || 3;
const RESTART_COOLDOWN_MS= parseInt(process.env.RESTART_COOLDOWN_MS, 10) || 60_000;
const HEALTH_TIMEOUT_MS  = parseInt(process.env.HEALTH_TIMEOUT_MS, 10) || 5_000;

const HOME        = os.homedir();
const STATE_DIR   = path.join(HOME, '.token-proxy');
const LOG_FILE    = path.join(STATE_DIR, 'watchdog-win.log');
const STATE_FILE  = path.join(STATE_DIR, 'watchdog-state.json');
const DISABLE_FLAG= path.join(STATE_DIR, 'watchdog-disabled');

// Project dir: where proxy.js and config.yaml live
const PROJECT_DIR = path.resolve(__dirname, '..');
const WSL_PROJECT = '/home/ubu/Documents/ProjectsCL1/_grobomo/llm-token-tracker';

const TASK_NAME = 'TokenProxyWatchdog';

// ── Logging ─────────────────────────────────────────────────────────────
function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try {
    ensureDir(STATE_DIR);
    fs.appendFileSync(LOG_FILE, line);
    // Rotate: keep last 10K lines
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 1_000_000) {
      const content = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = content.split('\n');
      fs.writeFileSync(LOG_FILE, lines.slice(-5000).join('\n'));
      log('log rotated (kept last 5000 lines)');
    }
  } catch {}
}

function writeState(state) {
  try {
    ensureDir(STATE_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      ...state,
      updated_at: new Date().toISOString(),
      pid: process.pid,
    }, null, 2));
  } catch {}
}

// ── Health check ────────────────────────────────────────────────────────
async function checkHealth() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const body = await res.json();
      return { ok: true, status: res.status, uptime: body.uptime_human || '?' };
    }
    return { ok: false, status: res.status, error: `HTTP ${res.status}` };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, status: 0, error: err.code || err.message || String(err) };
  }
}

// ── Restart proxy ───────────────────────────────────────────────────────
function restartProxy() {
  log('restarting proxy in WSL...');

  // Kill existing
  try {
    execSync(`wsl -e bash -c "pkill -f 'node proxy.js' 2>/dev/null; sleep 1"`, {
      timeout: 10_000, stdio: 'pipe',
    });
  } catch {}

  // Ensure config.yaml exists (copy from example if missing)
  const configPath = path.join(PROJECT_DIR, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    const examplePath = path.join(PROJECT_DIR, 'config.example.yaml');
    if (fs.existsSync(examplePath)) {
      log('config.yaml missing — copying from config.example.yaml');
      fs.copyFileSync(examplePath, configPath);
    } else {
      log('ERROR: no config.yaml and no config.example.yaml');
      return false;
    }
  }

  // Start proxy in a tmux session inside WSL. tmux creates a persistent
  // daemon that survives WSL shell exits and watchdog restarts.
  const tmuxSession = 'token-proxy';
  try {
    // Kill existing tmux session if present
    try {
      execSync(`wsl -e bash -c "tmux kill-session -t ${tmuxSession} 2>/dev/null"`, {
        timeout: 5_000, stdio: 'pipe',
      });
    } catch {}

    execSync(
      `wsl -e bash -c "tmux new-session -d -s ${tmuxSession} 'cd ${WSL_PROJECT} && exec node proxy.js 2>&1 | tee -a /tmp/proxy.log'"`,
      { timeout: 10_000, stdio: 'pipe' }
    );
    log(`spawned proxy in tmux session '${tmuxSession}'`);
  } catch (err) {
    log(`restart failed: ${err.message}`);
    return false;
  }

  // Wait for health
  return new Promise((resolve) => {
    let attempts = 0;
    const check = async () => {
      attempts++;
      const h = await checkHealth();
      if (h.ok) {
        log(`proxy restarted successfully (health OK after ${attempts}s)`);
        resolve(true);
        return;
      }
      if (attempts >= 15) {
        log(`proxy restart FAILED — health still down after 15 attempts`);
        resolve(false);
        return;
      }
      setTimeout(check, 1000);
    };
    setTimeout(check, 2000);
  });
}

// ── Main loop ───────────────────────────────────────────────────────────
async function main() {
  let consecutiveFailures = 0;
  let totalChecks = 0;
  let totalRestarts = 0;
  let lastRestart = 0;

  log(`watchdog started (pid=${process.pid}, interval=${CHECK_INTERVAL_MS}ms, threshold=${FAIL_THRESHOLD})`);
  writeState({ status: 'running', consecutiveFailures: 0, totalChecks: 0, totalRestarts: 0 });

  const tick = async () => {
    // Check disable flag
    if (fs.existsSync(DISABLE_FLAG)) {
      writeState({ status: 'disabled', consecutiveFailures, totalChecks, totalRestarts });
      return;
    }

    // Skip if in restart cooldown
    if (Date.now() - lastRestart < RESTART_COOLDOWN_MS) {
      return;
    }

    totalChecks++;
    const health = await checkHealth();

    if (health.ok) {
      if (consecutiveFailures > 0) {
        log(`proxy recovered (was down for ${consecutiveFailures} checks)`);
      }
      consecutiveFailures = 0;
      writeState({ status: 'healthy', uptime: health.uptime, consecutiveFailures, totalChecks, totalRestarts });
    } else {
      consecutiveFailures++;
      log(`health check FAILED (${consecutiveFailures}/${FAIL_THRESHOLD}): ${health.error}`);
      writeState({ status: 'failing', error: health.error, consecutiveFailures, totalChecks, totalRestarts });

      if (consecutiveFailures >= FAIL_THRESHOLD) {
        log(`threshold reached — attempting restart (attempt #${totalRestarts + 1})`);
        const ok = await restartProxy();
        totalRestarts++;
        lastRestart = Date.now();
        if (ok) {
          consecutiveFailures = 0;
          writeState({ status: 'restarted', consecutiveFailures, totalChecks, totalRestarts });
        } else {
          writeState({ status: 'restart_failed', consecutiveFailures, totalChecks, totalRestarts });
        }
      }
    }
  };

  // Run first check immediately
  await tick();
  setInterval(tick, CHECK_INTERVAL_MS);
}

// ── CLI commands ────────────────────────────────────────────────────────
const arg = process.argv[2];

if (arg === '--install') {
  const nodePath = process.execPath.replace(/\//g, '\\');
  const scriptPath = path.resolve(__filename).replace(/\//g, '\\');

  // Create the task — runs at login, restarts on failure
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Token Proxy Watchdog — monitors and restarts the LLM token proxy</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>${scriptPath}</Arguments>
      <WorkingDirectory>${path.dirname(scriptPath).replace(/\//g, '\\')}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;

  const tmpXml = path.join(os.tmpdir(), 'watchdog-task.xml');
  fs.writeFileSync(tmpXml, '\uFEFF' + xml, 'utf16le');

  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F 2>NUL`, { stdio: 'pipe' });
  } catch {}

  try {
    execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXml}"`, { stdio: 'inherit' });
    console.log(`\nInstalled Task Scheduler job: ${TASK_NAME}`);
    console.log('It will start automatically at next login.');
    console.log(`To start now: schtasks /Run /TN "${TASK_NAME}"`);
  } catch (err) {
    console.error('Failed to create task:', err.message);
    console.error('Try running from an elevated (admin) prompt.');
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpXml); } catch {}
  }
  process.exit(0);
}

if (arg === '--remove') {
  try {
    execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'inherit' });
    console.log(`Removed Task Scheduler job: ${TASK_NAME}`);
  } catch (err) {
    console.error('Failed to remove task (may not exist):', err.message);
  }
  process.exit(0);
}

if (arg === '--status') {
  console.log('Token Proxy Watchdog — Status');
  console.log('─'.repeat(40));

  // Read state file
  if (fs.existsSync(STATE_FILE)) {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log(`Status:       ${state.status}`);
    console.log(`Last updated: ${state.updated_at}`);
    console.log(`PID:          ${state.pid}`);
    console.log(`Checks:       ${state.totalChecks}`);
    console.log(`Restarts:     ${state.totalRestarts}`);
    console.log(`Failures:     ${state.consecutiveFailures} consecutive`);
    if (state.uptime) console.log(`Proxy uptime: ${state.uptime}`);
    if (state.error)  console.log(`Last error:   ${state.error}`);
  } else {
    console.log('No state file found — watchdog may not have run yet.');
  }

  // Check task scheduler
  console.log();
  try {
    const info = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST 2>NUL`, {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const statusLine = info.split('\n').find(l => l.includes('Status:'));
    console.log(`Scheduler:    ${statusLine ? statusLine.trim() : 'registered'}`);
  } catch {
    console.log('Scheduler:    NOT registered (run --install)');
  }

  // Quick health check
  console.log();
  checkHealth().then(h => {
    console.log(`Live health:  ${h.ok ? `OK (uptime: ${h.uptime})` : `FAIL (${h.error})`}`);
  });
  return;
}

if (arg === '--help' || arg === '-h') {
  console.log(`Usage: node ${path.basename(__filename)} [--install|--remove|--status|--help]`);
  console.log('  (no args)  Run watchdog in foreground');
  console.log('  --install  Register as Windows Task Scheduler job');
  console.log('  --remove   Unregister Task Scheduler job');
  console.log('  --status   Show current watchdog state');
  process.exit(0);
}

// Default: run the main loop
main().catch(err => {
  log(`FATAL: ${err.message}`);
  process.exit(1);
});
