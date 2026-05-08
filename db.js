'use strict';

// Uses Node.js v22.5+ built-in SQLite (no native addon needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs   = require('fs');

let db;

/**
 * Initialize the SQLite database and ensure schema is up-to-date.
 * @param {string} dbPath - Path to the SQLite database file
 */
function init(dbPath) {
  const resolvedPath = path.resolve(dbPath);
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new DatabaseSync(resolvedPath);

  // Performance tuning
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA cache_size = -4096');   // 4MB cache

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

  // Migration: add 'upstream' column to existing databases (schema v2)
  const cols = db.prepare('PRAGMA table_info(usage_log)').all();
  const hasUpstream = cols.some(c => c.name === 'upstream');
  if (!hasUpstream) {
    db.exec(`ALTER TABLE usage_log ADD COLUMN upstream TEXT DEFAULT 'unknown'`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (2)`);
  }
  // Schema v3: project + task + user_agent for "biggest token eaters" rollups
  const colNames = new Set(cols.map(c => c.name));
  if (!colNames.has('project'))    db.exec(`ALTER TABLE usage_log ADD COLUMN project    TEXT`);
  if (!colNames.has('task'))       db.exec(`ALTER TABLE usage_log ADD COLUMN task       TEXT`);
  if (!colNames.has('user_agent')) db.exec(`ALTER TABLE usage_log ADD COLUMN user_agent TEXT`);
  if (!colNames.has('project') || !colNames.has('task') || !colNames.has('user_agent')) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_project ON usage_log (project)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_task    ON usage_log (task)`);
    db.exec(`INSERT OR REPLACE INTO schema_version (version) VALUES (3)`);
  }

  return db;
}

/**
 * Log a single API request/response usage record.
 */
function logUsage(record) {
  if (!db) throw new Error('Database not initialized — call init() first');

  const stmt = db.prepare(`
    INSERT INTO usage_log
      (consumer, model, upstream, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, estimated_cost_usd, duration_ms, http_status,
       project, task, user_agent)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
  );
}

/**
 * Get usage records with optional filters.
 * @param {Object} [filters]
 * @param {string} [filters.period]   - 'today' | '7d' | '30d' | 'all'
 * @param {string} [filters.group]    - 'consumer' | 'model' | 'none'
 * @param {string} [filters.consumer] - filter to specific consumer
 * @param {number} [filters.limit]    - max rows (for raw queries)
 * @returns {Array}
 */
function getUsage(filters = {}) {
  if (!db) throw new Error('Database not initialized — call init() first');

  const { period = 'today', group = 'none', consumer, limit = 50 } = filters;

  // Build WHERE clause for period
  let periodClause;
  switch (period) {
    case 'today':
      periodClause = `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;
      break;
    case '7d':
      periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`;
      break;
    case '30d':
      periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`;
      break;
    default:
      periodClause = '1=1';
  }

  if (group === 'consumer') {
    const sql = `
      SELECT
        consumer,
        SUM(input_tokens)       AS total_input_tokens,
        SUM(output_tokens)      AS total_output_tokens,
        SUM(cache_read_tokens)  AS total_cache_read_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(estimated_cost_usd) AS total_cost_usd,
        COUNT(*)                AS request_count
      FROM usage_log
      WHERE ${periodClause} ${consumer ? `AND consumer = ?` : ''}
      GROUP BY consumer
      ORDER BY total_cost_usd DESC
    `;
    return consumer
      ? db.prepare(sql).all(consumer)
      : db.prepare(sql).all();
  }

  if (group === 'model') {
    const sql = `
      SELECT
        model,
        SUM(input_tokens)       AS total_input_tokens,
        SUM(output_tokens)      AS total_output_tokens,
        SUM(cache_read_tokens)  AS total_cache_read_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(estimated_cost_usd) AS total_cost_usd,
        COUNT(*)                AS request_count
      FROM usage_log
      WHERE ${periodClause} ${consumer ? `AND consumer = ?` : ''}
      GROUP BY model
      ORDER BY total_cost_usd DESC
    `;
    return consumer
      ? db.prepare(sql).all(consumer)
      : db.prepare(sql).all();
  }

  if (group === 'project' || group === 'task') {
    const col = group; // safe — already validated
    const sql = `
      SELECT
        COALESCE(${col}, '(unset)') AS ${col},
        SUM(input_tokens)       AS total_input_tokens,
        SUM(output_tokens)      AS total_output_tokens,
        SUM(cache_read_tokens)  AS total_cache_read_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(estimated_cost_usd) AS total_cost_usd,
        COUNT(*)                AS request_count
      FROM usage_log
      WHERE ${periodClause} ${consumer ? `AND consumer = ?` : ''}
      GROUP BY ${col}
      ORDER BY total_cost_usd DESC
    `;
    return consumer
      ? db.prepare(sql).all(consumer)
      : db.prepare(sql).all();
  }

  // Raw rows (most recent first)
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

/**
 * Get totals for a period (summary row).
 * @param {string} [period] - 'today' | '7d' | '30d' | 'all'
 */
function getTotals(period = 'today') {
  if (!db) throw new Error('Database not initialized — call init() first');

  let periodClause;
  switch (period) {
    case 'today':
      periodClause = `timestamp >= strftime('%Y-%m-%dT00:00:00Z', 'now')`;
      break;
    case '7d':
      periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')`;
      break;
    case '30d':
      periodClause = `timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')`;
      break;
    default:
      periodClause = '1=1';
  }

  return db.prepare(`
    SELECT
      SUM(input_tokens)       AS total_input_tokens,
      SUM(output_tokens)      AS total_output_tokens,
      SUM(cache_read_tokens)  AS total_cache_read_tokens,
      SUM(cache_write_tokens) AS total_cache_write_tokens,
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)                AS request_count
    FROM usage_log
    WHERE ${periodClause}
  `).get();
}

/**
 * Get current month spend vs monthly budget limit.
 * @param {number} monthlyLimit - budget limit in USD
 * @returns {Object} budget status
 */
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

/**
 * Close the database connection cleanly.
 */
function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { init, logUsage, getUsage, getTotals, getBudgetStatus, close };
