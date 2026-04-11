// src/middleware/requestId.js
// ─────────────────────────────────────────────
// Attaches a unique trace ID to every request.
//
// Checks X-Trace-ID header first (so if a client or upstream
// already injected one, we preserve it). Otherwise generates
// a new UUID v4.
//
// The traceId is forwarded to upstream services via the
// X-Trace-ID header (set in the proxyReq handler in index.js).
// This allows correlating Gateway logs with Flag API logs for
// the same originating request.
// ─────────────────────────────────────────────
'use strict';

const { v4: uuidv4 } = require('uuid');

function requestId(req, res, next) {
  req.traceId   = req.headers['x-trace-id'] || uuidv4();
  req.startTime = Date.now();

  // Echo the traceId back in the response so the client can
  // use it when reporting bugs ("my request ID is abc-123")
  res.setHeader('X-Trace-ID', req.traceId);
  next();
}

module.exports = { requestId };
