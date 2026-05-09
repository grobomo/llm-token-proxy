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
// Last 24 hours grouped by hour with model + project breakdown per hour.
// ---------------------------------------------------------------------------
router.get('/hourly-breakdown', (req, res) => {
  try {
    const projectRows = db.query(`
      SELECT
        strftime('%Y-%m-%dT%H', timestamp) AS hour,
        COALESCE(project, '(untagged)') AS project,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      GROUP BY hour, project
      ORDER BY hour, cost DESC
    `);

    const modelRows = db.query(`
      SELECT
        strftime('%Y-%m-%dT%H', timestamp) AS hour,
        model,
        SUM(estimated_cost_usd) AS cost,
        COUNT(*) AS calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      GROUP BY hour, model
      ORDER BY hour, cost DESC
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
    const projects = db.query(`
      SELECT
        COALESCE(project, '(untagged)') AS project,
        COUNT(*) AS calls,
        SUM(estimated_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
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
// GET /api/cost-breakdown
// Model-level cost breakdown + cache economics for the dashboard.
// ---------------------------------------------------------------------------
router.get('/cost-breakdown', (req, res) => {
  try {
    const models = db.query(`
      SELECT
        model,
        COUNT(*) AS calls,
        SUM(estimated_cost_usd) AS cost,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read_tokens) AS cache_read_tokens,
        SUM(cache_write_tokens) AS cache_write_tokens,
        SUM(CASE WHEN cache_estimated = 1 THEN 1 ELSE 0 END) AS estimated_calls
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      GROUP BY model
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
    const costByType = db.query(`
      SELECT
        model,
        COUNT(*) AS calls,
        SUM(output_tokens) AS total_output,
        SUM(cache_write_tokens) AS total_cw,
        SUM(cache_read_tokens) AS total_cr,
        SUM(estimated_cost_usd) AS cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      GROUP BY model
      ORDER BY cost DESC
    `);

    const sessionStarts = db.query(`
      SELECT COUNT(*) AS sessions,
             SUM(cache_write_tokens) AS total_cw
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
        AND cache_write_tokens > 50000
    `);

    const ss = sessionStarts[0] || { sessions: 0, total_cw: 0 };
    const cwCost = (ss.total_cw || 0) * 18.75 / 1e6;
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
    const stats = db.query(`
      SELECT
        upstream,
        cache_estimated,
        COUNT(*) AS calls,
        SUM(cache_read_tokens) AS total_cache_read,
        SUM(cache_write_tokens) AS total_cache_write,
        SUM(estimated_cost_usd) AS total_cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
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

module.exports = router;
