'use strict';

const { DatabaseSync } = require('node:sqlite');
const { fetch } = require('undici');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let db;
const ESCALATIONS_DIR = path.resolve(__dirname, '..', 'data', 'escalations');
const TIER_TIMEOUT = { L2: 10_000, L3: 15_000 };

function init(dbPath) {
  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS escalation_state (
      ticket_id TEXT PRIMARY KEY,
      caller TEXT,
      gate TEXT,
      tier_chain TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'pending',
      request TEXT,
      responses TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      resolved_at TEXT,
      webhook_url TEXT
    )
  `);
}

function generateTicketId() {
  return 'esc-' + crypto.randomBytes(6).toString('hex');
}

function createEscalation({ caller, gate, tierChain, request, webhookUrl }) {
  const ticketId = generateTicketId();
  db.prepare(`
    INSERT INTO escalation_state (ticket_id, caller, gate, tier_chain, status, request, webhook_url)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(ticketId, caller || null, gate || null, JSON.stringify(tierChain || ['L1']), JSON.stringify(request), webhookUrl || null);
  return ticketId;
}

function resolveEscalation(ticketId, response) {
  const row = db.prepare('SELECT * FROM escalation_state WHERE ticket_id = ?').get(ticketId);
  if (!row) return null;

  const responses = JSON.parse(row.responses || '[]');
  responses.push(response);

  db.prepare(`
    UPDATE escalation_state SET status = 'resolved', responses = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE ticket_id = ?
  `).run(JSON.stringify(responses), ticketId);

  if (row.webhook_url) {
    fetch(row.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket_id: ticketId, status: 'resolved', response }),
    }).catch(() => {});
  }

  return { ticketId, status: 'resolved', response };
}

function timeoutEscalation(ticketId, bestAvailable) {
  const row = db.prepare('SELECT * FROM escalation_state WHERE ticket_id = ?').get(ticketId);
  if (!row || row.status !== 'pending') return null;

  const responses = JSON.parse(row.responses || '[]');
  responses.push({ ...bestAvailable, partial: true, timed_out: true });

  db.prepare(`
    UPDATE escalation_state SET status = 'timeout', responses = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE ticket_id = ?
  `).run(JSON.stringify(responses), ticketId);

  return { ticketId, status: 'timeout', response: { ...bestAvailable, partial: true } };
}

function addTierResponse(ticketId, tierResponse) {
  const row = db.prepare('SELECT responses FROM escalation_state WHERE ticket_id = ?').get(ticketId);
  if (!row) return;
  const responses = JSON.parse(row.responses || '[]');
  responses.push(tierResponse);
  db.prepare('UPDATE escalation_state SET responses = ? WHERE ticket_id = ?').run(JSON.stringify(responses), ticketId);
}

function getEscalation(ticketId) {
  const row = db.prepare('SELECT * FROM escalation_state WHERE ticket_id = ?').get(ticketId);
  if (!row) return null;
  return {
    ticket_id: row.ticket_id,
    caller: row.caller,
    gate: row.gate,
    tier_chain: JSON.parse(row.tier_chain),
    status: row.status,
    responses: JSON.parse(row.responses),
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  };
}

function writeNotes(ticketId, tier, notes) {
  const filename = `${ticketId}-${tier}.md`;
  const filepath = path.join(ESCALATIONS_DIR, filename);
  fs.mkdirSync(ESCALATIONS_DIR, { recursive: true });
  fs.writeFileSync(filepath, notes, 'utf8');
}

async function runBackground(ticketId, tier, { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey, askModule) {
  const timeout = TIER_TIMEOUT[tier] || 10_000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    const result = await askModule.callTier(tier, { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey);

    clearTimeout(timer);
    addTierResponse(ticketId, { tier, ...result });

    const notes = `# Escalation ${ticketId} — ${tier}\n\n**Timestamp:** ${new Date().toISOString()}\n**Caller:** ${caller}\n**Prompt:** ${prompt.slice(0, 500)}\n\n## Response\n\n${result.content?.slice(0, 2000) || '(empty)'}\n\n## Metadata\n\n- Confidence: ${result.confidence ?? 'N/A'}\n- Latency: ${result.ms}ms\n- Tokens: ${result.tokens?.in || 0} in / ${result.tokens?.out || 0} out\n`;
    writeNotes(ticketId, tier, notes);

    resolveEscalation(ticketId, result);
    askModule.logCall({
      caller, system, prompt, tier,
      response: result.content?.slice(0, 500),
      confidence: result.confidence,
      ms: result.ms,
      tokens_in: result.tokens?.in || 0,
      tokens_out: result.tokens?.out || 0,
      escalated_from: tier === 'L2' ? 'L1' : 'L2',
      escalation_reason: `auto-escalation from ${tier === 'L2' ? 'L1' : 'L2'}`,
    });

    return result;
  } catch (err) {
    clearTimeout(timer);
    const row = db.prepare('SELECT responses FROM escalation_state WHERE ticket_id = ?').get(ticketId);
    const responses = row ? JSON.parse(row.responses || '[]') : [];
    const bestAvailable = responses[responses.length - 1] || { content: `${tier} timed out or failed: ${err.message}`, tier, ok: false };
    timeoutEscalation(ticketId, bestAvailable);
    return { ...bestAvailable, partial: true };
  }
}

module.exports = { init, createEscalation, resolveEscalation, timeoutEscalation, getEscalation, runBackground, addTierResponse, writeNotes, generateTicketId };
