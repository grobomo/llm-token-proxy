'use strict';

const sqlite = require('./sqlite');

let backend = null;

function getBackend() {
  if (!backend) throw new Error('Storage not initialized — call storage.init() first');
  return backend;
}

function init(config = {}) {
  const type = config.type || 'sqlite';

  if (type === 'postgres' || type === 'postgresql') {
    backend = require('./postgres');
    return backend.init(config);
  }

  backend = sqlite;
  backend.init({ path: config.path || config.db || './usage.db' });
  return backend;
}

function isAsync() {
  return backend?.async === true;
}

function logUsage(...a) {
  const result = getBackend().logUsage(...a);
  if (result && typeof result.catch === 'function') {
    result.catch(err => console.error('[storage] logUsage failed:', err.message));
  }
  return result;
}

module.exports = {
  init,
  isAsync,
  get type() { return getBackend().type; },
  logUsage,
  getUsage:          (...a) => getBackend().getUsage(...a),
  getTotals:         (...a) => getBackend().getTotals(...a),
  getBudgetStatus:   (...a) => getBackend().getBudgetStatus(...a),
  getHourlyCosts:    (...a) => getBackend().getHourlyCosts(...a),
  getHourlyBreakdown:(...a) => getBackend().getHourlyBreakdown(...a),
  getDailyComparison:(...a) => getBackend().getDailyComparison(...a),
  getCostBreakdown:  (...a) => getBackend().getCostBreakdown(...a),
  getSavingsPotential:(...a)=> getBackend().getSavingsPotential(...a),
  query:             (...a) => getBackend().query(...a),
  close:             (...a) => getBackend().close(...a),
};
