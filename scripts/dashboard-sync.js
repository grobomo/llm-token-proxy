#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PROJECT_DIR = path.resolve(__dirname, '..');
const DASHBOARD_DIR = path.join(PROJECT_DIR, 'dashboard');
const HASHES_FILE = path.join(PROJECT_DIR, '.dashboard-hashes.json');
const DRIFT_MARKER = path.join(PROJECT_DIR, '.dashboard-drift-detected');

const BUCKET = process.env.BUCKET || 'tokentracker-data';
const CF_DIST = process.env.CF_DISTRIBUTION_ID || 'E9NULDLVDW9ZJ';
const REGION = 'us-east-1';

const IGNORE_DIRS = new Set(['data', 'node_modules']);
const DEPLOY_FILES = ['index.html'];

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    console.error(`[sync] FAILED: ${cmd}\n  ${e.stderr || e.message}`);
    return null;
  }
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function walkDir(dir, base = dir) {
  const results = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(results, walkDir(full, base));
    } else {
      results[path.relative(base, full)] = hashFile(full);
    }
  }
  return results;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const ts = new Date().toISOString();

  console.log(`[sync] ${ts} Starting dashboard sync${dryRun ? ' (DRY RUN)' : ''}`);

  let uploaded = 0;
  for (const file of DEPLOY_FILES) {
    const local = path.join(DASHBOARD_DIR, file);
    if (!fs.existsSync(local)) continue;

    const s3Key = `dashboard/${file}`;
    const contentType = file.endsWith('.html') ? 'text/html' :
                        file.endsWith('.js') ? 'application/javascript' :
                        file.endsWith('.css') ? 'text/css' : 'application/octet-stream';

    if (dryRun) {
      console.log(`[sync] Would upload: ${file} → s3://${BUCKET}/${s3Key}`);
    } else {
      const result = run(`aws s3 cp "${local}" "s3://${BUCKET}/${s3Key}" --content-type "${contentType}" --region ${REGION}`);
      if (result !== null) {
        console.log(`[sync] Uploaded: ${file}`);
        uploaded++;
      }
    }
  }

  if (uploaded === 0 && !dryRun) {
    console.log('[sync] No files uploaded — aborting');
    process.exit(1);
  }

  if (!dryRun) {
    const inv = run(`aws cloudfront create-invalidation --distribution-id "${CF_DIST}" --paths "/dashboard/*" --region ${REGION}`);
    if (inv) console.log('[sync] CloudFront invalidation created');
  } else {
    console.log('[sync] Would invalidate: /dashboard/*');
  }

  const hashes = walkDir(DASHBOARD_DIR);
  if (!dryRun) {
    fs.writeFileSync(HASHES_FILE, JSON.stringify(hashes, null, 2));
    console.log(`[sync] Updated hash baseline (${Object.keys(hashes).length} files)`);
  }

  if (!dryRun && fs.existsSync(DRIFT_MARKER)) {
    fs.unlinkSync(DRIFT_MARKER);
    console.log('[sync] Cleared drift marker');
  }

  console.log(`[sync] ${new Date().toISOString()} Done`);
}

main();
