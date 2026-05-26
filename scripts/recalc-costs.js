#!/usr/bin/env node
'use strict';

/**
 * Recalculate all historical costs using current pricing config.
 * Fixes the DB after pricing rates are corrected (e.g. switching from
 * Anthropic published rates to actual RDsec/Trend Micro rates).
 *
 * Usage:
 *   node scripts/recalc-costs.js              # dry run
 *   node scripts/recalc-costs.js --execute    # apply changes
 *   node scripts/recalc-costs.js --since 2026-05-01  # only rows after date
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');
const yaml = require('js-yaml');

const args = process.argv.slice(2);
const execute = args.includes('--execute');
const sinceIdx = args.indexOf('--since');
const since = sinceIdx !== -1 ? args[sinceIdx + 1] : null;
const dbPath = path.join(process.env.HOME, '.token-proxy', 'usage.db');
const configPath = path.resolve(__dirname, '..', 'config.yaml');

if (!fs.existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
const pricingModule = require('../pricing');
pricingModule.loadPricing(config.pricing, config.upstream_pricing);

const db = new DatabaseSync(dbPath);

const whereClause = since ? `WHERE timestamp >= '${since}'` : '';
const rows = db.prepare(`
  SELECT id, model, upstream, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, estimated_cost_usd
  FROM usage_log ${whereClause}
  ORDER BY id ASC
`).all();

console.log(`Found ${rows.length} rows to recalculate${since ? ` (since ${since})` : ''}`);
console.log(`Mode: ${execute ? 'EXECUTE' : 'DRY RUN'}`);
console.log('');

let changed = 0;
let totalOldCost = 0;
let totalNewCost = 0;

const updateStmt = execute ? db.prepare(
  `UPDATE usage_log SET estimated_cost_usd = ? WHERE id = ?`
) : null;

for (const row of rows) {
  const usage = {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_input_tokens: row.cache_read_tokens,
    cache_creation_input_tokens: row.cache_write_tokens,
  };

  const newCost = pricingModule.calculateCost(row.model, usage, row.upstream);
  const oldCost = row.estimated_cost_usd;

  totalOldCost += oldCost;
  totalNewCost += newCost;

  if (Math.abs(newCost - oldCost) > 0.000001) {
    changed++;
    if (execute) {
      updateStmt.run(newCost, row.id);
    }
  }
}

console.log(`Results:`);
console.log(`  Total rows:     ${rows.length}`);
console.log(`  Changed:        ${changed}`);
console.log(`  Old total cost: $${totalOldCost.toFixed(2)}`);
console.log(`  New total cost: $${totalNewCost.toFixed(2)}`);
console.log(`  Savings:        $${(totalOldCost - totalNewCost).toFixed(2)}`);
console.log('');

if (!execute && changed > 0) {
  console.log(`Run with --execute to apply changes.`);
}

db.close();
