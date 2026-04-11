// src/db/redis.js
// ─────────────────────────────────────────────
// Shared Redis client using ioredis.
//
// The Gateway uses Redis for 3 things:
//   1. JWT blacklist  — blacklist:{jti}       checked in jwt.js
//   2. Rate limiting  — ratelimit:{uid}:{min} used in rateLimiter.js
//   3. Circuit state  — cb:{route}:*          used in circuitBreaker.js
//   4. Metrics cache  — metrics:{route}:{min} used in metrics.js + admin routes
//
// REDIS_URL comes from K8s Secret. Format:
//   redis://redis-master:6379   (in-cluster service name)
// ─────────────────────────────────────────────
'use strict';

const Redis = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://redis-master:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    // Exponential backoff: 50ms, 100ms, 200ms, ... up to 2s
    return Math.min(times * 50, 2_000);
  },
});

redis.on('error', (err) => {
  console.error(JSON.stringify({ event: 'redis_error', error: err.message }));
});

redis.on('connect', () => {
  console.log(JSON.stringify({ event: 'redis_connected' }));
});

module.exports = redis;
