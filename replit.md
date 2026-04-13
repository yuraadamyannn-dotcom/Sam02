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

## Environment Variables
- `TELEGRAM_BOT_TOKEN` — required
- `GROQ_API_KEY` — required
- `ELEVENLABS_API_KEY` — optional (TTS; falls back to no voice if missing)
- `SESSION_SECRET` — Express session
- `DATABASE_URL` — PostgreSQL connection
