// src/metrics.js
// ─────────────────────────────────────────────
// Prometheus metrics for Grafana Cloud.
// Scraped by Grafana Agent every 15 seconds via GET /metrics.
//
// Metrics:
//   gateway_request_duration_seconds  histogram   latency per route + status
//   gateway_rate_limit_hits_total     counter     rate limit rejections per route
//   gateway_circuit_state             gauge       0=CLOSED 1=HALF_OPEN 2=OPEN
// ─────────────────────────────────────────────
'use strict';

const client = require('prom-client');

// Collect default Node.js metrics (heap, event loop lag, etc.)
client.collectDefaultMetrics({ prefix: 'gateway_node_' });

// Request duration histogram — used for p50/p95/p99 Grafana panels
const requestDuration = new client.Histogram({
  name:    'gateway_request_duration_seconds',
  help:    'HTTP request duration in seconds',
  labelNames: ['route', 'status', 'upstream'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
});

// Counter for rate limit rejections
const rateLimitHits = new client.Counter({
  name:    'gateway_rate_limit_hits_total',
  help:    'Total number of requests rejected by rate limiter',
  labelNames: ['route'],
});

// Gauge for circuit breaker state: 0=CLOSED, 1=HALF_OPEN, 2=OPEN
const circuitState = new client.Gauge({
  name:    'gateway_circuit_state',
  help:    'Circuit breaker state per route (0=CLOSED 1=HALF_OPEN 2=OPEN)',
  labelNames: ['route'],
});

/**
 * Record a completed proxied request.
 * Also writes to Redis metrics hash for the admin /admin/metrics endpoint.
 *
 * @param {string} route     - path_prefix
 * @param {number} status    - HTTP status code from upstream
 * @param {number} startTime - req.startTime (Date.now() at request start)
 */
async function recordRequest(route, status, startTime) {
  const latencyS = (Date.now() - startTime) / 1000;
  requestDuration.observe({ route, status: String(status) }, latencyS);

  // Also update Redis rolling metrics for the admin dashboard
  // Uses a HASH per route per minute bucket
  const redis  = require('./db/redis');
  const bucket = Math.floor(Date.now() / 60_000);
  const key    = `metrics:${route}:${bucket}`;

  const pipeline = redis.pipeline();
  pipeline.hincrby(key, 'requests',      1);
  pipeline.hincrby(key, 'errors',        status >= 500 ? 1 : 0);
  pipeline.hincrby(key, 'latency_sum',   Math.round(latencyS * 1000)); // store in ms
  pipeline.hincrby(key, 'latency_count', 1);
  pipeline.expire(key, 3600); // 1 hour TTL
  await pipeline.exec();
}

module.exports = { requestDuration, rateLimitHits, circuitState, recordRequest };
