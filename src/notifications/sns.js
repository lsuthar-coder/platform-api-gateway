// src/notifications/sns.js
// ─────────────────────────────────────────────
// Publishes circuit breaker trip events to AWS SNS.
//
// Flow:
//   Circuit trips (5 failures in 60s)
//     → publishCircuitTrip()
//       → SNS topic "circuit-trips"
//         → circuit-breaker-handler Lambda (subscribed)
//           → Slack message + OCI log ingest
//
// This is the cross-cloud notification path:
//   OCI K3s → AWS SNS → AWS Lambda → Slack
//
// SNS_TOPIC_ARN comes from K8s Secret (value from Terraform output).
// AWS credentials come from K8s Secret (IAM user with sns:Publish only).
// ─────────────────────────────────────────────
'use strict';

const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const snsClient = new SNSClient({
  region:      process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

/**
 * Publish a circuit breaker trip event to SNS.
 * The Lambda subscriber formats this into a Slack message.
 *
 * @param {object} data
 * @param {string} data.route         - path_prefix that tripped
 * @param {number} data.failureCount  - how many failures triggered the trip
 */
async function publishCircuitTrip(data) {
  if (!process.env.SNS_TOPIC_ARN) {
    // SNS not configured (local dev) — just log
    console.warn(JSON.stringify({ event: 'circuit_trip_no_sns', ...data }));
    return;
  }

  const message = {
    route:        data.route,
    failureCount: data.failureCount,
    timestamp:    new Date().toISOString(),
    environment:  process.env.ENVIRONMENT || 'production',
    // Include the upstream URL for context in the Slack message
    upstreamUrl:  data.upstreamUrl || 'unknown',
  };

  await snsClient.send(new PublishCommand({
    TopicArn: process.env.SNS_TOPIC_ARN,
    Message:  JSON.stringify(message),
    Subject:  `Circuit breaker tripped: ${data.route}`,
  }));

  console.log(JSON.stringify({ event: 'circuit_trip_published', ...data }));
}

module.exports = { publishCircuitTrip };
