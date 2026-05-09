'use strict';

/**
 * Backfill cache cost estimates for historical RDSec/LiteLLM calls.
 *
 * Usage:
 *   node scripts/backfill-cache-estimates.js [--dry-run] [--db path/to/usage.db]
 *
 * Finds non-Anthropic upstream calls with cache_estimated=0, cache_read_tokens=0,
 * cache_write_tokens=0, and a caching-capable model with output_tokens > 0.
 * Applies the same heuristic as lib/cache-estimator.js:
 *   - First call per session: cache_write = 30% of 200K
 *   - Subsequent calls per session: cache_read = 200K
 * Then recalculates cost using pricing.js.
 */

const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');
const { DatabaseSync } = require('node:sqlite');
const { modelUsesCaching, DEFAULT_SYSTEM_PROMPT_TOKENS } = require('../lib/cache-estimator');
const pricing = require('../pricing');

// Parse args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const dbIdx = args.indexOf('--db');
const dbArg = dbIdx >= 0 ? args[dbIdx + 1] : null;

// Load config for pricing
const configPath = process.env.PROXY_CONFIG || path.resolve(__dirname, '..', 'config.yaml');
let config = {};
if (fs.existsSync(configPath)) {
  config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  pricing.loadPricing(config.pricing);
}

// Open database
const dbPath = dbArg || config.db || path.resolve(__dirname, '..', 'usage.db');
if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA busy_timeout = 5000');

// Find candidates: non-Anthropic upstream, no cache data, caching model, has output
const candidates = db.prepare(`
  SELECT id, model, upstream, session_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, estimated_cost_usd, timestamp
  FROM usage_log
  WHERE upstream != 'anthropic'
    AND cache_estimated = 0
    AND cache_read_tokens = 0
    AND cache_write_tokens = 0
    AND output_tokens > 0
  ORDER BY timestamp ASC
`).all();

// Filter to caching-capable models
const eligible = candidates.filter(r => modelUsesCaching(r.model));

if (eligible.length === 0) {
  console.log('No eligible rows to backfill.');
  process.exit(0);
}

console.log(`Found ${eligible.length} eligible rows for cache estimation backfill.`);
if (dryRun) console.log('(dry run — no changes will be made)');

// Track first-call-per-session
const sessionFirstCall = new Set();
const promptSize = DEFAULT_SYSTEM_PROMPT_TOKENS;
const cacheWriteEstimate = Math.floor(promptSize * 0.30);

let updated = 0;
let totalCostDelta = 0;

const updateStmt = db.prepare(`
  UPDATE usage_log
  SET cache_read_tokens = ?,
      cache_write_tokens = ?,
      cache_estimated = 1,
      estimated_cost_usd = ?
  WHERE id = ?
`);

for (const row of eligible) {
  const sessionKey = row.session_id || `no-session-${row.id}`;
  const isFirst = !sessionFirstCall.has(sessionKey);
  if (isFirst) sessionFirstCall.add(sessionKey);

  let cacheRead = 0;
  let cacheWrite = 0;

  if (isFirst) {
    cacheWrite = cacheWriteEstimate;
  } else {
    cacheRead = promptSize;
  }

  // Recalculate cost with cache tokens
  const newCost = pricing.calculateCost(row.model, {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  });

  const costDelta = newCost - row.estimated_cost_usd;
  totalCostDelta += costDelta;

  if (dryRun) {
    console.log(`  [DRY] id=${row.id} model=${row.model} session=${(row.session_id || 'none').slice(0, 8)}… ` +
      `${isFirst ? 'cache_write' : 'cache_read'}=${isFirst ? cacheWrite : cacheRead} ` +
      `cost: $${row.estimated_cost_usd.toFixed(4)} → $${newCost.toFixed(4)} (+$${costDelta.toFixed(4)})`);
  } else {
    updateStmt.run(cacheRead, cacheWrite, newCost, row.id);
  }

  updated++;
}

console.log(`\n${dryRun ? 'Would update' : 'Updated'} ${updated} rows.`);
console.log(`Sessions found: ${sessionFirstCall.size}`);
console.log(`Cache write estimates: ${sessionFirstCall.size} (first call per session)`);
console.log(`Cache read estimates: ${updated - sessionFirstCall.size} (subsequent calls)`);
console.log(`Total cost adjustment: +$${totalCostDelta.toFixed(4)}`);
