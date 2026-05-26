'use strict';

let _pricing = null;
let _upstreamPricing = null;

/**
 * Load the pricing table from config.
 * @param {Object} pricingConfig - The `pricing` block from config.yaml
 * @param {Object} [upstreamPricingConfig] - The `upstream_pricing` block (per-upstream rate overrides)
 */
function loadPricing(pricingConfig, upstreamPricingConfig) {
  _pricing = pricingConfig || {};
  _upstreamPricing = upstreamPricingConfig || null;
}

/**
 * Look up model pricing, optionally scoped to a specific upstream.
 * Priority: upstream-specific rate > global model rate > global default.
 * @param {string} model
 * @param {string} [upstream] - upstream name (e.g. 'rdsec', 'anthropic')
 * @returns {Object|null} pricing entry with input/output/cache_read/cache_write (per-million USD)
 */
function getModelPricing(model, upstream) {
  // Check upstream-specific pricing first
  if (upstream && _upstreamPricing && _upstreamPricing[upstream]) {
    const upPricing = _upstreamPricing[upstream];
    if (upPricing[model]) return upPricing[model];
    for (const key of Object.keys(upPricing)) {
      if (key === 'default') continue;
      if (model && model.startsWith(key)) return upPricing[key];
    }
    if (upPricing.default) return upPricing.default;
  }

  if (!_pricing) return null;

  // Direct match
  if (_pricing[model]) return _pricing[model];

  // Prefix match — e.g. "claude-4.6-opus-20250514" → "claude-4.6-opus"
  for (const key of Object.keys(_pricing)) {
    if (key === 'default') continue;
    if (model && model.startsWith(key)) return _pricing[key];
  }

  // Fallback to default
  return _pricing['default'] || null;
}

/**
 * Calculate estimated cost for a single API call.
 *
 * @param {string} model - Model name (e.g. "claude-4.6-opus")
 * @param {Object} usage - Usage object from API response
 * @param {number} usage.input_tokens
 * @param {number} usage.output_tokens
 * @param {number} [usage.cache_read_input_tokens]
 * @param {number} [usage.cache_creation_input_tokens]
 * @param {string} [upstream] - Upstream name for per-upstream pricing
 * @returns {number} Estimated cost in USD (6 decimal precision)
 */
function calculateCost(model, usage, upstream) {
  if (!usage) return 0;

  const pricing = getModelPricing(model, upstream);
  if (!pricing) {
    // No pricing found — return 0 to avoid blocking requests
    console.warn(`[pricing] No pricing data for model: ${model}`);
    return 0;
  }

  const rawInputTokens   = usage.input_tokens                   || 0;
  const outputTokens     = usage.output_tokens                  || 0;
  const cacheReadTokens  = usage.cache_read_input_tokens        || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens    || 0;

  const M = 1_000_000;
  let total;

  if (pricing.flat_input) {
    // Flat-input model: all prompt tokens (input + cache_read + cache_write) charged at one rate.
    // Used by upstreams like RDsec that don't differentiate cached vs fresh input.
    const allInputTokens = rawInputTokens + cacheReadTokens + cacheWriteTokens;
    const inputCost  = (allInputTokens / M) * pricing.flat_input;
    const outputCost = (outputTokens   / M) * (pricing.output || 0);
    total = inputCost + outputCost;
  } else {
    // Separate-rate model: different rates for input/cache_read/cache_write.
    const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);
    const inputCost      = (inputTokens      / M) * (pricing.input       || 0);
    const outputCost     = (outputTokens     / M) * (pricing.output      || 0);
    const cacheReadCost  = (cacheReadTokens  / M) * (pricing.cache_read  || 0);
    const cacheWriteCost = (cacheWriteTokens / M) * (pricing.cache_write || 0);
    total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }
  return parseFloat(total.toFixed(6));
}

/**
 * Format cost as a human-readable USD string.
 * @param {number} usd
 * @returns {string}
 */
function formatCost(usd) {
  if (usd < 0.001) return `$${(usd * 1000).toFixed(4)}m`;  // sub-cent: show in mills
  if (usd < 1)     return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

module.exports = { loadPricing, calculateCost, getModelPricing, formatCost };
