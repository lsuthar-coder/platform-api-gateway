# API Gateway

Production-grade API Gateway for the lsuthar.in platform. Routes requests across Auth, Feature Flag, and Audio services with JWT verification, rate limiting, circuit breaking, and canary deployments driven by feature flags.

**Live:** https://api.lsuthar.in/health

---

## Architecture

```
Client → Nginx Ingress → API Gateway → Auth Service      (http://auth-service:5000/auth)
                                     → Feature Flag Svc  (http://feature-flag-service:4000/flags)
                                     → Audio Service     (http://13.63.189.209:3001)
```

## Middleware Pipeline

```
requestId → requestLogger → CORS → jwtVerify → requireRoute → rateLimiter → circuitBreaker → resolveUpstream → dynamicProxy
```

## Features

- **JWT Verification** — RS256 public key fetched from Auth Service at startup
- **Dynamic Routing** — Routes loaded from PostgreSQL, reloaded every 30s (zero downtime)
- **Rate Limiting** — Redis sliding-window counter per user per minute per route
- **Circuit Breaker** — CLOSED / OPEN / HALF_OPEN states per upstream, stored in Redis
- **Canary Routing** — Feature flag-driven upstream selection for A/B deployments
- **Path Rewrite** — Strips route prefix before proxying to upstream
- **Prometheus Metrics** — Exposed at `/metrics` for Grafana scraping
- **Admin API** — Protected admin routes for runtime route management

## Public Routes (no JWT required)

| Path | Description |
|------|-------------|
| `POST /auth/login` | User login |
| `POST /auth/register` | User registration |
| `POST /auth/refresh` | Token refresh |
| `GET /auth/public-key` | JWT public key |
| `GET /audio/health` | Audio service health |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `REDIS_URL` | Redis connection URL |
| `AUTH_SERVICE_URL` | Auth service URL for public key fetch |
| `FLAG_SERVICE_URL` | Feature flag service URL |
| `PORT` | Server port (default: 3000) |

## Local Development

```bash
npm install
cp .env.example .env
npm start
```

## Docker

```bash
docker buildx build --platform linux/amd64 -t ghcr.io/lsuthar-coder/api-gateway:v3 --push .
```

## Deployment

Deployed on **Civo K8s** (MUM1 region) via **Azure Pipelines** CI/CD.

```bash
kubectl set image deployment/api-gateway api=ghcr.io/lsuthar-coder/api-gateway:v3
kubectl rollout status deployment/api-gateway
```

## Tech Stack

- Node.js + Express
- http-proxy-middleware v3
- ioredis
- pg (PostgreSQL)
- prom-client
- jsonwebtoken (RS256)
