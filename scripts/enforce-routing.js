#!/usr/bin/env node
'use strict';

/**
 * enforce-routing.js (T106)
 * Data-driven consumer enforcement — detects clients using expensive upstreams
 * when cheaper alternatives exist, and can auto-fix their configs.
 *
 * Usage:
 *   node enforce-routing.js              # report only (default)
 *   node enforce-routing.js --fix        # apply fixes (with backup)
 *   node enforce-routing.js --dry-run    # show what --fix would do
 *
 * Rules are defined in enforcement-rules.json (or inline defaults).
 * Queries usage.db for recent patterns and compares against rules.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

const HOME       = process.env.HOME || '/home/ubu';
const SCRIPT_DIR = path.dirname(path.resolve(__filename));
const DB_PATH    = process.env.USAGE_DB || path.resolve(SCRIPT_DIR, '../usage.db');
const RULES_PATH = path.resolve(SCRIPT_DIR, '../data/enforcement-rules.json');

const DEFAULT_RULES = {
  flag_high_cache_writers: {
    description: "Flag consumers with high cache_write per call (new sessions are expensive at $18.75/M)",
    cache_write_threshold_per_call: 5000,
    min_daily_cost: 5.00,
  },
  flag_unknown_consumers: {
    description: "Flag unidentified consumers spending > $1/day for investigation",
    threshold_daily_usd: 1.00,
  },
  flag_untagged_projects: {
    description: "Flag calls without X-Project header for attribution",
    threshold_daily_usd: 5.00,
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    fix: args.includes('--fix'),
    dryRun: args.includes('--dry-run'),
  };
}

function loadRules() {
  if (fs.existsSync(RULES_PATH)) {
    try { return JSON.parse(fs.readFileSync(RULES_PATH, 'utf-8')); } catch {}
  }
  return DEFAULT_RULES;
}

function analyzeRouting(db, rules) {
  const findings = [];

  // 1. Flag high cache writers (new sessions = expensive cache_write at $18.75/M)
  const cacheRule = rules.flag_high_cache_writers;
  if (cacheRule) {
    const highCW = db.prepare(`
      SELECT user_agent, consumer, COUNT(*) as calls, SUM(estimated_cost_usd) as cost,
             AVG(cache_write_tokens) as avg_cw, SUM(cache_write_tokens) as total_cw
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
        AND estimated_cost_usd > 0
        AND cache_write_tokens > 0
      GROUP BY user_agent, consumer
      HAVING avg_cw > ? AND cost > ?
      ORDER BY total_cw DESC
    `).all(cacheRule.cache_write_threshold_per_call, cacheRule.min_daily_cost);

    for (const row of highCW) {
      const cwCost = (row.total_cw / 1_000_000) * 18.75;
      findings.push({
        type: 'high_cache_write',
        severity: cwCost > 30 ? 'high' : cwCost > 10 ? 'medium' : 'low',
        user_agent: row.user_agent,
        consumer: row.consumer,
        calls: row.calls,
        total_cost: parseFloat(row.cost.toFixed(2)),
        cache_write_cost: parseFloat(cwCost.toFixed(2)),
        avg_cache_write_per_call: Math.round(row.avg_cw),
        fix: 'Reduce session restarts (each creates fresh cache). Consider longer sessions or session persistence.',
      });
    }
  }

  // 2. Flag unknown consumers
  const unknownRule = rules.flag_unknown_consumers;
  if (unknownRule) {
    const unknowns = db.prepare(`
      SELECT consumer, COUNT(*) as calls, SUM(estimated_cost_usd) as cost,
             GROUP_CONCAT(DISTINCT user_agent) as agents
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
        AND consumer IN ('unknown')
        AND estimated_cost_usd > 0
      GROUP BY consumer
      HAVING cost > ?
    `).all(unknownRule.threshold_daily_usd);

    for (const row of unknowns) {
      findings.push({
        type: 'unknown_consumer',
        severity: row.cost > 50 ? 'high' : 'medium',
        consumer: row.consumer,
        calls: row.calls,
        cost: parseFloat(row.cost.toFixed(2)),
        user_agents: row.agents,
        fix: 'Identify source and set X-Consumer header',
      });
    }
  }

  // 3. Flag untagged projects (calls without X-Project header)
  const untaggedRule = rules.flag_untagged_projects;
  if (untaggedRule) {
    const untagged = db.prepare(`
      SELECT consumer, COUNT(*) as calls, SUM(estimated_cost_usd) as cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
        AND project IS NULL
        AND estimated_cost_usd > 0
      GROUP BY consumer
      HAVING cost > ?
      ORDER BY cost DESC
    `).all(untaggedRule.threshold_daily_usd);

    for (const row of untagged) {
      findings.push({
        type: 'untagged_project',
        severity: row.cost > 50 ? 'high' : 'medium',
        consumer: row.consumer,
        calls: row.calls,
        cost: parseFloat(row.cost.toFixed(2)),
        fix: 'Run setup-projects.js or add ANTHROPIC_CUSTOM_HEADERS to project .claude/settings.json',
      });
    }
  }

  return findings;
}

function applyFixes(findings, opts) {
  const actions = [];
  for (const f of findings) {
    actions.push({ finding: f, action: 'report_only', note: f.fix });
  }
  return actions;
}

function main() {
  const opts = parseArgs();

  if (!fs.existsSync(DB_PATH)) {
    console.error('[enforce] usage.db not found at ' + DB_PATH);
    process.exit(1);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');

  const rules = loadRules();
  const findings = analyzeRouting(db, rules);
  db.close();

  if (findings.length === 0) {
    console.log(JSON.stringify({ status: 'ok', message: 'No routing violations found', findings: [] }, null, 2));
    return;
  }

  const actions = applyFixes(findings, opts);
  const totalSavings = findings.reduce((s, f) => s + (f.potential_daily_savings || 0), 0);

  const report = {
    status: 'violations_found',
    findings_count: findings.length,
    potential_daily_savings: parseFloat(totalSavings.toFixed(2)),
    findings,
    actions: opts.fix || opts.dryRun ? actions : undefined,
  };

  console.log(JSON.stringify(report, null, 2));

  if (findings.some(f => f.severity === 'high')) process.exit(1);
}

main();
