// src/db/postgres.js
// ─────────────────────────────────────────────
// PostgreSQL connection pool using node-postgres (pg).
//
// The Gateway only reads one table: routes.
// All other tables (flags, users, logs) are owned by their
// respective services and never accessed by the Gateway.
//
// Connection string comes from DATABASE_URL env var:
//   postgresql://ADMIN:password@host/DBNAME?sslmode=require
// This is stored in the K8s Secret 'api-gateway-secrets'
// and injected as an environment variable via secretRef in
// the Helm chart deployment.yaml.
// ─────────────────────────────────────────────
'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max:              5,    // keep small — Gateway only reads routes table
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  ssl: { rejectUnauthorized: false }, // OCI ADB requires SSL
});

pool.on('error', (err) => {
  console.error(JSON.stringify({ event: 'pg_pool_error', error: err.message }));
});

module.exports = pool;
