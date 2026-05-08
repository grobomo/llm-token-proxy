#!/usr/bin/env node
'use strict';

/**
 * spike-detect.js (T104)
 * Compares today's spend against 7-day rolling average.
 * Alerts when today exceeds Nx the average (default: 2x).
 * Runs via cron (recommended: every 30 min) or manually.
 *
 * Exit codes:
 *   0 = normal spend
 *   1 = spike detected
 *   2 = insufficient data (< 2 days of history)
 *
 * Output: JSON to stdout with spike details.
 * Side effect: writes ~/.token-proxy-spike-alert on spike, clears on normal.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const SCRIPT_DIR = path.dirname(path.resolve(__filename));
const DB_PATH    = process.env.USAGE_DB || path.resolve(SCRIPT_DIR, '../usage.db');
const ALERT_FILE = path.join(process.env.HOME || '/tmp', '.token-proxy-spike-alert');

const SPIKE_MULTIPLIER = parseFloat(process.env.SPIKE_MULTIPLIER || '2.0');
const MIN_DAILY_THRESHOLD = parseFloat(process.env.MIN_DAILY_THRESHOLD || '5.00');

function run() {
  if (!fs.existsSync(DB_PATH)) {
    console.error('[spike-detect] usage.db not found at ' + DB_PATH);
    process.exit(2);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');

  const today = db.prepare(`
    SELECT
      COALESCE(SUM(estimated_cost_usd), 0) AS cost,
      COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')
  `).get();

  const history = db.prepare(`
    SELECT
      date(timestamp) AS day,
      SUM(estimated_cost_usd) AS cost,
      COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-7 days')
      AND timestamp < strftime('%Y-%m-%dT00:00:00Z', 'now')
    GROUP BY date(timestamp)
    ORDER BY day
  `).all();

  db.close();

  if (history.length < 2) {
    const result = { status: 'insufficient_data', days: history.length, today_cost: today.cost };
    console.log(JSON.stringify(result));
    process.exit(2);
  }

  const avgCost = history.reduce((s, d) => s + d.cost, 0) / history.length;
  const avgCalls = history.reduce((s, d) => s + d.calls, 0) / history.length;
  const ratio = avgCost > 0 ? today.cost / avgCost : 0;

  const isSpike = today.cost > MIN_DAILY_THRESHOLD && ratio > SPIKE_MULTIPLIER;

  const result = {
    status: isSpike ? 'SPIKE' : 'normal',
    today_cost: parseFloat(today.cost.toFixed(2)),
    today_calls: today.calls,
    avg_daily_cost: parseFloat(avgCost.toFixed(2)),
    avg_daily_calls: Math.round(avgCalls),
    ratio: parseFloat(ratio.toFixed(2)),
    threshold: SPIKE_MULTIPLIER,
    history_days: history.length,
    history: history.map(d => ({ day: d.day, cost: parseFloat(d.cost.toFixed(2)), calls: d.calls })),
  };

  console.log(JSON.stringify(result, null, 2));

  if (isSpike) {
    const alertMsg = `[${new Date().toISOString()}] SPIKE: today=$${today.cost.toFixed(2)} (${ratio.toFixed(1)}x avg of $${avgCost.toFixed(2)}/day over ${history.length}d)\n`;
    fs.appendFileSync(ALERT_FILE, alertMsg);
    process.exit(1);
  } else {
    if (fs.existsSync(ALERT_FILE)) fs.unlinkSync(ALERT_FILE);
    process.exit(0);
  }
}

run();
