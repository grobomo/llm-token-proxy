'use strict';

const buckets = new Map();

function check(key, maxPerHour) {
  const now = Date.now();
  const windowMs = 3600_000;
  const cutoff = now - windowMs;

  if (!buckets.has(key)) buckets.set(key, []);
  const timestamps = buckets.get(key).filter(t => t > cutoff);
  buckets.set(key, timestamps);

  if (timestamps.length >= maxPerHour) {
    const resetAt = timestamps[0] + windowMs;
    return { allowed: false, remaining: 0, resetAt };
  }

  timestamps.push(now);
  return { allowed: true, remaining: maxPerHour - timestamps.length, resetAt: now + windowMs };
}

module.exports = { check };
