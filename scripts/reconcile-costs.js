#!/usr/bin/env node
'use strict';

/**
 * reconcile-costs.js (T105)
 * Compares Anthropic billing data against local usage.db for the same window.
 * Reports gaps: calls in billing but not proxy, and vice versa.
 *
 * Usage:
 *   # From a saved cost report JSON:
 *   node reconcile-costs.js --report cost-report.json
 *
 *   # From Anthropic API (requires ANTHROPIC_ADMIN_KEY):
 *   node reconcile-costs.js --api --start 2026-05-01 --end 2026-05-08
 *
 *   # Compare against proxy DB for a date range:
 *   node reconcile-costs.js --report cost-report.json --db ../usage.db
 *
 * Report JSON format (Anthropic /v1/organizations/{org_id}/cost):
 *   { "data": [{ "date": "2026-05-01", "model": "...", "cost_usd": N, "input_tokens": N, ... }] }
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const SCRIPT_DIR = path.dirname(path.resolve(__filename));
const DEFAULT_DB = process.env.USAGE_DB || path.resolve(SCRIPT_DIR, '../usage.db');

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { db: DEFAULT_DB };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report' && args[i+1]) opts.report = args[++i];
    else if (args[i] === '--db' && args[i+1]) opts.db = args[++i];
    else if (args[i] === '--api') opts.api = true;
    else if (args[i] === '--start' && args[i+1]) opts.start = args[++i];
    else if (args[i] === '--end' && args[i+1]) opts.end = args[++i];
    else if (args[i] === '--help') { printUsage(); process.exit(0); }
  }
  return opts;
}

function printUsage() {
  console.log(`Usage:
  node reconcile-costs.js --report <file.json> [--db <path>]
  node reconcile-costs.js --api --start YYYY-MM-DD --end YYYY-MM-DD [--db <path>]

Options:
  --report  Path to Anthropic cost report JSON
  --api     Fetch from Anthropic API (requires ANTHROPIC_ADMIN_KEY env)
  --start   Start date (YYYY-MM-DD)
  --end     End date (YYYY-MM-DD)
  --db      Path to usage.db (default: ../usage.db)`);
}

async function fetchFromApi(start, end) {
  const key = process.env.ANTHROPIC_ADMIN_KEY;
  if (!key) {
    console.error('[reconcile] ANTHROPIC_ADMIN_KEY not set');
    process.exit(1);
  }
  const url = `https://api.anthropic.com/v1/organizations/cost?start_date=${start}&end_date=${end}`;
  const res = await fetch(url, {
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
  });
  if (!res.ok) {
    console.error(`[reconcile] API error: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return await res.json();
}

function loadReport(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(raw);
}

function queryProxyDb(dbPath, startDate, endDate) {
  if (!fs.existsSync(dbPath)) {
    console.error('[reconcile] usage.db not found at ' + dbPath);
    process.exit(1);
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');

  const rows = db.prepare(`
    SELECT
      date(timestamp) AS day,
      model,
      SUM(estimated_cost_usd) AS cost,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens,
      COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= ? AND timestamp < ?
    GROUP BY day, model
    ORDER BY day, model
  `).all(startDate + 'T00:00:00Z', endDate + 'T23:59:59Z');

  const totals = db.prepare(`
    SELECT
      SUM(estimated_cost_usd) AS total_cost,
      SUM(input_tokens) AS total_input,
      SUM(output_tokens) AS total_output,
      COUNT(*) AS total_calls
    FROM usage_log
    WHERE timestamp >= ? AND timestamp < ?
  `).get(startDate + 'T00:00:00Z', endDate + 'T23:59:59Z');

  db.close();
  return { rows, totals };
}

function reconcile(billingData, proxyData) {
  const result = {
    billing_total: 0,
    proxy_total: proxyData.totals.total_cost || 0,
    proxy_calls: proxyData.totals.total_calls || 0,
    gap_usd: 0,
    gap_pct: 0,
    by_model: {},
  };

  // Aggregate billing by model
  const billingByModel = {};
  for (const entry of (billingData.data || billingData)) {
    const model = entry.model || entry.model_id || 'unknown';
    const cost = entry.cost_usd || entry.cost || 0;
    result.billing_total += cost;
    billingByModel[model] = (billingByModel[model] || 0) + cost;
  }

  // Aggregate proxy by model
  const proxyByModel = {};
  for (const row of proxyData.rows) {
    proxyByModel[row.model] = (proxyByModel[row.model] || 0) + row.cost;
  }

  // Compare
  const allModels = new Set([...Object.keys(billingByModel), ...Object.keys(proxyByModel)]);
  for (const model of allModels) {
    const billing = billingByModel[model] || 0;
    const proxy = proxyByModel[model] || 0;
    const gap = billing - proxy;
    result.by_model[model] = {
      billing: parseFloat(billing.toFixed(4)),
      proxy: parseFloat(proxy.toFixed(4)),
      gap: parseFloat(gap.toFixed(4)),
      gap_pct: billing > 0 ? parseFloat(((gap / billing) * 100).toFixed(1)) : (proxy > 0 ? -100 : 0),
    };
  }

  result.gap_usd = parseFloat((result.billing_total - result.proxy_total).toFixed(4));
  result.gap_pct = result.billing_total > 0
    ? parseFloat(((result.gap_usd / result.billing_total) * 100).toFixed(1))
    : 0;

  return result;
}

async function main() {
  const opts = parseArgs();

  if (!opts.report && !opts.api) {
    // No billing data — just show proxy summary
    const start = opts.start || new Date(Date.now() - 7*86400000).toISOString().slice(0, 10);
    const end = opts.end || new Date().toISOString().slice(0, 10);
    const proxy = queryProxyDb(opts.db, start, end);
    console.log(JSON.stringify({
      mode: 'proxy_only',
      period: { start, end },
      proxy_total_cost: parseFloat((proxy.totals.total_cost || 0).toFixed(2)),
      proxy_total_calls: proxy.totals.total_calls || 0,
      by_day_model: proxy.rows.map(r => ({
        day: r.day, model: r.model, cost: parseFloat(r.cost.toFixed(4)), calls: r.calls,
      })),
      note: 'No billing data provided. Use --report <file> or --api to compare against Anthropic billing.',
    }, null, 2));
    return;
  }

  let billingData;
  if (opts.api) {
    if (!opts.start || !opts.end) {
      console.error('[reconcile] --api requires --start and --end dates');
      process.exit(1);
    }
    billingData = await fetchFromApi(opts.start, opts.end);
  } else {
    billingData = loadReport(opts.report);
  }

  // Infer date range from billing data if not specified
  const start = opts.start || (billingData.data || billingData)[0]?.date || '2026-01-01';
  const dates = (billingData.data || billingData).map(e => e.date).filter(Boolean).sort();
  const end = opts.end || dates[dates.length - 1] || '2026-12-31';

  const proxyData = queryProxyDb(opts.db, start, end);
  const result = reconcile(billingData, proxyData);

  console.log(JSON.stringify({
    period: { start, end },
    ...result,
    summary: result.gap_usd > 0
      ? `Billing is $${result.gap_usd.toFixed(2)} HIGHER than proxy (${result.gap_pct}% gap) — possible bypass traffic`
      : `Proxy is $${Math.abs(result.gap_usd).toFixed(2)} HIGHER than billing (${Math.abs(result.gap_pct)}% over) — possible overcount or billing credits`,
  }, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
