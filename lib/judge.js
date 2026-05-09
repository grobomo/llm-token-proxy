'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const { fetch } = require('undici');

let db;

const TIER_MODELS = {
  L1: 'claude-haiku-4-5',
  L2: 'claude-sonnet-4-6',
  L3: 'claude-opus-4-7',
};

function init(dbPath) {
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS judge_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      gate TEXT NOT NULL,
      project TEXT,
      session_id TEXT,
      question TEXT NOT NULL,
      context TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      confidence REAL,
      latency_ms INTEGER,
      fallback_used INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'L1',
      escalated_from TEXT,
      escalation_reason TEXT
    )
  `);
  try { db.exec('ALTER TABLE judge_log ADD COLUMN tier TEXT DEFAULT \'L1\''); } catch {}
  try { db.exec('ALTER TABLE judge_log ADD COLUMN escalated_from TEXT'); } catch {}
  try { db.exec('ALTER TABLE judge_log ADD COLUMN escalation_reason TEXT'); } catch {}
}

async function callTier(tier, question, context, proxyUrl, apiKey) {
  const model = TIER_MODELS[tier] || TIER_MODELS.L1;
  const body = {
    model,
    max_tokens: tier === 'L1' ? 200 : 500,
    messages: [{ role: 'user', content: [
      { type: 'text', text: `You are a gate judge. Answer the following question with a JSON decision.\n\nQuestion: ${question}\n${context ? `Context: ${context}\n` : ''}\nRespond with EXACTLY this JSON:\n{"allow": true|false, "reason": "one sentence", "confidence": 0.0-1.0}` }
    ]}],
  };

  const start = Date.now();
  const res = await fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'x-consumer': `judge-${tier.toLowerCase()}`,
    },
    body: JSON.stringify(body),
  });

  const latencyMs = Date.now() - start;
  if (!res.ok) {
    return { allow: null, reason: `${tier} error: ${res.status}`, confidence: 0, latencyMs, tier, error: true };
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';

  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return { allow: Boolean(parsed.allow), reason: parsed.reason || '', confidence: parsed.confidence || 0.5, latencyMs, tier };
    }
  } catch {}

  return { allow: null, reason: `Failed to parse ${tier} response`, confidence: 0, latencyMs, tier, raw: text.slice(0, 200) };
}

async function callHaiku(question, context, proxyUrl, apiKey) {
  return callTier('L1', question, context, proxyUrl, apiKey);
}

function logDecision(entry) {
  if (!db) return;
  db.prepare(`
    INSERT INTO judge_log (gate, project, session_id, question, context, decision, reason, confidence, latency_ms, fallback_used, tier, escalated_from, escalation_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.gate, entry.project || null, entry.session_id || null,
    entry.question, entry.context || null,
    entry.decision, entry.reason || null, entry.confidence || null,
    entry.latency_ms || null, entry.fallback_used ? 1 : 0,
    entry.tier || 'L1', entry.escalated_from || null, entry.escalation_reason || null
  );
}

function getStats() {
  if (!db) return {};
  const byGate = db.prepare(`
    SELECT gate, tier, COUNT(*) as total,
           SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) as allowed,
           SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) as blocked,
           SUM(fallback_used) as fallbacks,
           SUM(CASE WHEN escalated_from IS NOT NULL THEN 1 ELSE 0 END) as escalations,
           ROUND(AVG(latency_ms)) as avg_latency_ms
    FROM judge_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-24 hours')
    GROUP BY gate, tier ORDER BY total DESC
  `).all();

  const recent = db.prepare(`
    SELECT timestamp, gate, project, decision, reason, confidence, latency_ms, tier, escalated_from
    FROM judge_log ORDER BY id DESC LIMIT 20
  `).all();

  return { by_gate: byGate, recent };
}

module.exports = { init, callHaiku, callTier, logDecision, getStats, TIER_MODELS };
