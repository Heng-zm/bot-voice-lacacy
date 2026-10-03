# ==========================================
# STAGE 1: Build Application
# ==========================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# Install Python & build requirements for npm packages with post-install checks (e.g. yt-dlp-exec)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    && rm -rf /var/lib/apt/lists/*

# Copy package descriptors including committed package-lock.json
COPY package*.json tsconfig.json ./

# Deterministic dependency installation
RUN npm ci

# Copy source code and assets
COPY src/ ./src/
COPY assets/ ./assets/

# Build TypeScript to dist/
RUN npm run build

# Remove development dependencies to keep production footprint minimal
RUN npm prune --omit=dev

# ==========================================
# STAGE 2: Production Runtime
# ==========================================
FROM node:20-bookworm-slim AS runner

WORKDIR /app

# Install system dependencies required for production:
# - python3 & python-is-python3: Required by yt-dlp to download media (TikTok, YouTube, FB, etc.)
# - ffmpeg: Audio/Video processing and format conversion
# - ca-certificates: TLS/SSL verification for Cloud APIs
# - curl: Container health checks
# - dumb-init: PID 1 signal forwarding and zombie process reaping
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    ffmpeg \
    ca-certificates \
    curl \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set production environment variables
ENV NODE_ENV=production \
    PORT=8080 \
    PUPPETEER_SKIP_DOWNLOAD=true

# Copy built code and production node_modules from builder
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules/ ./node_modules/
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/assets/ ./assets/

# Create persistent runtime directories and set proper ownership
RUN mkdir -p /app/downloads /app/logs \
    && chown -R node:node /app

# Switch to non-root user for security
USER node

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Expose HTTP health check / monitoring port
EXPOSE 8080

# dumb-init handles process signals (SIGINT, SIGTERM) cleanly for graceful bot shutdown
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "dist/bot.js"]
