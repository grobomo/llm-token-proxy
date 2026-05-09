#!/usr/bin/env node
'use strict';

/**
 * daily-report.js
 * Automated daily cost report — run via cron at end of day.
 * Outputs verified cost breakdown with raw token data.
 *
 * Usage:
 *   node daily-report.js                    # today
 *   node daily-report.js --date 2026-05-08  # specific date
 *   node daily-report.js --json             # machine-readable output
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const SCRIPT_DIR = path.dirname(path.resolve(__filename));
const DB_PATH    = process.env.USAGE_DB || path.resolve(SCRIPT_DIR, '../usage.db');
const DATA_DIR   = path.resolve(SCRIPT_DIR, '../data');
const M          = 1_000_000;

const PRICING = {
  'claude-opus-4-7':  { i: 15, o: 75, cr: 1.50, cw: 18.75, tier: 'opus' },
  'claude-4.6-opus':  { i: 15, o: 75, cr: 1.50, cw: 18.75, tier: 'opus' },
  'claude-opus-4-6':  { i: 15, o: 75, cr: 1.50, cw: 18.75, tier: 'opus' },
  'claude-4.6-opus-aws': { i: 15, o: 75, cr: 1.50, cw: 18.75, tier: 'opus' },
  'claude-4.6-sonnet': { i: 3, o: 15, cr: 0.30, cw: 3.75, tier: 'sonnet' },
  'claude-sonnet-4-6': { i: 3, o: 15, cr: 0.30, cw: 3.75, tier: 'sonnet' },
  'claude-4.5-haiku':  { i: 1, o: 5, cr: 0.10, cw: 1.25, tier: 'haiku' },
  'claude-haiku-4-5':  { i: 1, o: 5, cr: 0.10, cw: 1.25, tier: 'haiku' },
  'claude-4.5-haiku-aws': { i: 1, o: 5, cr: 0.10, cw: 1.25, tier: 'haiku' },
  'claude-haiku-4-5-20251001': { i: 1, o: 5, cr: 0.10, cw: 1.25, tier: 'haiku' },
};

function getPrice(model) {
  if (PRICING[model]) return PRICING[model];
  for (const k of Object.keys(PRICING)) { if (model.startsWith(k)) return PRICING[k]; }
  return { i: 3, o: 15, cr: 0.30, cw: 3.75, tier: 'default' };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { date: new Date().toISOString().slice(0, 10), json: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--date' && args[i+1]) opts.date = args[++i];
    if (args[i] === '--json') opts.json = true;
  }
  return opts;
}

function generateReport(db, date) {
  const startTs = date + 'T00:00:00Z';
  const endTs = date + 'T23:59:59Z';

  const rows = db.prepare(`
    SELECT model, consumer, project, user_agent, upstream,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           estimated_cost_usd
    FROM usage_log
    WHERE timestamp >= ? AND timestamp <= ?
  `).all(startTs, endTs);

  let totalCalls = rows.length;
  let totalRecorded = 0;
  let tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let cost = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let byProject = {};
  let byConsumer = {};
  let byModel = {};
  let byHour = {};

  for (const r of rows) {
    const p = getPrice(r.model);
    const inp = r.input_tokens || 0;
    const out = r.output_tokens || 0;
    const cr = r.cache_read_tokens || 0;
    const cw = r.cache_write_tokens || 0;

    totalRecorded += r.estimated_cost_usd || 0;
    tokens.input += inp;
    tokens.output += out;
    tokens.cache_read += cr;
    tokens.cache_write += cw;
    cost.input += (inp/M) * p.i;
    cost.output += (out/M) * p.o;
    cost.cache_read += (cr/M) * p.cr;
    cost.cache_write += (cw/M) * p.cw;

    const proj = r.project || '(untagged)';
    if (!byProject[proj]) byProject[proj] = { calls: 0, cost: 0, cw: 0 };
    byProject[proj].calls++;
    byProject[proj].cost += r.estimated_cost_usd || 0;
    byProject[proj].cw += cw;

    const cons = r.consumer || 'unknown';
    if (!byConsumer[cons]) byConsumer[cons] = { calls: 0, cost: 0 };
    byConsumer[cons].calls++;
    byConsumer[cons].cost += r.estimated_cost_usd || 0;

    const model = r.model || 'unknown';
    if (!byModel[model]) byModel[model] = { calls: 0, cost: 0, tier: p.tier };
    byModel[model].calls++;
    byModel[model].cost += r.estimated_cost_usd || 0;
  }

  const totalCalculated = cost.input + cost.output + cost.cache_read + cost.cache_write;

  return {
    date,
    total_calls: totalCalls,
    total_cost_recorded: parseFloat(totalRecorded.toFixed(2)),
    total_cost_calculated: parseFloat(totalCalculated.toFixed(2)),
    discrepancy_pct: parseFloat((Math.abs(totalCalculated - totalRecorded) / (totalCalculated || 1) * 100).toFixed(1)),
    tokens: {
      input: tokens.input,
      output: tokens.output,
      cache_read: tokens.cache_read,
      cache_write: tokens.cache_write,
    },
    cost_by_type: {
      input: { usd: parseFloat(cost.input.toFixed(2)), pct: parseFloat((cost.input/totalCalculated*100).toFixed(0)) },
      output: { usd: parseFloat(cost.output.toFixed(2)), pct: parseFloat((cost.output/totalCalculated*100).toFixed(0)) },
      cache_read: { usd: parseFloat(cost.cache_read.toFixed(2)), pct: parseFloat((cost.cache_read/totalCalculated*100).toFixed(0)) },
      cache_write: { usd: parseFloat(cost.cache_write.toFixed(2)), pct: parseFloat((cost.cache_write/totalCalculated*100).toFixed(0)) },
    },
    by_project: Object.entries(byProject)
      .map(([name, d]) => ({ name, calls: d.calls, cost: parseFloat(d.cost.toFixed(2)), cache_write_tokens: d.cw }))
      .sort((a, b) => b.cost - a.cost),
    by_consumer: Object.entries(byConsumer)
      .map(([name, d]) => ({ name, calls: d.calls, cost: parseFloat(d.cost.toFixed(2)) }))
      .sort((a, b) => b.cost - a.cost),
    by_model: Object.entries(byModel)
      .map(([name, d]) => ({ name, tier: d.tier, calls: d.calls, cost: parseFloat(d.cost.toFixed(2)) }))
      .sort((a, b) => b.cost - a.cost),
    pricing_source: 'Anthropic published rates (anthropic.com/pricing)',
  };
}

function printHuman(report) {
  console.log(`=== Daily Cost Report: ${report.date} ===`);
  console.log(`Total: $${report.total_cost_recorded} (${report.total_calls} calls)`);
  console.log(`Verified: $${report.total_cost_calculated} calculated from tokens (${report.discrepancy_pct}% discrepancy)`);
  console.log('');
  console.log('Cost by token type:');
  const ct = report.cost_by_type;
  console.log(`  Cache read ($1.50/M):    $${ct.cache_read.usd.toFixed(2).padStart(6)} (${ct.cache_read.pct}%) — ${(report.tokens.cache_read/1000).toFixed(0)}K tokens`);
  console.log(`  Output ($75/M):          $${ct.output.usd.toFixed(2).padStart(6)} (${ct.output.pct}%) — ${(report.tokens.output/1000).toFixed(0)}K tokens`);
  console.log(`  Cache write ($18.75/M):  $${ct.cache_write.usd.toFixed(2).padStart(6)} (${ct.cache_write.pct}%) — ${(report.tokens.cache_write/1000).toFixed(0)}K tokens`);
  console.log(`  Input ($15/M):           $${ct.input.usd.toFixed(2).padStart(6)} (${ct.input.pct}%) — ${(report.tokens.input/1000).toFixed(0)}K tokens`);
  console.log('');
  console.log('By project:');
  for (const p of report.by_project.slice(0, 10)) {
    console.log(`  ${p.name.padEnd(25)} $${p.cost.toFixed(2).padStart(7)} (${p.calls} calls, cw=${(p.cache_write_tokens/1000).toFixed(0)}K)`);
  }
  console.log('');
  console.log('By consumer:');
  for (const c of report.by_consumer) {
    console.log(`  ${c.name.padEnd(15)} $${c.cost.toFixed(2).padStart(7)} (${c.calls} calls)`);
  }
  console.log('');
  console.log('By model:');
  for (const m of report.by_model.filter(x => x.cost > 0)) {
    console.log(`  ${m.name.padEnd(30)} $${m.cost.toFixed(2).padStart(7)} (${m.calls} calls, ${m.tier})`);
  }
  console.log('');
  console.log(`Source: ${report.pricing_source}`);
}

function main() {
  const opts = parseArgs();

  if (!fs.existsSync(DB_PATH)) {
    console.error('[daily-report] usage.db not found at ' + DB_PATH);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');

  const report = generateReport(db, opts.date);
  db.close();

  if (opts.json) {
    // Save to data dir
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const outPath = path.join(DATA_DIR, `report-${opts.date}.json`);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    console.error(`Saved to ${outPath}`);
  } else {
    printHuman(report);
  }
}

main();
