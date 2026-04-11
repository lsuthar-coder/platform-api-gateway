// src/middleware/rateLimiter.js
// ─────────────────────────────────────────────
// Sliding-window rate limiter using Redis.
//
// Key pattern:  ratelimit:{userId}:{minuteBucket}
// TTL:          60 seconds (auto-expires)
// Limit:        req.route.rate_limit_per_min (from routes table)
//
// The minute bucket changes every 60 seconds, so the counter
// resets automatically — no cleanup job needed.
//
// Example:
//   User "user_123" makes request at 14:32:45
//   Bucket = Math.floor(Date.now() / 60000) = 28573012
//   Key    = ratelimit:user_123:28573012
//   INCR   → 1 (first request this minute)
//   EXPIRE 60 → key disappears at 14:33:45
//   ...
//   41st request → INCR → 41 → exceeds limit of 40 → 429
// ─────────────────────────────────────────────
'use strict';

const redis   = require('../db/redis');
const metrics = require('../metrics');

async function rateLimiter(req, res, next) {
  const userId = req.user?.sub || 'anonymous';
  const limit   = req.route.rate_limit_per_min;
  const bucket  = Math.floor(Date.now() / 60_000);
  const key     = `ratelimit:${userId}:${bucket}`;

  // INCR is atomic — safe with multiple Gateway replicas.
  // Returns new value after increment.
  const count = await redis.incr(key);

  if (count === 1) {
    // First request in this minute window — set TTL.
    // TTL ensures the key expires even if no more requests arrive.
    await redis.expire(key, 60);
  }

  if (count > limit) {
    // Increment the Prometheus counter for monitoring
    metrics.rateLimitHits.inc({ route: req.route.path_prefix });

    return res.status(429).json({
      error:       'Rate limit exceeded',
      limit,
      window:      '1 minute',
      retry_after: 60,
    });
  }

  // Attach rate limit headers to response (standard practice)
  res.setHeader('X-RateLimit-Limit',     limit);
  res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));

  next();
}

module.exports = rateLimiter;
