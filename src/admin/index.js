// src/admin/index.js
// ─────────────────────────────────────────────
// Admin routes — all require admin JWT (enforced by adminJwt
// middleware mounted in index.js before this router).
//
// Routes:
//   GET  /admin/routes              list all routes + CB state
//   POST /admin/routes              add new route
//   PUT  /admin/routes/:id          update route
//   DELETE /admin/routes/:id        remove route
//   GET  /admin/circuit             all circuit states
//   POST /admin/circuit/:route/reset  manually reset CB to CLOSED
//   GET  /admin/metrics             per-route traffic last 60min
// ─────────────────────────────────────────────
'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/postgres');
const redis   = require('../db/redis');
const { getRoutes } = require('../router/routes');

// ── GET /admin/routes ──────────────────────────────────────────────────────
// Returns all routes merged with their live circuit state and last-hour stats.
// Used by the Gateway tab RouteTable in the dashboard.
router.get('/routes', async (req, res) => {
  try {
    const routes = getRoutes(); // current in-memory table

    // Enrich each route with live circuit state from Redis
    const enriched = await Promise.all(routes.map(async (route) => {
      const key   = route.path_prefix;
      const state = await redis.get(`cb:${key}:state`) || 'CLOSED';
      const failures = parseInt(await redis.get(`cb:${key}:failures`) || '0');
      const trippedAt = await redis.get(`cb:${key}:tripped_at`);

      // Get last-hour request count from metrics hash
      const bucket = Math.floor(Date.now() / 60_000);
      let requestsLastHour = 0;
      let errorsLastHour   = 0;
      for (let i = 0; i < 60; i++) {
        const data = await redis.hgetall(`metrics:${key}:${bucket - i}`);
        if (data) {
          requestsLastHour += parseInt(data.requests || '0');
          errorsLastHour   += parseInt(data.errors   || '0');
        }
      }

      return {
        ...route,
        circuit_state:       state,
        circuit_failures:    failures,
        circuit_tripped_at:  trippedAt ? new Date(parseInt(trippedAt)).toISOString() : null,
        requests_last_hour:  requestsLastHour,
        errors_last_hour:    errorsLastHour,
      };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/routes ─────────────────────────────────────────────────────
// Add a new route. Takes effect within 30 seconds (next reload cycle).
router.post('/routes', async (req, res) => {
  const {
    path_prefix,
    upstream_url,
    rate_limit_per_min = 60,
    canary_enabled     = false,
    upstream_b_url     = null,
    canary_percentage  = 0,
    flag_name          = null,
    description        = null,
  } = req.body;

  // Validate required fields
  if (!path_prefix || !upstream_url) {
    return res.status(400).json({ error: 'path_prefix and upstream_url are required' });
  }

  // Validate canary constraint: upstream_b_url required if canary_enabled
  if (canary_enabled && (!upstream_b_url || canary_percentage <= 0)) {
    return res.status(400).json({
      error: 'upstream_b_url and canary_percentage > 0 required when canary_enabled=true',
    });
  }

  try {
    const result = await db.query(`
      INSERT INTO routes
        (path_prefix, upstream_url, rate_limit_per_min,
         canary_enabled, upstream_b_url, canary_percentage,
         flag_name, description)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      RETURNING *
    `, [path_prefix, upstream_url, rate_limit_per_min,
        canary_enabled, upstream_b_url, canary_percentage,
        flag_name, description]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') { // unique violation on path_prefix
      return res.status(409).json({ error: 'Route with this path_prefix already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /admin/routes/:id ──────────────────────────────────────────────────
// Update an existing route. Takes effect within 30 seconds.
router.put('/routes/:id', async (req, res) => {
  const { id } = req.params;
  const fields  = req.body;

  // Build dynamic SET clause from provided fields only
  const allowed  = ['upstream_url','rate_limit_per_min','canary_enabled',
                     'upstream_b_url','canary_percentage','flag_name','description'];
  const updates  = [];
  const values   = [];
  let   paramIdx = 1;

  for (const field of allowed) {
    if (field in fields) {
      updates.push(`${field} = $${paramIdx++}`);
      values.push(fields[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  values.push(id);
  try {
    const result = await db.query(
      `UPDATE routes SET ${updates.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
      values
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Route not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /admin/routes/:id ───────────────────────────────────────────────
// Remove a route. Requests to that path_prefix return 404 within 30 seconds.
router.delete('/routes/:id', async (req, res) => {
  const { id } = req.params;
  try {
    // Get path_prefix before deleting (needed to clear Redis CB keys)
    const existing = await db.query('SELECT path_prefix FROM routes WHERE id=$1', [id]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Route not found' });

    await db.query('DELETE FROM routes WHERE id=$1', [id]);

    // Clean up circuit breaker keys for this route
    const prefix = existing.rows[0].path_prefix;
    await redis.del(`cb:${prefix}:state`);
    await redis.del(`cb:${prefix}:failures`);
    await redis.del(`cb:${prefix}:tripped_at`);

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/circuit ─────────────────────────────────────────────────────
// Current circuit breaker state for every route.
// Used by the dashboard Gateway tab to show CB state badges.
router.get('/circuit', async (req, res) => {
  try {
    const routes = getRoutes();
    const states = await Promise.all(routes.map(async (route) => {
      const key       = route.path_prefix;
      const state     = await redis.get(`cb:${key}:state`) || 'CLOSED';
      const failures  = parseInt(await redis.get(`cb:${key}:failures`) || '0');
      const trippedAt = await redis.get(`cb:${key}:tripped_at`);

      return {
        route:      key,
        state,
        failures,
        tripped_at: trippedAt ? new Date(parseInt(trippedAt)).toISOString() : null,
      };
    }));

    res.json(states);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /admin/circuit/:route/reset ──────────────────────────────────────
// Manually reset a circuit to CLOSED.
// Used when you've fixed the upstream and don't want to wait
// for the 30-second HALF_OPEN probe window.
router.post('/circuit/:route/reset', async (req, res) => {
  // :route param comes URL-encoded — decode and add leading slash
  const routeKey = '/' + decodeURIComponent(req.params.route);

  try {
    await redis.del(`cb:${routeKey}:state`);
    await redis.del(`cb:${routeKey}:failures`);
    await redis.del(`cb:${routeKey}:tripped_at`);

    res.json({ message: `Circuit reset for ${routeKey}`, state: 'CLOSED' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /admin/metrics ─────────────────────────────────────────────────────
// Per-route traffic data for the last 60 minutes.
// Returns 60 data points per route — used by TrafficChart in the dashboard.
router.get('/metrics', async (req, res) => {
  try {
    const routes  = getRoutes();
    const bucket  = Math.floor(Date.now() / 60_000);
    const result  = {};

    for (const route of routes) {
      const key    = route.path_prefix;
      result[key]  = [];

      for (let i = 59; i >= 0; i--) {
        const b    = bucket - i;
        const data = await redis.hgetall(`metrics:${key}:${b}`);
        const min  = new Date(b * 60_000).toISOString().slice(11, 16); // HH:MM

        result[key].push({
          minute:        min,
          requests:      parseInt(data?.requests     || '0'),
          errors:        parseInt(data?.errors       || '0'),
          avg_latency_ms: data?.latency_count > 0
            ? Math.round(parseInt(data.latency_sum) / parseInt(data.latency_count))
            : 0,
        });
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
