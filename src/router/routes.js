// src/router/routes.js
// ─────────────────────────────────────────────
// Dynamic route table loader.
//
// Routes are stored in the PostgreSQL `routes` table and
// reloaded into memory every 30 seconds. This allows adding,
// updating, or removing routes via the admin API without
// restarting the Gateway pod.
//
// The in-memory table is sorted by path_prefix length DESC
// so longest-prefix matching works correctly:
//   /flags/admin/users   matches /flags/admin  (not /flags)
//   /flags/dark-mode     matches /flags         (not /)
//   /unknown             matches nothing → 404
// ─────────────────────────────────────────────
'use strict';

const db = require('../db/postgres');

// In-memory route table — shared across all requests in this pod
let routes = [];

/**
 * Load all routes from PostgreSQL and sort by prefix length (longest first).
 * Called once at startup and every 30s via setInterval.
 */
async function loadRoutes() {
  try {
    const result = await db.query(`
      SELECT
        id,
        path_prefix,
        upstream_url,
        rate_limit_per_min,
        canary_enabled,
        upstream_b_url,
        canary_percentage,
        flag_name,
        description
      FROM routes
      ORDER BY LENGTH(path_prefix) DESC
    `);

    routes = result.rows;
    console.log(JSON.stringify({
      event:         'routes_reloaded',
      count:         routes.length,
      prefixes:      routes.map(r => r.path_prefix),
    }));
  } catch (err) {
    // Don't crash on reload failure — keep serving with stale routes
    console.error(JSON.stringify({ event: 'routes_reload_failed', error: err.message }));
  }
}

/**
 * Get the current in-memory route table.
 * Used by requireRoute middleware in index.js and by admin routes.
 */
function getRoutes() {
  return routes;
}

module.exports = { loadRoutes, getRoutes };
