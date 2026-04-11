-- migrations/001_routes.sql
-- ─────────────────────────────────────────────
-- Creates the routes table used by the API Gateway
-- to determine where to proxy each incoming request.
--
-- Run once against OCI ADB before deploying the Gateway:
--   psql $DATABASE_URL -f migrations/001_routes.sql
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS routes (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- URL prefix matched against incoming request path.
  -- Longest match wins: /flags/admin beats /flags beats /
  path_prefix         VARCHAR(200)  UNIQUE NOT NULL,

  -- Default upstream service URL for this route
  upstream_url        TEXT          NOT NULL,

  -- Max requests per minute per user for this route
  rate_limit_per_min  INTEGER       NOT NULL DEFAULT 60
                                    CHECK (rate_limit_per_min > 0),

  -- ── Canary / variant routing ──────────────────────────────────────────
  -- Option A (legacy): canary_enabled=true with upstream_b_url + percentage
  canary_enabled      BOOLEAN       NOT NULL DEFAULT false,
  upstream_b_url      TEXT,
  canary_percentage   INTEGER       DEFAULT 0
                                    CHECK (canary_percentage BETWEEN 0 AND 100),

  -- Option B (preferred): flag_name links to Feature Flag Service
  -- evaluateFlag(flag_name, {userId}) returns the upstream URL
  -- Supports 2, 3, or N versions — not just A/B
  flag_name           VARCHAR(100),

  -- Human-readable description shown in admin dashboard
  description         TEXT,

  created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW(),

  -- Constraint: if canary_enabled=true, upstream_b_url and percentage are required
  CONSTRAINT canary_requires_upstream
    CHECK (
      NOT canary_enabled
      OR (upstream_b_url IS NOT NULL AND canary_percentage > 0)
    )
);

-- Auto-update updated_at on every row change
CREATE TRIGGER routes_updated_at
  BEFORE UPDATE ON routes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Index for fast prefix matching
CREATE INDEX IF NOT EXISTS idx_routes_prefix
  ON routes (path_prefix);

-- ── Seed initial routes ────────────────────────────────────────────────────
-- These are the routes present from day 1.
-- Add more via POST /admin/routes after the Gateway is running.

INSERT INTO routes (path_prefix, upstream_url, rate_limit_per_min, description)
VALUES
  ('/auth',     'http://auth-service:5000',            20, 'Auth Service — login, register, token management'),
  ('/flags',    'http://feature-flag-service:4000',    60, 'Feature Flag Service — flag reads and management'),
  ('/audio',    'https://audio.yourdomain.com',        10, 'Audio Service on AWS EC2 — video upload + extraction'),
  ('/logs',     'http://log-collector:5001',           30, 'Log Collector — search and live-tail pod logs'),
  ('/services', 'http://k8s-discovery:5002',           30, 'K8s Discovery — pod health + pipeline build status')
ON CONFLICT (path_prefix) DO NOTHING;
