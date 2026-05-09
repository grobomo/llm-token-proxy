'use strict';

/**
 * Cache cost estimator for upstreams that strip cache token fields.
 *
 * Problem: RDSec/LiteLLM gateways strip cache_creation_input_tokens and
 * cache_read_input_tokens. They also report prompt_tokens as NON-CACHED
 * input only (same as Anthropic's input_tokens, NOT the total).
 *
 * Evidence from production data:
 * - RDSec Opus calls: input_tokens=1, cache_read=0, cache_write=0
 * - Anthropic Opus calls: input_tokens=1-5000, cache_read=220K, cache_write=35-64K
 *
 * The proxy correctly normalizes prompt_tokens → input_tokens, but since
 * cache fields are 0, the cost only reflects output + tiny input. The entire
 * cache cost (~$3.75/session cache_write + ~$0.33/call cache_read for Opus)
 * is invisible.
 *
 * Heuristic: For non-Anthropic upstreams with Claude models, estimate cache
 * based on typical Claude Code patterns:
 * - Default system prompt cache size: ~200K tokens (configurable)
 * - First call in session: estimate cache_write of system prompt
 * - Subsequent calls: estimate cache_read of system prompt
 *
 * Tagged with cache_estimated=1 for dashboard distinction.
 */

// Default system prompt cache size estimate (tokens).
// Based on Anthropic production data: avg cache_read ~220K, cache_write ~50K.
// Conservative default — can be overridden via config.
const DEFAULT_SYSTEM_PROMPT_TOKENS = 200_000;

// Models that use prompt caching in Claude Code (prefix match)
const CACHING_MODEL_PREFIXES = [
  'claude-opus', 'claude-4.6-opus', 'claude-4.5-opus', 'claude-4.7-opus',
  'claude-sonnet', 'claude-4.6-sonnet', 'claude-4.5-sonnet',
  'claude-haiku', 'claude-4.5-haiku',
];

/**
 * Check if the upstream is known to strip cache token fields.
 * @param {string} upstreamName
 * @returns {boolean}
 */
function upstreamStripsCacheTokens(upstreamName) {
  return upstreamName !== 'anthropic';
}

/**
 * Check if the model uses prompt caching.
 * @param {string} model
 * @returns {boolean}
 */
function modelUsesCaching(model) {
  if (!model) return false;
  return CACHING_MODEL_PREFIXES.some(prefix => model.startsWith(prefix));
}

/**
 * Estimate cache token breakdown when the upstream doesn't report them.
 *
 * @param {Object} params
 * @param {Object} params.usage - Usage object from API response
 * @param {string} params.model - Model name
 * @param {string} params.upstream - Upstream name (e.g. 'rdsec', 'litellm')
 * @param {string} params.sessionId - Claude Code session ID
 * @param {Function} params.queryDb - Function to run SQL: (sql) => rows
 * @param {number} [params.systemPromptTokens] - Override default prompt size
 * @returns {Object} { usage, estimated } - Modified usage + whether estimation was applied
 */
function estimateCacheTokens({ usage, model, upstream, sessionId, queryDb, systemPromptTokens }) {
  // Don't estimate if upstream reports cache tokens or is Anthropic
  if (!upstreamStripsCacheTokens(upstream)) {
    return { usage, estimated: false };
  }

  const cacheRead  = usage.cache_read_input_tokens     || 0;
  const cacheWrite = usage.cache_creation_input_tokens  || 0;

  // If cache tokens are already present, no estimation needed
  if (cacheRead > 0 || cacheWrite > 0) {
    return { usage, estimated: false };
  }

  // Only estimate for models known to use caching
  if (!modelUsesCaching(model)) {
    return { usage, estimated: false };
  }

  const outputTokens = usage.output_tokens || 0;

  // Skip if no output (failed call, no response)
  if (outputTokens === 0) {
    return { usage, estimated: false };
  }

  const promptSize = systemPromptTokens || DEFAULT_SYSTEM_PROMPT_TOKENS;

  // Determine if this is the first call in the session
  let isFirstInSession = true;
  if (sessionId && queryDb) {
    try {
      const rows = queryDb(
        `SELECT COUNT(*) AS cnt FROM usage_log
         WHERE session_id = '${sessionId.replace(/'/g, "''")}'
         AND upstream != 'anthropic'
         AND timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-4 hours')`
      );
      isFirstInSession = !rows.length || rows[0].cnt === 0;
    } catch {
      // DB query failed — default to conservative (first-in-session) estimate
    }
  }

  const inputTokens = usage.input_tokens || 0;

  if (isFirstInSession) {
    // First call: system prompt being written to cache.
    // Anthropic data shows cache_write ~35-64K (not the full prompt, just new parts).
    // Use 30% of prompt size as cache_write estimate for first call.
    const estimatedCacheWrite = Math.floor(promptSize * 0.30);
    return {
      usage: {
        ...usage,
        input_tokens:                inputTokens,  // keep original (already non-cached)
        cache_creation_input_tokens: estimatedCacheWrite,
        cache_read_input_tokens:     0,
      },
      estimated: true,
    };
  }

  // Subsequent calls: system prompt being read from cache.
  // Anthropic data shows cache_read ~220K per call.
  return {
    usage: {
      ...usage,
      input_tokens:                inputTokens,  // keep original (already non-cached)
      cache_creation_input_tokens: 0,
      cache_read_input_tokens:     promptSize,
    },
    estimated: true,
  };
}

module.exports = {
  estimateCacheTokens,
  upstreamStripsCacheTokens,
  modelUsesCaching,
  DEFAULT_SYSTEM_PROMPT_TOKENS,
  CACHING_MODEL_PREFIXES,
};
