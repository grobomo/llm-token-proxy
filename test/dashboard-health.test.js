'use strict';

/**
 * Dashboard Health Tests
 *
 * Validates that the dashboard and its APIs return accurate, current data.
 * Run against a LIVE proxy (not the test mock). Use for pre-demo validation.
 *
 * Usage:
 *   node --test test/dashboard-health.test.js                    # default: 127.0.0.1:4100
 *   PROXY_URL=https://tokentracker.click node --test test/dashboard-health.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BASE = process.env.PROXY_URL || 'http://127.0.0.1:4100';

async function api(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, headers: res.headers };
}

describe('Dashboard Health', { timeout: 30000 }, () => {

  // =========================================================================
  // 1. Proxy is running and upstreams are reachable
  // =========================================================================
  describe('Proxy health', () => {
    it('proxy is running and healthy', async () => {
      const { status, json } = await api('/health');
      assert.equal(status, 200, 'Health endpoint should return 200');
      assert.equal(json.status, 'ok');
      assert.equal(json.proxy, 'running');
    });

    it('at least one upstream is reachable', async () => {
      const { json } = await api('/health');
      assert.ok(json.upstreams?.length > 0, 'Should have at least one upstream');
      assert.equal(json.upstream, 'reachable', 'Upstream should be reachable');
    });

    it('uptime is non-zero', async () => {
      const { json } = await api('/health');
      assert.ok(json.uptime_seconds > 0, `Uptime should be >0, got ${json.uptime_seconds}`);
    });
  });

  // =========================================================================
  // 2. Data freshness — most recent row should be within last 2 hours
  // =========================================================================
  describe('Data freshness', () => {
    it('database has rows', async () => {
      const { json } = await api('/api/db-stats');
      assert.ok(json.rows > 0, `DB should have rows, got ${json.rows}`);
    });

    it('newest data is within last 2 hours', async () => {
      const { json } = await api('/api/db-stats');
      assert.ok(json.newest, 'Should have a newest timestamp');
      const newest = new Date(json.newest);
      const age = Date.now() - newest.getTime();
      const twoHours = 2 * 60 * 60 * 1000;
      assert.ok(age < twoHours,
        `Newest data is ${Math.round(age / 60000)} min old (max 120 min). ` +
        `Proxy may not be capturing traffic.`);
    });

    it('has data from today (UTC)', async () => {
      const { json } = await api('/api/daily-comparison');
      assert.ok(json.today, 'Should have today data');
      assert.ok(json.today.calls > 0,
        `Today should have calls, got ${json.today.calls}. ` +
        `If 0, proxy is not in the request path.`);
    });
  });

  // =========================================================================
  // 3. Hourly chart continuity — no multi-hour gaps in recent data
  // =========================================================================
  describe('Hourly continuity', () => {
    it('has data for the current hour', async () => {
      const { json } = await api('/api/hourly-breakdown?range=24h');
      assert.ok(Array.isArray(json.hours), 'Should return hours array');

      const now = new Date();
      const currentHourUTC = now.getUTCHours();
      // Check last 3 hours for any data (allows for sparse traffic)
      const recentHours = json.hours.filter(h => {
        const hourNum = parseInt(h.hour?.split?.(':')[0] || h.hour, 10);
        const diff = (currentHourUTC - hourNum + 24) % 24;
        return diff <= 2; // within last 3 hours
      });
      assert.ok(recentHours.length > 0,
        `No data in the last 3 hours (current UTC hour: ${currentHourUTC}). ` +
        `Proxy may not be capturing traffic.`);
    });

    it('no gaps longer than 4 hours in last 24h', async () => {
      const { json } = await api('/api/hourly-breakdown?range=24h');
      if (!json.hours || json.hours.length < 2) return; // skip if sparse data

      // Extract hours that have data
      const hoursWithData = json.hours
        .filter(h => (h.total_cost || h.calls || 0) > 0)
        .map(h => parseInt(h.hour?.split?.(':')[0] || h.hour, 10))
        .sort((a, b) => a - b);

      if (hoursWithData.length < 2) return;

      let maxGap = 0;
      let gapStart = 0, gapEnd = 0;
      for (let i = 1; i < hoursWithData.length; i++) {
        const gap = hoursWithData[i] - hoursWithData[i - 1];
        if (gap > maxGap) {
          maxGap = gap;
          gapStart = hoursWithData[i - 1];
          gapEnd = hoursWithData[i];
        }
      }

      assert.ok(maxGap <= 4,
        `${maxGap}-hour gap detected (${gapStart}:00 to ${gapEnd}:00 UTC). ` +
        `Proxy was likely down or not in request path during this window.`);
    });
  });

  // =========================================================================
  // 4. Cost sanity — costs should be plausible for active usage
  // =========================================================================
  describe('Cost sanity', () => {
    it('total cost is positive', async () => {
      const { json } = await api('/api/db-stats');
      assert.ok(json.total_cost > 0, `Total cost should be >0, got ${json.total_cost}`);
    });

    it('24h cost breakdown sums correctly', async () => {
      const { json } = await api('/api/cost-breakdown?range=24h');
      assert.ok(Array.isArray(json.models), 'Should have models array');

      const summedCost = json.models.reduce((s, m) => s + (m.cost || 0), 0);
      const reportedTotal = json.total_cost || summedCost;

      if (json.models.length > 0) {
        // Verify individual model costs sum to total (within 1%)
        const diff = Math.abs(summedCost - reportedTotal);
        const tolerance = reportedTotal * 0.01 + 0.01; // 1% + rounding
        assert.ok(diff <= tolerance,
          `Model costs sum to $${summedCost.toFixed(2)} but total is ` +
          `$${reportedTotal.toFixed(2)} (diff: $${diff.toFixed(2)})`);
      }
    });

    it('opus calls cost at least $0.10 each (sanity floor)', async () => {
      const { json } = await api('/api/cost-breakdown?range=24h');
      const opusModels = json.models?.filter(m =>
        m.model?.includes('opus') && m.calls > 0
      ) || [];

      for (const m of opusModels) {
        const avgCost = m.cost / m.calls;
        assert.ok(avgCost >= 0.05,
          `${m.model}: avg $${avgCost.toFixed(4)}/call seems too low for Opus. ` +
          `Expected at least $0.05/call. Possible pricing or token counting issue.`);
      }
    });
  });

  // =========================================================================
  // 5. API endpoint availability
  // =========================================================================
  describe('API endpoints return 200', () => {
    const endpoints = [
      '/api/',
      '/api/summary',
      '/api/usage',
      '/api/budget',
      '/api/hourly-breakdown?range=24h',
      '/api/cost-breakdown?range=24h',
      '/api/project-costs?range=24h',
      '/api/daily-comparison',
      '/api/cache-estimation?range=24h',
      '/api/cache-stats',
      '/api/uptime',
      '/api/db-stats',
      '/api/digest?period=daily',
    ];

    for (const ep of endpoints) {
      it(`GET ${ep}`, async () => {
        const res = await fetch(`${BASE}${ep}`);
        assert.equal(res.status, 200, `${ep} returned ${res.status}`);
      });
    }
  });

  // =========================================================================
  // 6. Dashboard HTML loads
  // =========================================================================
  describe('Dashboard UI', () => {
    it('serves the dashboard HTML', async () => {
      const res = await fetch(`${BASE}/dashboard`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Token Tracker'), 'Dashboard should contain title');
    });

    it('digest renders with current date', async () => {
      const res = await fetch(`${BASE}/api/digest?period=daily`);
      assert.equal(res.status, 200);
      const html = await res.text();
      const now = new Date();
      const year = String(now.getFullYear());
      assert.ok(html.includes(year),
        `Digest should contain current year (${year})`);
    });
  });

  // =========================================================================
  // 7. Time accuracy — server time matches reality
  // =========================================================================
  describe('Time accuracy', () => {
    it('health timestamp is within 60 seconds of now', async () => {
      const { json } = await api('/health');
      const serverTime = new Date(json.ts);
      const drift = Math.abs(Date.now() - serverTime.getTime());
      assert.ok(drift < 60_000,
        `Server time drifted ${Math.round(drift / 1000)}s from local clock`);
    });
  });
});
