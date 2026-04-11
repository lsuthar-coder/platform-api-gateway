// src/middleware/circuitBreaker.js
// ─────────────────────────────────────────────
// Circuit breaker — CLOSED / OPEN / HALF_OPEN state machine.
// State is stored in Redis so ALL Gateway replicas share it.
//
// Redis keys per route:
//   cb:{route}:state      → "CLOSED" | "OPEN" | "HALF_OPEN"
//   cb:{route}:failures   → integer counter, TTL 60s
//   cb:{route}:tripped_at → unix timestamp when circuit opened
//
// State transitions:
//   CLOSED  → OPEN      : failures >= FAILURE_THRESHOLD in 60s window
//   OPEN    → HALF_OPEN : COOLDOWN_MS elapsed since tripped_at
//   HALF_OPEN → CLOSED  : probe request succeeds (2xx/3xx response)
//   HALF_OPEN → OPEN    : probe request fails (4xx/5xx or timeout)
// ─────────────────────────────────────────────
'use strict';

const redis  = require('../db/redis');
const { publishCircuitTrip } = require('../notifications/sns');
const metrics = require('../metrics');

const FAILURE_THRESHOLD = 5;         // failures before opening circuit
const FAILURE_WINDOW_S  = 60;        // sliding window in seconds
const COOLDOWN_MS       = 30_000;    // 30s before HALF_OPEN probe

/**
 * check — Express middleware. Reads circuit state from Redis.
 * CLOSED    → next() (proceed normally)
 * OPEN      → check if cooldown elapsed → maybe HALF_OPEN → next()
 *           → otherwise 503
 * HALF_OPEN → allow one probe through, mark it so recordResult knows
 */
async function check(req, res, next) {
  const routeKey = req.route.path_prefix;
  const state    = await redis.get(`cb:${routeKey}:state`) || 'CLOSED';

  if (state === 'CLOSED') {
    return next();
  }

  if (state === 'OPEN') {
    const trippedAt = parseInt(await redis.get(`cb:${routeKey}:tripped_at`) || '0');
    const elapsed   = Date.now() - trippedAt;

    if (elapsed >= COOLDOWN_MS) {
      // Cooldown elapsed — transition to HALF_OPEN and let one probe through
      await redis.set(`cb:${routeKey}:state`, 'HALF_OPEN');
      req._isCircuitProbe = true; // flag for recordResult
      return next();
    }

    // Still in cooldown — reject immediately
    metrics.circuitState.set({ route: routeKey }, 2); // 2 = OPEN
    return res.status(503).json({
      error:       'Service unavailable',
      route:       routeKey,
      retry_after: Math.ceil((COOLDOWN_MS - elapsed) / 1000),
    });
  }

  if (state === 'HALF_OPEN') {
    // Already have a probe in flight — reject additional requests
    return res.status(503).json({ error: 'Service unavailable (probing)', route: routeKey });
  }

  next();
}

/**
 * recordResult — called from the proxy response/error handlers in index.js.
 * Updates failure counter and state based on upstream response code.
 *
 * @param {string} routeKey - path_prefix of the matched route
 * @param {number} statusCode - HTTP status from upstream
 */
async function recordResult(routeKey, statusCode) {
  const isFailure = statusCode >= 500;
  const state     = await redis.get(`cb:${routeKey}:state`) || 'CLOSED';

  if (state === 'HALF_OPEN') {
    if (isFailure) {
      // Probe failed — reopen circuit
      await redis.set(`cb:${routeKey}:state`,      'OPEN');
      await redis.set(`cb:${routeKey}:tripped_at`, Date.now().toString());
      metrics.circuitState.set({ route: routeKey }, 2);
    } else {
      // Probe succeeded — close circuit, clear failure count
      await redis.set(`cb:${routeKey}:state`, 'CLOSED');
      await redis.del(`cb:${routeKey}:failures`);
      await redis.del(`cb:${routeKey}:tripped_at`);
      metrics.circuitState.set({ route: routeKey }, 0);
    }
    return;
  }

  if (state === 'CLOSED' && isFailure) {
    // Increment failure counter (auto-expires after FAILURE_WINDOW_S)
    const failures = await redis.incr(`cb:${routeKey}:failures`);
    if (failures === 1) {
      await redis.expire(`cb:${routeKey}:failures`, FAILURE_WINDOW_S);
    }

    if (failures >= FAILURE_THRESHOLD) {
      // Trip the circuit
      await redis.set(`cb:${routeKey}:state`,      'OPEN');
      await redis.set(`cb:${routeKey}:tripped_at`, Date.now().toString());
      metrics.circuitState.set({ route: routeKey }, 2);

      // Publish to AWS SNS → Lambda → Slack alert
      await publishCircuitTrip({ route: routeKey, failureCount: failures })
        .catch(err => console.error('SNS publish failed:', err.message));
    }
  }
}

module.exports = { check, recordResult };
