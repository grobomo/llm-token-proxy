#!/usr/bin/env node
// TOKEN_COST_REVIEWED: $0.00/day (no LLM calls, pure JS) — 2026-05-07
'use strict';

/**
 * daily-digest.js (T028)
 * Queries SQLite for yesterday's usage, formats a Slack digest, posts to #coco-chat.
 * Runs daily at 9 AM via cron. Zero LLM calls.
 */

const { DatabaseSync } = require('node:sqlite');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const SCRIPT_DIR    = path.dirname(path.resolve(__filename || __filename));
const DB_PATH       = path.resolve(SCRIPT_DIR, '../usage.db');
const DATA_DIR      = path.resolve(SCRIPT_DIR, '../data');
const PROPOSALS     = path.join(DATA_DIR, 'cost-proposals.json');
const SLACK_CHANNEL = 'C0ATJE19YRY'; // #coco-chat
const MONTHLY_BUDGET = 100.00;       // USD

// ─── helpers ────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function openDb() {
  if (!fs.existsSync(DB_PATH)) return null;
  const db = new DatabaseSync(DB_PATH, { open: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');
  return db;
}

function fmt(usd) {
  return `$${(usd || 0).toFixed(4)}`;
}

function pct(numerator, denominator) {
  if (!denominator) return '0%';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

// ─── queries ────────────────────────────────────────────────────────────────

/**
 * Yesterday's total: midnight-to-midnight UTC.
 */
function queryYesterday(db) {
  const row = db.prepare(`
    SELECT
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)                AS total_requests
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 days')
      AND timestamp <  strftime('%Y-%m-%dT00:00:00Z', 'now')
  `).get();
  return row || { total_cost_usd: 0, total_requests: 0 };
}

/**
 * Two days ago total (for trend % comparison).
 */
function queryDayBefore(db) {
  const row = db.prepare(`
    SELECT SUM(estimated_cost_usd) AS total_cost_usd
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-2 days')
      AND timestamp <  strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 days')
  `).get();
  return row || { total_cost_usd: 0 };
}

/**
 * Month-to-date spend (1st of current month to now).
 */
function queryMTD(db) {
  const row = db.prepare(`
    SELECT
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)                AS total_requests
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-01T00:00:00Z', 'now')
  `).get();
  return row || { total_cost_usd: 0, total_requests: 0 };
}

/**
 * 7-day daily totals (oldest first).
 */
function query7DayTrend(db) {
  return db.prepare(`
    SELECT
      strftime('%Y-%m-%d', timestamp) AS day,
      SUM(estimated_cost_usd)         AS cost_usd
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-7 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();
}

/**
 * Top 5 consumers by cost yesterday.
 */
function queryTopConsumers(db) {
  return db.prepare(`
    SELECT
      consumer,
      SUM(estimated_cost_usd) AS cost_usd,
      COUNT(*)                AS requests
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 days')
      AND timestamp <  strftime('%Y-%m-%dT00:00:00Z', 'now')
    GROUP BY consumer
    ORDER BY cost_usd DESC
    LIMIT 5
  `).all();
}

// ─── format message ──────────────────────────────────────────────────────────

function trendArrow(values) {
  if (values.length < 2) return '';
  const last  = values[values.length - 1];
  const prev  = values[values.length - 2];
  if (last > prev * 1.05)  return '📈';
  if (last < prev * 0.95)  return '📉';
  return '➡️';
}

function buildMessage(yesterday, dayBefore, mtd, trend7, topConsumers, proposals) {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'America/Chicago' });

  const yesterdayCost = yesterday.total_cost_usd || 0;
  const dayBeforeCost = dayBefore.total_cost_usd  || 0;
  const mtdCost       = mtd.total_cost_usd        || 0;

  // Day-over-day change
  let dodStr = '';
  if (dayBeforeCost > 0) {
    const change = ((yesterdayCost - dayBeforeCost) / dayBeforeCost) * 100;
    const arrow  = change > 5 ? '↑' : change < -5 ? '↓' : '→';
    dodStr = ` (${arrow}${Math.abs(change).toFixed(0)}% from prev day)`;
  }

  // MTD projection
  const dayOfMonth   = now.getUTCDate();
  const daysInMonth  = new Date(now.getUTCFullYear(), now.getUTCMonth() + 1, 0).getDate();
  const projected    = dayOfMonth > 0 ? (mtdCost / dayOfMonth) * daysInMonth : 0;
  const projStatus   = projected <= MONTHLY_BUDGET ? '✅' : '⚠️';

  // Budget pct
  const budgetPct    = pct(mtdCost, MONTHLY_BUDGET);

  // Top consumers section
  const totalYesterday = topConsumers.reduce((sum, c) => sum + (c.cost_usd || 0), 0) || yesterdayCost || 1;
  const consumersLines = topConsumers.length > 0
    ? topConsumers.map((c, i) => {
        const share = pct(c.cost_usd, totalYesterday);
        return `${i + 1}. \`${c.consumer}\` — ${fmt(c.cost_usd)} (${share})`;
      }).join('\n')
    : '_No data for yesterday_';

  // 7-day trend
  const trendValues = trend7.map(r => r.cost_usd || 0);
  const arrow       = trendArrow(trendValues);
  const trendLine   = trendValues.length > 0
    ? trendValues.map(v => fmt(v)).join(' → ') + ` ${arrow}`
    : '_No trend data_';

  // Proposals
  const allProposals   = proposals?.proposals || [];
  const appliedList    = allProposals.filter(p => p.auto_applied && p.applied_at);
  const pendingList    = allProposals.filter(p => !p.auto_applied && !p.dismissed && !p.applied_at);
  const alertList      = allProposals.filter(p => p.tier === 'ALERT' && !p.dismissed);

  const appliedSection = appliedList.length > 0
    ? appliedList.map(p => {
        if (p.type === 'model_downgrade') {
          const saving = p.estimated_savings_usd_monthly
            ? ` (est. saving: ${fmt(p.estimated_savings_usd_monthly / 30)}/day)`
            : '';
          return `• ↓ \`${p.target}\`: ${p.current_model} → ${p.proposed_model}${saving}`;
        }
        if (p.type === 'reduce_frequency') {
          return `• ↓ \`${p.target}\`: reduced polling frequency`;
        }
        return `• \`${p.target}\`: ${p.type}`;
      }).join('\n')
    : '_None_';

  const pendingSection = pendingList.length > 0
    ? pendingList.map(p => {
        if (p.type === 'context_trim') {
          return `• 💡 \`${p.target}\` context bloat (${p.avg_input_output_ratio}x ratio) — ${p.suggestion}`;
        }
        return `• 💡 \`${p.target}\`: ${p.type} — ${p.reason || ''}`;
      }).join('\n')
    : '_None_';

  const alertSection = alertList.length > 0
    ? alertList.map(p => `• 🚨 \`${p.target}\`: ${p.reason}`).join('\n')
    : '';

  const lines = [
    `🌴 *Daily Token Spend Report — ${dateStr}*`,
    ``,
    `*Yesterday's total:* ${fmt(yesterdayCost)}${dodStr} (${yesterday.total_requests || 0} requests)`,
    `*MTD:* ${fmt(mtdCost)} / ${fmt(MONTHLY_BUDGET)} budget (${budgetPct})`,
    `*Projected month-end:* ${fmt(projected)} ${projStatus}`,
    ``,
  ];

  if (alertSection) {
    lines.push(`*⚠️ Alerts:*`);
    lines.push(alertSection);
    lines.push(``);
  }

  lines.push(
    `*Top consumers (yesterday):*`,
    consumersLines,
    ``,
    `*Optimizations applied:*`,
    appliedSection,
    ``,
    `*Pending review:*`,
    pendingSection,
    ``,
    `*7-day trend:* ${trendLine}`,
    ``,
    `🌴`,
  );

  return lines.join('\n');
}

// ─── Slack post ──────────────────────────────────────────────────────────────

function postToSlack(text, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ channel: SLACK_CHANNEL, text, mrkdwn: true });
    const options = {
      hostname: 'slack.com',
      path:     '/api/chat.postMessage',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok) {
            resolve(parsed);
          } else {
            reject(new Error(`Slack API error: ${parsed.error}`));
          }
        } catch {
          reject(new Error(`Failed to parse Slack response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const db = openDb();

  let yesterday    = { total_cost_usd: 0, total_requests: 0 };
  let dayBefore    = { total_cost_usd: 0 };
  let mtd          = { total_cost_usd: 0, total_requests: 0 };
  let trend7       = [];
  let topConsumers = [];

  if (!db) {
    console.log(`[daily-digest] No database found at ${DB_PATH} — formatting empty digest`);
  } else {
    try {
      yesterday    = queryYesterday(db);
      dayBefore    = queryDayBefore(db);
      mtd          = queryMTD(db);
      trend7       = query7DayTrend(db);
      topConsumers = queryTopConsumers(db);
    } finally {
      db.close();
    }
  }

  const proposals = readJson(PROPOSALS);
  const message   = buildMessage(yesterday, dayBefore, mtd, trend7, topConsumers, proposals);

  const token = process.env.SLACK_BOT_TOKEN;

  if (!token) {
    console.log(`[daily-digest] SLACK_BOT_TOKEN not set — printing to stdout instead\n`);
    console.log(message);
    process.exit(0);
  }

  try {
    await postToSlack(message, token);
    console.log(`[daily-digest] Posted daily digest to #coco-chat (${SLACK_CHANNEL})`);
  } catch (err) {
    console.error(`[daily-digest] Failed to post to Slack: ${err.message}`);
    console.log(`\n--- Digest (stdout fallback) ---\n`);
    console.log(message);
    process.exit(1);
  }

  process.exit(0);
}

main().catch(err => {
  console.error(`[daily-digest] Fatal: ${err.message}`);
  process.exit(1);
});
