'use strict';

class ResponseCache {
  constructor(opts = {}) {
    this.ttlMs = (opts.ttlSeconds || 30) * 1000;
    this.maxEntries = opts.maxEntries || 100;
    this.store = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) { this.misses++; return null; }
    if (Date.now() - entry.ts > this.ttlMs) {
      this.store.delete(key);
      this.misses++;
      return null;
    }
    this.hits++;
    return entry.value;
  }

  set(key, value) {
    if (this.store.size >= this.maxEntries) {
      const oldest = this.store.keys().next().value;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, ts: Date.now() });
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      entries: this.store.size,
      hits: this.hits,
      misses: this.misses,
      hit_rate: total > 0 ? parseFloat((this.hits / total * 100).toFixed(1)) : 0,
    };
  }

  clear() {
    this.store.clear();
  }

  middleware(keyFn) {
    const cache = this;
    return (req, res, next) => {
      const key = keyFn ? keyFn(req) : req.originalUrl;
      const cached = cache.get(key);
      if (cached) {
        res.set('X-Cache', 'HIT');
        return res.json(cached);
      }
      const originalJson = res.json.bind(res);
      res.json = (body) => {
        cache.set(key, body);
        res.set('X-Cache', 'MISS');
        return originalJson(body);
      };
      next();
    };
  }
}

module.exports = ResponseCache;
