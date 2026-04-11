// src/middleware/requestLogger.js
// ─────────────────────────────────────────────
// Structured JSON request logger.
//
// Logs on response finish (not on request arrival) so we have
// the status code and latency available.
//
// Output format (one JSON line per request):
// {
//   "event":     "request",
//   "traceId":   "abc-123",
//   "method":    "GET",
//   "path":      "/flags/dark-mode/evaluate",
//   "status":    200,
//   "latencyMs": 14,
//   "userId":    "user_123",     // from JWT (if authenticated)
//   "upstream":  "http://...",   // which service we proxied to
//   "timestamp": "2024-..."
// }
//
// These lines are collected by the Log Collector pod, which
// streams stdout from all K3s pods and stores them in PostgreSQL.
// ─────────────────────────────────────────────
'use strict';

function requestLogger(req, res, next) {
  // Log after the response is sent (so we have status + latency)
  res.on('finish', () => {
    const log = {
      event:     'request',
      traceId:   req.traceId,
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      latencyMs: Date.now() - req.startTime,
      userId:    req.user?.sub || 'anonymous',
      upstream:  req.upstreamUrl || null,
      timestamp: new Date().toISOString(),
    };
    console.log(JSON.stringify(log));
  });
  next();
}

module.exports = { requestLogger };
