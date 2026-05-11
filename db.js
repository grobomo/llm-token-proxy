'use strict';

// Thin wrapper around lib/storage — delegates to the pluggable storage backend.
// Default: SQLite via node:sqlite. Set config.storage.type = 'postgres' for Postgres.
// All consumers (proxy.js, dashboard/api.js, scripts/) require('./db') unchanged.

const storage = require('./lib/storage');

function init(dbPathOrConfig) {
  if (typeof dbPathOrConfig === 'string') {
    return storage.init({ type: 'sqlite', path: dbPathOrConfig });
  }
  return storage.init(dbPathOrConfig);
}

module.exports = {
  init,
  logUsage:        (...a) => storage.logUsage(...a),
  getUsage:        (...a) => storage.getUsage(...a),
  getTotals:       (...a) => storage.getTotals(...a),
  getBudgetStatus: (...a) => storage.getBudgetStatus(...a),
  query:           (...a) => storage.query(...a),
  run:             (...a) => storage.run(...a),
  close:           (...a) => storage.close(...a),
};
