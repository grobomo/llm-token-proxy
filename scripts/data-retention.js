#!/usr/bin/env node
// TOKEN_COST_REVIEWED: $0.00/day (no LLM calls, pure JS) — 2026-05-09
'use strict';

/**
 * data-retention.js
 * Purge usage_log rows older than N days.
 *
 * Usage:
 *   node scripts/data-retention.js               # dry-run, 90 days default
 *   node scripts/data-retention.js --days 30      # dry-run, 30 days
 *   node scripts/data-retention.js --execute      # actually delete
 *   node scripts/data-retention.js --days 30 --execute
 *
 * Can also be triggered via API:
 *   curl -X POST http://127.0.0.1:4100/api/purge -H 'Content-Type: application/json' \
 *     -d '{"days": 90, "dryRun": false}'
 */

const path = require('path');
const fs = require('fs');
const yaml = require('js-yaml');

// Parse CLI args
const args = process.argv.slice(2);
const daysIdx = args.indexOf('--days');
const days = daysIdx >= 0 ? parseInt(args[daysIdx + 1]) || 90 : 90;
const execute = args.includes('--execute');

// Load config to find DB path
const configPath = process.env.PROXY_CONFIG || path.resolve(__dirname, '..', 'config.yaml');
let dbPath = path.resolve(__dirname, '..', 'usage.db');
try {
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  if (config.db) dbPath = path.resolve(path.dirname(configPath), config.db);
} catch {}

// Init DB
const db = require('../db');
db.init(dbPath);

const interval = `-${days} days`;

// Preview
const preview = db.query(`
  SELECT COUNT(*) AS count,
         SUM(estimated_cost_usd) AS cost,
         MIN(timestamp) AS oldest,
         MAX(timestamp) AS newest
  FROM usage_log
  WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
`);
const p = preview[0] || {};
const total = db.query('SELECT COUNT(*) AS count FROM usage_log');
const totalRows = total[0]?.count || 0;

console.log(`Data retention — ${days} days`);
console.log(`Total rows in DB: ${totalRows}`);
console.log(`Rows older than ${days} days: ${p.count || 0}`);
console.log(`Cost of old data: $${(p.cost || 0).toFixed(2)}`);
if (p.oldest) console.log(`Date range: ${p.oldest} — ${p.newest}`);

if ((p.count || 0) === 0) {
  console.log('\nNothing to purge.');
  db.close();
  process.exit(0);
}

if (!execute) {
  console.log('\nDry run — no data deleted. Add --execute to purge.');
  db.close();
  process.exit(0);
}

const result = db.run(
  `DELETE FROM usage_log WHERE timestamp < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')`
);
console.log(`\nDeleted ${result.changes} rows.`);

// VACUUM to reclaim disk space
try {
  db.query('VACUUM');
  console.log('Database vacuumed.');
} catch {}

db.close();
