// src/tracing.js
// ─────────────────────────────────────────────
// OpenTelemetry auto-instrumentation
// Loaded FIRST via: node -r ./src/tracing.js src/index.js
//
// Must be loaded before any other require() calls.
// Auto-instruments: Express routes, pg queries,
// ioredis calls, http/https outbound requests.
// Exports traces to Grafana Cloud Tempo via OTLP/HTTP.
// ─────────────────────────────────────────────
'use strict';

const { NodeSDK }           = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

// Only enable tracing if OTLP_ENDPOINT is configured.
// This lets the service run locally without a Grafana Cloud account.
if (!process.env.OTLP_ENDPOINT) {
  console.log('OTLP_ENDPOINT not set — tracing disabled');
} else {
  const exporter = new OTLPTraceExporter({
    url: process.env.OTLP_ENDPOINT,   // https://tempo-prod-XX.grafana.net/tempo
    headers: {
      Authorization: 'Basic ' + Buffer.from(
        `${process.env.OTLP_USERNAME}:${process.env.OTLP_PASSWORD}`
      ).toString('base64'),
    },
  });

  const sdk = new NodeSDK({
    serviceName:    process.env.SERVICE_NAME || 'api-gateway',
    traceExporter:  exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // Reduce noise: don't trace health + metrics endpoints
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) =>
            req.url === '/health' || req.url === '/metrics',
        },
      }),
    ],
  });

  sdk.start();
  console.log('OpenTelemetry tracing started');

  // Graceful shutdown: flush pending spans before process exits
  process.on('SIGTERM', () => sdk.shutdown());
}
