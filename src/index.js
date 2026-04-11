// src/index.js
// ─────────────────────────────────────────────
// API Gateway — entry point
// Mounts all middleware in the correct order,
// starts the background route-reload timer,
// and fetches the JWT public key at startup.
// ─────────────────────────────────────────────
'use strict';

require('dotenv').config();

const express        = require('express');
const { loadRoutes, getRoutes } = require('./router/routes');
const { fetchPublicKey }        = require('./middleware/jwt');
const jwtMiddleware              = require('./middleware/jwt');
const rateLimiter                = require('./middleware/rateLimiter');
const circuitBreaker             = require('./middleware/circuitBreaker');
const { selectUpstream }         = require('./router/canary');
const { createProxyMiddleware }  = require('http-proxy-middleware');
const adminRouter                = require('./admin');
const { requestId }              = require('./middleware/requestId');
const { requestLogger }          = require('./middleware/requestLogger');
const { adminJwt }               = require('./middleware/adminJwt');
const metrics                    = require('./metrics');
const { register }               = require('prom-client');

const app  = express();
const PORT = process.env.PORT || 3000;


// ── Step 1: Attach a unique traceId to every request ──────────────────────
// Generates a UUID and sets req.traceId + X-Trace-ID response header.
// Every downstream service receives this header — used to correlate logs.
app.use(requestId);

// ── Step 2: Log request start ─────────────────────────────────────────────
app.use(requestLogger);

// ── System endpoints (no auth, no middleware chain) ───────────────────────
app.get('/health', async (req, res) => {
  const routes  = getRoutes();
  const hasKey  = !!global.jwtPublicKey;
  res.json({
    status:       'ok',
    routes_loaded: routes.length,
    jwt_key_loaded: hasKey,
    redis:        'ok',
    timestamp:    new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ── Admin routes (separate admin JWT check, not the user JWT) ─────────────
// Admin JWT check is stricter: requires role === 'admin' in the token.
// Mounted before the catch-all proxy so /admin/* is never proxied upstream.
app.use('/admin', express.json(), adminJwt, adminRouter);

// ── Catch-all proxy — the main gateway logic ──────────────────────────────
// Every other request runs through the full middleware chain.
// Order matters: JWT → route match → rate limit → circuit breaker → proxy.
app.use(
  // Skip JWT for public routes
  (req, res, next) => {
    if (PUBLIC_ROUTES.some(route => req.path === route || req.path.startsWith(route))) {
      return next();
    }
    return jwtMiddleware.verifyToken(req, res, next);
  },

  // Step 4: Match request path to a route row from PostgreSQL
  // Attaches req.route = { path_prefix, upstream_url, rate_limit_per_min, flag_name, ... }
  // Returns 404 if no route matches.
  requireRoute,

  // Step 5: Rate limiting — Redis sliding-window counter per userId per minute
  rateLimiter,

  // Step 6: Circuit breaker — check cb:{route}:state in Redis
  // CLOSED → proceed. OPEN → 503. HALF_OPEN → let one probe through.
  circuitBreaker.check,

  // Step 7: Variant/canary routing — pick upstream URL
  // If route.flag_name is set: call evaluateFlag() to get the upstream URL.
  // Otherwise: use route.upstream_url directly (or canary % split if configured).
  resolveUpstream,

  // Step 8: Proxy to the selected upstream
  dynamicProxy,
);

// ── Error handler ──────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error(JSON.stringify({
    traceId: req.traceId,
    event:   'unhandled_error',
    error:   err.message,
    path:    req.path,
  }));
  res.status(500).json({ error: 'Internal server error' });
});

// Public routes — skip JWT verification
const PUBLIC_ROUTES = [
  '/auth/login',
  '/auth/register', 
  '/auth/refresh',
  '/auth/public-key',
];

function requireRoute(req, res, next) {
  const routes = getRoutes();
  const matched = routes.find(r => req.path.startsWith(r.path_prefix));
  if (!matched) {
    return res.status(404).json({ error: `No route found for path ${req.path}` });
  }
  req.route = matched;
  next();
}

// resolveUpstream: sets req.upstreamUrl based on flag or static config
async function resolveUpstream(req, res, next) {
  try {
    req.upstreamUrl = await selectUpstream(req.route, req);
    next();
  } catch (err) {
    next(err);
  }
}

// dynamicProxy: creates a one-shot proxy to req.upstreamUrl
// http-proxy-middleware is called per-request so the target can change each time.
function dynamicProxy(req, res, next) {
  const target = req.upstreamUrl;

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq) => {
        // Forward the trace ID so upstream services can log it
        proxyReq.setHeader('X-User-ID',    req.user?.sub   || 'anonymous');
proxyReq.setHeader('X-User-Role',  req.user?.role  || 'anonymous');
proxyReq.setHeader('X-User-Email', req.user?.email || 'anonymous');
      },
      proxyRes: (proxyRes, req) => {
        const status = proxyRes.statusCode;

        // Record response metrics
        metrics.recordRequest(req.route.path_prefix, status, req.startTime);

        // Feed result back to circuit breaker
        // 5xx responses increment the failure counter
        circuitBreaker.recordResult(req.route.path_prefix, status);
      },
      error: (err, req, res) => {
        // Upstream is unreachable — treat as a failure
        circuitBreaker.recordResult(req.route.path_prefix, 503);
        res.status(502).json({ error: 'Upstream unreachable', route: req.route.path_prefix });
      },
    },
  });

  proxy(req, res, next);
}

// ── Startup sequence ───────────────────────────────────────────────────────
async function start() {
  // 1. Fetch JWT public key from Auth Service
  //    Gateway uses this to verify all Bearer tokens without calling Auth Service per request.
  await fetchPublicKey();
  console.log('JWT public key loaded from Auth Service');

  // 2. Load routes from PostgreSQL into memory
  await loadRoutes();
  console.log(`Routes loaded: ${getRoutes().length}`);

  // 3. Reload routes every 30 seconds (background timer)
  //    Allows adding/updating routes via admin API without restarting the pod.
  setInterval(loadRoutes, 30_000);

  // 4. Start HTTP server
  app.listen(PORT, () => {
    console.log(JSON.stringify({ event: 'gateway_started', port: PORT }));
  });
}

start().catch(err => {
  console.error('Gateway startup failed:', err);
  process.exit(1);
});
