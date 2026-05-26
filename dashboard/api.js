'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const yaml     = require('js-yaml');
const db       = require('../db');

const ResponseCache = require('../lib/cache');

const router = express.Router();
const apiCache = new ResponseCache({ ttlSeconds: 30, maxEntries: 50 });

router.use(apiCache.middleware());

router.get('/cache-stats', (req, res) => {
  res.set('X-Cache', 'BYPASS');
  res.json(apiCache.stats());
});

// ---------------------------------------------------------------------------
// GET /api/ — Self-documenting API index
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  res.set('X-Cache', 'BYPASS');
  res.json({
    name: 'Token Tracker API',
    version: '0.1.0',
    endpoints: [
      { method: 'GET', path: '/api/', description: 'This index - lists all endpoints' },
      { method: 'GET', path: '/api/summary', description: 'Dashboard summary (totals, by consumer/model/project)', params: ['period=today|7d|30d|all'] },
      { method: 'GET', path: '/api/usage', description: 'Query usage rows', params: ['period=today|7d|30d|all', 'group=consumer|model|project|task|none', 'consumer=<filter>', 'limit=<n>'] },
      { method: 'GET', path: '/api/budget', description: 'Monthly budget status vs configured limit' },
      { method: 'GET', path: '/api/hourly', description: 'Hourly spend for spike chart', params: ['period=today|7d'] },
      { method: 'GET', path: '/api/hourly-breakdown', description: 'Hourly spend with model + project breakdown', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/top-operations', description: 'Top N most expensive calls', params: ['period=today|7d|30d', 'limit=<n>'] },
      { method: 'GET', path: '/api/cost-breakdown', description: 'Model-level cost + cache economics', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/project-costs', description: 'Top projects by cost', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/savings-potential', description: 'Cost optimization levers', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/daily-comparison', description: 'Today vs yesterday spend', params: ['tz_offset=<minutes>'] },
      { method: 'GET', path: '/api/cache-estimation', description: 'Cache estimation stats (estimated vs actual)', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/cache-stats', description: 'Response cache hit/miss stats' },
      { method: 'GET', path: '/api/sessions', description: 'Per-session cost analytics', params: ['range=1h|6h|12h|24h|7d|30d', 'limit=<n>'] },
      { method: 'GET', path: '/api/export', description: 'Download usage data as CSV', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/export-excel', description: 'Download Excel workbook with chart', params: ['range=1h|6h|12h|24h|7d|30d'] },
      { method: 'GET', path: '/api/digest', description: 'Styled HTML email digest of usage', params: ['period=daily|weekly'] },
      { method: 'GET', path: '/api/db-stats', description: 'Database stats: row count, date range, total cost' },
      { method: 'GET', path: '/api/uptime', description: 'Process uptime + historical availability (success rate, 5xx count)' },
      { method: 'GET', path: '/api/investigations', description: 'Active cost investigations (anomaly detection + Haiku analysis)', params: ['status=active|acknowledged|resolved|all'] },
      { method: 'POST', path: '/api/investigations/:id/acknowledge', description: 'Acknowledge a cost investigation (localhost only)' },
      { method: 'GET', path: '/api/fleet', description: 'Active Claude Code sessions with cost enrichment' },
      { method: 'POST', path: '/api/purge', description: 'Delete usage data older than N days (localhost only)', params: ['body: {days: 90, dryRun: true|false}'] },
      { method: 'POST', path: '/api/backfill-cache', description: 'Retroactively estimate cache tokens (localhost only)', params: ['body: {dryRun: true|false}'] },
    ],
  });
});

// Parse ?range= query param into SQL interval. Defaults to 24h.
function parseRange(req) {
  const r = req.query.range || '24h';
  const map = {
    '1h':  '-1 hours',
    '6h':  '-6 hours',
    '12h': '-12 hours',
    '24h': '-24 hours',
    '7d':  '-7 days',
    '30d': '-30 days',
    '90d': '-90 days',
  };
  return map[r] || '-24 hours';
}

// ---------------------------------------------------------------------------
// GET /api/uptime — Process uptime + historical availability from DB
// ---------------------------------------------------------------------------
router.get('/uptime', (req, res) => {
  res.set('X-Cache', 'BYPASS');
  const uptimeMs = Date.now() - (global.__proxyStartedAt || Date.now());
  const s = Math.floor(uptimeMs / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);

  let dbStats = {};
  try {
    const firstRow = db.query(`SELECT timestamp FROM usage_log ORDER BY id ASC LIMIT 1`);
    const totalRows = db.query(`SELECT COUNT(*) AS cnt FROM usage_log`);
    const errRows = db.query(`SELECT COUNT(*) AS cnt FROM usage_log WHERE http_status >= 500`);
    const last24h = db.query(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN http_status >= 500 THEN 1 ELSE 0 END) AS errors_5xx,
             SUM(CASE WHEN http_status BETWEEN 400 AND 499 THEN 1 ELSE 0 END) AS errors_4xx,
             SUM(CASE WHEN http_status BETWEEN 200 AND 299 THEN 1 ELSE 0 END) AS success
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `);
    const l = last24h[0] || {};
    const proxied = (l.success || 0) + (l.errors_5xx || 0);
    const successRate = proxied > 0 ? ((l.success || 0) / proxied * 100) : 100;

    dbStats = {
      first_request: firstRow[0]?.timestamp || null,
      total_requests: totalRows[0]?.cnt || 0,
      total_5xx: errRows[0]?.cnt || 0,
      last_24h: {
        requests: l.total || 0,
        proxied: proxied,
        success: l.success || 0,
        errors_5xx: l.errors_5xx || 0,
        errors_4xx: l.errors_4xx || 0,
        success_rate: parseFloat(successRate.toFixed(2)),
      },
    };
  } catch (e) {
    dbStats = { error: e.message };
  }

  res.json({
    started_at: global.__proxyStartedAt ? new Date(global.__proxyStartedAt).toISOString() : null,
    uptime_seconds: Math.floor(uptimeMs / 1000),
    uptime_human: d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`,
    requests_this_session: global.__proxyRequestCount || 0,
    errors_this_session: global.__proxyErrorCount || 0,
    ...dbStats,
  });
});

// Load config for budget limit
function getConfig() {
  try {
    const configPath = path.resolve(__dirname, '..', 'config.yaml');
    return yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// GET /api/usage
// Query params:
//   period   = today | 7d | 30d | all   (default: today)
//   group    = consumer | model | none  (default: none → raw rows)
//   consumer = <string>                  (optional filter)
//   limit    = <number>                  (default: 50, raw only)
// ---------------------------------------------------------------------------
router.get('/usage', (req, res) => {
  try {
    const { period = 'today', group = 'none', consumer, limit } = req.query;

    const validPeriods = ['today', '7d', '30d', 'all'];

    if (!validPeriods.includes(period)) {
      return res.status(400).json({ error: 'invalid_period', valid: validPeriods });
    }
    if (!['consumer', 'model', 'project', 'task', 'none'].includes(group)) {
      return res.status(400).json({ error: 'invalid_group', valid: ['consumer', 'model', 'project', 'task', 'none'] });
    }

    const rows = db.getUsage({
      period,
      group,
      consumer: consumer || undefined,
      limit:    limit ? parseInt(limit, 10) : 50,
    });

    // Also include summary totals
    const totals = db.getTotals(period);

    res.json({
      period,
      group,
      consumer:    consumer || null,
      row_count:   rows.length,
      totals,
      rows,
    });
  } catch (err) {
    console.error('[api/usage] error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/budget
// Returns current month spend vs configured monthly limit.
// ---------------------------------------------------------------------------
router.get('/budget', (req, res) => {
  try {
    const config       = getConfig();
    const monthlyLimit = config?.budget?.monthly_limit || 100;
    const alertAt      = config?.budget?.alert_at      || [50, 75, 90];

    const status = db.getBudgetStatus(monthlyLimit);

    // Determine which alerts have been crossed
    const crossedAlerts = alertAt.filter(pct => status.percent_used >= pct);

    res.json({
      ...status,
      monthly_limit:  monthlyLimit,
      alert_at:       alertAt,
      alerts_crossed: crossedAlerts,
    });
  } catch (err) {
    console.error('[api/budget] error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/summary
// Convenience endpoint — all data the dashboard needs in one request.
// ---------------------------------------------------------------------------
router.get('/summary', (req, res) => {
  try {
    const config       = getConfig();
    const monthlyLimit = config?.budget?.monthly_limit || 100;
    const period       = ['today','7d','30d','all'].includes(req.query.period) ? req.query.period : 'today';

    res.json({
      period,
      totals:      db.getTotals(period),
      month:       db.getBudgetStatus(monthlyLimit),
      by_consumer: db.getUsage({ period, group: 'consumer' }),
      by_model:    db.getUsage({ period, group: 'model'    }),
      by_project:  db.getUsage({ period, group: 'project'  }),
      by_task:     db.getUsage({ period, group: 'task'     }),
    });
  } catch (err) {
    console.error('[api/summary] error:', err);
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/hourly
// Hourly spend breakdown for spike chart.
// Query params: period = today | 7d (default: today)
// ---------------------------------------------------------------------------
router.get('/hourly', (req, res) => {
  try {
    const period = req.query.period === '7d' ? '7d' : 'today';
    const periodClause = period === '7d'
      ? `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
      : `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;

    const sql = period === '7d'
      ? `SELECT date(timestamp) || ' ' || strftime('%H', timestamp) || ':00' AS bucket,
              SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
         FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`
      : `SELECT strftime('%H', timestamp) || ':00' AS bucket,
              SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
         FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`;

    const rows = db.query ? db.query(sql) : [];
    res.json({ period, rows });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/top-operations
// Top N most expensive individual calls.
// Query params: period = today | 7d | 30d (default: today), limit (default: 10)
// ---------------------------------------------------------------------------
router.get('/top-operations', (req, res) => {
  try {
    const period = ['today', '7d', '30d'].includes(req.query.period) ? req.query.period : 'today';
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    let periodClause;
    switch (period) {
      case '7d':  periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`; break;
      case '30d': periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`; break;
      default:    periodClause = `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;
    }

    const rows = db.getUsage({ period, group: 'none', limit });
    const sorted = rows
      .filter(r => r.estimated_cost_usd > 0)
      .sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd)
      .slice(0, limit);

    res.json({ period, rows: sorted });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/hourly-breakdown
// Grouped by hour (for ranges <= 24h) or by day (for ranges >= 7d).
// Returns all time slots in the range, including zeros.
// ---------------------------------------------------------------------------
router.get('/hourly-breakdown', (req, res) => {
  try {
    const range = req.query.range || '24h';
    const interval = parseRange(req);
    const useDaily = ['7d', '30d', '90d'].includes(range);
    const bucketFmt = useDaily ? '%Y-%m-%d' : '%Y-%m-%dT%H';
    const bucketCol = 'bucket';

    const projectRows = db.query(`
      SELECT
        strftime('${bucketFmt}', timestamp) AS ${bucketCol},
        COALESCE(project, '(untagged)') AS project,
        model,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY ${bucketCol}, project, model
      ORDER BY ${bucketCol}, cost DESC
    `);

    const modelRows = db.query(`
      SELECT
        strftime('${bucketFmt}', timestamp) AS ${bucketCol},
        model,
        upstream,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY ${bucketCol}, model, upstream
      ORDER BY ${bucketCol}, cost DESC
    `);

    const effortRows = db.query(`
      SELECT
        strftime('${bucketFmt}', timestamp) AS ${bucketCol},
        COALESCE(effort_level, 'unknown') AS effort,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY ${bucketCol}, effort
      ORDER BY ${bucketCol}
    `);

    const bucketMap = {};
    const bucketProjectMap = {};
    for (const r of projectRows) {
      if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { hour: r.bucket, total_cost: 0, total_calls: 0, projects: [], models: [] };
      bucketMap[r.bucket].total_cost += r.cost || 0;
      bucketMap[r.bucket].total_calls += r.calls || 0;
      const bpKey = r.bucket + '|' + r.project;
      if (!bucketProjectMap[bpKey]) {
        bucketProjectMap[bpKey] = { project: r.project, cost: 0, calls: 0, models: [] };
        bucketMap[r.bucket].projects.push(bucketProjectMap[bpKey]);
      }
      bucketProjectMap[bpKey].cost += r.cost || 0;
      bucketProjectMap[bpKey].calls += r.calls || 0;
      bucketProjectMap[bpKey].models.push({ model: r.model, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
    }
    for (const p of Object.values(bucketProjectMap)) {
      p.cost = parseFloat(p.cost.toFixed(4));
      p.models.sort((a, b) => b.cost - a.cost);
    }
    for (const r of modelRows) {
      if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { hour: r.bucket, total_cost: 0, total_calls: 0, projects: [], models: [], effort: [] };
      bucketMap[r.bucket].models.push({ model: r.model, upstream: r.upstream, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
    }
    for (const r of effortRows) {
      if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { hour: r.bucket, total_cost: 0, total_calls: 0, projects: [], models: [], effort: [] };
      if (!bucketMap[r.bucket].effort) bucketMap[r.bucket].effort = [];
      bucketMap[r.bucket].effort.push({ level: r.effort, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
    }

    // Generate all time slots in the range (fill gaps with zeros)
    const now = new Date();
    const allSlots = [];
    if (useDaily) {
      const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 86400000);
        const key = d.toISOString().slice(0, 10);
        allSlots.push(key);
      }
    } else {
      const hours = range === '12h' ? 12 : range === '6h' ? 6 : range === '1h' ? 1 : 24;
      for (let i = hours - 1; i >= 0; i--) {
        const d = new Date(now.getTime() - i * 3600000);
        const key = d.toISOString().slice(0, 13);
        allSlots.push(key);
      }
    }

    const filled = allSlots.map(slot => {
      return bucketMap[slot] || { hour: slot, total_cost: 0, total_calls: 0, projects: [], models: [], effort: [] };
    });

    res.json({ hours: filled, granularity: useDaily ? 'daily' : 'hourly' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/daily-comparison
// Today's spend vs yesterday (same time window) for trend indicator.
// ---------------------------------------------------------------------------
router.get('/daily-comparison', (req, res) => {
  try {
    // Accept tz_offset in minutes (e.g. -300 for CDT) to define "today" in user's local time
    const offsetMin = parseInt(req.query.tz_offset || '0') || 0;
    const offsetSql = offsetMin >= 0 ? `+${offsetMin} minutes` : `${offsetMin} minutes`;

    const today = db.query(`
      SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '${offsetSql}')
    `);

    const yesterdayFull = db.query(`
      SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day', '${offsetSql}')
        AND timestamp < strftime('%Y-%m-%dT00:00:00Z', 'now', '${offsetSql}')
    `);

    const t = today[0] || { cost: 0, calls: 0 };
    const y = yesterdayFull[0] || { cost: 0, calls: 0 };

    res.json({
      today: { cost: parseFloat((t.cost || 0).toFixed(2)), calls: t.calls || 0 },
      yesterday: { cost: parseFloat((y.cost || 0).toFixed(2)), calls: y.calls || 0 },
      tz_offset: offsetMin,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/project-costs
// Top projects by cost in the last 24 hours.
// ---------------------------------------------------------------------------
router.get('/project-costs', (req, res) => {
  try {
    const interval = parseRange(req);
    const projects = db.query(`
      SELECT
        COALESCE(project, '(untagged)') AS project,
        COUNT(*) AS calls,
        SUM(estimated_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND http_status BETWEEN 200 AND 299
      GROUP BY project
      ORDER BY cost DESC
      LIMIT 10
    `);

    const totalCost = projects.reduce((s, p) => s + (p.cost || 0), 0);
    res.json({ projects, total_cost: parseFloat(totalCost.toFixed(2)) });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/portal-comparison
// Compares tracker daily totals to RDsec portal actual billing.
// Reads portal-data.json for ground truth. Shows last 7 matched days.
// ---------------------------------------------------------------------------
router.get('/portal-comparison', (req, res) => {
  try {
    const portalPath = path.resolve(__dirname, '..', 'scripts', 'portal-data.json');
    if (!fs.existsSync(portalPath)) {
      return res.json({ error: 'no_portal_data', message: 'scripts/portal-data.json not found' });
    }

    const portalData = JSON.parse(fs.readFileSync(portalPath, 'utf-8'));
    const lastPulled = fs.statSync(portalPath).mtime.toISOString();

    const trackerDaily = db.query(`
      SELECT
        date(timestamp) AS day,
        ROUND(SUM(estimated_cost_usd), 2) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      GROUP BY day
      ORDER BY day DESC
    `);

    const trackerMap = {};
    for (const r of trackerDaily) trackerMap[r.day] = r;

    const comparison = portalData
      .filter(p => trackerMap[p.date])
      .map(p => ({
        date: p.date,
        portal_cost: p.cost,
        portal_traces: p.traces,
        tracker_cost: trackerMap[p.date].cost,
        tracker_calls: trackerMap[p.date].calls,
        delta: parseFloat((trackerMap[p.date].cost - p.cost).toFixed(2)),
        ratio: p.cost > 0 ? parseFloat((trackerMap[p.date].cost / p.cost).toFixed(3)) : null,
      }))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 7);

    res.json({ comparison, last_pulled: lastPulled, source: 'scripts/portal-data.json' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/project-details
// Recent calls for a project — shows WHAT is causing spend.
// ---------------------------------------------------------------------------
router.get('/project-details', (req, res) => {
  try {
    const project = req.query.project || '';
    const interval = parseRange(req);
    const projectFilter = project === '(untagged)'
      ? "(project IS NULL OR project = '')"
      : `project = '${project.replace(/'/g, "''")}'`;

    const summary = db.query(`
      SELECT model, COUNT(*) AS calls, ROUND(SUM(estimated_cost_usd), 4) AS cost,
             SUM(input_tokens + cache_read_tokens + cache_write_tokens) AS total_input,
             SUM(output_tokens) AS total_output
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND ${projectFilter}
      GROUP BY model ORDER BY cost DESC
    `);

    const recent = db.query(`
      SELECT timestamp, model, consumer,
             input_tokens + cache_read_tokens + cache_write_tokens AS prompt_tokens,
             output_tokens, ROUND(estimated_cost_usd, 4) AS cost, session_id
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND ${projectFilter}
      ORDER BY estimated_cost_usd DESC
      LIMIT 10
    `);

    res.json({ project, summary, recent_expensive: recent });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cost-breakdown
// Model-level cost breakdown + cache economics for the dashboard.
// ---------------------------------------------------------------------------
router.get('/cost-breakdown', (req, res) => {
  try {
    const interval = parseRange(req);
    const models = db.query(`
      SELECT
        model,
        upstream,
        COUNT(*) AS calls,
        SUM(estimated_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(CASE WHEN cache_estimated = 1 THEN 1 ELSE 0 END) AS estimated_calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND http_status BETWEEN 200 AND 299
      GROUP BY model, upstream
      ORDER BY cost DESC
    `);

    const totals = models.reduce((acc, m) => {
      acc.cost += m.cost || 0;
      acc.calls += m.calls || 0;
      acc.cache_write += m.cache_write_tokens || 0;
      acc.cache_read += m.cache_read_tokens || 0;
      acc.estimated_calls += m.estimated_calls || 0;
      return acc;
    }, { cost: 0, calls: 0, cache_write: 0, cache_read: 0, estimated_calls: 0 });

    res.json({ models, totals });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/savings-potential
// Show cost breakdown and optimization levers (session restarts, caching).
// ---------------------------------------------------------------------------
router.get('/savings-potential', (req, res) => {
  try {
    const interval = parseRange(req);
    const costByType = db.query(`
      SELECT
        model,
        COUNT(*) AS calls,
        SUM(output_tokens) AS total_output,
        SUM(cache_write_tokens) AS total_cw,
        SUM(cache_read_tokens) AS total_cr,
        SUM(estimated_cost_usd) AS cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY model
      ORDER BY cost DESC
    `);

    const sessionStarts = db.query(`
      SELECT COUNT(*) AS sessions,
             SUM(cache_write_tokens) AS total_cw
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND cache_write_tokens > 50000
    `);

    const ss = sessionStarts[0] || { sessions: 0, total_cw: 0 };
    const config = getConfig();
    const defaultPricing = config?.pricing?.default || {};
    const cwRate = defaultPricing.cache_write || 18.75;
    const cwCost = (ss.total_cw || 0) * cwRate / 1e6;
    const savingsPerFewerRestart = ss.sessions > 1 ? cwCost / ss.sessions : 0;

    res.json({
      models: costByType.map(m => ({
        model: m.model,
        calls: m.calls,
        cost: parseFloat((m.cost || 0).toFixed(2)),
        output_tokens: m.total_output || 0,
        cache_write_tokens: m.total_cw || 0,
      })),
      session_restarts: {
        count: ss.sessions,
        cache_write_cost: parseFloat(cwCost.toFixed(2)),
        savings_per_fewer_restart: parseFloat(savingsPerFewerRestart.toFixed(2)),
      },
      note: 'Primary savings lever: fewer session restarts ($' + savingsPerFewerRestart.toFixed(0) + '/restart avoided). Model routing not viable — all opus-aws calls are full sessions (100-300+ messages).',
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/cache-estimation
// Show cache estimation stats — how many records use estimated vs actual cache data.
// ---------------------------------------------------------------------------
router.get('/cache-estimation', (req, res) => {
  try {
    const interval = parseRange(req);
    const stats = db.query(`
      SELECT
        upstream,
        cache_estimated,
        COUNT(*) AS calls,
        SUM(cache_read_tokens) AS total_cache_read,
        SUM(cache_write_tokens) AS total_cache_write,
        SUM(estimated_cost_usd) AS total_cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY upstream, cache_estimated
      ORDER BY total_cost DESC
    `);

    const summary = stats.reduce((acc, row) => {
      if (row.cache_estimated) {
        acc.estimated_calls += row.calls;
        acc.estimated_cost += row.total_cost || 0;
      } else {
        acc.actual_calls += row.calls;
        acc.actual_cost += row.total_cost || 0;
      }
      return acc;
    }, { estimated_calls: 0, estimated_cost: 0, actual_calls: 0, actual_cost: 0 });

    res.json({
      rows: stats,
      summary: {
        ...summary,
        estimated_cost: parseFloat(summary.estimated_cost.toFixed(2)),
        actual_cost: parseFloat(summary.actual_cost.toFixed(2)),
      },
      note: 'Estimated rows use heuristic: 85% of input tokens as cache_write (first call) or cache_read (subsequent). Actual rows have cache data from the upstream API.',
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/backfill-cache
// Retroactively estimate cache tokens for historical calls missing cache data.
// Body: { dryRun: true|false } — defaults to dry run.
// Only accessible from localhost.
// ---------------------------------------------------------------------------
const { modelUsesCaching, DEFAULT_SYSTEM_PROMPT_TOKENS } = require('../lib/cache-estimator');
const pricing = require('../pricing');

router.post('/backfill-cache', (req, res) => {
  // Localhost-only
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'internal_only' });
  }

  let body = {};
  try {
    if (req.body && req.body.length > 0) body = JSON.parse(req.body.toString('utf8'));
  } catch { /* empty body = defaults */ }
  const dryRun = body.dryRun !== false; // default true for safety

  try {
    const candidates = db.query(`
      SELECT id, model, upstream, session_id, input_tokens, output_tokens,
             cache_read_tokens, cache_write_tokens, estimated_cost_usd, timestamp
      FROM usage_log
      WHERE upstream != 'anthropic'
        AND cache_estimated = 0
        AND cache_read_tokens = 0
        AND cache_write_tokens = 0
        AND output_tokens > 0
      ORDER BY timestamp ASC
    `);

    const eligible = candidates.filter(r => modelUsesCaching(r.model));
    if (eligible.length === 0) {
      return res.json({ updated: 0, message: 'No eligible rows.' });
    }

    const promptSize = DEFAULT_SYSTEM_PROMPT_TOKENS;
    const cacheWriteEstimate = Math.floor(promptSize * 0.30);
    const sessionFirstCall = new Set();
    let updated = 0;
    let totalCostDelta = 0;
    const details = [];

    for (const row of eligible) {
      const sessionKey = row.session_id || `no-session-${row.id}`;
      const isFirst = !sessionFirstCall.has(sessionKey);
      if (isFirst) sessionFirstCall.add(sessionKey);

      const cacheRead = isFirst ? 0 : promptSize;
      const cacheWrite = isFirst ? cacheWriteEstimate : 0;

      const config = getConfig();
      pricing.loadPricing(config.pricing);
      const newCost = pricing.calculateCost(row.model, {
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      });

      const costDelta = newCost - row.estimated_cost_usd;
      totalCostDelta += costDelta;

      if (!dryRun) {
        db.run(
          `UPDATE usage_log SET cache_read_tokens = ?, cache_write_tokens = ?, cache_estimated = 1, estimated_cost_usd = ? WHERE id = ?`,
          cacheRead, cacheWrite, newCost, row.id
        );
      }

      details.push({
        id: row.id, model: row.model,
        session: (row.session_id || 'none').slice(0, 8),
        type: isFirst ? 'cache_write' : 'cache_read',
        tokens: isFirst ? cacheWrite : cacheRead,
        old_cost: parseFloat(row.estimated_cost_usd.toFixed(4)),
        new_cost: parseFloat(newCost.toFixed(4)),
        delta: parseFloat(costDelta.toFixed(4)),
      });
      updated++;
    }

    // Bust the cache so dashboard refreshes
    if (!dryRun) apiCache.clear();

    res.json({
      dry_run: dryRun,
      updated,
      sessions: sessionFirstCall.size,
      cache_writes: sessionFirstCall.size,
      cache_reads: updated - sessionFirstCall.size,
      total_cost_delta: parseFloat(totalCostDelta.toFixed(4)),
      details: details.length <= 100 ? details : details.slice(0, 100),
      truncated: details.length > 100,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/sessions
// Per-session cost and call analytics.
// Query params: range (default: 24h), limit (default: 20)
// ---------------------------------------------------------------------------
router.get('/sessions', (req, res) => {
  try {
    const interval = parseRange(req);
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    const sessions = db.query(`
      SELECT
        session_id,
        COALESCE(project, '(untagged)') AS project,
        consumer,
        GROUP_CONCAT(DISTINCT model) AS models,
        COUNT(*) AS calls,
        SUM(estimated_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        MIN(timestamp) AS first_call,
        MAX(timestamp) AS last_call,
        ROUND((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 24 * 60, 1) AS duration_min
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
        AND session_id IS NOT NULL
        AND http_status BETWEEN 200 AND 299
      GROUP BY session_id
      ORDER BY cost DESC
      LIMIT ${limit}
    `);

    const totalCost = sessions.reduce((s, r) => s + (r.cost || 0), 0);
    const totalCalls = sessions.reduce((s, r) => s + (r.calls || 0), 0);

    res.json({
      sessions: sessions.map(s => ({
        ...s,
        cost: parseFloat((s.cost || 0).toFixed(4)),
        models: s.models ? s.models.split(',') : [],
      })),
      total_cost: parseFloat(totalCost.toFixed(2)),
      total_calls: totalCalls,
      session_count: sessions.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/call-details?project=X&range=24h&limit=50
// Per-call details: timestamp, prompt preview, caller CWD, model, tokens, cost
// ---------------------------------------------------------------------------
router.get('/call-details', (req, res) => {
  try {
    const interval = parseRange(req);
    const project = req.query.project || null;
    const sessionId = req.query.session_id || null;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    let where = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')`;
    if (project) where += ` AND project = '${project.replace(/'/g, "''")}'`;
    if (sessionId) where += ` AND session_id = '${sessionId.replace(/'/g, "''")}'`;

    const calls = db.query(`
      SELECT timestamp, model, consumer, project, session_id,
             input_tokens, output_tokens, cache_read_tokens,
             estimated_cost_usd AS cost, duration_ms,
             caller_cwd, prompt_preview, user_agent
      FROM usage_log
      WHERE ${where}
      ORDER BY timestamp DESC
      LIMIT ${limit}
    `);

    res.json({ calls, count: calls.length });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/export-excel
// Excel workbook with embedded bar chart + 4 data sheets.
// ---------------------------------------------------------------------------
router.get('/export-excel', async (req, res) => {
  try {
    const { buildExcelReport } = require('../lib/excel-export');
    const range = (req.query.range || '24h').replace(/[^a-zA-Z0-9]/g, '');
    const buf = await buildExcelReport(db, range);
    const filename = `token-tracker-${range}-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('X-Cache', 'BYPASS');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/export
// Download usage data as CSV for the selected range.
// ---------------------------------------------------------------------------
router.get('/export', (req, res) => {
  try {
    const interval = parseRange(req);
    const rows = db.query(`
      SELECT
        timestamp, model, upstream, consumer, project, session_id,
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
    res.set('X-Cache', 'BYPASS');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/digest
// Styled HTML email digest of token usage. Query param: period=daily|weekly
// Returns text/html suitable for browser viewing or email body.
// ---------------------------------------------------------------------------
router.get('/digest', (req, res) => {
  try {
    const period = req.query.period === 'weekly' ? 'weekly' : 'daily';
    const interval = period === 'weekly' ? '-7 days' : '-1 days';
    const prevInterval = period === 'weekly' ? '-14 days' : '-2 days';
    const label = period === 'weekly' ? 'Weekly' : 'Daily';

    // Current period totals
    const current = db.query(`
      SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests,
             SUM(input_tokens) AS input_tok, SUM(output_tokens) AS output_tok,
             SUM(cache_read_tokens) AS cache_r, SUM(cache_write_tokens) AS cache_w
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    `)[0] || {};

    // Previous period (for comparison)
    const prev = db.query(`
      SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${prevInterval}')
        AND timestamp <  strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    `)[0] || {};

    // MTD
    const mtd = db.query(`
      SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-01T00:00:00Z', 'now')
    `)[0] || {};

    // Top models by cost
    const models = db.query(`
      SELECT model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY model ORDER BY cost DESC LIMIT 5
    `);

    // Top projects by cost
    const projects = db.query(`
      SELECT COALESCE(project, 'untagged') AS project,
             SUM(estimated_cost_usd) AS cost, COUNT(*) AS requests
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      GROUP BY project ORDER BY cost DESC LIMIT 8
    `);

    // Daily trend (last 7 days)
    const trend = db.query(`
      SELECT strftime('%m-%d', timestamp) AS day,
             SUM(estimated_cost_usd) AS cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-7 days')
      GROUP BY day ORDER BY day ASC
    `);

    const cost = current.cost || 0;
    const prevCost = prev.cost || 0;
    const change = prevCost > 0 ? ((cost - prevCost) / prevCost * 100) : 0;
    const changeIcon = change > 5 ? '&#9650;' : change < -5 ? '&#9660;' : '&#8212;';
    const changeColor = change > 5 ? '#e74c3c' : change < -5 ? '#27ae60' : '#7f8c8d';
    const fmt = (v) => `$${(v || 0).toFixed(2)}`;
    const fmtK = (v) => v >= 1_000_000 ? `${(v/1_000_000).toFixed(1)}M` : v >= 1_000 ? `${(v/1_000).toFixed(0)}K` : String(v || 0);

    // Sparkline bars
    const maxTrend = Math.max(...trend.map(t => t.cost || 0), 0.01);
    const bars = trend.map(t => {
      const pct = Math.round(((t.cost || 0) / maxTrend) * 100);
      return `<div style="display:inline-block;width:28px;margin:0 1px;text-align:center;vertical-align:bottom">
        <div style="background:#3498db;width:100%;height:${Math.max(pct, 2)}px;border-radius:2px 2px 0 0"></div>
        <div style="font-size:9px;color:#999">${t.day}</div>
      </div>`;
    }).join('');

    const modelRows = models.map(m =>
      `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${m.model}</td>
           <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmt(m.cost)}</td>
           <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${m.requests}</td></tr>`
    ).join('');

    const projectRows = projects.map(p =>
      `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee">${p.project}</td>
           <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${fmt(p.cost)}</td>
           <td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right">${p.requests}</td></tr>`
    ).join('');

    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width"><title>Token Tracker ${label} Digest</title></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f4f4f4">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#2c3e50,#3498db);padding:24px 24px 16px;color:#fff">
    <h1 style="margin:0;font-size:20px;font-weight:600">Token Tracker &mdash; ${label} Digest</h1>
    <p style="margin:4px 0 0;opacity:.8;font-size:13px">${dateStr}</p>
  </div>
  <div style="padding:20px 24px">
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px">
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${fmt(cost)}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">${label} Spend</div>
        <div style="font-size:12px;color:${changeColor};margin-top:2px">${changeIcon} ${Math.abs(change).toFixed(0)}% vs prev</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${current.requests || 0}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">Requests</div>
      </div>
      <div style="flex:1;min-width:120px;background:#f8f9fa;border-radius:6px;padding:12px;text-align:center">
        <div style="font-size:24px;font-weight:700;color:#2c3e50">${fmt(mtd.cost)}</div>
        <div style="font-size:11px;color:#7f8c8d;margin-top:2px">MTD Spend</div>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">7-Day Trend</h3>
      <div style="height:80px;display:flex;align-items:flex-end">${bars}</div>
    </div>
    <div style="margin-bottom:20px">
      <h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Tokens</h3>
      <div style="font-size:13px;color:#555">
        Input: <strong>${fmtK(current.input_tok)}</strong> &middot;
        Output: <strong>${fmtK(current.output_tok)}</strong> &middot;
        Cache Read: <strong>${fmtK(current.cache_r)}</strong> &middot;
        Cache Write: <strong>${fmtK(current.cache_w)}</strong>
      </div>
    </div>
    ${modelRows ? `<div style="margin-bottom:20px">
      <h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Top Models</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="color:#7f8c8d;font-size:11px"><th style="text-align:left;padding:4px 8px">Model</th><th style="text-align:right;padding:4px 8px">Cost</th><th style="text-align:right;padding:4px 8px">Reqs</th></tr>
        ${modelRows}
      </table>
    </div>` : ''}
    ${projectRows ? `<div style="margin-bottom:20px">
      <h3 style="font-size:13px;color:#7f8c8d;text-transform:uppercase;letter-spacing:.5px;margin:0 0 8px">Top Projects</h3>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="color:#7f8c8d;font-size:11px"><th style="text-align:left;padding:4px 8px">Project</th><th style="text-align:right;padding:4px 8px">Cost</th><th style="text-align:right;padding:4px 8px">Reqs</th></tr>
        ${projectRows}
      </table>
    </div>` : ''}
  </div>
  <div style="padding:12px 24px;background:#f8f9fa;font-size:11px;color:#999;text-align:center;border-top:1px solid #eee">
    Generated by <a href="/dashboard" style="color:#3498db;text-decoration:none">Token Tracker</a>
  </div>
</div>
</body></html>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/db-stats
// Database statistics: row count, date range, file size, models.
// ---------------------------------------------------------------------------
router.get('/db-stats', (req, res) => {
  try {
    const stats = db.query(`
      SELECT COUNT(*) AS rows,
             MIN(timestamp) AS oldest,
             MAX(timestamp) AS newest,
             COUNT(DISTINCT model) AS models,
             COUNT(DISTINCT project) AS projects,
             COUNT(DISTINCT session_id) AS sessions,
             SUM(estimated_cost_usd) AS total_cost
      FROM usage_log
    `);
    const row = stats[0] || {};
    res.json({
      rows: row.rows || 0,
      oldest: row.oldest || null,
      newest: row.newest || null,
      models: row.models || 0,
      projects: row.projects || 0,
      sessions: row.sessions || 0,
      total_cost: parseFloat((row.total_cost || 0).toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/investigations
// Active cost investigations from cost_investigations table.
// ---------------------------------------------------------------------------
router.get('/investigations', (req, res) => {
  try {
    const status = req.query.status || 'active';
    const validStatuses = ['active', 'acknowledged', 'resolved', 'all'];
    const filterStatus = validStatuses.includes(status) ? status : 'active';
    const whereClause = filterStatus === 'all' ? '1=1' : `status = '${filterStatus}'`;
    const investigations = db.query(`
      SELECT id, severity, type, summary, pattern, recommendation,
             daily_cost_estimate, first_seen, last_seen, sample_ids, status,
             created_at, updated_at
      FROM cost_investigations
      WHERE ${whereClause}
      ORDER BY daily_cost_estimate DESC
    `);

    res.json({
      investigations: investigations.map(inv => ({
        ...inv,
        pattern: (() => { try { return JSON.parse(inv.pattern); } catch { return inv.pattern; } })(),
        sample_ids: (() => { try { return JSON.parse(inv.sample_ids); } catch { return []; } })(),
      })),
      count: investigations.length,
      total_daily_waste: parseFloat(investigations.reduce((s, i) => s + (i.daily_cost_estimate || 0), 0).toFixed(2)),
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/investigations/:id/acknowledge
// Mark an investigation as acknowledged. Localhost only.
// ---------------------------------------------------------------------------
router.post('/investigations/:id/acknowledge', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'internal_only' });
  }
  try {
    const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    db.run(
      `UPDATE cost_investigations SET status = 'acknowledged', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      id
    );
    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/investigations/:id/fix
// Queue a fix request for Claude to handle. Writes task to fix-queue dir.
// Localhost only.
// ---------------------------------------------------------------------------
router.post('/investigations/:id/fix', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'internal_only' });
  }
  try {
    const id = req.params.id.replace(/[^a-zA-Z0-9_-]/g, '');
    const rows = db.query(`SELECT * FROM cost_investigations WHERE id = ?`, id);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const inv = rows[0];
    let pattern = {};
    try { pattern = JSON.parse(inv.pattern); } catch {}

    const fixQueueDir = path.join(__dirname, '..', 'data', 'fix-queue');
    if (!fs.existsSync(fixQueueDir)) fs.mkdirSync(fixQueueDir, { recursive: true });

    const task = {
      id,
      created_at: new Date().toISOString(),
      status: 'pending',
      severity: inv.severity,
      summary: inv.summary,
      type: inv.type,
      daily_cost_estimate: inv.daily_cost_estimate,
      root_cause: pattern.haiku_root_cause || null,
      fix_action: pattern.haiku_fix_action || inv.recommendation,
    };

    fs.writeFileSync(path.join(fixQueueDir, `${id}.json`), JSON.stringify(task, null, 2));

    db.run(
      `UPDATE cost_investigations SET status = 'fix_queued', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      id
    );

    res.json({ ok: true, id, message: 'Fix queued. Claude will investigate and apply the fix.' });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/fleet
// Active Claude Code sessions from ~/.claude/sessions/*.json (native) +
// ~/.claude/fleet/sessions/*.json (custom fleet), enriched with cost data.
// Uses PID liveness to determine actual status.
// ---------------------------------------------------------------------------
router.get('/fleet', (req, res) => {
  res.set('X-Cache', 'BYPASS');
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const nativeDir = path.join(homeDir, '.claude', 'sessions');
    const fleetDir = path.join(homeDir, '.claude', 'fleet', 'sessions');
    const now = Date.now();
    const sessions = [];
    const seenPids = new Set();

    function isPidAlive(pid) {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }

    function enrichCost(projectName) {
      if (!projectName) return null;
      try {
        const safeName = projectName.replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safeName) return null;
        const costRow = db.query(
          `SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
           FROM usage_log
           WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
             AND project LIKE '%${safeName}%'`
        );
        if (costRow[0] && costRow[0].cost) {
          return { cost: parseFloat(costRow[0].cost.toFixed(4)), calls: costRow[0].calls };
        }
      } catch {}
      return null;
    }

    // Read native Claude Code sessions (PID-based liveness)
    try {
      const files = fs.readdirSync(nativeDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(nativeDir, file), 'utf8');
          const s = JSON.parse(raw);
          const pid = s.pid;
          if (!pid || !isPidAlive(pid)) continue;
          seenPids.add(pid);

          const project = s.cwd ? s.cwd.split('/').pop() : null;
          sessions.push({
            file,
            session_id: s.sessionId || file.replace('.json', ''),
            project,
            cwd: s.cwd || null,
            model: s.model || null,
            current_task: s.current_task || s.status || null,
            started_at: s.started_at || null,
            last_checkin: s.last_checkin || new Date(fs.statSync(path.join(nativeDir, file)).mtime).toISOString(),
            status: 'active',
            age_min: 0,
            cost_24h: enrichCost(project),
          });
        } catch {}
      }
    } catch {}

    // Read custom fleet sessions (fallback for sessions not in native dir)
    try {
      const files = fs.readdirSync(fleetDir).filter(f => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(fleetDir, file), 'utf8');
          const s = JSON.parse(raw);
          if (s.pid && seenPids.has(s.pid)) continue;

          const lastCheckin = s.last_checkin ? new Date(s.last_checkin).getTime() : 0;
          const ageMs = now - lastCheckin;
          const ageMin = Math.round(ageMs / 60000);
          let status = 'active';
          if (ageMs > 30 * 60000) status = 'stale';
          else if (ageMs > 15 * 60000) status = 'inactive';

          sessions.push({
            file,
            session_id: s.session_id || file.replace('.json', ''),
            project: s.project || null,
            cwd: s.cwd || null,
            model: s.model || null,
            current_task: s.current_task || null,
            started_at: s.started_at || null,
            last_checkin: s.last_checkin || null,
            status,
            age_min: ageMin,
            cost_24h: enrichCost(s.project),
          });
        } catch {}
      }
    } catch {}

    sessions.sort((a, b) => {
      const order = { active: 0, inactive: 1, stale: 2 };
      return (order[a.status] || 9) - (order[b.status] || 9);
    });

    res.json({
      sessions,
      total: sessions.length,
      active: sessions.filter(s => s.status === 'active').length,
      stale: sessions.filter(s => s.status === 'stale').length,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/purge
// Delete usage data older than N days. Localhost-only, dry-run by default.
// Body: { days: 90, dryRun: true }
// ---------------------------------------------------------------------------
router.post('/purge', (req, res) => {
  const ip = req.socket.remoteAddress;
  if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
    return res.status(403).json({ error: 'internal_only' });
  }

  try {
    let body = {};
    try {
      if (req.body && req.body.length > 0) body = JSON.parse(req.body.toString('utf8'));
    } catch { /* defaults */ }

    const days = Math.max(1, parseInt(body.days) || 90);
    const dryRun = body.dryRun !== false; // default true for safety
    const interval = `-${days} days`;

    // Count rows that would be deleted
    const preview = db.query(`
      SELECT COUNT(*) AS count,
             SUM(estimated_cost_usd) AS cost,
             MIN(timestamp) AS oldest,
             MAX(timestamp) AS newest
      FROM usage_log
      WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    `);
    const p = preview[0] || {};

    if (dryRun) {
      return res.json({
        dryRun: true,
        days,
        would_delete: p.count || 0,
        would_delete_cost: parseFloat((p.cost || 0).toFixed(2)),
        oldest: p.oldest || null,
        newest: p.newest || null,
        message: `Would delete ${p.count || 0} rows older than ${days} days. POST with {"dryRun": false} to execute.`,
      });
    }

    const result = db.run(
      `DELETE FROM usage_log WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')`
    );

    res.json({
      dryRun: false,
      days,
      deleted: result.changes || 0,
      deleted_cost: parseFloat((p.cost || 0).toFixed(2)),
      message: `Deleted ${result.changes || 0} rows older than ${days} days.`,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal_error', message: err.message });
  }
});

module.exports = router;
