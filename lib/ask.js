'use strict';

const { DatabaseSync } = require('node:sqlite');
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
    CREATE TABLE IF NOT EXISTS ask_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      caller TEXT,
      system_prompt TEXT,
      prompt TEXT NOT NULL,
      tier TEXT NOT NULL,
      model TEXT NOT NULL,
      response TEXT,
      confidence REAL,
      latency_ms INTEGER,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      escalated_from TEXT,
      escalation_reason TEXT
    )
  `);
}

async function callTier(tier, { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey) {
  const model = TIER_MODELS[tier];
  if (!model) return { ok: false, content: `Unknown tier: ${tier}`, tier };

  const messages = [{ role: 'user', content: prompt }];
  const body = {
    model,
    max_tokens: maxTokens || 1024,
    messages,
  };
  if (system) body.system = system;

  const start = Date.now();
  let res;
  try {
    res = await fetch(`${proxyUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'x-consumer': `ask-${tier.toLowerCase()}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, content: `Fetch error: ${err.message}`, ms: Date.now() - start, tier, tokens: { in: 0, out: 0 } };
  }

  const ms = Date.now() - start;
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { ok: false, content: `HTTP ${res.status}: ${errText.slice(0, 200)}`, ms, tier, tokens: { in: 0, out: 0 } };
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const tokensIn = data.usage?.input_tokens || 0;
  const tokensOut = data.usage?.output_tokens || 0;

  let parsed = null;
  let confidence = null;
  if (jsonMode) {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
        if (typeof parsed.confidence === 'number') confidence = parsed.confidence;
      }
    } catch {}
  }

  return { ok: true, content: text, parsed, ms, tokens: { in: tokensIn, out: tokensOut }, tier, confidence };
}

function logCall(entry) {
  if (!db) return;
  db.prepare(`
    INSERT INTO ask_log (caller, system_prompt, prompt, tier, model, response, confidence, latency_ms, tokens_in, tokens_out, escalated_from, escalation_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    entry.caller || null, entry.system || null, entry.prompt,
    entry.tier, TIER_MODELS[entry.tier] || entry.model || 'unknown',
    entry.response || null, entry.confidence ?? null,
    entry.ms || null, entry.tokens_in || 0, entry.tokens_out || 0,
    entry.escalated_from || null, entry.escalation_reason || null
  );
}

function getStats() {
  if (!db) return {};
  const byTier = db.prepare(`
    SELECT tier, caller, COUNT(*) as total,
           ROUND(AVG(latency_ms)) as avg_latency_ms,
           SUM(tokens_in) as total_tokens_in,
           SUM(tokens_out) as total_tokens_out,
           SUM(CASE WHEN escalated_from IS NOT NULL THEN 1 ELSE 0 END) as escalations
    FROM ask_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-24 hours')
    GROUP BY tier, caller ORDER BY total DESC
  `).all();

  const recent = db.prepare(`
    SELECT timestamp, caller, tier, prompt, confidence, latency_ms, escalated_from
    FROM ask_log ORDER BY id DESC LIMIT 20
  `).all();

  return { by_tier: byTier, recent };
}

module.exports = { init, callTier, logCall, getStats, TIER_MODELS };
