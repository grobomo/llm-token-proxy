#!/usr/bin/env node
'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');
const http = require('http');
const crypto = require('crypto');

const DB_PATH = process.env.USAGE_DB
  || path.resolve(__dirname, '..', 'usage.db');
const HOME_DB = path.join(process.env.HOME || '/tmp', '.token-proxy', 'usage.db');
const RESOLVED_DB = fs.existsSync(DB_PATH) ? DB_PATH : HOME_DB;

const ASK_URL = process.env.ASK_URL || 'http://127.0.0.1:4100/ask';
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '48');
const MIN_COST_THRESHOLD = parseFloat(process.env.MIN_COST || '1.00');

function getApiKey() {
  if (process.env.ANTHROPIC_AUTH_TOKEN) return process.env.ANTHROPIC_AUTH_TOKEN;
  if (process.env.LLM_PROXY_AUTH) return process.env.LLM_PROXY_AUTH;
  try {
    const settingsPath = path.join(process.env.HOME || '', '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (settings.env && settings.env.LLM_PROXY_AUTH) return settings.env.LLM_PROXY_AUTH;
    if (settings.env && settings.env.ANTHROPIC_AUTH_TOKEN) return settings.env.ANTHROPIC_AUTH_TOKEN;
  } catch {}
  return null;
}

function openDb() {
  const db = new DatabaseSync(RESOLVED_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA query_only = true');
  return db;
}

function openWriteDb() {
  const db = new DatabaseSync(RESOLVED_DB);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_investigations (
      id TEXT PRIMARY KEY, severity TEXT NOT NULL, type TEXT NOT NULL,
      summary TEXT NOT NULL, pattern TEXT NOT NULL, recommendation TEXT NOT NULL,
      daily_cost_estimate REAL DEFAULT 0, first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL, sample_ids TEXT, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);
  return db;
}

function fingerprint(type, consumer, model) {
  return 'inv-' + crypto.createHash('sha256')
    .update(`${type}:${consumer}:${model}`).digest('hex').slice(0, 12);
}

// ---------------------------------------------------------------------------
// Phase 1: SQL anomaly detection
// ---------------------------------------------------------------------------

function detectUnattributedSpend(db) {
  const rows = db.prepare(`
    SELECT consumer, model, upstream,
           COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS total_cost,
           AVG(input_tokens) AS avg_input,
           AVG(output_tokens) AS avg_output,
           MIN(timestamp) AS first_seen,
           MAX(timestamp) AS last_seen,
           GROUP_CONCAT(id) AS sample_ids
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LOOKBACK_HOURS} hours')
      AND (project IS NULL OR project = '')
      AND http_status BETWEEN 200 AND 299
    GROUP BY consumer, model
    HAVING total_cost > ${MIN_COST_THRESHOLD}
    ORDER BY total_cost DESC
  `).all();

  return rows.map(r => ({
    type: 'unattributed_spend',
    consumer: r.consumer,
    model: r.model,
    upstream: r.upstream,
    calls: r.calls,
    total_cost: r.total_cost,
    avg_input: Math.round(r.avg_input),
    avg_output: Math.round(r.avg_output),
    daily_cost: r.total_cost / (LOOKBACK_HOURS / 24),
    first_seen: r.first_seen,
    last_seen: r.last_seen,
    sample_ids: (r.sample_ids || '').split(',').slice(0, 5),
  }));
}

function detectRecurringPatterns(db) {
  const rows = db.prepare(`
    SELECT consumer, model,
           CAST(strftime('%M', timestamp) AS INTEGER) AS minute_mark,
           COUNT(*) AS occurrences,
           SUM(estimated_cost_usd) AS total_cost,
           AVG(input_tokens) AS avg_input,
           AVG(cache_read_tokens) AS avg_cache_read,
           COUNT(DISTINCT session_id) AS distinct_sessions
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LOOKBACK_HOURS} hours')
      AND http_status BETWEEN 200 AND 299
      AND estimated_cost_usd > 0.05
    GROUP BY consumer, model, minute_mark
    HAVING occurrences >= 3
    ORDER BY total_cost DESC
  `).all();

  const grouped = {};
  for (const r of rows) {
    const key = `${r.consumer}:${r.model}`;
    if (!grouped[key]) grouped[key] = { minutes: [], total_cost: 0, total_occ: 0, consumer: r.consumer, model: r.model, avg_input: 0, avg_cache_read: 0, distinct_sessions: 0 };
    grouped[key].minutes.push({ minute: r.minute_mark, occurrences: r.occurrences });
    grouped[key].total_cost += r.total_cost;
    grouped[key].total_occ += r.occurrences;
    grouped[key].avg_input = Math.round(r.avg_input);
    grouped[key].avg_cache_read = Math.round(r.avg_cache_read || 0);
    grouped[key].distinct_sessions = Math.max(grouped[key].distinct_sessions, r.distinct_sessions || 0);
  }

  return Object.values(grouped)
    .filter(g => {
      if (g.total_cost <= MIN_COST_THRESHOLD) return false;
      // Interactive sessions are not cron jobs: claude-code with high cache_read
      // is a normal conversation (RDsec strips cache from input_tokens, making
      // them appear as 1-3 tokens). Real heartbeats have near-zero cache_read.
      if (g.consumer === 'claude-code' && g.avg_cache_read > 10000) return false;
      // Many distinct sessions = interactive use across projects, not a single cron
      if (g.distinct_sessions > 3) return false;
      return true;
    })
    .map(g => ({
      type: 'recurring_pattern',
      consumer: g.consumer,
      model: g.model,
      schedule_minutes: g.minutes.sort((a, b) => b.occurrences - a.occurrences).slice(0, 3),
      total_occurrences: g.total_occ,
      total_cost: g.total_cost,
      daily_cost: g.total_cost / (LOOKBACK_HOURS / 24),
      avg_input: g.avg_input,
      avg_cache_read: g.avg_cache_read,
      distinct_sessions: g.distinct_sessions,
    }));
}

function detectContextGrowth(db) {
  // Use input_tokens + cache_read_tokens as effective input size.
  // RDsec strips cache from prompt_tokens, so input_tokens alone is 1-3
  // for calls with 100K+ actual context via cache_read.
  const rows = db.prepare(`
    SELECT consumer, model, session_id,
           (input_tokens + cache_read_tokens) AS effective_input,
           input_tokens, cache_read_tokens,
           timestamp, id, estimated_cost_usd
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LOOKBACK_HOURS} hours')
      AND http_status BETWEEN 200 AND 299
      AND estimated_cost_usd > 0.05
    ORDER BY consumer, model, session_id, timestamp ASC
  `).all();

  // Group by consumer:model:session — context grows within a session, not across
  const groups = {};
  for (const r of rows) {
    const sessionKey = r.session_id || 'no-session';
    const key = `${r.consumer}:${r.model}:${sessionKey}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(r);
  }

  const findings = [];
  for (const [key, calls] of Object.entries(groups)) {
    if (calls.length < 4) continue;
    let increasing = 0;
    for (let i = 1; i < calls.length; i++) {
      if (calls[i].effective_input > calls[i - 1].effective_input) increasing++;
    }
    const growthRatio = increasing / (calls.length - 1);
    if (growthRatio < 0.7) continue;

    const first = calls[0];
    const last = calls[calls.length - 1];
    const tokenGrowth = last.effective_input - first.effective_input;
    const hoursSpan = (new Date(last.timestamp) - new Date(first.timestamp)) / 3600000;
    if (hoursSpan < 1 || tokenGrowth < 1000) continue;

    // Normal Claude Code sessions grow context — that's expected behavior.
    // Only flag if growth is from a non-interactive consumer (e.g. openclaw agent)
    // or if the session has no session_id (automated process).
    if (first.consumer === 'claude-code' && first.session_id) continue;

    const totalCost = calls.reduce((s, c) => s + c.estimated_cost_usd, 0);
    findings.push({
      type: 'context_growth',
      consumer: first.consumer,
      model: first.model,
      calls: calls.length,
      first_input_tokens: first.effective_input,
      last_input_tokens: last.effective_input,
      token_growth_total: tokenGrowth,
      token_growth_per_hour: Math.round(tokenGrowth / hoursSpan),
      growth_ratio: parseFloat(growthRatio.toFixed(2)),
      total_cost: totalCost,
      daily_cost: totalCost / (hoursSpan / 24),
      first_seen: first.timestamp,
      last_seen: last.timestamp,
      sample_ids: [first.id, last.id].map(String),
    });
  }
  return findings.sort((a, b) => b.daily_cost - a.daily_cost);
}

function detectCostOutliers(db) {
  const medians = db.prepare(`
    SELECT model, AVG(estimated_cost_usd) AS median_cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LOOKBACK_HOURS} hours')
      AND http_status BETWEEN 200 AND 299
      AND estimated_cost_usd > 0
    GROUP BY model
  `).all();

  const medianMap = {};
  for (const m of medians) medianMap[m.model] = m.median_cost;

  const outliers = db.prepare(`
    SELECT id, consumer, model, project, input_tokens, output_tokens,
           estimated_cost_usd, timestamp, session_id
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-${LOOKBACK_HOURS} hours')
      AND http_status BETWEEN 200 AND 299
      AND estimated_cost_usd > 0.50
    ORDER BY estimated_cost_usd DESC
    LIMIT 20
  `).all();

  return outliers
    .filter(o => medianMap[o.model] && o.estimated_cost_usd > medianMap[o.model] * 5)
    .map(o => ({
      type: 'cost_outlier',
      id: o.id,
      consumer: o.consumer,
      model: o.model,
      project: o.project,
      cost: o.estimated_cost_usd,
      median_for_model: parseFloat(medianMap[o.model].toFixed(4)),
      multiplier: parseFloat((o.estimated_cost_usd / medianMap[o.model]).toFixed(1)),
      input_tokens: o.input_tokens,
      output_tokens: o.output_tokens,
      timestamp: o.timestamp,
    }));
}

// ---------------------------------------------------------------------------
// Phase 2: Haiku investigation via /ask
// ---------------------------------------------------------------------------

function buildPrompt(anomalies) {
  const sections = anomalies.map((a, i) => {
    switch (a.type) {
      case 'unattributed_spend':
        return `${i + 1}. UNATTRIBUTED: consumer="${a.consumer}" model="${a.model}" upstream="${a.upstream}" — ${a.calls} calls, $${a.total_cost.toFixed(2)} total ($${a.daily_cost.toFixed(2)}/day), avg ${a.avg_input} input tokens, ${a.avg_output} output tokens`;
      case 'recurring_pattern':
        return `${i + 1}. RECURRING: consumer="${a.consumer}" model="${a.model}" — fires at minute marks [${a.schedule_minutes.map(m => `:${String(m.minute).padStart(2, '0')} (${m.occurrences}x)`).join(', ')}], $${a.daily_cost.toFixed(2)}/day, avg ${a.avg_input} input tokens, avg ${a.avg_cache_read || 0} cache_read tokens, ${a.distinct_sessions || '?'} distinct sessions`;
      case 'context_growth':
        return `${i + 1}. CONTEXT GROWTH: consumer="${a.consumer}" model="${a.model}" — input tokens grew from ${a.first_input_tokens} to ${a.last_input_tokens} (+${a.token_growth_per_hour}/hr), ${a.calls} calls, $${a.daily_cost.toFixed(2)}/day`;
      case 'cost_outlier':
        return `${i + 1}. OUTLIER: consumer="${a.consumer}" model="${a.model}" project="${a.project || 'none'}" — $${a.cost.toFixed(2)} (${a.multiplier}x median), ${a.input_tokens} input tokens`;
      default:
        return `${i + 1}. ${a.type}: ${JSON.stringify(a)}`;
    }
  });

  return `You are a cost analyst for an LLM API proxy. Analyze these anomalies detected in the last ${LOOKBACK_HOURS}h of usage data and provide investigation results.

ANOMALIES:
${sections.join('\n')}

For EACH anomaly, respond in this exact JSON format:
[
  {
    "index": 1,
    "severity": "high|medium|low",
    "root_cause": "one sentence: what process/config is causing this cost",
    "can_fix": true,
    "fix_action": "exact command or config change to stop this cost. Example: 'systemctl --user stop openclaw-gateway' or 'edit ~/.openclaw/openclaw.json: set models.providers.trendmicro-aiendpoint.models[haiku].active=false'. If you can't determine the exact fix, say what to investigate first.",
    "monthly_savings": 0.00
  }
]

RULES:
- Every recommendation MUST include a concrete fix_action the user can execute — a command, a config edit with file path and key, or a service to stop/disable.
- can_fix=true means you know exactly what to change. can_fix=false means investigation needed first.
- monthly_savings = daily_cost * 30.
- Do NOT give vague advice like "audit logs" or "investigate routing." Give the specific systemd unit, config file, or process to change.
- For unattributed calls: identify the likely source process based on the consumer/user-agent/timing pattern and suggest adding X-Project header or stopping the process.
- For context growth: identify what process accumulates context and suggest how to cap or reset it.

CRITICAL — avoid false positives:
- consumer="claude-code" with high cache_read_tokens (>10K) is a NORMAL interactive session, NOT a cron job or heartbeat. Do not recommend crontab -l or systemctl disable for these.
- input_tokens can be 1-3 even for large requests when the upstream (RDsec/LiteLLM) strips cache tokens from prompt_tokens. Check cache_read_tokens for the real input size.
- Multiple distinct sessions indicate interactive use across projects, not a single automated process.
- NEVER recommend disabling systemd services or cron jobs without confirming they are the actual source. consumer="claude-code" calls come from Claude Code IDE sessions, not from cron.`;
}

function callAsk(tier, system, prompt, maxTokens) {
  return new Promise((resolve, reject) => {
    const apiKey = getApiKey();
    if (!apiKey) return reject(new Error('No API key found'));

    const endpoint = tier === 'L1' ? '/ask' : '/ask/l2';
    const body = JSON.stringify({ system, prompt, caller: 'cost-investigator', maxTokens: maxTokens || 4096, jsonMode: true });
    const url = new URL(ASK_URL);

    const req = http.request({
      hostname: url.hostname, port: url.port,
      path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-api-key': apiKey },
      timeout: tier === 'L1' ? 60000 : 90000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.ok && parsed.parsed) {
            resolve(Array.isArray(parsed.parsed) ? parsed.parsed : [parsed.parsed]);
          } else if (parsed.ok && parsed.content) {
            let cleaned = parsed.content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
            const match = cleaned.match(/\[[\s\S]*\]/);
            if (match) resolve(JSON.parse(match[0]));
            else { console.error(`[cost-investigator] ${tier} parse fail:`, parsed.content.slice(0, 200)); resolve([]); }
          } else {
            reject(new Error(`${endpoint} failed: ${data.slice(0, 200)}`));
          }
        } catch (e) { reject(new Error(`Parse error: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function askHaiku(prompt) {
  return callAsk('L1', 'You are a concise cost analyst. Respond only with the requested JSON array.', prompt, 4096);
}

function readConfigFile(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').slice(0, 3000); } catch { return null; }
}

async function askSonnetForFixes(findings, haikuResults) {
  const fixable = [];
  for (let i = 0; i < findings.length; i++) {
    const h = haikuResults.find(r => r.index === i + 1);
    if (!h || h.can_fix === false) continue;
    fixable.push({ index: i + 1, finding: findings[i], haiku: h });
  }
  if (fixable.length === 0) return [];

  const configFiles = {
    openclaw: readConfigFile(path.join(process.env.HOME || '', '.openclaw', 'openclaw.json')),
    systemdTimers: (() => { try { return require('child_process').execSync('systemctl --user list-timers --no-pager 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).slice(0, 2000); } catch { return null; } })(),
    crontab: (() => { try { return require('child_process').execSync('crontab -l 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).slice(0, 1000); } catch { return null; } })(),
  };

  const contextParts = [];
  if (configFiles.openclaw) contextParts.push('~/.openclaw/openclaw.json:\n' + configFiles.openclaw);
  if (configFiles.systemdTimers) contextParts.push('systemctl --user list-timers:\n' + configFiles.systemdTimers);
  if (configFiles.crontab) contextParts.push('crontab -l:\n' + configFiles.crontab);

  const findingSummaries = fixable.map(f =>
    `${f.index}. ${f.finding.type}: consumer="${f.finding.consumer}" model="${f.finding.model}" — $${(f.finding.daily_cost || f.finding.cost || 0).toFixed(2)}/day. Haiku says: "${f.haiku.root_cause}"`
  ).join('\n');

  const prompt = `You are a systems engineer. Given these cost anomalies and the ACTUAL config files from the system, write the EXACT fix for each.

ANOMALIES TO FIX:
${findingSummaries}

SYSTEM CONFIG:
${contextParts.join('\n\n')}

For each anomaly, respond with JSON:
[{"index":1, "fix_command":"exact shell command OR config edit (file path + what to change)", "explanation":"one sentence why this fixes it", "risk":"none|low|medium — what could break"}]

Be EXACT. Use real paths, real config keys, real service names from the config above. No guessing.`;

  console.log(`[cost-investigator] Sending ${fixable.length} findings to Sonnet L2 for resolution...`);
  return callAsk('L2', 'You are a precise systems engineer. Respond only with the requested JSON array.', prompt, 4096);
}

// ---------------------------------------------------------------------------
// Phase 3: Persist findings
// ---------------------------------------------------------------------------

function persistFindings(anomalies, haikuResults) {
  const wdb = openWriteDb();
  const upsert = wdb.prepare(`
    INSERT INTO cost_investigations (id, severity, type, summary, pattern, recommendation, daily_cost_estimate, first_seen, last_seen, sample_ids, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ON CONFLICT(id) DO UPDATE SET
      severity = excluded.severity,
      summary = excluded.summary,
      pattern = excluded.pattern,
      recommendation = excluded.recommendation,
      daily_cost_estimate = excluded.daily_cost_estimate,
      last_seen = excluded.last_seen,
      sample_ids = excluded.sample_ids,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `);

  const results = [];
  for (let i = 0; i < anomalies.length; i++) {
    const a = anomalies[i];
    const h = haikuResults.find(r => r.index === i + 1) || {};
    const id = fingerprint(a.type, a.consumer || '', a.model || '');
    const severity = h.severity || (a.daily_cost > 5 ? 'high' : a.daily_cost > 1 ? 'medium' : 'low');
    const summary = buildSummaryLine(a);
    const recommendation = h.fix_action || h.recommendation || 'Haiku analysis failed — re-run cost-investigator.';
    const firstSeen = a.first_seen || a.timestamp || new Date().toISOString();
    const lastSeen = a.last_seen || a.timestamp || new Date().toISOString();
    const sampleIds = JSON.stringify(a.sample_ids || [a.id].filter(Boolean));

    const pattern = JSON.stringify({
      ...a,
      haiku_root_cause: h.root_cause || null,
      haiku_can_fix: h.can_fix != null ? h.can_fix : null,
      haiku_fix_action: h.fix_action || null,
      haiku_monthly_savings: h.monthly_savings || null,
    });

    upsert.run(id, severity, a.type, summary, pattern, recommendation,
      a.daily_cost || a.cost || 0, firstSeen, lastSeen, sampleIds);

    results.push({ id, severity, type: a.type, summary, recommendation, daily_cost: a.daily_cost || a.cost || 0 });
  }

  wdb.close();
  return results;
}

function buildSummaryLine(a) {
  switch (a.type) {
    case 'unattributed_spend':
      return `${a.calls} unattributed ${a.model} calls from "${a.consumer}" — $${a.daily_cost.toFixed(2)}/day`;
    case 'recurring_pattern':
      return `Recurring ${a.model} calls from "${a.consumer}" at :${String(a.schedule_minutes[0]?.minute).padStart(2, '0')} — $${a.daily_cost.toFixed(2)}/day`;
    case 'context_growth':
      return `${a.model} context growing +${a.token_growth_per_hour} tokens/hr from "${a.consumer}" — $${a.daily_cost.toFixed(2)}/day`;
    case 'cost_outlier':
      return `$${a.cost.toFixed(2)} ${a.model} call (${a.multiplier}x median) from "${a.consumer}"`;
    default:
      return `${a.type}: ${a.consumer} ${a.model}`;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  console.log(`[cost-investigator] DB: ${RESOLVED_DB}`);
  console.log(`[cost-investigator] Lookback: ${LOOKBACK_HOURS}h, min cost: $${MIN_COST_THRESHOLD}`);

  if (!fs.existsSync(RESOLVED_DB)) {
    console.error('[cost-investigator] usage.db not found');
    process.exit(2);
  }

  const db = openDb();

  const anomalies = [
    ...detectUnattributedSpend(db),
    ...detectRecurringPatterns(db),
    ...detectContextGrowth(db),
    ...detectCostOutliers(db),
  ];

  db.close();

  // Deduplicate by (type, consumer, model)
  const seen = new Set();
  const unique = anomalies.filter(a => {
    const key = `${a.type}:${a.consumer}:${a.model}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.log(`[cost-investigator] Detected ${unique.length} anomalies`);

  if (unique.length === 0) {
    console.log(JSON.stringify({ status: 'clean', anomalies: 0 }));
    process.exit(0);
  }

  // Phase 2a: Haiku L1 — identify root causes
  let haikuResults = [];
  try {
    const prompt = buildPrompt(unique);
    console.log(`[cost-investigator] L1 (Haiku): sending ${unique.length} anomalies for identification...`);
    haikuResults = await askHaiku(prompt);
    console.log(`[cost-investigator] L1 returned ${haikuResults.length} results`);
  } catch (err) {
    console.error(`[cost-investigator] L1 failed: ${err.message}`);
  }

  // Phase 2b: Sonnet L2 — resolve with real config context
  let sonnetFixes = [];
  try {
    sonnetFixes = await askSonnetForFixes(unique, haikuResults);
    console.log(`[cost-investigator] L2 (Sonnet) returned ${sonnetFixes.length} fixes`);
    for (const fix of sonnetFixes) {
      const h = haikuResults.find(r => r.index === fix.index);
      if (h && fix.fix_command) {
        h.fix_action = fix.fix_command;
        h.can_fix = true;
        if (fix.risk) h.risk = fix.risk;
        if (fix.explanation) h.root_cause = (h.root_cause || '') + ' → ' + fix.explanation;
      }
    }
  } catch (err) {
    console.error(`[cost-investigator] L2 failed (using L1 results): ${err.message}`);
  }

  const persisted = persistFindings(unique, haikuResults);

  const output = {
    status: 'findings',
    count: persisted.length,
    total_daily_waste: parseFloat(persisted.reduce((s, f) => s + f.daily_cost, 0).toFixed(2)),
    findings: persisted,
  };

  console.log(JSON.stringify(output, null, 2));
  process.exit(persisted.some(f => f.severity === 'high') ? 1 : 0);
}

run().catch(err => {
  console.error('[cost-investigator] Fatal:', err);
  process.exit(2);
});
