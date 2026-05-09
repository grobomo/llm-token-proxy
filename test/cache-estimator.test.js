'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  estimateCacheTokens, DEFAULT_SYSTEM_PROMPT_TOKENS, modelUsesCaching,
} = require('../lib/cache-estimator');

describe('Cache Estimator', () => {
  describe('modelUsesCaching', () => {
    it('returns true for known Claude models', () => {
      for (const m of ['claude-opus-4-6', 'claude-4.6-opus-aws', 'claude-sonnet-4-6', 'claude-haiku-4-5-aws']) {
        assert.equal(modelUsesCaching(m), true, `Expected true for ${m}`);
      }
    });

    it('returns false for unknown models', () => {
      for (const m of ['gpt-4o', 'llama-3', null, undefined, '']) {
        assert.equal(modelUsesCaching(m), false, `Expected false for ${m}`);
      }
    });
  });

  describe('estimateCacheTokens', () => {
    it('passes through Anthropic upstream without modification', () => {
      const usage = { input_tokens: 1, output_tokens: 500 };
      const { usage: result, estimated } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'anthropic', sessionId: 'test-1', queryDb: () => [],
      });
      assert.deepEqual(result, usage);
      assert.equal(estimated, false);
    });

    it('passes through when cache tokens already present', () => {
      const usage = {
        input_tokens: 1, output_tokens: 500,
        cache_read_input_tokens: 120000, cache_creation_input_tokens: 0,
      };
      const { usage: result, estimated } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'rdsec', sessionId: 'test-2', queryDb: () => [],
      });
      assert.deepEqual(result, usage);
      assert.equal(estimated, false);
    });

    it('skips estimation for non-caching models', () => {
      const usage = { input_tokens: 1, output_tokens: 500 };
      const { estimated } = estimateCacheTokens({
        usage, model: 'gpt-4o', upstream: 'rdsec', sessionId: 'test-3', queryDb: () => [],
      });
      assert.equal(estimated, false);
    });

    it('skips estimation when output_tokens is 0 (failed call)', () => {
      const usage = { input_tokens: 1, output_tokens: 0 };
      const { estimated } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'rdsec', sessionId: 'test-4', queryDb: () => [],
      });
      assert.equal(estimated, false);
    });

    it('estimates cache_write for first call in session', () => {
      const usage = { input_tokens: 1, output_tokens: 500 };
      const { usage: result, estimated } = estimateCacheTokens({
        usage, model: 'claude-4.6-opus-aws', upstream: 'rdsec', sessionId: 'test-5',
        queryDb: () => [{ cnt: 0 }],  // no prior calls
      });

      assert.equal(estimated, true);
      assert.equal(result.input_tokens, 1);  // preserved
      assert.equal(result.cache_creation_input_tokens, Math.floor(DEFAULT_SYSTEM_PROMPT_TOKENS * 0.30));
      assert.equal(result.cache_read_input_tokens, 0);
      assert.equal(result.output_tokens, 500);
    });

    it('estimates cache_read for subsequent calls in session', () => {
      const usage = { input_tokens: 1, output_tokens: 300 };
      const { usage: result, estimated } = estimateCacheTokens({
        usage, model: 'claude-4.6-opus-aws', upstream: 'rdsec', sessionId: 'test-6',
        queryDb: () => [{ cnt: 5 }],  // 5 prior calls
      });

      assert.equal(estimated, true);
      assert.equal(result.input_tokens, 1);  // preserved
      assert.equal(result.cache_read_input_tokens, DEFAULT_SYSTEM_PROMPT_TOKENS);
      assert.equal(result.cache_creation_input_tokens, 0);
      assert.equal(result.output_tokens, 300);
    });

    it('skips estimation when no sessionId (single-turn calls)', () => {
      const usage = { input_tokens: 1, output_tokens: 200 };
      const { usage: result, estimated } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'litellm', sessionId: null, queryDb: null,
      });

      assert.equal(estimated, false);
      assert.deepEqual(result, usage);
    });

    it('handles db query failure gracefully', () => {
      const usage = { input_tokens: 1, output_tokens: 100 };
      const { estimated } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'rdsec', sessionId: 'test-7',
        queryDb: () => { throw new Error('DB error'); },
      });

      assert.equal(estimated, true);  // defaults to first-in-session
    });

    it('works with any non-anthropic upstream name', () => {
      const usage = { input_tokens: 1, output_tokens: 100 };
      for (const upstream of ['rdsec', 'litellm', 'openai', 'custom-gateway']) {
        const { estimated } = estimateCacheTokens({
          usage, model: 'claude-opus-4-6', upstream, sessionId: 'test-8',
          queryDb: () => [{ cnt: 0 }],
        });
        assert.equal(estimated, true, `Should estimate for upstream: ${upstream}`);
      }
    });

    it('accepts custom systemPromptTokens override', () => {
      const usage = { input_tokens: 1, output_tokens: 100 };
      const { usage: result } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'rdsec', sessionId: 'test-9',
        queryDb: () => [{ cnt: 3 }],
        systemPromptTokens: 150_000,
      });

      assert.equal(result.cache_read_input_tokens, 150_000);
    });

    it('preserves original input_tokens (already non-cached)', () => {
      const usage = { input_tokens: 5021, output_tokens: 632 };
      const { usage: result } = estimateCacheTokens({
        usage, model: 'claude-opus-4-6', upstream: 'rdsec', sessionId: 'test-10',
        queryDb: () => [{ cnt: 0 }],
      });

      // input_tokens should NOT be reduced — RDSec already returns non-cached
      assert.equal(result.input_tokens, 5021);
    });
  });
});
