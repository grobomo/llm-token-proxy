'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const basicAuth = require('./auth');
const audit = require('./audit');

const PORT = process.env.PORT || 80;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const USAGE_DB_PATH = process.env.USAGE_DB || path.resolve(__dirname, 'usage.db');
const DOMAIN = process.env.DOMAIN || 'tokentracker.click';
const CERT_DIR = `/etc/letsencrypt/live/${DOMAIN}`;

audit.init();

const app = express();
app.set('trust proxy', true);

app.use(audit.middleware);
app.use(basicAuth);

// --- Usage DB (read-only) ---
let usageDb;
function getUsageDb() {
  if (!usageDb) {
    try {
      usageDb = new Database(USAGE_DB_PATH, { readonly: true });
      usageDb.pragma('journal_mode = WAL');
    } catch (err) {
      console.error('[db] Cannot open usage.db:', err.message);
      return null;
    }
  }
  return usageDb;
}

function query(sql) {
  const db = getUsageDb();
  if (!db) return [];
  try {
    return db.prepare(sql).all();
  } catch (err) {
    console.error('[query]', err.message);
    return [];
  }
}

// --- Dashboard API (mirrors local proxy endpoints) ---
app.get('/api/hourly-breakdown', (req, res) => {
  const projectRows = query(`
    SELECT strftime('%Y-%m-%dT%H', timestamp) AS hour,
           COALESCE(project, '(untagged)') AS project,
           SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY hour, project ORDER BY hour, cost DESC
  `);
  const modelRows = query(`
    SELECT strftime('%Y-%m-%dT%H', timestamp) AS hour,
           model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY hour, model ORDER BY hour, cost DESC
  `);

  const hourMap = {};
  for (const r of projectRows) {
    if (!hourMap[r.hour]) hourMap[r.hour] = { hour: r.hour, total_cost: 0, total_calls: 0, projects: [], models: [] };
    hourMap[r.hour].total_cost += r.cost || 0;
    hourMap[r.hour].total_calls += r.calls || 0;
    hourMap[r.hour].projects.push({ project: r.project, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
  }
  for (const r of modelRows) {
    if (!hourMap[r.hour]) hourMap[r.hour] = { hour: r.hour, total_cost: 0, total_calls: 0, projects: [], models: [] };
    hourMap[r.hour].models.push({ model: r.model, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
  }
  res.json({ hours: Object.values(hourMap) });
});

app.get('/api/cost-breakdown', (req, res) => {
  const models = query(`
    SELECT model, COUNT(*) AS calls, SUM(estimated_cost_usd) AS cost,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY model ORDER BY cost DESC
  `);
  const totals = models.reduce((acc, m) => {
    acc.cost += m.cost || 0;
    acc.calls += m.calls || 0;
    acc.cache_write += m.cache_write_tokens || 0;
    acc.cache_read += m.cache_read_tokens || 0;
    return acc;
  }, { cost: 0, calls: 0, cache_write: 0, cache_read: 0 });
  res.json({ models, totals });
});

app.get('/api/daily-comparison', (req, res) => {
  const today = query(`SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`);
  const yesterday = query(`SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day') AND timestamp < strftime('%Y-%m-%dT00:00:00Z', 'now')`);
  const t = today[0] || { cost: 0, calls: 0 };
  const y = yesterday[0] || { cost: 0, calls: 0 };
  res.json({
    today: { cost: parseFloat((t.cost || 0).toFixed(2)), calls: t.calls || 0 },
    yesterday: { cost: parseFloat((y.cost || 0).toFixed(2)), calls: y.calls || 0 },
  });
});

app.get('/api/savings-potential', (req, res) => {
  const costByType = query(`
    SELECT model, COUNT(*) AS calls, SUM(output_tokens) AS total_output,
           SUM(cache_write_tokens) AS total_cw, SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY model ORDER BY cost DESC
  `);
  const sessionStarts = query(`
    SELECT COUNT(*) AS sessions, SUM(cache_write_tokens) AS total_cw
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      AND cache_write_tokens > 50000
  `);
  const ss = sessionStarts[0] || { sessions: 0, total_cw: 0 };
  const cwCost = (ss.total_cw || 0) * 18.75 / 1e6;
  const savingsPerFewerRestart = ss.sessions > 1 ? cwCost / ss.sessions : 0;
  res.json({
    models: costByType.map(m => ({ model: m.model, calls: m.calls, cost: parseFloat((m.cost || 0).toFixed(2)) })),
    session_restarts: { count: ss.sessions, cache_write_cost: parseFloat(cwCost.toFixed(2)), savings_per_fewer_restart: parseFloat(savingsPerFewerRestart.toFixed(2)) },
    note: 'Primary savings lever: fewer session restarts.',
  });
});

// --- Access audit endpoint ---
app.get('/admin/access-log', (req, res) => {
  const entries = audit.getRecentAccess(100);
  const knownIps = audit.getKnownIps();

  if (req.query.format === 'html') {
    const rows = entries.map(e => `
      <tr style="border-bottom:1px solid #30363d${e.first_seen ? ';background:#1a2332' : ''}">
        <td>${e.timestamp}</td>
        <td>${e.ip}</td>
        <td>${e.path}</td>
        <td>${e.user_agent?.slice(0, 60) || ''}</td>
        <td>${e.auth_success ? 'OK' : 'FAIL'}</td>
        <td>${e.first_seen ? 'NEW' : ''}</td>
      </tr>
    `).join('');

    const ipRows = knownIps.map(k => `
      <tr><td>${k.ip}</td><td>${k.first_seen_at}</td><td>${k.last_seen_at || '-'}</td><td>${k.access_count}</td><td>${k.label || ''}</td></tr>
    `).join('');

    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Access Audit</title>
      <style>body{background:#0d1117;color:#e6edf3;font-family:monospace;padding:20px}
      table{border-collapse:collapse;width:100%;margin-bottom:24px}th,td{padding:6px 10px;text-align:left;font-size:13px}
      th{color:#8b949e;border-bottom:2px solid #30363d}h2{color:#58a6ff;margin:16px 0 8px}
      .new{color:#3fb950;font-weight:bold}</style></head><body>
      <h2>Known IPs</h2><table><tr><th>IP</th><th>First seen</th><th>Last seen</th><th>Count</th><th>Label</th></tr>${ipRows}</table>
      <h2>Recent Access (last 100)</h2><table><tr><th>Time</th><th>IP</th><th>Path</th><th>UA</th><th>Auth</th><th>New?</th></tr>${rows}</table>
      </body></html>`);
  }

  res.json({ entries, known_ips: knownIps });
});

// --- Static dashboard ---
const DASH_DIR = path.resolve(__dirname, '..', 'dashboard');
app.use('/dashboard', express.static(DASH_DIR));
app.get('/dashboard', (req, res) => res.sendFile(path.resolve(DASH_DIR, 'index.html')));
app.get('/', (req, res) => res.redirect('/dashboard'));

// Start HTTP (redirect to HTTPS if certs exist)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] HTTP listening on :${PORT}`);
  console.log(`[dashboard] usage.db: ${USAGE_DB_PATH}`);
});

// Start HTTPS if certs exist
try {
  if (fs.existsSync(path.join(CERT_DIR, 'fullchain.pem'))) {
    const https = require('https');
    const opts = {
      cert: fs.readFileSync(path.join(CERT_DIR, 'fullchain.pem')),
      key: fs.readFileSync(path.join(CERT_DIR, 'privkey.pem')),
    };
    https.createServer(opts, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`[dashboard] HTTPS listening on :${HTTPS_PORT} (${DOMAIN})`);
    });
  }
} catch (err) {
  console.log(`[dashboard] HTTPS not available: ${err.message}`);
}
