'use strict';

let Pool;
try {
  Pool = require('pg').Pool;
} catch {
  // pg is an optional dependency — loaded only when storage.type = 'postgres'
}

let pool;

async function init(config) {
  if (!Pool) throw new Error('pg package not installed. Run: npm install pg');

  pool = new Pool({
    host:     config.host     || '127.0.0.1',
    port:     config.port     || 5432,
    database: config.database || 'token_proxy',
    user:     config.user     || 'token_proxy',
    password: config.password || '',
    max:      config.pool_size || 10,
    ssl:      config.ssl      || false,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    )
  `);
  await pool.query(`INSERT INTO schema_version (version) VALUES (1) ON CONFLICT DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id                    BIGSERIAL PRIMARY KEY,
      timestamp             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      consumer              TEXT    NOT NULL DEFAULT 'unknown',
      model                 TEXT    NOT NULL DEFAULT 'unknown',
      upstream              TEXT             DEFAULT 'unknown',
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens    INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd    DOUBLE PRECISION NOT NULL DEFAULT 0,
      duration_ms           INTEGER NOT NULL DEFAULT 0,
      http_status           INTEGER NOT NULL DEFAULT 0,
      project               TEXT,
      task                  TEXT,
      user_agent            TEXT,
      session_id            TEXT,
      original_model        TEXT
    )
  `);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON usage_log (timestamp)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_consumer  ON usage_log (consumer)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_model     ON usage_log (model)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_project   ON usage_log (project)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_task      ON usage_log (task)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_usage_session   ON usage_log (session_id)`);

  await pool.query(`
    INSERT INTO schema_version (version) VALUES (5) ON CONFLICT (version) DO NOTHING
  `);

  return pool;
}

function _periodClause(period, paramOffset = 0) {
  switch (period) {
    case 'today': return `timestamp >= date_trunc('day', NOW())`;
    case '7d':    return `timestamp >= NOW() - INTERVAL '7 days'`;
    case '30d':   return `timestamp >= NOW() - INTERVAL '30 days'`;
    default:      return '1=1';
  }
}

async function logUsage(record) {
  if (!pool) throw new Error('Database not initialized — call init() first');

  await pool.query(`
    INSERT INTO usage_log
      (consumer, model, upstream, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, estimated_cost_usd, duration_ms, http_status,
       project, task, user_agent, session_id, original_model)
    VALUES
      ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  `, [
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
  ]);
}

async function getUsage(filters = {}) {
  if (!pool) throw new Error('Database not initialized — call init() first');

  const { period = 'today', group = 'none', consumer, limit = 50 } = filters;
  const periodClause = _periodClause(period);

  if (group === 'consumer' || group === 'model' || group === 'project' || group === 'task') {
    const col = (group === 'project' || group === 'task')
      ? `COALESCE(${group}, '(unset)')`
      : group;
    const params = consumer ? [consumer] : [];
    const sql = `
      SELECT
        ${col} AS ${group},
        SUM(input_tokens)       AS total_input_tokens,
        SUM(output_tokens)      AS total_output_tokens,
        SUM(cache_read_tokens)  AS total_cache_read_tokens,
        SUM(cache_write_tokens) AS total_cache_write_tokens,
        SUM(estimated_cost_usd) AS total_cost_usd,
        COUNT(*)::int           AS request_count
      FROM usage_log
      WHERE ${periodClause} ${consumer ? 'AND consumer = $1' : ''}
      GROUP BY ${col}
      ORDER BY total_cost_usd DESC
    `;
    const { rows } = await pool.query(sql, params);
    return rows;
  }

  const params = consumer ? [consumer, limit] : [limit];
  const sql = `
    SELECT *
    FROM usage_log
    WHERE ${periodClause} ${consumer ? 'AND consumer = $1' : ''}
    ORDER BY id DESC
    LIMIT ${consumer ? '$2' : '$1'}
  `;
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getTotals(period = 'today') {
  if (!pool) throw new Error('Database not initialized — call init() first');

  const { rows } = await pool.query(`
    SELECT
      SUM(input_tokens)       AS total_input_tokens,
      SUM(output_tokens)      AS total_output_tokens,
      SUM(cache_read_tokens)  AS total_cache_read_tokens,
      SUM(cache_write_tokens) AS total_cache_write_tokens,
      SUM(estimated_cost_usd) AS total_cost_usd,
      COUNT(*)::int           AS request_count
    FROM usage_log
    WHERE ${_periodClause(period)}
  `);
  return rows[0];
}

async function getBudgetStatus(monthlyLimit = 100) {
  if (!pool) throw new Error('Database not initialized — call init() first');

  const { rows } = await pool.query(`
    SELECT
      SUM(estimated_cost_usd) AS month_spend,
      COUNT(*)::int           AS request_count
    FROM usage_log
    WHERE timestamp >= date_trunc('month', NOW())
  `);

  const row      = rows[0];
  const spent    = parseFloat(row?.month_spend) || 0;
  const requests = row?.request_count           || 0;
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

async function getHourlyCosts(period = 'today') {
  if (!pool) throw new Error('Database not initialized');

  const periodClause = period === '7d'
    ? `timestamp >= NOW() - INTERVAL '7 days'`
    : `timestamp >= date_trunc('day', NOW())`;

  const sql = period === '7d'
    ? `SELECT to_char(timestamp, 'YYYY-MM-DD HH24') || ':00' AS bucket,
            SUM(estimated_cost_usd) AS cost, COUNT(*)::int AS calls
       FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`
    : `SELECT to_char(timestamp, 'HH24') || ':00' AS bucket,
            SUM(estimated_cost_usd) AS cost, COUNT(*)::int AS calls
       FROM usage_log WHERE ${periodClause} GROUP BY bucket ORDER BY bucket`;

  const { rows } = await pool.query(sql);
  return rows;
}

async function getHourlyBreakdown() {
  if (!pool) throw new Error('Database not initialized');
  const where = `timestamp >= NOW() - INTERVAL '24 hours'`;

  const { rows: projectRows } = await pool.query(`
    SELECT
      to_char(timestamp, 'YYYY-MM-DD"T"HH24') AS hour,
      COALESCE(project, '(untagged)') AS project,
      SUM(estimated_cost_usd) AS cost,
      COUNT(*)::int AS calls
    FROM usage_log WHERE ${where}
    GROUP BY hour, project ORDER BY hour, cost DESC
  `);

  const { rows: modelRows } = await pool.query(`
    SELECT
      to_char(timestamp, 'YYYY-MM-DD"T"HH24') AS hour,
      model,
      SUM(estimated_cost_usd) AS cost,
      COUNT(*)::int AS calls
    FROM usage_log WHERE ${where}
    GROUP BY hour, model ORDER BY hour, cost DESC
  `);

  return { projectRows, modelRows };
}

async function getDailyComparison(offsetMin = 0) {
  if (!pool) throw new Error('Database not initialized');
  const offset = `${offsetMin} minutes`;

  const { rows: todayRows } = await pool.query(`
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*)::int AS calls
    FROM usage_log
    WHERE timestamp >= date_trunc('day', NOW() + $1::interval)
  `, [offset]);

  const { rows: yesterdayRows } = await pool.query(`
    SELECT SUM(estimated_cost_usd) AS cost, COUNT(*)::int AS calls
    FROM usage_log
    WHERE timestamp >= date_trunc('day', NOW() + $1::interval - INTERVAL '1 day')
      AND timestamp < date_trunc('day', NOW() + $1::interval)
  `, [offset]);

  return { today: todayRows[0], yesterday: yesterdayRows[0] };
}

async function getCostBreakdown() {
  if (!pool) throw new Error('Database not initialized');

  const { rows } = await pool.query(`
    SELECT
      model,
      COUNT(*)::int AS calls,
      SUM(estimated_cost_usd) AS cost,
      SUM(input_tokens) AS input_tokens,
      SUM(output_tokens) AS output_tokens,
      SUM(cache_read_tokens) AS cache_read_tokens,
      SUM(cache_write_tokens) AS cache_write_tokens
    FROM usage_log
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
    GROUP BY model ORDER BY cost DESC
  `);
  return rows;
}

async function getSavingsPotential() {
  if (!pool) throw new Error('Database not initialized');

  const { rows: costByType } = await pool.query(`
    SELECT
      model, COUNT(*)::int AS calls,
      SUM(output_tokens) AS total_output,
      SUM(cache_write_tokens) AS total_cw,
      SUM(cache_read_tokens) AS total_cr,
      SUM(estimated_cost_usd) AS cost
    FROM usage_log
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
    GROUP BY model ORDER BY cost DESC
  `);

  const { rows: ssRows } = await pool.query(`
    SELECT COUNT(*)::int AS sessions,
           SUM(cache_write_tokens) AS total_cw
    FROM usage_log
    WHERE timestamp >= NOW() - INTERVAL '24 hours'
      AND cache_write_tokens > 50000
  `);

  return { costByType, sessionStarts: ssRows[0] };
}

async function query(sql) {
  if (!pool) throw new Error('Database not initialized');
  const { rows } = await pool.query(sql);
  return rows;
}

async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  type: 'postgres',
  async: true,
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
  close,
};
