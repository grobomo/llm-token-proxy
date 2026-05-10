#!/usr/bin/env node
'use strict';

// Merge a remote (Lightsail) usage.db into the local DB.
// Downloads via scp, deduplicates on (timestamp, consumer, model, session_id),
// inserts missing rows into local DB.
//
// Usage: node scripts/merge-dbs.js [--dry-run]
//        node scripts/merge-dbs.js --remote-path /tmp/remote-usage.db

const { DatabaseSync } = require('node:sqlite');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const INSTANCE = 'token-proxy-dashboard';
const REMOTE_DB_PATH = '/opt/dashboard/usage.db';
const LOCAL_DB_PATH = process.env.USAGE_DB ||
  path.join(process.env.HOME, '.token-proxy', 'usage.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const remotePathIdx = args.indexOf('--remote-path');
const tmpPath = remotePathIdx >= 0 ? args[remotePathIdx + 1] : '/tmp/remote-usage.db';

if (remotePathIdx < 0) {
  console.log(`[merge] Downloading remote DB from ${INSTANCE}:${REMOTE_DB_PATH}...`);
  try {
    execSync(`scp ${INSTANCE}:${REMOTE_DB_PATH} ${tmpPath}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('[merge] Failed to download remote DB:', err.message);
    process.exit(1);
  }
}

if (!fs.existsSync(tmpPath)) {
  console.error(`[merge] Remote DB not found at ${tmpPath}`);
  process.exit(1);
}

if (!fs.existsSync(LOCAL_DB_PATH)) {
  console.error(`[merge] Local DB not found at ${LOCAL_DB_PATH}`);
  process.exit(1);
}

const local = new DatabaseSync(LOCAL_DB_PATH);
const remote = new DatabaseSync(tmpPath, { readOnly: true });

local.exec('PRAGMA journal_mode = WAL');

const localCount = local.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n;
const remoteCount = remote.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n;
console.log(`[merge] Local: ${localCount} rows, Remote: ${remoteCount} rows`);

const cols = remote.prepare('PRAGMA table_info(usage_log)').all()
  .map(c => c.name)
  .filter(c => c !== 'id');

const remoteRows = remote.prepare(`SELECT ${cols.join(', ')} FROM usage_log ORDER BY timestamp`).all();
console.log(`[merge] Read ${remoteRows.length} rows from remote`);

const existsStmt = local.prepare(`
  SELECT 1 FROM usage_log
  WHERE timestamp = ? AND consumer = ? AND model = ? AND COALESCE(session_id, '') = ?
  LIMIT 1
`);

const insertSql = `INSERT INTO usage_log (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
const insertStmt = dryRun ? null : local.prepare(insertSql);

let added = 0;
let skipped = 0;

const batchSize = 500;
if (!dryRun) local.exec('BEGIN');

for (const row of remoteRows) {
  const exists = existsStmt.get(
    row.timestamp, row.consumer, row.model, row.session_id || ''
  );
  if (exists) {
    skipped++;
    continue;
  }
  if (!dryRun) {
    insertStmt.run(...cols.map(c => row[c] ?? null));
  }
  added++;

  if (!dryRun && added % batchSize === 0) {
    local.exec('COMMIT');
    local.exec('BEGIN');
  }
}

if (!dryRun) local.exec('COMMIT');

const finalCount = local.prepare('SELECT COUNT(*) AS n FROM usage_log').get().n;
console.log(`[merge] ${dryRun ? '(DRY RUN) Would add' : 'Added'}: ${added} rows, Skipped (duplicate): ${skipped}`);
console.log(`[merge] Final local count: ${finalCount}`);

if (!dryRun && added > 0) {
  console.log('[merge] Done. Run scripts/sync-dashboard.sh to push merged DB to Lightsail.');
}
