'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

let db;

function init(config) {
  const dbPath = config.path || './usage.db';
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new DatabaseSync(resolvedPath);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -4096');

  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      consumer              TEXT    NOT NULL DEFAULT 'unknown',
      model                 TEXT    NOT NULL DEFAULT 'unknown',
      upstream              TEXT             DEFAULT 'unknown',
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd    REAL    NOT NULL DEFAULT 0,
      duration_ms           INTEGER NOT NULL DEFAULT 0,
      http_status           INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log (timestamp);
    CREATE INDEX IF NOT EXISTS idx_usage_consumer  ON usage_log (consumer);
    CREATE INDEX IF NOT EXISTS idx_usage_model     ON usage_log (model);

    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
    INSERT OR IGNORE INTO schema_version (version) VALUES (1);
  `);

  const cols = db.prepare('PRAGMA table_info(usage_log)').all();
  const colNames = new Set(cols.map(c => c.name));

  if (!colNames.has('upstream')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN upstream TEXT DEFAULT 'unknown'`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (2)`);
  }
  if (!colNames.has('project'))    db.exec(`ALTER TABLE usage_log ADD COLUMN project    TEXT`);
  if (!colNames.has('task'))       db.exec(`ALTER TABLE usage_log ADD COLUMN task       TEXT`);
  if (!colNames.has('user_agent')) db.exec(`ALTER TABLE usage_log ADD COLUMN user_agent TEXT`);
  if (!colNames.has('project') || !colNames.has('task') || !colNames.has('user_agent')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_log (project)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_task    ON usage_log (task)`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (3)`);
  }
  if (!colNames.has('session_id')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN session_id TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_log (session_id)`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (4)`);
  }
  if (!colNames.has('original_model')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN original_model TEXT`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (5)`);
  }
  if (!colNames.has('cache_estimated')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN cache_estimated INTEGER NOT NULL DEFAULT 0`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (6)`);
  }
  if (!colNames.has('caller_cwd'))     db.exec(`ALTER TABLE usage_log ADD COLUMN caller_cwd TEXT`);
  if (!colNames.has('prompt_preview')) db.exec(`ALTER TABLE usage_log ADD COLUMN prompt_preview TEXT`);
  if (!colNames.has('effort_level')) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN effort_level TEXT`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (7)`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS cost_investigations (
      id                  TEXT PRIMARY KEY,
      severity            TEXT NOT NULL,
      type                TEXT NOT NULL,
      summary             TEXT NOT NULL,
      pattern             TEXT NOT NULL,
      recommendation      TEXT NOT NULL,
      daily_cost_estimate REAL DEFAULT 0,
      first_seen          TEXT NOT NULL,
      last_seen           TEXT NOT NULL,
      sample_ids          TEXT,
      status              TEXT DEFAULT 'active',
      created_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at          TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )
  `);

  return db;
}

function _periodClause(period) {
  switch (period) {
    case 'today': return `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;
    case '7d':    return `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`;
    case '30d':   return `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`;
    default:      return '1=1';
  }
}

function logUsage(record) {
  if (!db) throw new Error('Database not initialized — call init() first');

  const stmt = db.prepare(`
    INSERT INTO usage_log
      (consumer, model, upstream, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, estimated_cost_usd, duration_ms, http_status,
       project, task, user_agent, session_id, original_model, cache_estimated,
       caller_cwd, prompt_preview, effort_level)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    record.consumer            || 'unknown',
    record.model               || 'unknown',
    record.upstream            || 'unknown',
    record.input_tokens        || 0,
    record.output_tokens       || 0,
    record.cache_read_tokens   || 0,
    record.cache_write_tokens  || 0,
    record.estimated_cost_usd  || 0,
    record.duration_ms         || 0,
    record.http_status         || 0,
    record.project             || null,
    record.task                || null,
    record.user_agent          || null,
    record.session_id          || null,
    record.original_model      || null,
    record.cache_estimated     ? 1 : 0,
    record.caller_cwd          || null,
    record.prompt_preview      || null,
    record.effort_level        || null,
  );
}

function getUsage(filters = {}) {
  if (!db) throw new Error('Database not initialized — call init() first');

  const { period = 'today', group = 'none', consumer, limit = 50 } = filters;
  const periodClause = _periodClause(period);

  if (group === 'consumer' || group === 'model' || group === 'project' || group === 'task') {
    const col = group === 'project' || group === 'task' ? `COALESCE(${group}, '(unset)')` : group;
    const alias = group;
    const sql = `
      SELECT
        ${col} AS ${alias},
        SUM(input_tokens)       AS total_input_tokens,
        SUM(output_tokens)      AS total_output_tokens,
        SUM(cache_read_tokens)  AS total_cache_read_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(estimated_cost_usd) AS total_cost_usd,
        COUNT(*)                AS request_count
      FROM usage_log
      WHERE ${periodClause} ${consumer ? `AND consumer = ?` : ''}
      GROUP BY ${group === 'project' || group === 'task' ? col : group}
      ORDER BY total_cost_usd DESC
    `;
    return consumer ? db.prepare(sql).all(consumer) : db.prepare(sql).all();
  }

  const sql = `
    SELECT *
    FROM usage_log
    WHERE ${periodClause} ${consumer ? `AND consumer = ?` : ''}
    ORDER BY id DESC
    LIMIT ?
  `;
  return consumer
    ? db.prepare(sql).all(consumer, limit)
    : db.prepare(sql).all(limit);
}

function getTotals(period = 'today') {
  if (!db) throw new Error('Database not initialized — call init() first');

  return db.prepare(`
    SELECT
      SUM(input_tokens)       AS total_input_tokens,
      SUM(output_tokens)      AS total_output_tokens,
      SUM(cache_read_tokens)  AS total_cache_read_tokens,
      SUM(cache_write_tokens) AS total_cache_write_tokens,
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)                AS request_count
    FROM usage_log
    WHERE ${_periodClause(period)}
  `).get();
}

function getBudgetStatus(monthlyLimit = 100) {
  if (!db) throw new Error('Database not initialized — call init() first');

  const row = db.prepare(`
    SELECT
      SUM(estimated_cost_usd) AS month_spend,
      COUNT(*)                AS request_count
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-01T00:00:00Z', 'now')
  `).get();

  const spent    = row?.month_spend    || 0;
  const requests = row?.request_count  || 0;
  const pct      = monthlyLimit > 0 ? (spent / monthlyLimit) * 100 : 0;

  return {
    period:        'current_month',
    spent_usd:     parseFloat(spent.toFixed(6)),
    limit_usd:     monthlyLimit,
    remaining_usd: parseFloat(Math.max(0, monthlyLimit - spent).toFixed(6)),
    percent_used:  parseFloat(pct.toFixed(2)),
    request_count: requests,
    over_budget:   spent > monthlyLimit,
  };
}

function getHourlyCosts(period = 'today') {
  if (!db) throw new Error('Database not initialized');
  const periodClause = period === '7d'
    ? `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`
    : `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;

  const sql = period === '7d'
    ? `SELECT date(timestamp) || ' ' || strftime('%H', timestamp) || ':00' AS bucket,
            SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
       FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`
    : `SELECT strftime('%H', timestamp) || ':00' AS bucket,
            SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
       FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`;

  return db.prepare(sql).all();
}

function getHourlyBreakdown() {
  if (!db) throw new Error('Database not initialized');
  const where = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')`;

  const projectRows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H', timestamp) AS hour,
      COALESCE(project, '(untagged)') AS project,
      SUM(estimated_cost_usd) AS cost,
      COUNT(*) AS calls
    FROM usage_log WHERE ${where}
    GROUP BY hour, project ORDER BY hour, cost DESC
  `).all();

  const modelRows = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H', timestamp) AS hour,
      model,
      SUM(estimated_cost_usd) AS cost,
      COUNT(*) AS calls
    FROM usage_log WHERE ${where}
    GROUP BY hour, model ORDER BY hour, cost DESC
  `).all();

  return { projectRows, modelRows };
}

function getDailyComparison(offsetMin = 0) {
  if (!db) throw new Error('Database not initialized');
  const offsetSql = offsetMin >= 0 ? `+${offsetMin} minutes` : `${offsetMin} minutes`;

  const today = db.prepare(`
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '${offsetSql}')
  `).all();

  const yesterday = db.prepare(`
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*) AS calls
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now', '-1 day', '${offsetSql}')
      AND timestamp < strftime('%Y-%m-%dT00:00:00Z', 'now', '${offsetSql}')
  `).all();

  return { today: today[0], yesterday: yesterday[0] };
}

function getCostBreakdown() {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(`
    SELECT
      model,
      COUNT(*) AS calls,
      SUM(estimated_cost_usd) AS cost,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY model ORDER BY cost DESC
  `).all();
}

function getSavingsPotential() {
  if (!db) throw new Error('Database not initialized');

  const costByType = db.prepare(`
    SELECT
      model, COUNT(*) AS calls,
      SUM(output_tokens) AS total_output,
      SUM(cache_write_tokens) AS total_cw,
      SUM(cache_read_tokens) AS total_cr,
      SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    GROUP BY model ORDER BY cost DESC
  `).all();

  const sessionStarts = db.prepare(`
    SELECT COUNT(*) AS sessions,
           SUM(cache_write_tokens) AS total_cw
    FROM usage_log
    WHERE timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
      AND cache_write_tokens > 50000
  `).all();

  return { costByType, sessionStarts: sessionStarts[0] };
}

function query(sql) {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).all();
}

function run(sql, ...params) {
  if (!db) throw new Error('Database not initialized');
  return db.prepare(sql).run(...params);
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = {
  type: 'sqlite',
  init,
  logUsage,
  getUsage,
  getTotals,
  getBudgetStatus,
  getHourlyCosts,
  getHourlyBreakdown,
  getDailyComparison,
  getCostBreakdown,
  getSavingsPotential,
  query,
  run,
  close,
};
