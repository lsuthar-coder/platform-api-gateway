// src/index.js
'use strict';

require('dotenv').config();

const express        = require('express');
const cors           = require('cors');
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

const corsOptions = {
  origin: [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://calm-grass-030e6b700.1.azurestaticapps.net',
    'https://dashboard.lsuthar.in'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

// CORS must be first — before everything including requestId
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(requestId);
app.use(requestLogger);

app.get('/health', async (req, res) => {
  const routes = getRoutes();
  const hasKey = !!global.jwtPublicKey;
  res.json({
    status:         'ok',
    routes_loaded:  routes.length,
    jwt_key_loaded: hasKey,
    redis:          'ok',
    timestamp:      new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.use('/admin', express.json(), adminJwt, adminRouter);

const PUBLIC_ROUTES = [
  '/auth/login',
  '/auth/register',
  '/auth/refresh',
  '/auth/public-key',
  '/.well-known/acme-challenge',
  '/audio/health',
];

app.use(
  (req, res, next) => {
    if (PUBLIC_ROUTES.some(route => req.path === route || req.path.startsWith(route))) {
      return next();
    }
    return jwtMiddleware.verifyToken(req, res, next);
  },
  requireRoute,
  rateLimiter,
  circuitBreaker.check,
  resolveUpstream,
  dynamicProxy,
);

app.use((err, req, res, _next) => {
  console.error(JSON.stringify({
    traceId: req.traceId,
    event:   'unhandled_error',
    error:   err.message,
    path:    req.path,
  }));
  res.status(500).json({ error: 'Internal server error' });
});

function requireRoute(req, res, next) {
  const routes  = getRoutes();
  const matched = routes.find(r => req.path.startsWith(r.path_prefix));
  if (!matched) {
    return res.status(404).json({ error: `No route found for path ${req.path}` });
  }
  req.route = matched;
  next();
}

async function resolveUpstream(req, res, next) {
  try {
    req.upstreamUrl = await selectUpstream(req.route, req);
    next();
  } catch (err) {
    next(err);
  }
}

function dynamicProxy(req, res, next) {
  const target = req.upstreamUrl;

  // Don't strip prefix — upstream services include it in their routes
  // e.g. auth-service has /auth/login, feature-flag-service has /flags/*

  const proxy = createProxyMiddleware({
    target,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq) => {
        proxyReq.setHeader('X-User-ID',    req.user?.sub   || 'anonymous');
        proxyReq.setHeader('X-User-Role',  req.user?.role  || 'anonymous');
        proxyReq.setHeader('X-User-Email', req.user?.email || 'anonymous');
      },
      proxyRes: (proxyRes, req) => {
        const status = proxyRes.statusCode;
        metrics.recordRequest(req.route.path_prefix, status, req.startTime);
        circuitBreaker.recordResult(req.route.path_prefix, status);
      },
      error: (err, req, res) => {
        circuitBreaker.recordResult(req.route.path_prefix, 503);
        res.status(502).json({ error: 'Upstream unreachable', route: req.route.path_prefix });
      },
    },
  });

  proxy(req, res, next);
}

async function start() {
  await fetchPublicKey();
  console.log('JWT public key loaded from Auth Service');

  await loadRoutes();
  console.log(`Routes loaded: ${getRoutes().length}`);

  setInterval(loadRoutes, 30_000);

  app.listen(PORT, () => {
    console.log(JSON.stringify({ event: 'gateway_started', port: PORT }));
  });
}

start().catch(err => {
  console.error('Gateway startup failed:', err);
  process.exit(1);
});