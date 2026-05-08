'use strict';

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const yaml     = require('js-yaml');
const db       = require('../db');

const router = express.Router();

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

module.exports = router;
