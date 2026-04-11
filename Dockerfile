# Dockerfile
# ─────────────────────────────────────────────
# Multi-stage build for API Gateway.
#
# Stage 1 (builder): installs all dependencies including devDependencies.
# Stage 2 (runtime): copies only production node_modules + source.
#
# Result: smaller final image (no nodemon, no jest, no test files).
# Built for linux/amd64 and linux/arm64 via docker buildx
# so it runs on both OCI AMD VMs and ARM A1 instances.
# ─────────────────────────────────────────────

# ── Stage 1: Install dependencies ────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps) for potential build steps
RUN npm ci

# ── Stage 2: Production runtime ──────────────────────────────────────────
FROM node:20-alpine AS runtime

# Add non-root user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

WORKDIR /app

# Copy only production dependencies from builder stage
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY src/ ./src/

# Set ownership
RUN chown -R appuser:appgroup /app
USER appuser

# Port the service listens on
EXPOSE 3000

# Health check — Kubernetes also does this but useful for docker run
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://localhost:3000/health || exit 1

# Start with tracing.js loaded FIRST via -r flag
# This must be before any other require() calls
CMD ["node", "-r", "./src/tracing.js", "src/index.js"]
