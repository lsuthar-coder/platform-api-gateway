// src/middleware/adminJwt.js
// ─────────────────────────────────────────────
// Admin JWT middleware — extends the regular JWT check
// by also requiring role === 'admin' in the token payload.
//
// Used on all /admin/* routes.
// Runs BEFORE the regular jwtMiddleware in the chain because
// admin routes are mounted separately in index.js.
// ─────────────────────────────────────────────
'use strict';

const { verifyToken } = require('./jwt');

async function adminJwt(req, res, next) {
  // First run the regular JWT verification
  // This populates req.user if valid
  await verifyToken(req, res, async () => {
    // Then check the role claim inside the token
    if (req.user.role !== 'admin') {
      return res.status(403).json({
        error: 'Admin access required',
      });
    }
    next();
  });
}

module.exports = { adminJwt };
