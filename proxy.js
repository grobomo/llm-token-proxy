'use strict';

const express    = require('express');
const path       = require('path');
const fs         = require('fs');
const yaml       = require('js-yaml');
const { fetch, Agent } = require('undici');

const db      = require('./db');
const pricing = require('./pricing');
const { estimateCacheTokens } = require('./lib/cache-estimator');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const CONFIG_PATH = process.env.PROXY_CONFIG || path.resolve(__dirname, 'config.yaml');
const config      = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT     = config.port     || 4100;
const BIND     = config.bind     || '127.0.0.1';
const UPSTREAM = config.upstream;  // optional legacy single-upstream; prefer config.upstreams

// ---------------------------------------------------------------------------
// Multi-upstream routing
// ---------------------------------------------------------------------------
// Build list of upstreams from config.upstreams map (order matters for matching)
const UPSTREAMS = Object.entries(config.upstreams || {}).map(([name, cfg]) => ({
  name,
  url:         cfg.url,
  key_pattern: cfg.key_pattern,
}));

/**
 * Extract the API key from the request.
 * Checks x-api-key header first, then Authorization: Bearer <token>.
 */
function extractApiKey(req) {
  if (req.headers['x-api-key']) return req.headers['x-api-key'];
  const auth = req.headers['authorization'] || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Classify the calling consumer.
 * Order: explicit X-Consumer header → User-Agent sniff → "unknown".
 * Heuristic only — for accurate per-consumer attribution, callers should set X-Consumer.
 */
function detectConsumer(req) {
  const explicit = req.headers['x-consumer'];
  if (explicit) return String(explicit);
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('claude-cli') || ua.includes('claude-code')) return 'claude-code';
  if (ua.includes('anthropic'))                                 return 'anthropic-sdk';
  if (ua.includes('openai'))                                    return 'openai-sdk';
  return 'unknown';
}

/**
 * Resolve which upstream to use based on the API key prefix.
 * Returns { name, url } — falls back to legacy UPSTREAM if no pattern matches.
 */
function resolveUpstream(req) {
  const apiKey = extractApiKey(req);
  if (apiKey && UPSTREAMS.length > 0) {
    for (const upstream of UPSTREAMS) {
      if (upstream.key_pattern && apiKey.startsWith(upstream.key_pattern)) {
        return { name: upstream.name, url: upstream.url };
      }
    }
  }
  // Fallback to legacy single-upstream
  if (UPSTREAM) return { name: 'default', url: UPSTREAM };
  // No upstream configured — caller must define config.upstreams or config.upstream.
  throw new Error('No upstream configured. Set config.upstreams (preferred) or config.upstream in config.yaml.');
}

pricing.loadPricing(config.pricing);

// ---------------------------------------------------------------------------
// Model overrides — route specific patterns to cheaper models
// ---------------------------------------------------------------------------
const MODEL_OVERRIDES = (config.model_overrides || []).filter(r => r.enabled !== false);

function resolveModelOverride(model, consumer, parsed) {
  for (const rule of MODEL_OVERRIDES) {
    const m = rule.match || {};
    if (m.model && !matchGlob(m.model, model)) continue;
    if (m.consumer && m.consumer !== consumer) continue;
    if (m.no_cache && hasCache(parsed)) continue;
    if (m.max_messages && Array.isArray(parsed.messages) && parsed.messages.length > m.max_messages) continue;
    return rule;
  }
  return null;
}

function matchGlob(pattern, str) {
  if (!pattern.includes('*')) return pattern === str;
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  return re.test(str);
}

function hasCache(parsed) {
  if (Array.isArray(parsed.system)) {
    if (parsed.system.some(s => s.cache_control)) return true;
  }
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (Array.isArray(msg.content)) {
        if (msg.content.some(c => c.cache_control)) return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
db.init(config.db || path.resolve(__dirname, 'usage.db'));

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Parse raw request body for proxying (we need to inspect + forward it)
app.use(express.raw({ type: '*/*', limit: '10mb' }));

// ---------------------------------------------------------------------------
// Logging helper
// ---------------------------------------------------------------------------
function log(level, ...args) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const cfgLevel = config.log?.level || 'info';
  if (levels[level] <= levels[cfgLevel]) {
    console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}]`, ...args);
  }
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', async (req, res) => {
  // Check reachability of the primary upstream (first in config.upstreams)
  const primaryUpstream = UPSTREAMS.length > 0 ? UPSTREAMS[0].url : UPSTREAM;
  let upstreamStatus = 'unknown';
  try {
    // Lightweight reachability check — just hit the upstream base URL
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(primaryUpstream.replace(/\/v1\/?$/, ''), {
      method: 'HEAD',
      signal: ctrl.signal,
    }).catch(() => null);
    clearTimeout(timer);
    // Any response (even 401/404) means the host is reachable
    upstreamStatus = (r !== null) ? 'reachable' : 'unreachable';
  } catch {
    upstreamStatus = 'unreachable';
  }

  const status = upstreamStatus === 'reachable' ? 200 : 503;
  res.status(status).json({
    status:    status === 200 ? 'ok' : 'degraded',
    upstream:  upstreamStatus,
    upstreams: UPSTREAMS.map(u => u.name),
    proxy:     'running',
    port:      PORT,
    ts:        new Date().toISOString(),
  });
});

app.get('/diagnose', async (req, res) => {
  const results = {};
  for (const upstream of UPSTREAMS) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const r = await fetch(upstream.url.replace(/\/v1\/?$/, ''), {
        method: 'HEAD',
        signal: ctrl.signal,
      }).catch(() => null);
      clearTimeout(timer);
      results[upstream.name] = r !== null ? 'reachable' : 'unreachable';
    } catch {
      results[upstream.name] = 'unreachable';
    }
  }

  const allReachable = Object.values(results).every(s => s === 'reachable');
  const allDown = Object.values(results).every(s => s === 'unreachable');

  let cause, action;
  if (allReachable) {
    cause = 'healthy';
    action = 'No action needed';
  } else if (allDown) {
    cause = 'all_upstreams_down';
    action = 'Check network connectivity. If persistent, wait for upstream recovery.';
  } else {
    cause = 'partial_outage';
    const down = Object.entries(results).filter(([,s]) => s === 'unreachable').map(([n]) => n);
    action = `${down.join(', ')} unreachable. Requests using those upstreams will fail. Others are healthy.`;
  }

  res.status(allReachable ? 200 : 503).json({
    cause,
    proxy: true,
    upstreams: results,
    action,
    ts: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Shared modules for tiered endpoints (T125/T126)
// ---------------------------------------------------------------------------
const ask = require('./lib/ask');
const rateLimit = require('./lib/rate-limit');
const escalation = require('./lib/escalation');

ask.init(config.db || path.resolve(__dirname, 'usage.db'));
escalation.init(config.db || path.resolve(__dirname, 'usage.db'));

function internalOnly(req, res, next) {
  const ip = req.socket.remoteAddress;
  if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') return next();
  res.status(403).json({ error: 'internal_only' });
}

function parseBody(req) {
  if (!req.body || req.body.length === 0) return {};
  return JSON.parse(req.body.toString('utf8'));
}

// ---------------------------------------------------------------------------
// Judge endpoint (T118/T126) — semantic gate decisions with tiered escalation
// ---------------------------------------------------------------------------
const judge = require('./lib/judge');
judge.init(config.db || path.resolve(__dirname, 'usage.db'));

app.post('/judge', async (req, res) => {
  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { question, context, gate, project, session_id, fallback, sync, critical, webhook_url } = body;

  if (!question || !gate) {
    return res.status(400).json({ error: 'missing_fields', required: ['question', 'gate'] });
  }

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return res.status(401).json({ error: 'missing_api_key' });
  }

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await judge.callTier('L1', question, context, proxyUrl, apiKey);

  let decision, fallbackUsed = false;
  if (result.allow === null && fallback !== undefined) {
    decision = fallback ? 'allow' : 'block';
    fallbackUsed = true;
  } else {
    decision = result.allow ? 'allow' : 'block';
  }

  judge.logDecision({
    gate, project, session_id, question, context,
    decision, reason: result.reason, confidence: result.confidence,
    latency_ms: result.latencyMs, fallback_used: fallbackUsed, tier: 'L1',
  });

  if (result.confidence !== null && result.confidence < 0.7 && !fallbackUsed) {
    const ticketId = escalation.createEscalation({
      caller: `judge-${gate}`, gate, tierChain: ['L1', 'L2'], request: body, webhookUrl: webhook_url,
    });
    escalation.addTierResponse(ticketId, { tier: 'L1', ...result, decision });
    escalation.writeNotes(ticketId, 'L1', `# Judge Escalation ${ticketId} — L1\n\n**Gate:** ${gate}\n**Confidence:** ${result.confidence}\n**Decision:** ${decision}\n**Reason:** ${result.reason}\n`);

    if (sync) {
      const l2Result = await Promise.race([
        judge.callTier('L2', question, context, proxyUrl, apiKey),
        new Promise(resolve => setTimeout(() => resolve(null), 8000)),
      ]);
      if (l2Result && l2Result.allow !== null) {
        const l2Decision = l2Result.allow ? 'allow' : 'block';
        escalation.resolveEscalation(ticketId, { tier: 'L2', ...l2Result, decision: l2Decision });
        judge.logDecision({
          gate, project, session_id, question, context,
          decision: l2Decision, reason: l2Result.reason, confidence: l2Result.confidence,
          latency_ms: l2Result.latencyMs, tier: 'L2', escalated_from: 'L1',
          escalation_reason: `L1 confidence ${result.confidence} < 0.7`,
        });
        return res.json({
          allow: l2Decision === 'allow', reason: l2Result.reason,
          confidence: l2Result.confidence, latency_ms: l2Result.latencyMs,
          tier: 'L2', escalated_from: 'L1', ticket_id: ticketId,
        });
      }
      escalation.timeoutEscalation(ticketId, { tier: 'L1', decision, reason: result.reason });
      return res.json({
        allow: decision === 'allow', reason: result.reason,
        confidence: result.confidence, latency_ms: result.latencyMs,
        tier: 'L1', partial: true, ticket_id: ticketId, fallback_used: fallbackUsed,
      });
    }

    escalation.runBackground(ticketId, 'L2', {
      system: `You are a gate judge. Answer with JSON: {"allow": true|false, "reason": "string", "confidence": 0.0-1.0}\n\nQuestion: ${question}\n${context ? `Context: ${context}` : ''}`,
      prompt: question, caller: `judge-${gate}`, maxTokens: 500, jsonMode: true,
    }, proxyUrl, apiKey, ask);

    return res.json({
      allow: decision === 'allow', reason: result.reason,
      confidence: result.confidence, latency_ms: result.latencyMs,
      tier: 'L1', fallback_used: fallbackUsed,
      escalation: { status: 'escalating', ticket_id: ticketId, poll_url: `/escalation/${ticketId}` },
    });
  }

  res.json({
    allow: decision === 'allow', reason: result.reason,
    confidence: result.confidence, latency_ms: result.latencyMs,
    tier: 'L1', fallback_used: fallbackUsed,
  });
});

app.post('/judge/l2', internalOnly, async (req, res) => {
  const limit = rateLimit.check('judge-l2', 50);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', remaining: 0, reset_at: new Date(limit.resetAt).toISOString() });
  }

  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { question, context, gate, project, session_id, escalation_reason } = body;

  if (!question || !gate) return res.status(400).json({ error: 'missing_fields', required: ['question', 'gate'] });

  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await judge.callTier('L2', question, context, proxyUrl, apiKey);

  const decision = result.allow === null ? 'error' : (result.allow ? 'allow' : 'block');
  judge.logDecision({
    gate, project, session_id, question, context,
    decision, reason: result.reason, confidence: result.confidence,
    latency_ms: result.latencyMs, tier: 'L2',
    escalated_from: body.escalated_from || null, escalation_reason: escalation_reason || null,
  });

  res.json({
    allow: decision === 'allow', reason: result.reason,
    confidence: result.confidence, latency_ms: result.latencyMs,
    tier: 'L2', remaining_quota: limit.remaining,
  });
});

app.post('/judge/l3', internalOnly, async (req, res) => {
  const limit = rateLimit.check('judge-l3', 10);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', remaining: 0, reset_at: new Date(limit.resetAt).toISOString() });
  }

  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { question, context, gate, project, session_id, escalation_reason } = body;

  if (!question || !gate) return res.status(400).json({ error: 'missing_fields', required: ['question', 'gate'] });

  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await judge.callTier('L3', question, context, proxyUrl, apiKey);

  const decision = result.allow === null ? 'error' : (result.allow ? 'allow' : 'block');
  judge.logDecision({
    gate, project, session_id, question, context,
    decision, reason: result.reason, confidence: result.confidence,
    latency_ms: result.latencyMs, tier: 'L3',
    escalated_from: body.escalated_from || null, escalation_reason: escalation_reason || null,
  });

  res.json({
    allow: decision === 'allow', reason: result.reason,
    confidence: result.confidence, latency_ms: result.latencyMs,
    tier: 'L3', remaining_quota: limit.remaining,
  });
});

app.get('/api/judge-stats', (req, res) => {
  res.json(judge.getStats());
});

// ---------------------------------------------------------------------------
// Tiered /ask endpoints (T125) — general-purpose LLM calls at L1/L2/L3
// ---------------------------------------------------------------------------

const RATE_LIMITS = { L2: 100, L3: 20 };

app.post('/ask', async (req, res) => {
  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { system, prompt, caller, maxTokens, jsonMode, sync, webhook_url } = body;

  if (!prompt) return res.status(400).json({ error: 'missing_fields', required: ['prompt'] });

  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await ask.callTier('L1', { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey);

  ask.logCall({
    caller, system, prompt, tier: 'L1',
    response: result.content?.slice(0, 500),
    confidence: result.confidence,
    ms: result.ms,
    tokens_in: result.tokens?.in || 0,
    tokens_out: result.tokens?.out || 0,
  });

  if (result.ok && jsonMode && result.confidence !== null && result.confidence < 0.7) {
    const ticketId = escalation.createEscalation({
      caller, gate: body.gate, tierChain: ['L1', 'L2'], request: body, webhookUrl: webhook_url,
    });

    escalation.addTierResponse(ticketId, { tier: 'L1', ...result });
    escalation.writeNotes(ticketId, 'L1', `# Escalation ${ticketId} — L1\n\n**Confidence:** ${result.confidence}\n**Reason:** Below 0.7 threshold\n**Response:** ${result.content?.slice(0, 500) || '(empty)'}\n`);

    if (sync) {
      const l2Result = await Promise.race([
        ask.callTier('L2', { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey),
        new Promise(resolve => setTimeout(() => resolve(null), 8000)),
      ]);

      if (l2Result && l2Result.ok) {
        escalation.resolveEscalation(ticketId, l2Result);
        ask.logCall({
          caller, system, prompt, tier: 'L2',
          response: l2Result.content?.slice(0, 500),
          confidence: l2Result.confidence, ms: l2Result.ms,
          tokens_in: l2Result.tokens?.in || 0, tokens_out: l2Result.tokens?.out || 0,
          escalated_from: 'L1', escalation_reason: `L1 confidence ${result.confidence} < 0.7`,
        });
        return res.json({ ...l2Result, escalated_from: 'L1', ticket_id: ticketId });
      }
      escalation.timeoutEscalation(ticketId, result);
      return res.json({ ...result, partial: true, ticket_id: ticketId });
    }

    escalation.runBackground(ticketId, 'L2', { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey, ask);

    return res.json({
      status: 'escalating',
      ticket_id: ticketId,
      tier: 'L1',
      message: `Low confidence (${result.confidence}) — escalating to L2`,
      poll_url: `/escalation/${ticketId}`,
      l1_response: result,
    });
  }

  res.json(result);
});

app.post('/ask/l2', internalOnly, async (req, res) => {
  const limit = rateLimit.check('ask-l2', RATE_LIMITS.L2);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', remaining: 0, reset_at: new Date(limit.resetAt).toISOString() });
  }

  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { system, prompt, caller, maxTokens, jsonMode, escalation_reason } = body;

  if (!prompt) return res.status(400).json({ error: 'missing_fields', required: ['prompt'] });

  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await ask.callTier('L2', { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey);

  ask.logCall({
    caller, system, prompt, tier: 'L2',
    response: result.content?.slice(0, 500),
    confidence: result.confidence, ms: result.ms,
    tokens_in: result.tokens?.in || 0, tokens_out: result.tokens?.out || 0,
    escalated_from: body.escalated_from || null,
    escalation_reason: escalation_reason || null,
  });

  res.json({ ...result, remaining_quota: limit.remaining });
});

app.post('/ask/l3', internalOnly, async (req, res) => {
  const limit = rateLimit.check('ask-l3', RATE_LIMITS.L3);
  if (!limit.allowed) {
    return res.status(429).json({ error: 'rate_limited', remaining: 0, reset_at: new Date(limit.resetAt).toISOString() });
  }

  let body;
  try { body = parseBody(req); } catch { return res.status(400).json({ error: 'invalid_json' }); }
  const { system, prompt, caller, maxTokens, jsonMode, escalation_reason } = body;

  if (!prompt) return res.status(400).json({ error: 'missing_fields', required: ['prompt'] });

  const apiKey = extractApiKey(req);
  if (!apiKey) return res.status(401).json({ error: 'missing_api_key' });

  const proxyUrl = `http://127.0.0.1:${PORT}`;
  const result = await ask.callTier('L3', { system, prompt, caller, maxTokens, jsonMode }, proxyUrl, apiKey);

  ask.logCall({
    caller, system, prompt, tier: 'L3',
    response: result.content?.slice(0, 500),
    confidence: result.confidence, ms: result.ms,
    tokens_in: result.tokens?.in || 0, tokens_out: result.tokens?.out || 0,
    escalated_from: body.escalated_from || null,
    escalation_reason: escalation_reason || null,
  });

  res.json({ ...result, remaining_quota: limit.remaining });
});

app.get('/escalation/:ticketId', (req, res) => {
  const data = escalation.getEscalation(req.params.ticketId);
  if (!data) return res.status(404).json({ error: 'not_found' });
  res.json(data);
});

app.get('/api/ask-stats', (req, res) => {
  res.json(ask.getStats());
});

// ---------------------------------------------------------------------------
// Dashboard routes
// ---------------------------------------------------------------------------
const dashboardApi = require('./dashboard/api');
app.use('/api', dashboardApi);

// Serve dashboard HTML
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
});

// Root redirect
app.get('/', (req, res) => res.redirect('/dashboard'));

// ---------------------------------------------------------------------------
// Proxy: /v1/* → upstream
// ---------------------------------------------------------------------------

// Headers that should NOT be forwarded upstream (hop-by-hop + connection mgmt)
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade', 'host',
]);

// Headers to strip from upstream response before forwarding to client.
// content-encoding/content-length: undici auto-decompresses gzip/deflate but
// leaves these headers intact — forwarding them to the client over a plain
// body causes ZlibError on Claude Code Windows. Always strip; Express will
// re-set content-length correctly when sending.
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
  'content-encoding', 'content-length',
]);

app.all('/v1/*', async (req, res) => {
  if (shuttingDown) {
    res.set('Retry-After', '2');
    return res.status(503).json({ error: 'shutting_down', retry_after: 2 });
  }
  const startTime  = Date.now();
  const consumer   = detectConsumer(req);
  const project    = req.headers['x-project'] ? String(req.headers['x-project']) : null;
  const task       = req.headers['x-task']    ? String(req.headers['x-task'])    : null;
  const sessionId  = req.headers['x-claude-code-session-id'] || null;
  const userAgent  = req.headers['user-agent'] ? String(req.headers['user-agent']).slice(0, 256) : null;

  // ---- Resolve upstream based on API key format ----
  let upstreamName, upstreamBaseResolved;
  try {
    ({ name: upstreamName, url: upstreamBaseResolved } = resolveUpstream(req));
  } catch (err) {
    return res.status(400).json({ error: 'no_upstream_match', message: err.message });
  }

  // ---- Build upstream URL ----
  // req.url = /v1/messages → strip leading /v1 and append to upstream base
  const upstreamBase = upstreamBaseResolved.replace(/\/$/, ''); // no trailing slash
  const reqPath      = req.url;                                  // e.g. /v1/messages
  const upstreamUrl  = upstreamBase + reqPath.replace(/^\/v1/, '');

  // ---- Forward request headers (strip hop-by-hop + add host) ----
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && k.toLowerCase() !== 'x-consumer') {
      forwardHeaders[k] = v;
    }
  }
  // Strip zstd from accept-encoding — neither undici nor the proxy can decode it.
  if (forwardHeaders['accept-encoding']) {
    forwardHeaders['accept-encoding'] = forwardHeaders['accept-encoding']
      .split(',').map(s => s.trim()).filter(s => !s.startsWith('zstd')).join(', ') || 'gzip, deflate, br';
  }

  // ---- Parse request body ----
  let requestBody = req.body;   // Buffer from express.raw()
  let model       = 'unknown';
  let isStreaming  = false;

  let originalModel = null;

  if (requestBody && requestBody.length > 0) {
    try {
      const parsed = JSON.parse(requestBody.toString('utf8'));
      model       = parsed.model   || 'unknown';
      isStreaming  = Boolean(parsed.stream);

      // Model override — route specific patterns to cheaper models
      const override = resolveModelOverride(model, consumer, parsed);
      if (override) {
        originalModel = model;
        model = override.replace_model;
        parsed.model = model;
        log('info', `[model-override] ${override.name}: ${originalModel} → ${model}`);
      }

      // Auto-inject stream_options.include_usage for OpenAI-style streaming so
      // upstream returns token counts in the final SSE chunk. Only touch the
      // OpenAI-compatible path (/chat/completions); Anthropic-native (/messages)
      // returns usage in message_delta without needing this flag.
      let bodyModified = !!override;
      if (isStreaming && reqPath.includes('/chat/completions')) {
        const existing = parsed.stream_options && parsed.stream_options.include_usage;
        if (!existing) {
          parsed.stream_options = { ...(parsed.stream_options || {}), include_usage: true };
          bodyModified = true;
        }
      }

      if (bodyModified) {
        requestBody = Buffer.from(JSON.stringify(parsed), 'utf8');
        if (forwardHeaders['content-length']) forwardHeaders['content-length'] = String(requestBody.length);
      }
    } catch {
      // Non-JSON body — passthrough as-is
    }
  }

  const reqAcceptEnc = req.headers['accept-encoding'] || '-';
  const reqUA        = (req.headers['user-agent'] || '-').slice(0, 60);
  log('info', `${req.method} ${req.url} | consumer=${consumer} model=${model} stream=${isStreaming} upstream=${upstreamName} ae="${reqAcceptEnc}" ua="${reqUA}"`);

  // ---- Make upstream request ----
  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method:  req.method,
      headers: forwardHeaders,
      body:    (req.method !== 'GET' && req.method !== 'HEAD' && requestBody?.length > 0)
               ? requestBody
               : undefined,
      // Don't decompress — forward raw bytes
      dispatcher: new Agent({ bodyTimeout: 0, headersTimeout: 30_000 }),
    });
  } catch (err) {
    log('error', 'Upstream fetch failed:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream_unreachable', message: err.message });
    }
    return;
  }

  const httpStatus      = upstreamRes.status;
  const contentType     = upstreamRes.headers.get('content-type') || '';
  const isSSE           = contentType.includes('text/event-stream');
  const upCE            = upstreamRes.headers.get('content-encoding') || '-';
  const upCL            = upstreamRes.headers.get('content-length')   || '-';
  const upTE            = upstreamRes.headers.get('transfer-encoding')|| '-';

  // Capture LiteLLM cost headers as fallback when stream parser can't extract usage
  const litellmCost    = parseFloat(upstreamRes.headers.get('x-litellm-response-cost') || '') || null;
  const litellmSpend   = upstreamRes.headers.get('x-litellm-key-spend') || null;

  log('info', `[upstream] status=${httpStatus} ce=${upCE} cl=${upCL} te=${upTE} ct="${contentType}"${litellmCost ? ` litellm_cost=$${litellmCost}` : ''}`);

  // ---- Forward response headers ----
  res.status(httpStatus);
  for (const [k, v] of upstreamRes.headers.entries()) {
    if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
      res.setHeader(k, v);
    }
  }

  // ====================================================================
  // SSE Streaming path
  // ====================================================================
  if (isSSE) {
    // These are already set by upstream but make sure chunked encoding works
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');

    let sseBuffer        = '';
    let usageFromStream  = null;
    const decoder        = new TextDecoder();

    try {
      for await (const chunk of upstreamRes.body) {
        // Forward chunk to client immediately (low latency)
        res.write(chunk);

        // Also accumulate for usage parsing
        sseBuffer += decoder.decode(chunk, { stream: true });

        // Parse SSE events from buffer — look for message_stop
        const lines = sseBuffer.split('\n');
        // Keep the last partial line in the buffer
        sseBuffer = lines.pop();

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;

          if (line.startsWith('event: message_stop')) {
            // Next non-empty line should be `data: {...}`
            const dataLine = lines[i + 1]?.trim();
            if (dataLine && dataLine.startsWith('data: ')) {
              try {
                const eventData = JSON.parse(dataLine.slice(6));
                if (eventData.usage) {
                  usageFromStream = eventData.usage;
                }
              } catch {
                // ignore parse errors in stream
              }
            }
          }

          // Also check for message_delta with usage (Claude streaming format)
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            if (payload === '[DONE]') continue;
            try {
              const eventData = JSON.parse(payload);
              if (eventData.type === 'message_delta' && eventData.usage) {
                usageFromStream = { ...usageFromStream, ...eventData.usage };
              }
              if (eventData.type === 'message_stop' && eventData.usage) {
                usageFromStream = { ...usageFromStream, ...eventData.usage };
              }
              // Capture usage from content_block_stop or message with usage
              if (eventData.message?.usage) {
                usageFromStream = { ...usageFromStream, ...eventData.message.usage };
              }
              // OpenAI-compatible streaming (RDsec): usage carried on a chunk with `choices`.
              // Normalize OpenAI field names → Anthropic so pricing.js works.
              // IMPORTANT: OpenAI's `prompt_tokens` is the TOTAL (includes cached).
              // Anthropic's `input_tokens` is NON-cached only. Subtract cache tokens
              // to avoid double-charging in pricing.js.
              if (eventData.usage && Array.isArray(eventData.choices)) {
                const u = eventData.usage;
                const cacheRead  = u.cache_read_input_tokens     ?? u.prompt_tokens_details?.cached_tokens          ?? 0;
                const cacheWrite = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0;
                const totalInput = u.prompt_tokens ?? (usageFromStream?.input_tokens || 0);
                usageFromStream = {
                  ...usageFromStream,
                  input_tokens:                Math.max(0, totalInput - cacheRead - cacheWrite),
                  output_tokens:               u.completion_tokens != null ? u.completion_tokens : (usageFromStream?.output_tokens || 0),
                  cache_read_input_tokens:     cacheRead,
                  cache_creation_input_tokens: cacheWrite,
                };
              }
            } catch {
              // not JSON, skip
            }
          }
        }
      }
    } catch (streamErr) {
      log('warn', 'Stream read error:', streamErr.message);
    } finally {
      res.end();
    }

    // Log after stream completes
    const duration = Date.now() - startTime;
    if (usageFromStream) {
      // Estimate cache tokens for upstreams that strip them (RDSec/LiteLLM)
      const { usage: estimatedUsage, estimated: cacheEstimated } = estimateCacheTokens({
        usage: usageFromStream,
        model,
        upstream: upstreamName,
        sessionId,
        queryDb: (sql) => db.query(sql),
      });
      const cost = pricing.calculateCost(model, estimatedUsage);
      // Prefer LiteLLM's authoritative cost when available; use our estimate as fallback
      const finalCost = litellmCost != null ? litellmCost : cost;
      db.logUsage({
        consumer,
        model,
        upstream:           upstreamName,
        input_tokens:       estimatedUsage.input_tokens              || 0,
        output_tokens:      estimatedUsage.output_tokens             || 0,
        cache_read_tokens:  estimatedUsage.cache_read_input_tokens   || 0,
        cache_write_tokens: estimatedUsage.cache_creation_input_tokens || 0,
        estimated_cost_usd: finalCost,
        duration_ms:        duration,
        http_status:        httpStatus,
        project, task, user_agent: userAgent, session_id: sessionId, original_model: originalModel,
        cache_estimated:    cacheEstimated,
      });
      log('info', `[SSE done] consumer=${consumer} model=${model} upstream=${upstreamName} in=${estimatedUsage.input_tokens} out=${estimatedUsage.output_tokens} cache_r=${estimatedUsage.cache_read_input_tokens || 0} cache_w=${estimatedUsage.cache_creation_input_tokens || 0}${cacheEstimated ? ' (est)' : ''} cost=$${finalCost}${litellmCost != null && Math.abs(cost - litellmCost) > 0.001 ? ` (est=$${cost})` : ''} dur=${duration}ms`);
    } else {
      // Fallback: use LiteLLM response-cost header if stream parser found nothing
      const fallbackCost = litellmCost || 0;
      db.logUsage({
        consumer, model,
        upstream: upstreamName,
        input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
        estimated_cost_usd: fallbackCost,
        duration_ms: duration,
        http_status: httpStatus,
        project, task, user_agent: userAgent, session_id: sessionId, original_model: originalModel,
      });
      if (fallbackCost > 0) {
        log('info', `[SSE done] consumer=${consumer} model=${model} upstream=${upstreamName} cost=$${fallbackCost} (from x-litellm-response-cost header) dur=${duration}ms`);
      } else {
        log('warn', `[SSE done] no usage data for consumer=${consumer} model=${model} upstream=${upstreamName} dur=${duration}ms`);
      }
    }

    return;
  }

  // ====================================================================
  // Regular (non-streaming) response path
  // ====================================================================
  let responseBody;
  try {
    responseBody = Buffer.from(await upstreamRes.arrayBuffer());
  } catch (err) {
    log('error', 'Failed to read upstream response body:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream_read_error', message: err.message });
    }
    return;
  }

  res.send(responseBody);

  // Parse usage from response body
  const duration = Date.now() - startTime;
  let usageData  = null;
  try {
    const parsed = JSON.parse(responseBody.toString('utf8'));
    const u = parsed.usage;
    if (u) {
      // Normalize OpenAI field names → Anthropic for consistent pricing.
      // OpenAI: prompt_tokens (total), completion_tokens
      // Anthropic: input_tokens (non-cached), output_tokens, cache_*_input_tokens
      const cacheRead  = u.cache_read_input_tokens     ?? u.prompt_tokens_details?.cached_tokens          ?? 0;
      const cacheWrite = u.cache_creation_input_tokens ?? u.prompt_tokens_details?.cache_creation_tokens ?? 0;
      const totalInput = u.prompt_tokens ?? u.input_tokens ?? 0;
      usageData = {
        input_tokens:                u.input_tokens != null ? u.input_tokens : Math.max(0, totalInput - cacheRead - cacheWrite),
        output_tokens:               u.output_tokens ?? u.completion_tokens ?? 0,
        cache_read_input_tokens:     cacheRead,
        cache_creation_input_tokens: cacheWrite,
      };
    }
  } catch {
    // Not JSON — skip usage parsing
  }

  if (usageData) {
    // Estimate cache tokens for upstreams that strip them (RDSec/LiteLLM)
    const { usage: estimatedUsage, estimated: cacheEstimated } = estimateCacheTokens({
      usage: usageData,
      model,
      upstream: upstreamName,
      sessionId,
      queryDb: (sql) => db.query(sql),
    });
    const cost = pricing.calculateCost(model, estimatedUsage);
    const finalCost = litellmCost != null ? litellmCost : cost;
    db.logUsage({
      consumer,
      model,
      upstream:           upstreamName,
      input_tokens:       estimatedUsage.input_tokens              || 0,
      output_tokens:      estimatedUsage.output_tokens             || 0,
      cache_read_tokens:  estimatedUsage.cache_read_input_tokens   || 0,
      cache_write_tokens: estimatedUsage.cache_creation_input_tokens || 0,
      estimated_cost_usd: finalCost,
      duration_ms:        duration,
      http_status:        httpStatus,
      project, task, user_agent: userAgent, session_id: sessionId, original_model: originalModel,
      cache_estimated:    cacheEstimated,
    });
    log('info', `[done] consumer=${consumer} model=${model} upstream=${upstreamName} in=${estimatedUsage.input_tokens} out=${estimatedUsage.output_tokens} cache_r=${estimatedUsage.cache_read_input_tokens || 0} cache_w=${estimatedUsage.cache_creation_input_tokens || 0}${cacheEstimated ? ' (est)' : ''} cost=$${finalCost}${litellmCost != null && Math.abs(cost - litellmCost) > 0.001 ? ` (est=$${cost})` : ''} dur=${duration}ms`);
  } else {
    const fallbackCost = litellmCost || 0;
    db.logUsage({
      consumer, model,
      upstream: upstreamName,
      input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      estimated_cost_usd: fallbackCost,
      duration_ms: duration,
      http_status: httpStatus,
      project, task, user_agent: userAgent, session_id: sessionId, original_model: originalModel,
    });
    if (httpStatus >= 200 && httpStatus < 300) {
      log('debug', `[done] no usage data in response for consumer=${consumer} model=${model} upstream=${upstreamName} status=${httpStatus}${fallbackCost > 0 ? ` litellm_cost=$${fallbackCost}` : ''}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 404 catch-all
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

// ---------------------------------------------------------------------------
// Graceful shutdown — drain in-flight requests before exiting
// ---------------------------------------------------------------------------
let server;
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('info', `${signal} received — draining in-flight requests (2s max)...`);

  // Stop accepting new connections
  if (server) server.close();

  // Short drain — most requests complete in <1s; long drain just extends the outage window
  const drainTimeout = setTimeout(() => {
    log('info', 'Drain timeout — forcing exit');
    db.close();
    process.exit(0);
  }, 2000);
  drainTimeout.unref();

  // If server closes cleanly (all connections done), exit immediately
  if (server) {
    server.on('close', () => {
      clearTimeout(drainTimeout);
      log('info', 'All connections drained — clean exit');
      db.close();
      process.exit(0);
    });
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));


// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server = app.listen(PORT, BIND, () => {
  log('info', `Token Proxy listening on http://${BIND}:${PORT}`);
  if (UPSTREAMS.length > 0) {
    for (const u of UPSTREAMS) {
      log('info', `Upstream [${u.name}]: ${u.url} (key prefix: ${u.key_pattern})`);
    }
  } else {
    log('info', `Upstream (legacy): ${UPSTREAM}`);
  }
  log('info', `Dashboard: http://${BIND}:${PORT}/dashboard`);
  log('info', `Health:    http://${BIND}:${PORT}/health`);
});

module.exports = app; // for testing
