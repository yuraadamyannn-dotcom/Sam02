# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Telegram AI bot "Сэм (Sam)" — a 17-year-old AI persona with multimedia capabilities, group admin features, games, and analytics.

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
- `bot/chat_health.ts` — sentiment tracking, DM offended users, DM admins on conflict, `/chathealth` report
- `bot/interactives.ts` — random polls, would-you-rather, word games, AI trivia for activity boost
- `bot/admin.ts` — Group admin: ban/mute/warn/rules/welcome/custom commands
- `bot/danni.ts` — Analytics: /danni, /danni_chat, /export_data (owner-only). Owner ID from `ADMIN_TELEGRAM_ID` env var.
- `bot/broadcast.ts` — Broadcast system (owner-only global, or group mention in groups)
- `bot/referral.ts` — /invite, /referrals leaderboard, /adduser, /dmlink, /invitestats, captcha for newcomers
- `bot/engagement.ts` — Advanced engagement: rate-limited mass invites, whitelist system, /spam_check, /stats panel, /mention
- `bot/utils/backoff.ts` — Exponential backoff with jitter, timeout wrapper
- `bot/utils/sentiment.ts` — Russian sentiment analysis, conflict detection
- `bot/utils/spam.ts` — Flood detection, spam filter

### Shadow Messages
- `/shadow текст` or `/s текст` — bot deletes the user's command message and sends `🌑 Древние духи гласят: текст` as its own message (true bot-sent shadow). Requires bot to have admin/delete-message permission in groups.
- Inline mode (`@Wuixolllbot текст`) still works but sends via the user (Telegram limitation — inline results always come from the user "via @bot"). Use `/shadow` for true bot-sent messages.

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
- `bot_processed_commands` — command deduplication guard keyed by chat/message ID

### Owner
- Username: @Wuixoll
- ID read from `ADMIN_TELEGRAM_ID` env secret (fallback: 8188102679)
- Access: /danni, /status, /broadcast, /stata, /stats, /spam_check, /whitelist, /add_users
- Bot greets owner as "создатель/владелец" with a special dashboard keyboard on /start

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
- `ADMIN_TELEGRAM_ID` — owner Telegram user ID (used by both TS and Python bots for owner recognition, alerts, admin access)
- `ELEVENLABS_API_KEY` — optional (TS TTS; falls back to no voice if missing)
- `SESSION_SECRET` — Express session
- `DATABASE_URL` — PostgreSQL connection

## Runtime Notes
- **Single workflow**: `Start application` is the ONLY workflow that runs the bot (`BOT_POLLING=true PORT=8080`). The `artifacts/api-server: API Server` artifact workflow is left stopped to avoid port conflicts. Never start both simultaneously.
- The DB schema has been pushed with `pnpm --filter @workspace/db run push`; missing-table errors such as `user_memory` should not occur unless a new database is attached.
- Hybrid memory added in `bot/hybrid_memory.ts`: SQLite guardian prefers `/mnt/data/memory_guardian.db` and falls back to workspace `.data/memory_guardian.db` if `/mnt/data` is unavailable; Qdrant hot memory activates with `QDRANT_URL` + `QDRANT_API_KEY`, and Zilliz cold memory activates with either `ZILLIZ_URL` + `ZILLIZ_API_KEY` or `ZILLIZ_URI` + `ZILLIZ_TOKEN`. Optional `OPENAI_API_KEY` enables `text-embedding-3-small`; without it the bot uses local 384-dimension hash embeddings and keeps working.
- Self-healing added in `bot/code_guardian.ts`: SQLite state prefers `/mnt/data/code_guardian.db` and falls back to workspace `.data/code_guardian.db`, with processed-update dedupe, bot-loop filtering, handler exception capture, memory pressure monitoring, rate limiting, static CodeAnalyzer, patch history, rollback metadata, integration error counters, and owner alerts. Owner commands: `/status`, `/memory_stats`, `/analyze`, `/rollback [patch_id]`.
- Predictive protection: CodeAnalyzer runs at startup and every 30 minutes; RateLimiter protects per-user, per-chat, global, and command bursts; HybridMemory uses SQLite distributed locks for write paths and autoscaler state for latency/storage pressure.

## AI Router (`bot/ai_router.ts`)
- Provider order: **Groq** (5 models: llama-3.3-70b-versatile → llama-3.1-8b-instant → gemma2-9b-it → llama3-70b-8192 → mixtral-8x7b-32768) → **Gemini 2.0 Flash** → **Grok/xAI**
- Each Groq model has its own 2-minute cooldown; if one is rate-limited, the next model is tried automatically
- The `chat()` function in `index.ts` catches all AI errors internally and returns an in-character fallback — the user never sees a raw error message
