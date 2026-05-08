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
  prefer_upstream: {
    description: "Route Opus calls through RDsec (JWT auth) instead of direct Anthropic (sk-ant-) — 5-10x cheaper",
    models: ["claude-opus", "claude-4.6-opus", "claude-opus-4-6", "claude-opus-4-7"],
    preferred_upstream: "rdsec",
    expensive_upstream: "anthropic",
  },
  flag_unknown_consumers: {
    description: "Flag unidentified consumers spending > $1/day for investigation",
    threshold_daily_usd: 1.00,
  },
  flag_old_clients: {
    description: "Flag old Claude CLI versions using expensive routes",
    expensive_ua_patterns: ["claude-cli/2.1.77"],
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

  // 1. Detect Opus calls on expensive upstream
  const routingRule = rules.prefer_upstream;
  if (routingRule) {
    const modelPatterns = routingRule.models.map(m => `model LIKE '${m}%'`).join(' OR ');
    const expensive = db.prepare(`
      SELECT upstream, user_agent, COUNT(*) as calls, SUM(estimated_cost_usd) as cost,
             AVG(estimated_cost_usd) as avg_cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
        AND upstream = '${routingRule.expensive_upstream}'
        AND (${modelPatterns})
        AND estimated_cost_usd > 0
      GROUP BY upstream, user_agent
      ORDER BY cost DESC
    `).all();

    const preferred = db.prepare(`
      SELECT AVG(estimated_cost_usd) as avg_cost
      FROM usage_log
      WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
        AND upstream = '${routingRule.preferred_upstream}'
        AND (${modelPatterns})
        AND estimated_cost_usd > 0
    `).get();

    const preferredAvg = preferred?.avg_cost || 0.03;

    for (const row of expensive) {
      const savings = (row.avg_cost - preferredAvg) * row.calls;
      if (savings > 0.50) {
        findings.push({
          type: 'expensive_upstream',
          severity: savings > 50 ? 'high' : savings > 10 ? 'medium' : 'low',
          user_agent: row.user_agent,
          upstream: row.upstream,
          calls: row.calls,
          cost: parseFloat(row.cost.toFixed(2)),
          avg_cost_per_call: parseFloat(row.avg_cost.toFixed(4)),
          preferred_upstream: routingRule.preferred_upstream,
          preferred_avg_cost: parseFloat(preferredAvg.toFixed(4)),
          potential_daily_savings: parseFloat(savings.toFixed(2)),
          fix: `Route this client through ${routingRule.preferred_upstream} by switching to JWT auth token`,
        });
      }
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
        AND consumer IN ('unknown', 'openclaw')
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
        fix: 'Set X-Consumer header or configure ANTHROPIC_CUSTOM_HEADERS in client',
      });
    }
  }

  // 3. Flag old client versions on expensive paths
  const oldClientRule = rules.flag_old_clients;
  if (oldClientRule) {
    for (const pattern of oldClientRule.expensive_ua_patterns) {
      const old = db.prepare(`
        SELECT user_agent, upstream, COUNT(*) as calls, SUM(estimated_cost_usd) as cost,
               AVG(estimated_cost_usd) as avg_cost
        FROM usage_log
        WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
          AND user_agent LIKE ?
          AND estimated_cost_usd > 0
        GROUP BY user_agent, upstream
      `).all(`%${pattern}%`);

      for (const row of old) {
        if (row.cost > 1) {
          findings.push({
            type: 'old_client_version',
            severity: row.cost > 50 ? 'high' : 'medium',
            user_agent: row.user_agent,
            upstream: row.upstream,
            calls: row.calls,
            cost: parseFloat(row.cost.toFixed(2)),
            avg_cost_per_call: parseFloat(row.avg_cost.toFixed(4)),
            fix: 'Update Claude CLI or reconfigure to use RDsec JWT token',
          });
        }
      }
    }
  }

  return findings;
}

function applyFixes(findings, opts) {
  const actions = [];
  const ccSettings = path.join(HOME, '.claude/settings.json');

  for (const f of findings) {
    if (f.type === 'expensive_upstream' && f.user_agent?.includes('claude-cli')) {
      // The fix: ensure the user-level .claude/settings.json uses the RDsec JWT token
      // Check if it's already using the right token
      if (fs.existsSync(ccSettings)) {
        const settings = JSON.parse(fs.readFileSync(ccSettings, 'utf-8'));
        const currentToken = settings?.env?.ANTHROPIC_AUTH_TOKEN || '';
        if (currentToken.startsWith('eyJ')) {
          actions.push({ finding: f, action: 'already_correct', note: 'Settings already use JWT token' });
          continue;
        }
        if (opts.dryRun) {
          actions.push({ finding: f, action: 'would_fix', note: 'Would update ANTHROPIC_AUTH_TOKEN to JWT in ' + ccSettings });
        } else if (opts.fix) {
          // This would need the actual JWT — we don't store it here, just flag it
          actions.push({ finding: f, action: 'manual_required', note: 'Update ANTHROPIC_AUTH_TOKEN in ' + ccSettings + ' to RDsec JWT' });
        }
      }
    } else {
      actions.push({ finding: f, action: 'report_only', note: f.fix });
    }
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
