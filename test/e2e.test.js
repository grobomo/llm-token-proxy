'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PROXY_PORT = 14100;
const MOCK_PORT = 14200;
const BASE = `http://127.0.0.1:${PROXY_PORT}`;
const API_KEY = ['sk', 'test', 'e2e', 'key'].join('-');

let proxyProcess;
let mockUpstream;

async function req(method, urlPath, body, headers = {}) {
  const opts = {
    method,
    headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json', ...headers },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${urlPath}`, opts);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

async function waitForReady(url, maxMs = 10000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Server not ready at ${url} after ${maxMs}ms`);
}

describe('E2E: Token Proxy', { timeout: 30000 }, () => {
  before(async () => {
    const { createMockUpstream } = require('./mock-upstream');
    mockUpstream = createMockUpstream(MOCK_PORT);
    await mockUpstream.start();

    const configPath = path.resolve(__dirname, 'config.test.yaml');
    const proxyPath = path.resolve(__dirname, '..', 'proxy.js');

    proxyProcess = spawn(process.execPath, [proxyPath], {
      env: { ...process.env, PROXY_CONFIG: configPath },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proxyProcess.stderr.on('data', d => {
      const msg = d.toString();
      if (!msg.includes('[ERROR]')) return;
      process.stderr.write(`[proxy-err] ${msg}`);
    });

    await waitForReady(`${BASE}/health`);
  });

  after(async () => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM');
      await new Promise(resolve => proxyProcess.on('exit', resolve));
    }
    if (mockUpstream) await mockUpstream.stop();
  });

  // =========================================================================
  // Health & diagnostics
  // =========================================================================

  describe('/health', () => {
    it('returns 200 with proxy running', async () => {
      const { status, json } = await req('GET', '/health');
      assert.equal(status, 200);
      assert.equal(json.proxy, 'running');
      assert.equal(json.upstream, 'reachable');
    });
  });

  describe('/diagnose', () => {
    it('returns upstream status', async () => {
      const { status, json } = await req('GET', '/diagnose');
      assert.equal(status, 200);
      assert.equal(json.cause, 'healthy');
      assert.equal(json.upstreams.mock, 'reachable');
    });
  });

  // =========================================================================
  // Proxy pass-through (/v1/messages)
  // =========================================================================

  describe('/v1/messages', () => {
    it('proxies non-streaming request and returns response', async () => {
      const { status, json } = await req('POST', '/v1/messages', {
        model: 'claude-haiku-4-5',
        max_tokens: 100,
        messages: [{ role: 'user', content: 'Hello' }],
      });
      assert.equal(status, 200);
      assert.equal(json.type, 'message');
      assert.ok(json.content[0].text.includes('Mock response'));
      assert.ok(json.usage.input_tokens > 0);
    });

    it('returns 400 for unknown upstream (bad key prefix)', async () => {
      const { status, json } = await req('POST', '/v1/messages', {
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
      }, { 'x-api-key': 'bad-prefix-key' });
      assert.equal(status, 400);
      assert.equal(json.error, 'no_upstream_match');
    });
  });

  // =========================================================================
  // /ask endpoints (T125)
  // =========================================================================

  describe('/ask (L1)', () => {
    it('returns response without escalation for simple prompt', async () => {
      const { status, json } = await req('POST', '/ask', {
        prompt: 'What is 2+2?',
        caller: 'test-e2e',
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.tier, 'L1');
      assert.ok(json.content.length > 0);
      assert.ok(json.ms >= 0);
    });

    it('returns 400 when prompt missing', async () => {
      const { status, json } = await req('POST', '/ask', { caller: 'test' });
      assert.equal(status, 400);
      assert.equal(json.error, 'missing_fields');
    });

    it('returns 401 when API key missing', async () => {
      const res = await fetch(`${BASE}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'test' }),
      });
      assert.equal(res.status, 401);
    });

    it('triggers escalation on low confidence with jsonMode', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.json({
          id: 'msg_esc',
          type: 'message',
          role: 'assistant',
          model: rq.body.model,
          content: [{ type: 'text', text: '{"result": "uncertain", "confidence": 0.3}' }],
          usage: { input_tokens: 50, output_tokens: 30 },
        });
      });

      const { status, json } = await req('POST', '/ask', {
        prompt: 'Ambiguous question',
        caller: 'test-escalation',
        jsonMode: true,
        sync: false,
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.status, 'escalating');
      assert.ok(json.ticket_id.startsWith('esc-'));
      assert.ok(json.poll_url.includes(json.ticket_id));
      assert.ok(json.l1_response);
    });

    it('sync escalation waits for L2 and returns result', async () => {
      mockUpstream.setResponse((rq, rs) => {
        const model = rq.body.model;
        const conf = model.includes('sonnet') ? 0.85 : 0.3;
        rs.json({
          id: 'msg_sync',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: JSON.stringify({ result: 'decided', confidence: conf }) }],
          usage: { input_tokens: 80, output_tokens: 40 },
        });
      });

      const { status, json } = await req('POST', '/ask', {
        prompt: 'Need deeper analysis',
        caller: 'test-sync-esc',
        jsonMode: true,
        sync: true,
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.tier, 'L2');
      assert.equal(json.escalated_from, 'L1');
      assert.ok(json.ticket_id);
    });
  });

  describe('/ask/l2 (internal only)', () => {
    it('responds from localhost', async () => {
      const { status, json } = await req('POST', '/ask/l2', {
        prompt: 'Deep question',
        caller: 'test-l2',
        escalation_reason: 'test',
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.tier, 'L2');
      assert.ok(json.remaining_quota >= 0);
    });

    it('returns 400 without prompt', async () => {
      const { status, json } = await req('POST', '/ask/l2', { caller: 'test' });
      assert.equal(status, 400);
    });
  });

  describe('/ask/l3 (internal only)', () => {
    it('responds from localhost', async () => {
      const { status, json } = await req('POST', '/ask/l3', {
        prompt: 'Critical question',
        caller: 'test-l3',
        escalation_reason: 'test',
      });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.equal(json.tier, 'L3');
    });
  });

  // =========================================================================
  // /judge endpoints (T126)
  // =========================================================================

  describe('/judge (L1)', () => {
    it('returns allow decision with high confidence', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.json({
          id: 'msg_judge',
          type: 'message',
          role: 'assistant',
          model: rq.body.model,
          content: [{ type: 'text', text: '{"allow": true, "reason": "Safe operation", "confidence": 0.95}' }],
          usage: { input_tokens: 60, output_tokens: 20 },
        });
      });

      const { status, json } = await req('POST', '/judge', {
        question: 'Can this file be deleted?',
        gate: 'test-gate',
        project: 'test-project',
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.allow, true);
      assert.equal(json.tier, 'L1');
      assert.ok(json.confidence >= 0.7);
      assert.equal(json.fallback_used, false);
    });

    it('returns 400 without question or gate', async () => {
      const { status, json } = await req('POST', '/judge', { question: 'test' });
      assert.equal(status, 400);
      assert.equal(json.error, 'missing_fields');
    });

    it('uses fallback when LLM errors', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.status(500).json({ error: 'internal' });
      });

      const { status, json } = await req('POST', '/judge', {
        question: 'Should this pass?',
        gate: 'fallback-gate',
        fallback: true,
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.allow, true);
      assert.equal(json.fallback_used, true);
    });

    it('triggers escalation on low confidence', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.json({
          id: 'msg_low',
          type: 'message',
          role: 'assistant',
          model: rq.body.model,
          content: [{ type: 'text', text: '{"allow": false, "reason": "Unsure", "confidence": 0.4}' }],
          usage: { input_tokens: 60, output_tokens: 20 },
        });
      });

      const { status, json } = await req('POST', '/judge', {
        question: 'Ambiguous gate decision',
        gate: 'esc-gate',
        sync: false,
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.tier, 'L1');
      assert.ok(json.escalation);
      assert.equal(json.escalation.status, 'escalating');
      assert.ok(json.escalation.ticket_id.startsWith('esc-'));
    });

    it('sync escalation returns L2 decision', async () => {
      mockUpstream.setResponse((rq, rs) => {
        const model = rq.body.model;
        const conf = model.includes('sonnet') ? 0.92 : 0.35;
        const allow = model.includes('sonnet') ? true : false;
        rs.json({
          id: 'msg_jsync',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: JSON.stringify({ allow, reason: 'Mock', confidence: conf }) }],
          usage: { input_tokens: 80, output_tokens: 30 },
        });
      });

      const { status, json } = await req('POST', '/judge', {
        question: 'Critical sync decision',
        gate: 'sync-gate',
        sync: true,
      });

      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.tier, 'L2');
      assert.equal(json.escalated_from, 'L1');
      assert.ok(json.confidence >= 0.7);
    });
  });

  describe('/judge/l2 (internal only)', () => {
    it('responds from localhost', async () => {
      const { status, json } = await req('POST', '/judge/l2', {
        question: 'Should this merge?',
        gate: 'merge-gate',
        escalation_reason: 'test',
      });
      assert.equal(status, 200);
      assert.ok(json.tier === 'L2');
      assert.ok(json.remaining_quota >= 0);
    });
  });

  describe('/judge/l3 (internal only)', () => {
    it('responds from localhost', async () => {
      const { status, json } = await req('POST', '/judge/l3', {
        question: 'High stakes decision',
        gate: 'critical-gate',
        escalation_reason: 'test',
      });
      assert.equal(status, 200);
      assert.equal(json.tier, 'L3');
    });
  });

  // =========================================================================
  // Escalation polling
  // =========================================================================

  describe('/escalation/:ticketId', () => {
    it('returns 404 for unknown ticket', async () => {
      const { status, json } = await req('GET', '/escalation/esc-nonexistent');
      assert.equal(status, 404);
      assert.equal(json.error, 'not_found');
    });

    it('returns escalation state after async escalation', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.json({
          id: 'msg_poll',
          type: 'message',
          role: 'assistant',
          model: rq.body.model,
          content: [{ type: 'text', text: '{"result": "low", "confidence": 0.2}' }],
          usage: { input_tokens: 50, output_tokens: 20 },
        });
      });

      const { json: askJson } = await req('POST', '/ask', {
        prompt: 'Trigger escalation for poll test',
        caller: 'test-poll',
        jsonMode: true,
        sync: false,
      });

      assert.equal(askJson.status, 'escalating');
      const ticketId = askJson.ticket_id;

      // Wait for background L2 to complete
      await new Promise(r => setTimeout(r, 500));

      const { status, json } = await req('GET', `/escalation/${ticketId}`);
      mockUpstream.resetResponse();

      assert.equal(status, 200);
      assert.equal(json.ticket_id, ticketId);
      assert.ok(['resolved', 'timeout', 'pending'].includes(json.status));
      assert.ok(Array.isArray(json.tier_chain));
      assert.ok(Array.isArray(json.responses));
    });
  });

  // =========================================================================
  // Rate limiting
  // =========================================================================

  describe('Rate limiting', () => {
    it('/ask/l3 enforces 20/hour limit', async () => {
      // Make 20 requests to hit the limit (some already used above)
      let rateLimited = false;
      for (let i = 0; i < 25; i++) {
        const { status } = await req('POST', '/ask/l3', {
          prompt: `Rate limit test ${i}`,
          caller: 'test-rate',
        });
        if (status === 429) { rateLimited = true; break; }
      }
      assert.ok(rateLimited, 'Expected rate limit to trigger within 25 requests');
    });
  });

  // =========================================================================
  // Stats endpoints
  // =========================================================================

  describe('/api/ask-stats', () => {
    it('returns stats grouped by tier', async () => {
      const { status, json } = await req('GET', '/api/ask-stats');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.by_tier));
      assert.ok(Array.isArray(json.recent));
    });
  });

  describe('/api/judge-stats', () => {
    it('returns stats grouped by gate', async () => {
      const { status, json } = await req('GET', '/api/judge-stats');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.by_gate));
      assert.ok(Array.isArray(json.recent));
    });
  });

  // =========================================================================
  // Streaming SSE proxy (T128)
  // =========================================================================

  describe('/v1/messages (streaming)', () => {
    it('proxies SSE stream and preserves event format', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        rs.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_stream","type":"message","role":"assistant","model":"claude-haiku-4-5","content":[],"usage":{"input_tokens":80,"output_tokens":0}}}\n\n');
        rs.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        rs.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello from stream"}}\n\n');
        rs.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
        rs.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":12}}\n\n');
        rs.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
        rs.end();
      });

      const res = await fetch(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 100,
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').includes('text/event-stream'));

      const body = await res.text();
      mockUpstream.resetResponse();

      assert.ok(body.includes('event: message_start'));
      assert.ok(body.includes('Hello from stream'));
      assert.ok(body.includes('event: message_stop'));
      assert.ok(body.includes('"output_tokens":12'));
    });

    it('handles upstream error during stream gracefully', async () => {
      mockUpstream.setResponse((rq, rs) => {
        rs.writeHead(500, { 'Content-Type': 'application/json' });
        rs.end(JSON.stringify({ error: 'overloaded' }));
      });

      const res = await fetch(`${BASE}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 100,
          stream: true,
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      });

      mockUpstream.resetResponse();
      assert.equal(res.status, 500);
    });
  });

  // =========================================================================
  // Cache backfill (admin)
  // =========================================================================

  describe('/api/backfill-cache', () => {
    it('returns dry-run results by default', async () => {
      const { status, json } = await req('POST', '/api/backfill-cache', {});
      assert.equal(status, 200);
      assert.equal(json.dry_run, true);
      assert.ok(typeof json.updated === 'number');
      assert.ok(typeof json.sessions === 'number');
    });
  });

  // =========================================================================
  // Dashboard API endpoints (T141)
  // =========================================================================

  describe('/api/usage', () => {
    it('returns usage rows with totals', async () => {
      const { status, json } = await req('GET', '/api/usage');
      assert.equal(status, 200);
      assert.equal(json.period, 'today');
      assert.ok(Array.isArray(json.rows));
      assert.ok(typeof json.totals === 'object');
      assert.ok(typeof json.row_count === 'number');
    });

    it('accepts group=model parameter', async () => {
      const { status, json } = await req('GET', '/api/usage?group=model');
      assert.equal(status, 200);
      assert.equal(json.group, 'model');
    });

    it('rejects invalid period', async () => {
      const { status, json } = await req('GET', '/api/usage?period=bogus');
      assert.equal(status, 400);
      assert.equal(json.error, 'invalid_period');
    });

    it('rejects invalid group', async () => {
      const { status, json } = await req('GET', '/api/usage?group=bogus');
      assert.equal(status, 400);
      assert.equal(json.error, 'invalid_group');
    });
  });

  describe('/api/budget', () => {
    it('returns budget status with limits', async () => {
      const { status, json } = await req('GET', '/api/budget');
      assert.equal(status, 200);
      assert.ok(typeof json.monthly_limit === 'number');
      assert.ok(Array.isArray(json.alert_at));
      assert.ok(Array.isArray(json.alerts_crossed));
    });
  });

  describe('/api/summary', () => {
    it('returns all dashboard data in one call', async () => {
      const { status, json } = await req('GET', '/api/summary');
      assert.equal(status, 200);
      assert.ok(typeof json.totals === 'object');
      assert.ok(typeof json.month === 'object');
      assert.ok(Array.isArray(json.by_consumer));
      assert.ok(Array.isArray(json.by_model));
    });
  });

  describe('/api/hourly', () => {
    it('returns hourly spend rows', async () => {
      const { status, json } = await req('GET', '/api/hourly');
      assert.equal(status, 200);
      assert.equal(json.period, 'today');
      assert.ok(Array.isArray(json.rows));
    });
  });

  describe('/api/top-operations', () => {
    it('returns top expensive calls', async () => {
      const { status, json } = await req('GET', '/api/top-operations');
      assert.equal(status, 200);
      assert.equal(json.period, 'today');
      assert.ok(Array.isArray(json.rows));
    });
  });

  describe('/api/cache-estimation', () => {
    it('returns estimation stats with summary', async () => {
      const { status, json } = await req('GET', '/api/cache-estimation');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.rows));
      assert.ok(typeof json.summary === 'object');
      assert.ok(typeof json.summary.estimated_calls === 'number');
      assert.ok(typeof json.summary.actual_calls === 'number');
    });
  });

  describe('/api/hourly-breakdown', () => {
    it('returns hours array', async () => {
      const { status, json } = await req('GET', '/api/hourly-breakdown');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.hours));
    });

    it('accepts range parameter', async () => {
      const { status, json } = await req('GET', '/api/hourly-breakdown?range=7d');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.hours));
    });

    it('falls back to 24h for invalid range', async () => {
      const { status, json } = await req('GET', '/api/hourly-breakdown?range=bogus');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.hours));
    });
  });

  describe('/api/cost-breakdown', () => {
    it('returns models array with totals', async () => {
      const { status, json } = await req('GET', '/api/cost-breakdown');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.models));
      assert.ok(typeof json.totals === 'object');
      assert.ok(typeof json.totals.cost === 'number');
      assert.ok(typeof json.totals.calls === 'number');
    });

    it('respects range=1h', async () => {
      const { status, json } = await req('GET', '/api/cost-breakdown?range=1h');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.models));
    });
  });

  describe('/api/project-costs', () => {
    it('returns projects array', async () => {
      const { status, json } = await req('GET', '/api/project-costs');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.projects));
    });

    it('respects range=30d', async () => {
      const { status, json } = await req('GET', '/api/project-costs?range=30d');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.projects));
    });
  });

  describe('/api/savings-potential', () => {
    it('returns savings data', async () => {
      const { status, json } = await req('GET', '/api/savings-potential');
      assert.equal(status, 200);
      assert.ok(Array.isArray(json.models));
      assert.ok(typeof json.session_restarts === 'object');
    });
  });

  describe('/api/daily-comparison', () => {
    it('returns today vs yesterday comparison', async () => {
      const { status, json } = await req('GET', '/api/daily-comparison');
      assert.equal(status, 200);
      assert.ok('today' in json);
      assert.ok('yesterday' in json);
      assert.ok(typeof json.today.cost === 'number');
      assert.ok(typeof json.yesterday.cost === 'number');
    });
  });

  describe('/api/cache-stats', () => {
    it('returns cache statistics', async () => {
      const { status, json } = await req('GET', '/api/cache-stats');
      assert.equal(status, 200);
      assert.ok(typeof json.entries === 'number');
      assert.ok(typeof json.hits === 'number');
      assert.ok(typeof json.misses === 'number');
    });
  });

  // =========================================================================
  // 404 catch-all
  // =========================================================================

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      const { status, json } = await req('GET', '/nonexistent');
      assert.equal(status, 404);
      assert.equal(json.error, 'not_found');
    });
  });
});
