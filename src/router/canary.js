// src/router/canary.js
// ─────────────────────────────────────────────
// Upstream URL selection — supports 3 modes:
//
//   1. Static: route.flag_name is null, canary_enabled is false
//      → always use route.upstream_url
//
//   2. Variant (feature flag): route.flag_name is set
//      → call evaluateFlag() on the Feature Flag Service
//      → the flag variant's VALUE is the upstream URL
//      → supports 2, 3, or N versions (not just A/B)
//
//   3. Legacy canary: canary_enabled=true, no flag_name
//      → hash userId % 100 < canary_percentage → upstream_b_url
//      → otherwise upstream_url
//      → kept for backward compatibility
//
// Mode 2 is preferred because the Flag Service centralises
// all routing logic — you control splits from the dashboard
// without touching Gateway config.
// ─────────────────────────────────────────────
'use strict';

/**
 * Select the upstream URL for a request.
 *
 * @param {object} route   - row from routes table
 * @param {object} req     - Express request (req.user.sub = userId)
 * @returns {Promise<string>} upstream URL
 */
async function selectUpstream(route, req) {
  const userId = req.user?.sub || req.ip;

  // ── Mode 2: Variant routing via Feature Flag Service ─────────────────────
  if (route.flag_name) {
    const variant = await evaluateFlag(route.flag_name, { userId });
    if (variant?.value) {
      return variant.value; // variant.value is the upstream URL
    }
    // Fallback to static upstream if flag evaluation fails
    return route.upstream_url;
  }

  // ── Mode 3: Legacy canary (percentage-based, 2 upstreams only) ───────────
  if (route.canary_enabled && route.upstream_b_url) {
    const bucket = hashUserId(userId) % 100;
    return bucket < route.canary_percentage
      ? route.upstream_b_url
      : route.upstream_url;
  }

  // ── Mode 1: Static routing ────────────────────────────────────────────────
  return route.upstream_url;
}

/**
 * Call the Feature Flag Service evaluate endpoint.
 * Returns the variant object: { key, value, reason }
 * variant.value = upstream URL set when creating the flag variants.
 *
 * Falls back to null on any error so the gateway can use
 * the static upstream_url as a safe default.
 */
async function evaluateFlag(flagName, context) {
  try {
    const url = `${process.env.FLAG_SERVICE_URL}/flags/${flagName}/evaluate?userId=${context.userId}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(2000) }); // 2s timeout

    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    console.error(JSON.stringify({
      event:     'flag_eval_failed',
      flag:      flagName,
      error:     err.message,
    }));
    return null;
  }
}

/**
 * Deterministic hash for consistent routing.
 * Same userId always maps to the same 0-9999 bucket.
 * Used by legacy canary mode (% 100) and as the basis
 * for the Feature Flag Service's own evaluation.
 */
function hashUserId(userId) {
  let h = 0;
  for (const c of String(userId)) {
    h = (h * 31 + c.charCodeAt(0)) % 10_000;
  }
  return Math.abs(h);
}

module.exports = { selectUpstream };
