# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Telegram AI bot "Сэм (Sam)" — a 20-year-old AI persona with multimedia capabilities, group admin features, games, and analytics.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **Build**: esbuild (ESM bundle)

## Key Commands

- `pnpm --filter @workspace/db run push` — push DB schema changes
- `pnpm --filter @workspace/api-server run dev` — run API server locally

## Bot Architecture

### Entry point
`artifacts/api-server/src/bot/index.ts` — main bot handlers, chat logic, tag processing

### Modules
- `bot/music.ts` — YouTube search (Invidious API), lyrics (some-random-api)
- `bot/games.ts` — Duel, Marriage, Mafia (in-memory state + DB)
- `bot/admin.ts` — Group admin: ban/mute/warn/rules/welcome/custom commands
- `bot/danni.ts` — Analytics: /danni, /danni_chat, /export_data (owner-only)
- `bot/broadcast.ts` — Broadcast system (owner-only)
- `bot/utils/backoff.ts` — Exponential backoff with jitter, timeout wrapper
- `bot/utils/sentiment.ts` — Russian sentiment analysis, conflict detection
- `bot/utils/spam.ts` — Flood detection, spam filter

### AI
- **Chat**: Groq `llama-3.3-70b-versatile` (text, 30s timeout, 4 retries)
- **Vision**: Groq `meta-llama/llama-4-scout-17b-16e-instruct` (photos, video frames)
- **STT**: Groq `whisper-large-v3` (voice/video audio, 120s timeout)
- **TTS**: ElevenLabs `eleven_multilingual_v2`, voice Adam (young male)
- **Image gen**: Pollinations.ai flux model (prompt-enhanced, 60s timeout)

### DB Tables
- `telegram_users` — user profiles + message count
- `user_memory` — per-user persistent memory (name, interests, summary, notes)
- `scheduled_messages` — proactive follow-up scheduler
- `bot_stickers` — sticker library (learned from users)
- `group_settings` — per-group rules + welcome message
- `group_commands` — custom trigger→response commands per group
- `group_warnings` — user warning history (3 warnings = autoban)
- `marriages` — marriage records
- `bot_chats` — all chats bot is in (for broadcast)
- `user_analytics` — per-user-per-chat activity + sentiment
- `message_log` — recent message log for conflict analysis (last 500/chat)
- `moderation_config` — per-group moderation settings

### Owner
- Username: @Wuixoll, ID: 8188102679
- Access: /danni, /status, /broadcast

## Python Failover Bot (`bot/`)

Standalone Python Telegram bot with intelligent Gemini↔Grok API failover.

### Run
```bash
cd bot && python3 main.py
```

### Architecture
- `bot/api_manager.py` — core failover engine (circuit breaker, health checks, smart routing)
- `bot/config.py` — env config loader
- `bot/handlers/text.py` — text, translate, summarize, code gen, URL analysis
- `bot/handlers/voice.py` — STT (Gemini/Groq Whisper) + TTS (gTTS)
- `bot/handlers/image.py` — image analysis, OCR
- `bot/handlers/music.py` — song identification by lyrics/description
- `bot/utils/cache.py` — in-memory LRU cache (TTL 1h)
- `bot/utils/logger.py` — logging + Telegram admin alerts
- `bot/utils/retry.py` — exponential backoff with jitter

### Failover Logic
- Priority: Gemini (primary) → Grok (fallback)
- Circuit breaker: 3 failures → 60s block → auto-recover
- Health checks every 30s
- Smart routing: 70/30 load split; quality tasks → Gemini Pro; speed → faster API
- Admin alert after 5min downtime

### Python Dependencies
```
python-telegram-bot==21.10, google-generativeai==0.8.5, openai==1.82.0, groq==0.26.0, gTTS==2.5.4
```

## Environment Variables
- `TELEGRAM_BOT_TOKEN` — required (both bots)
- `GROQ_API_KEY` — required (TS bot + Python STT fallback)
- `GEMINI_API_KEY` — required for Python bot (primary AI)
- `GROK_API_KEY` — required for Python bot (fallback AI)
- `ADMIN_TELEGRAM_ID` — optional (Python bot: downtime alerts)
- `ELEVENLABS_API_KEY` — optional (TS TTS; falls back to no voice if missing)
- `SESSION_SECRET` — Express session
- `DATABASE_URL` — PostgreSQL connection
