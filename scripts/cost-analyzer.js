#!/usr/bin/env node
// TOKEN_COST_REVIEWED: $0.00/day (no LLM calls, pure JS) — 2026-05-07
'use strict';

/**
 * cost-analyzer.js (T026)
 * Rules-based cost pattern analyzer — queries SQLite, writes cost-insights.json.
 * Runs hourly via cron. Zero LLM calls.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const SCRIPT_DIR = path.dirname(path.resolve(__filename || __filename));
const DB_PATH    = path.resolve(SCRIPT_DIR, '../usage.db');
const DATA_DIR   = path.resolve(SCRIPT_DIR, '../data');
const OUTPUT     = path.join(DATA_DIR, 'cost-insights.json');

// Thresholds
const RUNAWAY_SPEND_USD   = 5.00;   // per consumer per hour
const CONTEXT_BLOAT_RATIO = 50;     // input_tokens / output_tokens
const HIGH_FREQ_REQUESTS  = 100;    // requests per consumer per hour
const PERIOD_HOURS        = 1;

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) {
    return null;
  }
  const db = new DatabaseSync(DB_PATH, { open: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');
  return db;
}

// ─── queries ────────────────────────────────────────────────────────────────

/**
 * Per-consumer summary for the last N hours.
 */
function queryConsumerSummary(db, hours) {
  return db.prepare(`
    SELECT
      consumer,
      model,
      SUM(estimated_cost_usd)              AS cost_usd,
      COUNT(*)                             AS requests,
      AVG(input_tokens)                    AS avg_input_tokens,
      AVG(output_tokens)                   AS avg_output_tokens,
      SUM(input_tokens)                    AS total_input_tokens,
      SUM(output_tokens)                   AS total_output_tokens
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? )
    GROUP BY consumer, model
    ORDER BY cost_usd DESC
  `).all(`-${hours} hours`);
}

/**
 * Total cost across all consumers for the last N hours.
 */
function queryTotalCost(db, hours) {
  const row = db.prepare(`
    SELECT
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)                AS total_requests
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? )
  `).get(`-${hours} hours`);
  return row || { total_cost_usd: 0, total_requests: 0 };
}

/**
 * Context bloat: rows where input/output ratio > threshold.
 */
function queryContextBloat(db, hours, ratio) {
  return db.prepare(`
    SELECT
      consumer,
      model,
      AVG(CAST(input_tokens AS REAL) / NULLIF(output_tokens, 0)) AS avg_ratio,
      COUNT(*) AS bloated_requests,
      SUM(estimated_cost_usd) AS cost_usd
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ? )
      AND output_tokens > 0
      AND CAST(input_tokens AS REAL) / output_tokens > ?
    GROUP BY consumer, model
    ORDER BY avg_ratio DESC
  `).all(`-${hours} hours`, ratio);
}

// ─── pattern detection ───────────────────────────────────────────────────────

function detectPatterns(rows, bloatRows) {
  const patterns = [];

  // Group consumer+model rows into per-consumer aggregates for frequency check
  const consumerAgg = {};
  for (const row of rows) {
    const key = row.consumer;
    if (!consumerAgg[key]) {
      consumerAgg[key] = { consumer: row.consumer, cost: 0, requests: 0, models: [] };
    }
    consumerAgg[key].cost     += row.cost_usd || 0;
    consumerAgg[key].requests += row.requests  || 0;
    consumerAgg[key].models.push({ model: row.model, cost: row.cost_usd, requests: row.requests });
  }

  for (const row of rows) {
    // 1. Model overuse — cron/automated consumers using opus
    // Heuristic: any consumer containing ":cron:" or "scheduled:" or "automated:" using opus.
    const consumerLow = (row.consumer || '').toLowerCase();
    const isAutomated = /:cron:|^scheduled:|^automated:/.test(consumerLow);
    if (
      isAutomated &&
      row.model &&
      row.model.toLowerCase().includes('opus')
    ) {
      patterns.push({
        type:                  'model_overuse',
        consumer:              row.consumer,
        model:                 row.model,
        detail:                `Automated consumer using opus — Haiku/Sonnet would cost far less`,
        potential_savings_usd: parseFloat(((row.cost_usd || 0) * 0.9).toFixed(6)),
        severity:              'high',
      });
    }

    // 2. Runaway spend — any consumer > $5 in the hour
    if ((consumerAgg[row.consumer]?.cost || 0) > RUNAWAY_SPEND_USD &&
        !patterns.find(p => p.type === 'runaway_spend' && p.consumer === row.consumer)) {
      patterns.push({
        type:     'runaway_spend',
        consumer: row.consumer,
        cost_usd: parseFloat((consumerAgg[row.consumer].cost).toFixed(6)),
        detail:   `Consumer spent $${consumerAgg[row.consumer].cost.toFixed(4)} in last ${PERIOD_HOURS}h — exceeds $${RUNAWAY_SPEND_USD} threshold`,
        severity: 'critical',
      });
    }

    // 3. High frequency — more than 100 requests per consumer per hour
    if ((consumerAgg[row.consumer]?.requests || 0) > HIGH_FREQ_REQUESTS &&
        !patterns.find(p => p.type === 'high_frequency' && p.consumer === row.consumer)) {
      patterns.push({
        type:     'high_frequency',
        consumer: row.consumer,
        requests: consumerAgg[row.consumer].requests,
        detail:   `${consumerAgg[row.consumer].requests} requests in last ${PERIOD_HOURS}h — exceeds ${HIGH_FREQ_REQUESTS} threshold`,
        severity: 'high',
      });
    }
  }

  // 4. Context bloat
  for (const row of bloatRows) {
    patterns.push({
      type:           'context_bloat',
      consumer:       row.consumer,
      model:          row.model,
      avg_ratio:      parseFloat((row.avg_ratio || 0).toFixed(1)),
      bloated_requests: row.bloated_requests,
      cost_usd:       parseFloat((row.cost_usd || 0).toFixed(6)),
      detail:         `Avg input/output ratio ${(row.avg_ratio || 0).toFixed(1)}x — input tokens disproportionately high (threshold: ${CONTEXT_BLOAT_RATIO}x)`,
      severity:       row.avg_ratio > 100 ? 'high' : 'medium',
    });
  }

  return patterns;
}

// ─── build consumer breakdown ────────────────────────────────────────────────

function buildConsumerBreakdown(rows) {
  const seen = new Set();
  const result = [];

  // Aggregate by consumer (merge models)
  const byConsumer = {};
  for (const row of rows) {
    if (!byConsumer[row.consumer]) {
      byConsumer[row.consumer] = {
        id:                row.consumer,
        cost_usd:          0,
        requests:          0,
        avg_input_tokens:  0,
        avg_output_tokens: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        models:            {},
        _input_sum: 0,
        _output_sum: 0,
        _count: 0,
      };
    }
    const c = byConsumer[row.consumer];
    c.cost_usd           += row.cost_usd || 0;
    c.requests           += row.requests  || 0;
    c.total_input_tokens += row.total_input_tokens || 0;
    c.total_output_tokens+= row.total_output_tokens || 0;
    c._input_sum         += (row.avg_input_tokens || 0) * (row.requests || 0);
    c._output_sum        += (row.avg_output_tokens || 0) * (row.requests || 0);
    c._count             += row.requests || 0;
    // Track primary model by highest cost
    if (!c.models[row.model] || c.models[row.model] < row.cost_usd) {
      c.models[row.model] = row.cost_usd;
    }
  }

  for (const [consumer, c] of Object.entries(byConsumer)) {
    // Find primary model (highest cost)
    const primary_model = Object.entries(c.models)
      .sort(([, a], [, b]) => b - a)[0]?.[0] || 'unknown';

    result.push({
      id:                  consumer,
      cost_usd:            parseFloat(c.cost_usd.toFixed(6)),
      requests:            c.requests,
      avg_input_tokens:    c._count > 0 ? Math.round(c._input_sum / c._count) : 0,
      avg_output_tokens:   c._count > 0 ? Math.round(c._output_sum / c._count) : 0,
      total_input_tokens:  c.total_input_tokens,
      total_output_tokens: c.total_output_tokens,
      primary_model,
    });
  }

  return result.sort((a, b) => b.cost_usd - a.cost_usd);
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  ensureDataDir();

  const db = openDb();
  if (!db) {
    const output = {
      timestamp:      new Date().toISOString(),
      period_hours:   PERIOD_HOURS,
      total_cost_usd: 0,
      total_requests: 0,
      consumers:      [],
      patterns:       [],
      note:           `Database not found at ${DB_PATH}`,
    };
    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
    console.log(`[cost-analyzer] No database found — wrote empty insights to ${OUTPUT}`);
    process.exit(0);
  }

  try {
    const totals    = queryTotalCost(db, PERIOD_HOURS);
    const rows      = queryConsumerSummary(db, PERIOD_HOURS);
    const bloatRows = queryContextBloat(db, PERIOD_HOURS, CONTEXT_BLOAT_RATIO);

    const consumers = buildConsumerBreakdown(rows);
    const patterns  = detectPatterns(rows, bloatRows);

    const output = {
      timestamp:      new Date().toISOString(),
      period_hours:   PERIOD_HOURS,
      total_cost_usd: parseFloat((totals.total_cost_usd || 0).toFixed(6)),
      total_requests: totals.total_requests || 0,
      consumers,
      patterns,
    };

    fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));

    const alertCount = patterns.filter(p => p.severity === 'critical').length;
    console.log(
      `[cost-analyzer] Done — $${output.total_cost_usd.toFixed(4)} in last ${PERIOD_HOURS}h, ` +
      `${output.total_requests} requests, ${patterns.length} pattern(s) detected` +
      (alertCount ? ` ⚠️  ${alertCount} ALERT(s)` : '')
    );
  } finally {
    db.close();
  }

  process.exit(0);
}

main();
