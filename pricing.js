'use strict';

let _pricing = null;

/**
 * Load the pricing table from config.
 * @param {Object} pricingConfig - The `pricing` block from config.yaml
 */
function loadPricing(pricingConfig) {
  _pricing = pricingConfig || {};
}

/**
 * Look up model pricing. Falls back to 'default' if model not found.
 * @param {string} model
 * @returns {Object|null} pricing entry with input/output/cache_read/cache_write (per-million USD)
 */
function getModelPricing(model) {
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
 * @returns {number} Estimated cost in USD (6 decimal precision)
 */
function calculateCost(model, usage) {
  if (!usage) return 0;

  const pricing = getModelPricing(model);
  if (!pricing) {
    // No pricing found — return 0 to avoid blocking requests
    console.warn(`[pricing] No pricing data for model: ${model}`);
    return 0;
  }

  const rawInputTokens   = usage.input_tokens                   || 0;
  const outputTokens     = usage.output_tokens                  || 0;
  const cacheReadTokens  = usage.cache_read_input_tokens        || 0;
  const cacheWriteTokens = usage.cache_creation_input_tokens    || 0;

  // Some upstreams include cache tokens inside input_tokens. Subtract them
  // to avoid double-charging: once at the full input rate and again at the
  // cache rate. If input_tokens is already net-of-cache, subtraction yields
  // the same value (cache fields are 0).
  const inputTokens = Math.max(0, rawInputTokens - cacheReadTokens - cacheWriteTokens);

  // Pricing is per million tokens
  const M = 1_000_000;
  const inputCost      = (inputTokens      / M) * (pricing.input      || 0);
  const outputCost     = (outputTokens     / M) * (pricing.output     || 0);
  const cacheReadCost  = (cacheReadTokens  / M) * (pricing.cache_read || 0);
  const cacheWriteCost = (cacheWriteTokens / M) * (pricing.cache_write || 0);

  const total = inputCost + outputCost + cacheReadCost + cacheWriteCost;
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
