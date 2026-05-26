'use strict';

const fs = require('fs');
const path = require('path');

let S3Client, GetObjectCommand, PutObjectCommand;
try {
  ({ S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3'));
} catch {}

let openDatabase;
const USE_BUILTIN = process.argv.includes('--local') || process.env.USE_BUILTIN_SQLITE;
if (!USE_BUILTIN) {
  try {
    const BetterSqlite = require('better-sqlite3');
    openDatabase = (p) => new BetterSqlite(p, { readonly: true });
  } catch {}
}
if (!openDatabase) {
  const { DatabaseSync } = require('node:sqlite');
  openDatabase = (p) => {
    const db = new DatabaseSync(p);
    db.pragma = (stmt) => db.exec(`PRAGMA ${stmt}`);
    return db;
  };
}

const BUCKET = process.env.BUCKET || 'tokentracker-data';
const REGION = process.env.AWS_REGION || 'us-east-1';
const LOCAL_MODE = process.argv.includes('--local');
const LOCAL_DB = process.env.USAGE_DB
  || path.resolve(__dirname, '..', 'usage.db')
  || path.join(process.env.HOME || '/tmp', '.token-proxy', 'usage.db');
const LOCAL_OUT = path.resolve(__dirname, '..', 'dashboard', 'data');

const s3 = (LOCAL_MODE || !S3Client) ? null : new S3Client({ region: REGION });

const RANGES = {
  '24h': '-24 hours',
  '7d': '-7 days',
  '30d': '-30 days',
  '90d': '-90 days',
};

async function downloadDb() {
  if (LOCAL_MODE) {
    const src = fs.existsSync(LOCAL_DB) ? LOCAL_DB
      : fs.existsSync(path.join(process.env.HOME || '', '.token-proxy', 'usage.db'))
        ? path.join(process.env.HOME, '.token-proxy', 'usage.db') : null;
    if (!src) throw new Error('No local usage.db found');
    const dest = '/tmp/usage.db';
    fs.copyFileSync(src, dest);
    return dest;
  }
  const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'usage.db' }));
  const dest = '/tmp/usage.db';
  const body = await resp.Body.transformToByteArray();
  fs.writeFileSync(dest, body);
  return dest;
}

async function uploadJson(key, data) {
  const json = JSON.stringify(data);
  if (LOCAL_MODE) {
    fs.mkdirSync(LOCAL_OUT, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_OUT, key), json);
    return;
  }
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `data/${key}`,
    Body: json,
    ContentType: 'application/json',
    CacheControl: 'public, max-age=3600',
  }));
}

function query(db, sql) {
  try { return db.prepare(sql).all(); } catch { return []; }
}

function generateHourlyBreakdown(db, interval, range) {
  const useDaily = ['7d', '30d', '90d'].includes(range);
  const bucketFmt = useDaily ? '%Y-%m-%d' : '%Y-%m-%dT%H';

  const projectRows = query(db, `
    SELECT strftime('${bucketFmt}', timestamp) AS bucket,
           COALESCE(project, '(untagged)') AS project,
           SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY bucket, project ORDER BY bucket, cost DESC
  `);
  const modelRows = query(db, `
    SELECT strftime('${bucketFmt}', timestamp) AS bucket,
           model, SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
    GROUP BY bucket, model ORDER BY bucket, cost DESC
  `);
  const bucketMap = {};
  for (const r of projectRows) {
    if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { hour: r.bucket, total_cost: 0, total_calls: 0, projects: [], models: [] };
    bucketMap[r.bucket].total_cost += r.cost || 0;
    bucketMap[r.bucket].total_calls += r.calls || 0;
    bucketMap[r.bucket].projects.push({ project: r.project, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
  }
  for (const r of modelRows) {
    if (!bucketMap[r.bucket]) bucketMap[r.bucket] = { hour: r.bucket, total_cost: 0, total_calls: 0, projects: [], models: [] };
    bucketMap[r.bucket].models.push({ model: r.model, cost: parseFloat((r.cost || 0).toFixed(4)), calls: r.calls });
  }

  // Fill all time slots including zeros
  const now = new Date();
  const allSlots = [];
  if (useDaily) {
    const days = range === '90d' ? 90 : range === '30d' ? 30 : 7;
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 86400000);
      allSlots.push(d.toISOString().slice(0, 10));
    }
  } else {
    const hours = 24;
    for (let i = hours - 1; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600000);
      allSlots.push(d.toISOString().slice(0, 13));
    }
  }

  const filled = allSlots.map(slot =>
    bucketMap[slot] || { hour: slot, total_cost: 0, total_calls: 0, projects: [], models: [] }
  );

  return { hours: filled, granularity: useDaily ? 'daily' : 'hourly' };
}

function generateCostBreakdown(db, interval) {
  const models = query(db, `
    SELECT model, COUNT(*) AS calls, SUM(estimated_cost_usd) AS cost,
           SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
           SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
           SUM(CASE WHEN cache_estimated = 1 THEN 1 ELSE 0 END) AS estimated_calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND http_status BETWEEN 200 AND 299
    GROUP BY model ORDER BY cost DESC
  `);
  const totals = models.reduce((acc, m) => {
    acc.cost += m.cost || 0; acc.calls += m.calls || 0;
    acc.cache_write += m.cache_write_tokens || 0; acc.cache_read += m.cache_read_tokens || 0;
    acc.estimated_calls += m.estimated_calls || 0;
    return acc;
  }, { cost: 0, calls: 0, cache_write: 0, cache_read: 0, estimated_calls: 0 });
  return { models, totals };
}

function generateProjectCosts(db, interval) {
  const projects = query(db, `
    SELECT COALESCE(project, '(untagged)') AS project, COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS cost, SUM(input_tokens) AS input_tokens,
           SUM(output_tokens) AS output_tokens
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND http_status BETWEEN 200 AND 299
    GROUP BY project ORDER BY cost DESC LIMIT 10
  `);
  return { projects, total_cost: parseFloat(projects.reduce((s, p) => s + (p.cost || 0), 0).toFixed(2)) };
}

function generateSavings(db, interval) {
  const sessionStarts = query(db, `
    SELECT COUNT(*) AS sessions, SUM(cache_write_tokens) AS total_cw
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND cache_write_tokens > 50000
  `);
  const ss = sessionStarts[0] || { sessions: 0, total_cw: 0 };
  const cwCost = (ss.total_cw || 0) * 18.75 / 1e6;
  return {
    session_restarts: { count: ss.sessions, cache_write_cost: parseFloat(cwCost.toFixed(2)) },
  };
}

function generateDailyComparison(db) {
  const today = query(db, `
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')
  `);
  const yesterday = query(db, `
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day')
      AND timestamp < strftime('%Y-%m-%dT00:00:00Z', 'now')
  `);
  const t = today[0] || {}; const y = yesterday[0] || {};
  return {
    today: { cost: parseFloat((t.cost || 0).toFixed(2)), calls: t.calls || 0 },
    yesterday: { cost: parseFloat((y.cost || 0).toFixed(2)), calls: y.calls || 0 },
  };
}

function generateSessions(db, interval) {
  const sessions = query(db, `
    SELECT session_id, COALESCE(project, '(untagged)') AS project, consumer,
           GROUP_CONCAT(DISTINCT model) AS models, COUNT(*) AS calls,
           SUM(estimated_cost_usd) AS cost,
           MIN(timestamp) AS first_call, MAX(timestamp) AS last_call,
           ROUND((julianday(MAX(timestamp)) - julianday(MIN(timestamp))) * 24 * 60, 1) AS duration_min
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${interval}')
      AND session_id IS NOT NULL AND http_status BETWEEN 200 AND 299
    GROUP BY session_id ORDER BY cost DESC LIMIT 20
  `);
  return {
    sessions: sessions.map(s => ({ ...s, cost: parseFloat((s.cost || 0).toFixed(4)), models: s.models ? s.models.split(',') : [] })),
    total_cost: parseFloat(sessions.reduce((s, r) => s + (r.cost || 0), 0).toFixed(2)),
    session_count: sessions.length,
  };
}

function generateDbStats(db) {
  const row = query(db, `
    SELECT COUNT(*) AS rows, MIN(timestamp) AS oldest, MAX(timestamp) AS newest,
           COUNT(DISTINCT model) AS models, COUNT(DISTINCT project) AS projects,
           COUNT(DISTINCT session_id) AS sessions, SUM(estimated_cost_usd) AS total_cost
    FROM usage_log
  `)[0] || {};
  return {
    rows: row.rows || 0, oldest: row.oldest, newest: row.newest,
    models: row.models || 0, projects: row.projects || 0,
    sessions: row.sessions || 0, total_cost: parseFloat((row.total_cost || 0).toFixed(2)),
  };
}

function generateInvestigations(db) {
  const investigations = query(db, `
    SELECT id, severity, type, summary, pattern, recommendation,
           daily_cost_estimate, first_seen, last_seen, sample_ids, status
    FROM cost_investigations WHERE status = 'active'
    ORDER BY daily_cost_estimate DESC
  `);
  return {
    investigations: investigations.map(inv => {
      let pat = inv.pattern; try { pat = JSON.parse(inv.pattern); } catch {}
      let sids = []; try { sids = JSON.parse(inv.sample_ids); } catch {}
      return { ...inv, pattern: pat, sample_ids: sids };
    }),
    count: investigations.length,
    total_daily_waste: parseFloat(investigations.reduce((s, i) => s + (i.daily_cost_estimate || 0), 0).toFixed(2)),
  };
}

function generateJudgeStats(db) {
  const gates = query(db, `
    SELECT gate, COUNT(*) AS total,
           SUM(CASE WHEN decision = 'allow' THEN 1 ELSE 0 END) AS allowed,
           SUM(CASE WHEN decision = 'block' THEN 1 ELSE 0 END) AS blocked,
           ROUND(AVG(latency_ms)) AS avg_latency_ms
    FROM judge_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY gate ORDER BY total DESC
  `);
  const recent = query(db, `
    SELECT gate, decision, reason, timestamp
    FROM judge_log ORDER BY id DESC LIMIT 10
  `);
  return { by_gate: gates, recent };
}

exports.handler = async function() {
  console.log('Downloading usage.db...');
  const dbPath = await downloadDb();
  const db = openDatabase(dbPath);
  db.pragma('journal_mode = WAL');

  console.log('Generating data...');
  const uploads = [];

  for (const [range, interval] of Object.entries(RANGES)) {
    uploads.push(uploadJson(`hourly-breakdown-${range}.json`, generateHourlyBreakdown(db, interval, range)));
    uploads.push(uploadJson(`cost-breakdown-${range}.json`, generateCostBreakdown(db, interval)));
    uploads.push(uploadJson(`project-costs-${range}.json`, generateProjectCosts(db, interval)));
    uploads.push(uploadJson(`savings-potential-${range}.json`, generateSavings(db, interval)));
    uploads.push(uploadJson(`sessions-${range}.json`, generateSessions(db, interval)));
  }

  uploads.push(uploadJson('daily-comparison.json', generateDailyComparison(db)));
  uploads.push(uploadJson('db-stats.json', generateDbStats(db)));
  uploads.push(uploadJson('investigations.json', generateInvestigations(db)));
  uploads.push(uploadJson('judge-stats.json', generateJudgeStats(db)));
  uploads.push(uploadJson('meta.json', { generated_at: new Date().toISOString(), ranges: Object.keys(RANGES) }));

  await Promise.all(uploads);
  db.close();

  const fileCount = 4 + Object.keys(RANGES).length * 5;
  console.log(`Done. Uploaded ${fileCount} files.`);
  return { statusCode: 200, body: `Generated ${fileCount} data files` };
};

if (require.main === module) {
  exports.handler().then(r => console.log(r.body)).catch(e => { console.error(e); process.exit(1); });
}
