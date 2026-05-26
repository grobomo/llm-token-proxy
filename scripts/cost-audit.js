#!/usr/bin/env node
'use strict';

/**
 * Cost Audit — shows exactly how every dollar is calculated.
 *
 * Usage:
 *   node scripts/cost-audit.js                    # yesterday, full breakdown
 *   node scripts/cost-audit.js --date 2026-05-15  # specific day
 *   node scripts/cost-audit.js --range 7d         # last 7 days
 *   node scripts/cost-audit.js --call-detail 20   # show top N individual calls
 *   node scripts/cost-audit.js --reconcile 200    # compare against external bill
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  return args[i + 1] || true;
}

const targetDate    = flag('date');
const range         = flag('range') || (targetDate ? null : '1d');
const callDetailN   = parseInt(flag('call-detail') || '10', 10);
const reconcileAmt  = flag('reconcile') ? parseFloat(flag('reconcile')) : null;
const dbPath        = flag('db') || path.join(process.env.HOME, '.token-proxy', 'usage.db');
const configPath    = flag('config') || path.resolve(__dirname, '..', 'config.yaml');

// ── DB ────────────────────────────────────────────────────────────────────
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}
const db = new DatabaseSync(dbPath, { readOnly: true });

// ── Config / Pricing ──────────────────────────────────────────────────────
let config = {};
try { config = yaml.load(fs.readFileSync(configPath, 'utf8')); } catch {}
const pricing = config.pricing || {};
const upstreamPricing = config.upstream_pricing || {};

function getRate(model, upstream) {
  // Check upstream-specific pricing first
  if (upstream && upstreamPricing[upstream]) {
    const up = upstreamPricing[upstream];
    if (up[model]) return { ...up[model], _source: `upstream_pricing.${upstream}.${model}` };
    for (const key of Object.keys(up)) {
      if (key === 'default') continue;
      if (model.startsWith(key)) return { ...up[key], _source: `upstream_pricing.${upstream}.${key}` };
    }
    if (up.default) return { ...up.default, _source: `upstream_pricing.${upstream}.default` };
  }
  // Fall back to global pricing
  if (pricing[model]) return { ...pricing[model], _source: `pricing.${model}` };
  for (const key of Object.keys(pricing)) {
    if (key === 'default') continue;
    if (model.startsWith(key)) return { ...pricing[key], _source: `pricing.${key}` };
  }
  return pricing.default ? { ...pricing.default, _source: 'pricing.default' } : null;
}

function calcCost(model, inp, out, cr, cw, upstream) {
  const rate = getRate(model, upstream);
  if (!rate) return { total: 0, breakdown: null, rate: null };
  const M = 1_000_000;

  let total, breakdown;
  if (rate.flat_input) {
    const allInput = inp + cr + cw;
    const inputCost = (allInput / M) * rate.flat_input;
    const outputCost = (out / M) * (rate.output || 0);
    total = inputCost + outputCost;
    breakdown = { input: inputCost, output: outputCost, cache_read: 0, cache_write: 0 };
  } else {
    const netInput = Math.max(0, inp - cr - cw);
    const inputCost = (netInput / M) * (rate.input || 0);
    const outputCost = (out / M) * (rate.output || 0);
    const crCost = (cr / M) * (rate.cache_read || 0);
    const cwCost = (cw / M) * (rate.cache_write || 0);
    total = inputCost + outputCost + crCost + cwCost;
    breakdown = { input: inputCost, output: outputCost, cache_read: crCost, cache_write: cwCost };
  }
  return { total, breakdown, rate };
}

// ── Time filter ───────────────────────────────────────────────────────────
let whereClause;
let label;
if (targetDate) {
  whereClause = `date(timestamp) = '${targetDate}'`;
  label = targetDate;
} else if (range === '1d') {
  whereClause = `date(timestamp) = date('now', '-1 day')`;
  label = 'yesterday';
} else if (range === '7d') {
  whereClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`;
  label = 'last 7 days';
} else {
  whereClause = `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;
  label = 'today';
}

// ── Queries ───────────────────────────────────────────────────────────────
const fmt = (n) => `$${n.toFixed(4)}`;
const fmtPct = (n, total) => total > 0 ? `${(n / total * 100).toFixed(1)}%` : '0%';
const fmtTok = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n);
const pad = (s, n) => String(s).padStart(n);
const rpad = (s, n) => String(s).padEnd(n);

console.log('');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`  COST AUDIT — ${label}`);
console.log('═══════════════════════════════════════════════════════════════');
console.log('');

// ── 1. Grand totals ──────────────────────────────────────────────────────
const totals = db.prepare(`
  SELECT COUNT(*) AS calls,
         SUM(estimated_cost_usd) AS cost,
         SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
         SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw,
         SUM(cache_estimated) AS est_count
  FROM usage_log WHERE ${whereClause}
`).get();

console.log('1. TOTALS');
console.log(`   Calls:        ${totals.calls}`);
console.log(`   Tracked cost: ${fmt(totals.cost || 0)}`);
console.log(`   Estimated:    ${totals.est_count || 0} calls used cache heuristic`);
console.log('');

// ── 2. Per-model/upstream breakdown with rate proof ──────────────────────
const models = db.prepare(`
  SELECT model, upstream,
         COUNT(*) AS calls,
         SUM(estimated_cost_usd) AS cost,
         SUM(input_tokens) AS inp, SUM(output_tokens) AS out,
         SUM(cache_read_tokens) AS cr, SUM(cache_write_tokens) AS cw,
         SUM(cache_estimated) AS est_count
  FROM usage_log WHERE ${whereClause}
  GROUP BY model, upstream ORDER BY cost DESC
`).all();

console.log('2. PER-MODEL COST BREAKDOWN (rates from config.yaml)');
console.log('');

for (const m of models) {
  const rate = getRate(m.model, m.upstream);
  const recalc = calcCost(m.model, m.inp, m.out, m.cr, m.cw, m.upstream);

  console.log(`   ${m.model} [${m.upstream}] — ${m.calls} calls`);
  console.log(`   ┌─────────────────┬──────────────┬─────────────┬──────────────┐`);
  console.log(`   │ Token type      │ Tokens       │ Rate/M      │ Cost         │`);
  console.log(`   ├─────────────────┼──────────────┼─────────────┼──────────────┤`);

  const netInp = Math.max(0, m.inp - m.cr - m.cw);
  const rows = [
    ['input (net)',   netInp,  rate?.input || 0,      recalc.breakdown?.input || 0],
    ['output',        m.out,   rate?.output || 0,      recalc.breakdown?.output || 0],
    ['cache_read',    m.cr,    rate?.cache_read || 0,  recalc.breakdown?.cache_read || 0],
    ['cache_write',   m.cw,    rate?.cache_write || 0, recalc.breakdown?.cache_write || 0],
  ];

  for (const [label, tokens, ratePerM, cost] of rows) {
    console.log(`   │ ${rpad(label, 15)} │ ${pad(fmtTok(tokens), 12)} │ ${pad(`$${ratePerM}`, 11)} │ ${pad(fmt(cost), 12)} │`);
  }

  console.log(`   ├─────────────────┼──────────────┼─────────────┼──────────────┤`);
  console.log(`   │ TOTAL           │              │             │ ${pad(fmt(recalc.total), 12)} │`);
  console.log(`   └─────────────────┴──────────────┴─────────────┴──────────────┘`);

  const dbCost = m.cost || 0;
  const diff = Math.abs(recalc.total - dbCost);
  if (diff > 0.01) {
    console.log(`   ⚠ DB says ${fmt(dbCost)}, recalc says ${fmt(recalc.total)} — delta ${fmt(diff)}`);
  }
  if (m.est_count > 0) {
    console.log(`   ⚠ ${m.est_count}/${m.calls} calls used cache estimation heuristic`);
  }
  console.log('');
}

// ── 3. Cost attribution by token type ────────────────────────────────────
let totalInput = 0, totalOutput = 0, totalCR = 0, totalCW = 0;
for (const m of models) {
  const recalc = calcCost(m.model, m.inp, m.out, m.cr, m.cw, m.upstream);
  if (recalc.breakdown) {
    totalInput += recalc.breakdown.input;
    totalOutput += recalc.breakdown.output;
    totalCR += recalc.breakdown.cache_read;
    totalCW += recalc.breakdown.cache_write;
  }
}

const recalcTotal = totalInput + totalOutput + totalCR + totalCW;
const dbTotal = totals.cost || 0;

console.log('3. COST ATTRIBUTION BY TOKEN TYPE (recalculated with current rates)');
console.log(`   input:       ${fmt(totalInput)} (${fmtPct(totalInput, recalcTotal)})`);
console.log(`   output:      ${fmt(totalOutput)} (${fmtPct(totalOutput, recalcTotal)})`);
console.log(`   cache_read:  ${fmt(totalCR)} (${fmtPct(totalCR, recalcTotal)})`);
console.log(`   cache_write: ${fmt(totalCW)} (${fmtPct(totalCW, recalcTotal)})`);
console.log(`   RECALC TOTAL: ${fmt(recalcTotal)}`);
if (Math.abs(recalcTotal - dbTotal) > 0.01) {
  console.log(`   DB STORED:    ${fmt(dbTotal)} (delta ${fmt(Math.abs(recalcTotal - dbTotal))} — DB used old rates)`);
}
console.log('');

// ── 4. Top individual calls ──────────────────────────────────────────────
const topCalls = db.prepare(`
  SELECT id, timestamp, model, upstream, consumer, project,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         estimated_cost_usd, cache_estimated, session_id
  FROM usage_log WHERE ${whereClause}
  ORDER BY estimated_cost_usd DESC LIMIT ?
`).all(callDetailN);

console.log(`4. TOP ${callDetailN} MOST EXPENSIVE CALLS`);
console.log('');

for (const c of topCalls) {
  const recalc = calcCost(c.model, c.input_tokens, c.output_tokens, c.cache_read_tokens, c.cache_write_tokens, c.upstream);
  const rate = getRate(c.model, c.upstream);
  console.log(`   #${c.id} ${c.timestamp}`);
  console.log(`   model=${c.model} upstream=${c.upstream} project=${c.project || '(none)'}`);
  console.log(`   in=${fmtTok(c.input_tokens)} out=${fmtTok(c.output_tokens)} cr=${fmtTok(c.cache_read_tokens)} cw=${fmtTok(c.cache_write_tokens)}${c.cache_estimated ? ' (est)' : ''}`);
  console.log(`   cost=${fmt(c.estimated_cost_usd)} recalc=${fmt(recalc.total)}`);
  if (recalc.breakdown) {
    const parts = [];
    if (recalc.breakdown.cache_read > 0)  parts.push(`cr=${fmt(recalc.breakdown.cache_read)} @$${rate.cache_read}/M`);
    if (recalc.breakdown.cache_write > 0) parts.push(`cw=${fmt(recalc.breakdown.cache_write)} @$${rate.cache_write}/M`);
    if (recalc.breakdown.output > 0)      parts.push(`out=${fmt(recalc.breakdown.output)} @$${rate.output}/M`);
    if (recalc.breakdown.input > 0)       parts.push(`in=${fmt(recalc.breakdown.input)} @$${rate.input}/M`);
    console.log(`   → ${parts.join(' + ')}`);
  }
  console.log('');
}

// ── 5. Pricing rates being used ──────────────────────────────────────────
console.log('5. PRICING RATES USED (from config.yaml)');
console.log('');

const hasUpstreamPricing = Object.keys(upstreamPricing).length > 0;
if (!hasUpstreamPricing) {
  console.log('   ⚠ No upstream_pricing configured — using global rates for all upstreams.');
  console.log('   ⚠ If billed through RDsec/Trend Micro, actual rates may differ.');
}
console.log('');

for (const m of models) {
  const rate = getRate(m.model, m.upstream);
  if (rate) {
    console.log(`   ${m.model} [${m.upstream}] — source: ${rate._source}`);
    console.log(`     input=$${rate.input}/M  output=$${rate.output}/M  cache_read=$${rate.cache_read}/M  cache_write=$${rate.cache_write}/M`);
  } else {
    console.log(`   ${m.model} [${m.upstream}]: NO PRICING CONFIGURED`);
  }
}
console.log('');

// ── 6. Reconciliation ────────────────────────────────────────────────────
if (reconcileAmt !== null) {
  console.log('6. RECONCILIATION');
  console.log(`   External bill:   ${fmt(reconcileAmt)}`);
  console.log(`   Recalculated:    ${fmt(recalcTotal)}`);
  console.log(`   DB stored:       ${fmt(dbTotal)}`);
  const delta = recalcTotal - reconcileAmt;
  const ratio = reconcileAmt > 0 ? recalcTotal / reconcileAmt : 0;
  console.log(`   Delta:           ${fmt(delta)} (tracker is ${delta > 0 ? 'higher' : 'lower'})`);
  console.log(`   Ratio:           ${ratio.toFixed(2)}x`);
  console.log('');

  if (Math.abs(delta) > 1) {
    console.log('   DIAGNOSIS:');
    if (delta > 0) {
      console.log('   Tracker is HIGHER than external bill. Possible causes:');
      console.log('   a) Pricing rates in config.yaml are higher than actual rates');
      console.log(`      cache_read alone = ${fmt(totalCR)} (${fmtPct(totalCR, totalCost)} of total)`);
      console.log(`      cache_write alone = ${fmt(totalCW)} (${fmtPct(totalCW, totalCost)} of total)`);

      if (totalCR > reconcileAmt * 0.5) {
        console.log('      → cache_read is the primary suspect');
        const impliedCRRate = totalCR > 0
          ? ((reconcileAmt - totalOutput - totalCW - totalInput) / (totals.cr / 1_000_000))
          : 0;
        if (impliedCRRate >= 0) {
          console.log(`      → If external bill is correct, implied cache_read rate = $${impliedCRRate.toFixed(2)}/M`);
        }
      }

      console.log('   b) Cache tokens being double-counted');
      console.log('   c) Tracker captures more calls than billing covers');
    } else {
      console.log('   Tracker is LOWER than external bill. Possible causes:');
      console.log('   a) Some API calls bypass the proxy');
      console.log('   b) Pricing rates are too low');
      console.log('   c) External bill includes fixed/platform fees');
    }
  } else {
    console.log('   ✓ Costs match within $1 tolerance.');
  }
  console.log('');
}

// ── 7. Data quality checks ───────────────────────────────────────────────
console.log(`${reconcileAmt !== null ? '7' : '6'}. DATA QUALITY CHECKS`);
console.log('');

const zeroCost = db.prepare(`
  SELECT COUNT(*) AS cnt FROM usage_log
  WHERE ${whereClause} AND estimated_cost_usd = 0 AND http_status BETWEEN 200 AND 299
`).get();
if (zeroCost.cnt > 0) {
  console.log(`   ⚠ ${zeroCost.cnt} successful calls with $0.00 cost (missing usage data or pricing)`);
}

const noSession = db.prepare(`
  SELECT COUNT(*) AS cnt FROM usage_log
  WHERE ${whereClause} AND session_id IS NULL AND consumer = 'claude-code'
`).get();
if (noSession.cnt > 0) {
  console.log(`   ⚠ ${noSession.cnt} claude-code calls without session_id`);
}

const noProject = db.prepare(`
  SELECT COUNT(*) AS cnt FROM usage_log
  WHERE ${whereClause} AND project IS NULL
`).get();
if (noProject.cnt > 0) {
  console.log(`   ⚠ ${noProject.cnt} calls without project attribution`);
}

const estCount = totals.est_count || 0;
if (estCount > 0) {
  console.log(`   ⚠ ${estCount} calls used cache estimation (not actual upstream data)`);
}

if (!zeroCost.cnt && !noSession.cnt && !noProject.cnt && !estCount) {
  console.log('   ✓ All checks passed');
}

console.log('');
console.log('═══════════════════════════════════════════════════════════════');

db.close();
