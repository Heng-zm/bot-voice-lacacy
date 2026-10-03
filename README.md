# 🤖 Bot Voice Legacy

> High-Concurrency Telegram Bot powered by Google Gemini AI, Edge TTS, Media Downloader (TikTok, YouTube, Facebook, Instagram), Real-time Temp Mail, Upstash Redis, and Supabase Cloud.

---

## 🌟 Key Features

- **🚀 Concurrent Multi-User Engine:** Non-blocking async queue runner handling 10+ concurrent users with zero lag.
- **🧠 Gemini AI Chat:** Context-aware conversations with memory and language adaptation.
- **🔊 Edge TTS:** High-fidelity text-to-speech conversion supporting multiple languages (Khmer, English, etc.) and gender voices.
- **📥 Media Downloader:** Downloads video/audio from TikTok, YouTube, Facebook, Instagram, Twitter/X, and Pinterest via `yt-dlp` and `ffmpeg` with security guards.
- **📧 Real-time Temp Mail:** Disposable email mailbox generation with automated push notifications for incoming emails and verification codes.
- **⚡ Cloud Infrastructure:**
  - **Upstash Redis:** Fast distributed caching, rate-limiting, and state management.
  - **Supabase PostgreSQL:** Persistent storage for subscribers, settings, and stats.
  - **Built-in Healthcheck API:** HTTP monitoring server on port `8080` (`/health`).

---

## 📋 Bot Commands

| Command | Description |
| :--- | :--- |
| `/start` | 🚀 Open main interactive menu |
| `/chat <prompt>` | 🤖 Chat with Gemini AI |
| `/tts <text>` | 🔊 Convert text to voice speech |
| `/download <url>` | 📥 Download media from TikTok, YouTube, FB, IG |
| `/tempmail` | 📧 Generate disposable email address |
| `/status` | ⚡ Check services health and latency |
| `/clean` | 🧹 Clean bot messages in chat |
| `/donate` | ☕ Support creator via Bakong KHQR |
| `/help` | 💡 Guide and command documentation |
| `/admin` | 👑 Admin dashboard (Authorized IDs only) |

---

## 🛠️ Tech Stack

- **Runtime:** Node.js LTS (v20+)
- **Framework:** TypeScript, [GrammY](https://grammy.dev/)
- **AI:** Google GenAI SDK (`@google/genai`)
- **Speech:** `node-edge-tts`
- **Database:** Supabase (`@supabase/supabase-js`)
- **Cache:** Upstash Redis (`ioredis`)
- **Deployment:** Multi-stage Docker, Docker Compose, PM2, Systemd

---

## 🚀 Getting Started

### 1. Clone Repository
```bash
git clone https://github.com/Heng-zm/bot-voice-lacacy.git
cd bot-voice-lacacy
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your credentials:
```bash
cp .env.example .env
```

Required keys:
```env
BOT_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_or_service_key
REDIS_URL=rediss://default:token@host:port
ADMIN_IDS=123456789
PORT=8080
```

### 3. Run Development Mode
```bash
npm install
npm run dev
```

### 4. Build and Run Production Mode
```bash
npm run build
npm start
```

---

## 🐳 Production Deployment (Docker Compose)

```bash
docker compose up -d --build
```
Check health:
```bash
curl http://localhost:8080/health
```

---

## 📄 License

ISC License
