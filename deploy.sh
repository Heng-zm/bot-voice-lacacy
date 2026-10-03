#!/usr/bin/env bash
set -e

echo "🚀 [DEPLOY] Starting production deployment..."

# Ensure we are in the project directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 1. Pull latest changes if using git
if [ -d ".git" ]; then
    echo "📦 [GIT] Pulling latest updates from git repository..."
    git pull --rebase || true
fi

# 2. Check for .env file
if [ ! -f ".env" ]; then
    echo "❌ [ERROR] .env file not found! Please create .env before deploying."
    exit 1
fi

# 3. Create persistent directories
mkdir -p downloads logs

# 4. Deployment mode detection
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "🐳 [DOCKER] Deploying with Docker Compose..."
    docker compose down --remove-orphans || true
    docker compose build --no-cache
    docker compose up -d
    echo "✅ [DOCKER] Bot deployed successfully in background container!"
    docker compose ps
    echo "📊 Healthcheck: http://localhost:8080/health"
    exit 0
fi

if command -v pm2 >/dev/null 2>&1; then
    echo "⚡ [PM2] Deploying with PM2..."
    npm ci
    npm run build
    pm2 reload ecosystem.config.cjs || pm2 start ecosystem.config.cjs
    pm2 save
    echo "✅ [PM2] Bot deployed successfully with PM2!"
    pm2 status telegram-bot-production
    exit 0
fi

echo "⚠️ Neither Docker Compose nor PM2 found. Building and starting with native Node..."
npm ci
npm run build
nohup node dist/bot.js > logs/bot.log 2>&1 &
echo "✅ [NODE] Bot started in background (PID: $!)"
