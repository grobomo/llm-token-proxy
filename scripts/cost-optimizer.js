#!/usr/bin/env node
// TOKEN_COST_REVIEWED: $0.00/day (no LLM calls, pure JS) — 2026-05-07
'use strict';

/**
 * cost-optimizer.js (T027)
 * Rules-based proposal generator — reads cost-insights.json, writes cost-proposals.json.
 * Runs every 4 hours via cron. Zero LLM calls.
 */

const path = require('path');
const fs   = require('fs');

const SCRIPT_DIR  = path.dirname(path.resolve(__filename || __filename));
const DATA_DIR    = path.resolve(SCRIPT_DIR, '../data');
const INSIGHTS    = path.join(DATA_DIR, 'cost-insights.json');
const PROPOSALS   = path.join(DATA_DIR, 'cost-proposals.json');

// How old can insights be before we skip (don't act on stale data)
const MAX_INSIGHTS_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// Estimated monthly savings models (rough heuristics)
const OPUS_TO_HAIKU_FACTOR = 18;   // Opus is ~18x more expensive than Haiku per token
const OPUS_TO_SONNET_FACTOR = 5;   // Opus is ~5x more expensive than Sonnet per token

// ─── helpers ────────────────────────────────────────────────────────────────

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function generateId() {
  return `prop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Check if a proposal for the same target+type already exists (to avoid duplicates).
 */
function alreadyProposed(existingProposals, type, target) {
  if (!existingProposals?.proposals) return false;
  return existingProposals.proposals.some(
    p => p.type === type && p.target === target && !p.dismissed
  );
}

// ─── proposal generators ─────────────────────────────────────────────────────

function proposeModelDowngrade(pattern, existingProposals) {
  if (alreadyProposed(existingProposals, 'model_downgrade', pattern.consumer)) return null;

  const hourlyCost = pattern.potential_savings_usd || 0;
  const monthlySavings = parseFloat((hourlyCost * 24 * 30).toFixed(2));

  return {
    id:                           generateId(),
    type:                         'model_downgrade',
    target:                       pattern.consumer,
    current_model:                pattern.model || 'opus',
    proposed_model:               'claude-4.5-haiku',
    reason:                       pattern.detail,
    estimated_savings_usd_monthly: monthlySavings,
    tier:                         'SAFE',
    auto_applied:                 true,
    applied_at:                   null,
    created_at:                   new Date().toISOString(),
    dismissed:                    false,
  };
}

function proposeRunawayInvestigation(pattern, existingProposals) {
  if (alreadyProposed(existingProposals, 'investigate_spend', pattern.consumer)) return null;

  return {
    id:                           generateId(),
    type:                         'investigate_spend',
    target:                       pattern.consumer,
    cost_usd_in_period:           pattern.cost_usd,
    reason:                       pattern.detail,
    estimated_savings_usd_monthly: null,
    tier:                         'ALERT',
    auto_applied:                 false,
    applied_at:                   null,
    created_at:                   new Date().toISOString(),
    dismissed:                    false,
  };
}

function proposeContextTrim(pattern, existingProposals) {
  if (alreadyProposed(existingProposals, 'context_trim', pattern.consumer)) return null;

  // Rough savings: reducing input tokens by 50% = 50% reduction in input cost
  const hourlyCost = pattern.cost_usd || 0;
  const monthlySavings = parseFloat(((hourlyCost * 24 * 30) * 0.4).toFixed(2)); // ~40% savings

  return {
    id:                           generateId(),
    type:                         'context_trim',
    target:                       pattern.consumer,
    avg_input_output_ratio:       pattern.avg_ratio,
    bloated_requests:             pattern.bloated_requests,
    reason:                       pattern.detail,
    suggestion:                   'Trim system prompts, reduce file loading, consider lazy context injection',
    estimated_savings_usd_monthly: monthlySavings,
    tier:                         'SUGGEST',
    auto_applied:                 false,
    applied_at:                   null,
    created_at:                   new Date().toISOString(),
    dismissed:                    false,
  };
}

function proposeReducedInterval(pattern, existingProposals) {
  if (alreadyProposed(existingProposals, 'reduce_frequency', pattern.consumer)) return null;

  return {
    id:                           generateId(),
    type:                         'reduce_frequency',
    target:                       pattern.consumer,
    requests_in_period:           pattern.requests,
    reason:                       pattern.detail,
    suggestion:                   'Reduce polling/cron interval — high request volume detected',
    estimated_savings_usd_monthly: null,
    tier:                         'SAFE',
    auto_applied:                 true,
    applied_at:                   null,
    created_at:                   new Date().toISOString(),
    dismissed:                    false,
  };
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  // Read insights
  const insights = readJson(INSIGHTS);
  if (!insights) {
    console.log(`[cost-optimizer] No insights file found at ${INSIGHTS} — nothing to do`);
    process.exit(0);
  }

  // Check freshness
  const insightsAge = Date.now() - new Date(insights.timestamp).getTime();
  if (insightsAge > MAX_INSIGHTS_AGE_MS) {
    console.log(
      `[cost-optimizer] Insights are ${Math.round(insightsAge / 60000)}m old (threshold: ${MAX_INSIGHTS_AGE_MS / 60000}m) — skipping`
    );
    process.exit(0);
  }

  // Read existing proposals (to avoid duplicates)
  const existingProposals = readJson(PROPOSALS);

  const newProposals = [];
  const alerts = [];

  for (const pattern of (insights.patterns || [])) {
    let proposal = null;

    switch (pattern.type) {
      case 'model_overuse':
        proposal = proposeModelDowngrade(pattern, existingProposals);
        break;
      case 'runaway_spend':
        proposal = proposeRunawayInvestigation(pattern, existingProposals);
        break;
      case 'context_bloat':
        proposal = proposeContextTrim(pattern, existingProposals);
        break;
      case 'high_frequency':
        proposal = proposeReducedInterval(pattern, existingProposals);
        break;
      default:
        // Unknown pattern type — ignore
        break;
    }

    if (proposal) {
      newProposals.push(proposal);
      if (proposal.tier === 'ALERT') {
        alerts.push(proposal);
      }
    }
  }

  // Merge with existing proposals (keep old ones, append new)
  const allProposals = [
    ...(existingProposals?.proposals || []),
    ...newProposals,
  ];

  const output = {
    timestamp:          new Date().toISOString(),
    insights_timestamp: insights.timestamp,
    proposals:          allProposals,
    summary: {
      total:       allProposals.length,
      new:         newProposals.length,
      alerts:      allProposals.filter(p => p.tier === 'ALERT' && !p.dismissed).length,
      auto_applied: allProposals.filter(p => p.auto_applied && p.applied_at).length,
      pending:      allProposals.filter(p => !p.auto_applied && !p.dismissed && !p.applied_at).length,
    },
  };

  fs.writeFileSync(PROPOSALS, JSON.stringify(output, null, 2));

  // For ALERT tier — write to stdout so cron output can capture it
  for (const alert of alerts) {
    const msg = [
      `⚠️  COST ALERT: ${alert.type.toUpperCase()}`,
      `   Target: ${alert.target}`,
      `   ${alert.reason}`,
      `   Action: Investigate immediately`,
    ].join('\n');
    console.error(msg);
    console.log(msg); // also stdout for cron capture
  }

  console.log(
    `[cost-optimizer] Done — ${newProposals.length} new proposal(s), ` +
    `${alerts.length} alert(s), ` +
    `${output.summary.total} total in proposals file`
  );

  process.exit(0);
}

main();
