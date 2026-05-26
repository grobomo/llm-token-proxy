#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(PROJECT_DIR, 'dashboard');
const HASHES_FILE = path.join(PROJECT_DIR, '.dashboard-hashes.json');
const DRIFT_MARKER = path.join(PROJECT_DIR, '.dashboard-drift-detected');

const IGNORE_DIRS = new Set(['data', 'node_modules']);

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function walkDir(dir, base = dir) {
  const results = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(results, walkDir(full, base));
    } else {
      const rel = path.relative(base, full);
      results[rel] = hashFile(full);
    }
  }
  return results;
}

function main() {
  if (!fs.existsSync(DASHBOARD_DIR)) {
    console.error('[drift] dashboard/ not found');
    process.exit(2);
  }

  const current = walkDir(DASHBOARD_DIR);
  let previous = {};
  if (fs.existsSync(HASHES_FILE)) {
    try { previous = JSON.parse(fs.readFileSync(HASHES_FILE, 'utf8')); } catch {}
  }

  const changed = [];
  const added = [];
  const removed = [];

  for (const [file, hash] of Object.entries(current)) {
    if (!(file in previous)) added.push(file);
    else if (previous[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(previous)) {
    if (!(file in current)) removed.push(file);
  }

  const drifted = changed.length + added.length + removed.length > 0;

  if (drifted) {
    const report = { detected: new Date().toISOString(), changed, added, removed };
    fs.writeFileSync(DRIFT_MARKER, JSON.stringify(report, null, 2));
    console.log(`[drift] Changes detected: ${changed.length} modified, ${added.length} added, ${removed.length} removed`);
    for (const f of [...changed, ...added]) console.log(`  M ${f}`);
    for (const f of removed) console.log(`  D ${f}`);
    process.exit(1);
  } else {
    if (fs.existsSync(DRIFT_MARKER)) fs.unlinkSync(DRIFT_MARKER);
    console.log('[drift] No changes detected');
    process.exit(0);
  }
}

main();
