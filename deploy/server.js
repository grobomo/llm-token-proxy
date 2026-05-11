'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const { authenticate, requireAdmin, getSessionInfo } = require('./auth');
const audit = require('./audit');

const PORT = process.env.PORT || 80;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const USAGE_DB_PATH = process.env.USAGE_DB || path.resolve(__dirname, 'usage.db');
const DOMAIN = process.env.DOMAIN || 'tokentracker.click';
const CERT_DIR = `/etc/letsencrypt/live/${DOMAIN}`;
const STARTED_AT = new Date();
let totalRequests = 0;

audit.init();

const app = express();
app.set('trust proxy', true);

app.use(audit.middleware);
app.use(express.json());
app.use((req, res, next) => { totalRequests++; next(); });

// --- Public routes (no auth required) ---
app.get('/login', (req, res) => {
  res.sendFile(path.resolve(__dirname, 'login.html'));
});

app.post('/auth/login', (req, res) => {
  const { password } = req.body || {};
  const { createSessionForPassword } = require('./auth');
  const result = createSessionForPassword(password);
  if (result) {
    const cookieName = 'dash_session';
    const maxAge = parseInt(process.env.SESSION_TTL_HOURS || '24') * 3600;
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.set('Set-Cookie', `${cookieName}=${result.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`);
    return res.json({ ok: true, role: result.role });
  }
  return res.status(401).json({ ok: false });
});

// Root redirects to login (public)
app.get('/', (req, res) => res.redirect('/login'));

// Everything below requires a valid session
app.use(authenticate);

// --- Usage DB (read-only, auto-reopens when file changes) ---
let usageDb;
let usageDbMtime = 0;
function getUsageDb() {
  try {
    const stat = fs.statSync(USAGE_DB_PATH);
    const mtime = stat.mtimeMs;
    if (usageDb && mtime === usageDbMtime) return usageDb;
    if (usageDb) { try { usageDb.close(); } catch {} }
    usageDb = new Database(USAGE_DB_PATH, { readonly: true });
    usageDb.pragma('journal_mode = WAL');
    usageDbMtime = mtime;
  } catch (err) {
    console.error('[db] Cannot open usage.db:', err.message);
    return null;
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

function parseRange(req) {
  const r = req.query.range || '24h';
  const map = {
    '1h':  '-1 hours',
    '6h':  '-6 hours',
    '12h': '-12 hours',
    '24h': '-24 hours',
    '7d':  '-7 days',
    '30d': '-30 days',
  };
  return map[r] || '-24 hours';
}

// --- Dashboard API (mirrors local proxy endpoints) ---
app.get('/api/hourly-breakdown', (req, res) => {
  const interval = parseRange(req);
  const projectRows = query(`
    SELECT strftime('%Y-%m-%dT%H', timestamp) AS hour,
           COALESCE(project, '(untagged)') AS project,
           SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY hour, project ORDER BY hour, cost DESC
  `);
  const modelRows = query(`
    SELECT strftime('%Y-%m-%dT%H', timestamp) AS hour,
           model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
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
  const interval = parseRange(req);
  const models = query(`
    SELECT model, COUNT(*) AS calls, SUM(estimated_cost_usd) AS cost,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens,
           SUM(cache_write_tokens) AS cache_write_tokens
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
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
  const interval = parseRange(req);
  const costByType = query(`
    SELECT model, COUNT(*) AS calls, SUM(output_tokens) AS total_output,
           SUM(cache_write_tokens) AS total_cw, SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY model ORDER BY cost DESC
  `);
  const sessionStarts = query(`
    SELECT COUNT(*) AS sessions, SUM(cache_write_tokens) AS total_cw
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
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

app.get('/api/project-costs', (req, res) => {
  const interval = parseRange(req);
  const projects = query(`
    SELECT COALESCE(project, '(untagged)') AS project, COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND http_status BETWEEN 200 AND 299
    GROUP BY project ORDER BY cost DESC LIMIT 10
  `);
  const totalCost = projects.reduce((s, p) => s + (p.cost || 0), 0);
  res.json({ projects, total_cost: parseFloat(totalCost.toFixed(2)) });
});

app.get('/api/sessions', (req, res) => {
  const interval = parseRange(req);
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const sessions = query(`
    SELECT session_id, COALESCE(project, '(untagged)') AS project, consumer,
           GROUP_CONCAT(DISTINCT model) AS models, COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS cost,
           MIN(timestamp) AS first_call, MAX(timestamp) AS last_call,
           ROUND((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 24 * 60, 1) AS duration_min
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND session_id IS NOT NULL AND http_status BETWEEN 200 AND 299
    GROUP BY session_id ORDER BY cost DESC LIMIT ${limit}
  `);
  const totalCost = sessions.reduce((s, r) => s + (r.cost || 0), 0);
  res.json({
    sessions: sessions.map(s => ({ ...s, cost: parseFloat((s.cost || 0).toFixed(4)), models: s.models ? s.models.split(',') : [] })),
    total_cost: parseFloat(totalCost.toFixed(2)),
    total_calls: sessions.reduce((s, r) => s + (r.calls || 0), 0),
    session_count: sessions.length,
  });
});

app.get('/api/judge-stats', (req, res) => {
  res.json({ by_gate: [], recent: [] });
});

// --- /api/digest — Styled HTML usage digest ---
app.get('/api/digest', (req, res) => {
  try {
    const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
    const interval = period === 'weekly' ? '-7 days' : '-1 days';
    const prevInterval = period === 'weekly' ? '-14 days' : '-2 days';
    const label = period === 'weekly' ? 'Weekly' : 'Daily';

    const current = query(`SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests,
      SUM(input_tokens) AS input_tok, SUM(output_tokens) AS output_tok,
      SUM(cache_read_tokens) AS cache_r, SUM(cache_write_tokens) AS cache_w
      FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ','now','${interval}')`)[0] || {};
    const prev = query(`SELECT SUM(estimated_cost_usd) AS cost FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ','now','${prevInterval}')
        AND timestamp < strftime('%Y-%m-%dT%H:%M:%fZ','now','${interval}')`)[0] || {};
    const mtd = query(`SELECT SUM(estimated_cost_usd) AS cost FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-01T00:00:00Z','now')`)[0] || {};
    const models = query(`SELECT model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests
      FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ','now','${interval}')
      GROUP BY model ORDER BY cost DESC LIMIT 5`);
    const projects = query(`SELECT COALESCE(project,'untagged') AS project,
      SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ','now','${interval}')
      GROUP BY project ORDER BY cost DESC LIMIT 8`);
    const trend = query(`SELECT strftime('%m-%d',timestamp) AS day, SUM(estimated_cost_usd) AS cost
      FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z','now','-7 days')
      GROUP BY day ORDER BY day ASC`);

    const cost = current.cost || 0;
    const prevCost = prev.cost || 0;
    const change = prevCost > 0 ? ((cost - prevCost) / prevCost * 100) : 0;
    const changeIcon = change > 5 ? '&#9650;' : change < -5 ? '&#9660;' : '&#8212;';
    const changeColor = change > 5 ? '#e74c3c' : change < -5 ? '#27ae60' : '#7f8c8d';
    const fmt = (v) => `$${(v||0).toFixed(2)}`;
    const fmtK = (v) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}K` : String(v||0);
    const maxTrend = Math.max(...trend.map(t => t.cost||0), 0.01);
    const bars = trend.map(t => {
      const pct = Math.round(((t.cost||0)/maxTrend)*100);
      return `<div style="display:inline-block;width:28px;margin:0 1px;text-align:center;vertical-align:bottom">
        <div style="background:#3498db;width:100%;height:${Math.max(pct,2)}px;border-radius:2px 2px 0 0"></div>
        <div style="font-size:9px;color:#999">${t.day}</div></div>`;
    }).join('');
    const modelRows = models.map(m => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${m.model}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmt(m.cost)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${m.requests}</td></tr>`).join('');
    const projectRows = projects.map(p => `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${p.project}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmt(p.cost)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${p.requests}</td></tr>`).join('');
    const dateStr = new Date().toLocaleDateString('en-US',{weekday:'long',month:'long',day:'numeric',year:'numeric'});

    res.set('Content-Type','text/html; charset=utf-8');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Token Tracker ${label} Digest</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#2c3e50,#3498db);padding:24px 24px 16px;color:#fff">
    <h1 style="margin:0;font-size:20px;font-weight:600">Token Tracker &mdash; ${label} Digest</h1>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${dateStr}</p></div>
  <div style="padding:20px 24px">
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${fmt(cost)}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">${label} Spend</div>
        <div style="font-size:12px;color:${changeColor};margin-top:2px">${changeIcon} ${Math.abs(change).toFixed(0)}% vs prev</div></div>
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${current.requests||0}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">Requests</div></div>
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${fmt(mtd.cost)}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">MTD Spend</div></div></div>
    <div style="margin-bottom:20px"><h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">7-Day Trend</h3><div style="height:80px;display:flex;align-items:flex-end">${bars}</div></div>
    <div style="margin-bottom:20px"><h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Tokens</h3><div style="font-size:13px;color:#555">Input: <strong>${fmtK(current.input_tok)}</strong> &middot; Output: <strong>${fmtK(current.output_tok)}</strong> &middot; Cache Read: <strong>${fmtK(current.cache_r)}</strong> &middot; Cache Write: <strong>${fmtK(current.cache_w)}</strong></div></div>
    ${modelRows?`<div style="margin-bottom:20px"><h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Top Models</h3><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:#7f8c8d;font-size:11px"><th style="text-align:left;padding:4px 8px">Model</th><th style="text-align:right;padding:4px 8px">Cost</th><th style="text-align:right;padding:4px 8px">Reqs</th></tr>${modelRows}</table></div>`:''}
    ${projectRows?`<div style="margin-bottom:20px"><h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Top Projects</h3><table style="width:100%;border-collapse:collapse;font-size:13px"><tr style="color:#7f8c8d;font-size:11px"><th style="text-align:left;padding:4px 8px">Project</th><th style="text-align:right;padding:4px 8px">Cost</th><th style="text-align:right;padding:4px 8px">Reqs</th></tr>${projectRows}</table></div>`:''}</div>
  <div style="padding:12px 24px;background:#f8f9fa;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee">Generated by <a href="/dashboard" style="color:#3498db;text-decoration:none">Token Tracker</a></div>
</div></body></html>`);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

app.get('/api/db-stats', (req, res) => {
  const stats = query(`
    SELECT COUNT(*) AS rows,
           MIN(timestamp) AS oldest,
           MAX(timestamp) AS newest,
           COUNT(DISTINCT model) AS models,
           COUNT(DISTINCT project) AS projects,
           COUNT(DISTINCT session_id) AS sessions,
           SUM(estimated_cost_usd) AS total_cost
    FROM usage_log
  `);
  const s = stats[0] || {};
  res.json({
    rows: s.rows || 0,
    oldest: s.oldest || null,
    newest: s.newest || null,
    models: s.models || 0,
    projects: s.projects || 0,
    sessions: s.sessions || 0,
    total_cost: parseFloat((s.total_cost || 0).toFixed(2)),
  });
});

app.get('/api/uptime', (req, res) => {
  const uptimeMs = Date.now() - STARTED_AT.getTime();
  const s = Math.floor(uptimeMs / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const uptimeHuman = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;

  const last24h = query(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS ok,
           SUM(CASE WHEN http_status >= 500 THEN 1 ELSE 0 END) AS errors
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
  `);
  const stats = last24h[0] || { total: 0, ok: 0, errors: 0 };
  const denominator = (stats.ok || 0) + (stats.errors || 0);
  const successRate = denominator > 0 ? parseFloat(((stats.ok / denominator) * 100).toFixed(1)) : 100;

  res.json({
    started_at: STARTED_AT.toISOString(),
    uptime_seconds: Math.floor(uptimeMs / 1000),
    uptime_human: uptimeHuman,
    requests_this_session: totalRequests,
    total_requests: totalRequests,
    last_24h: {
      total: stats.total || 0,
      success: stats.ok || 0,
      errors: stats.errors || 0,
      success_rate: successRate,
    },
  });
});

app.get('/api/cache-estimation', (req, res) => {
  const interval = parseRange(req);
  const stats = query(`
    SELECT upstream, cache_estimated, COUNT(*) AS calls,
           SUM(cache_read_tokens) AS total_cache_read,
           SUM(cache_write_tokens) AS total_cache_write,
           SUM(estimated_cost_usd) AS total_cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY upstream, cache_estimated ORDER BY total_cost DESC
  `);
  const summary = { estimated_calls: 0, estimated_cost: 0, actual_calls: 0, actual_cost: 0 };
  for (const r of stats) {
    if (r.cache_estimated) {
      summary.estimated_calls += r.calls || 0;
      summary.estimated_cost += r.total_cost || 0;
    } else {
      summary.actual_calls += r.calls || 0;
      summary.actual_cost += r.total_cost || 0;
    }
  }
  summary.estimated_cost = parseFloat(summary.estimated_cost.toFixed(4));
  summary.actual_cost = parseFloat(summary.actual_cost.toFixed(4));
  res.json({ rows: stats, summary });
});

// --- /diagnose — stub for dashboard health panel ---
app.get('/diagnose', (req, res) => {
  const db = getUsageDb();
  const upstreams = {};
  if (db) {
    // Check latest data freshness as a proxy for upstream health
    const latest = query(`SELECT MAX(timestamp) AS ts FROM usage_log`);
    const lastTs = latest[0]?.ts;
    const ageMin = lastTs ? (Date.now() - new Date(lastTs).getTime()) / 60000 : Infinity;
    upstreams['usage-db'] = ageMin < 60 ? 'reachable' : 'stale';
  } else {
    upstreams['usage-db'] = 'unreachable';
  }
  res.json({
    status: db ? 'ok' : 'no_db',
    mode: 'deploy',
    upstreams,
    ts: new Date().toISOString(),
  });
});

// --- /api/ — self-documenting API index ---
app.get('/api/', (req, res) => {
  res.json({
    name: 'Token Tracker API (deploy)',
    endpoints: [
      { method: 'GET', path: '/api/', description: 'This index' },
      { method: 'GET', path: '/api/hourly-breakdown', description: 'Hourly spend with model + project breakdown', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/cost-breakdown', description: 'Model-level cost + cache economics', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/daily-comparison', description: 'Today vs yesterday spend' },
      { method: 'GET', path: '/api/savings-potential', description: 'Cost optimization levers', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/project-costs', description: 'Top projects by cost', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/sessions', description: 'Per-session cost analytics', params: ['range=1h|6h|12h|24h|7d|30d', 'limit=<n>'] },
      { method: 'GET', path: '/api/cache-estimation', description: 'Cache estimation stats', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/judge-stats', description: 'Judge decision stats' },
      { method: 'GET', path: '/api/digest', description: 'Styled HTML email digest of usage', params: ['period=daily|weekly'] },
      { method: 'GET', path: '/api/db-stats', description: 'Database stats: row count, date range, total cost' },
      { method: 'GET', path: '/api/uptime', description: 'Server uptime and 24h success rate' },
      { method: 'GET', path: '/api/export', description: 'Download usage data as CSV', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/export-excel', description: 'Download Excel workbook with chart', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/diagnose', description: 'Health/diagnostic check' },
    ],
  });
});

// --- /api/export-excel — Excel workbook with chart ---
app.get('/api/export-excel', async (req, res) => {
  try {
    const { buildExcelReport } = require('../lib/excel-export');
    const range = (req.query.range || '24h').replace(/[^a-zA-Z0-9]/g, '');
    const dbAdapter = { query: (sql) => query(sql) };
    const buf = await buildExcelReport(dbAdapter, range);
    const filename = `token-tracker-${range}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buf);
  } catch (err) {
    console.error('[export-excel]', err.message);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// --- /api/export — CSV download ---
app.get('/api/export', (req, res) => {
  const interval = parseRange(req);
  const rows = query(`
    SELECT timestamp, model, upstream, consumer, project, session_id,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           cache_estimated, estimated_cost_usd, http_status, duration_ms
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    ORDER BY timestamp DESC
  `);

  const cols = [
    'timestamp', 'model', 'upstream', 'consumer', 'project', 'session_id',
    'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
    'cache_estimated', 'estimated_cost_usd', 'http_status', 'duration_ms',
  ];
  const csvEsc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [cols.join(',')];
  for (const row of rows) {
    lines.push(cols.map(c => csvEsc(row[c])).join(','));
  }

  const range = (req.query.range || '24h').replace(/[^a-zA-Z0-9]/g, '');
  const filename = `token-usage-${range}-${new Date().toISOString().slice(0, 10)}.csv`;
  res.set('Content-Type', 'text/csv');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(lines.join('\n'));
});

// Favicon
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="14" fill="#0d1117" stroke="#58a6ff" stroke-width="2"/><text x="16" y="21" text-anchor="middle" font-size="14" font-family="monospace" fill="#58a6ff">T</text></svg>`;
app.get('/favicon.ico', (req, res) => {
  res.set('Content-Type', 'image/svg+xml');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(FAVICON_SVG);
});

// --- Admin endpoints (admin role required) ---
app.use('/admin', requireAdmin);

app.get('/admin/sessions', (req, res) => {
  res.json(getSessionInfo());
});

app.get('/admin/access-log', (req, res) => {
  const filter = req.query.filter || 'all'; // all | admin | viewer
  const entries = audit.getRecentAccess(100, filter);
  const knownIps = audit.getKnownIps();

  if (req.query.format === 'html') {
    const esc = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const rows = entries.map(e => `
      <tr style="border-bottom:1px solid #30363d${e.first_seen ? ';background:#1a2332' : ''}">
        <td>${esc(e.timestamp)}</td>
        <td>${esc(e.ip)}</td>
        <td>${esc(e.path)}</td>
        <td>${esc((e.user_agent || '').slice(0, 60))}</td>
        <td>${e.auth_success ? 'OK' : 'FAIL'}</td>
        <td>${e.first_seen ? 'NEW' : ''}</td>
      </tr>
    `).join('');

    const ipRows = knownIps.map(k => `
      <tr><td>${esc(k.ip)}</td><td>${esc(k.first_seen_at)}</td><td>${esc(k.last_seen_at || '-')}</td><td>${k.access_count}</td><td>${esc(k.label || '')}</td></tr>
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
