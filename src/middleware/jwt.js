// src/middleware/jwt.js
// ─────────────────────────────────────────────
// JWT verification middleware
//
// Two exports:
//   fetchPublicKey() — called once at startup, fetches RSA
//     public key from Auth Service and caches it globally.
//   verifyToken      — Express middleware, verifies every
//     incoming Bearer token against the cached public key,
//     then checks Redis blacklist for the token's JTI.
// ─────────────────────────────────────────────
'use strict';

const { jwtVerify, importSPKI } = require('jose');
const redis                      = require('../db/redis');

// Cached public key — fetched once at startup, held in memory.
// When the OCI Function rotates keys, restarting the Gateway pod
// re-runs fetchPublicKey() and picks up the new key automatically.
let publicKey = null;

/**
 * Fetch the RSA public key from Auth Service.
 * Auth Service exposes GET /auth/public-key (no auth required).
 * Gateway uses this key to verify all JWT signatures locally —
 * no Auth Service call needed per request.
 */
async function fetchPublicKey() {
  const url = process.env.AUTH_SERVICE_URL + '/auth/public-key';
  const res  = await fetch(url);

  if (!res.ok) {
    throw new Error(`Failed to fetch public key: HTTP ${res.status}`);
  }

  const { publicKey: pem } = await res.json();
  // importSPKI converts the PEM string into a CryptoKey object
  // that the jose library uses for RS256 verification
  publicKey = await importSPKI(pem, 'RS256');

  // Make it accessible to health check endpoint
  global.jwtPublicKey = publicKey;
  return publicKey;
}

/**
 * Express middleware: verify Bearer token + check Redis blacklist.
 *
 * Attaches to req.user:
 *   { sub: userId, email, role, jti, iat, exp }
 *
 * Short-circuits with 401 on:
 *   - Missing Authorization header
 *   - Invalid token format
 *   - Bad RS256 signature
 *   - Expired token
 *   - Token JTI found in Redis blacklist (logged out)
 */
async function verifyToken(req, res, next) {
  // Extract Bearer token from Authorization header
  const header = req.headers['authorization'];
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = header.split(' ')[1];

  // Verify the RS256 signature using the cached public key
  let payload;
  try {
    const result = await jwtVerify(token, publicKey, { algorithms: ['RS256'] });
    payload = result.payload;
  } catch (err) {
    // jwtVerify throws on bad signature, expired token, wrong algorithm
    return res.status(401).json({ error: 'Invalid token' });
  }

  // Check Redis blacklist using the token's unique JTI (JWT ID).
  // On logout, Auth Service writes: SET blacklist:{jti} "1" EX {remaining_ttl}
  // If the key exists, the token has been revoked — reject even if signature is valid.
  const blacklisted = await redis.exists(`blacklist:${payload.jti}`);
  if (blacklisted) {
    return res.status(401).json({ error: 'Token revoked' });
  }

  // Attach decoded payload to req.user for downstream middleware
  req.user = payload;
  // sub = userId, used as clientId for rate limiting and audit logs
  next();
}

module.exports = { fetchPublicKey, verifyToken };
