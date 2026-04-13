/**
 * chat_memory.ts — group atmosphere tracker
 *
 * Records global chat events (conflicts, rule changes, member add/remove,
 * admin disputes, mood shifts) and generates a chat dossier on demand.
 * Sam uses this context to understand what's happening in a group.
 */

import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { db } from "@workspace/db";
import { chatEventsTable } from "@workspace/db";
import { eq, desc, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { withRetry } from "./utils/backoff";
import { analyzeSentiment } from "./utils/sentiment";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

// ─── Types ────────────────────────────────────────────────────────────────────

type EventType =
  | "rule_change" | "member_add" | "member_remove"
  | "conflict" | "admin_dispute" | "mood_shift"
  | "ban" | "mute" | "warn" | "marriage" | "divorce"
  | "mafia" | "broadcast" | "spam_detected" | "mass_join";

interface Participant { id: number; name: string; }

// ─── Event recording ──────────────────────────────────────────────────────────

export async function recordChatEvent(
  chatId: number,
  type: EventType,
  description: string,
  participants: Participant[] = [],
  severity = 1,
  context?: string,
): Promise<void> {
  try {
    await db.insert(chatEventsTable).values({
      chatId, eventType: type, description,
      participantsJson: JSON.stringify(participants),
      severity: Math.max(1, Math.min(10, severity)),
      context: context ?? null,
      resolved: false,
    });
  } catch (err) {
    logger.error({ err }, "recordChatEvent failed");
  }
}

// ─── Mark event resolved ──────────────────────────────────────────────────────

export async function resolveLastConflict(chatId: number): Promise<void> {
  try {
    const [last] = await db.select({ id: chatEventsTable.id })
      .from(chatEventsTable)
      .where(eq(chatEventsTable.chatId, chatId))
      .orderBy(desc(chatEventsTable.recordedAt))
      .limit(1);
    if (last) {
      await db.update(chatEventsTable)
        .set({ resolved: true })
        .where(eq(chatEventsTable.id, last.id));
    }
  } catch { /* Non-critical */ }
}

// ─── In-memory recent messages for atmosphere analysis ────────────────────────

interface RecentMsg {
  userId: number; name: string; text: string; sentiment: number; ts: number;
}
const recentMsgs = new Map<number, RecentMsg[]>(); // chatId → msgs
const WINDOW = 50;

export function feedAtmosphereMsg(
  chatId: number, userId: number, name: string, text: string
): void {
  const buf = recentMsgs.get(chatId) ?? [];
  buf.push({ userId, name, text, sentiment: analyzeSentiment(text), ts: Date.now() });
  if (buf.length > WINDOW) buf.shift();
  recentMsgs.set(chatId, buf);
}

// ─── Atmosphere analysis (Groq, runs every N new messages) ───────────────────

const atmosphereCounter = new Map<number, number>();
const ATMOSPHERE_TRIGGER = 20;
const lastAtmosphere = new Map<number, { mood: string; ts: number }>();

export function shouldRunAtmosphereAnalysis(chatId: number): boolean {
  const n = (atmosphereCounter.get(chatId) ?? 0) + 1;
  atmosphereCounter.set(chatId, n);
  return n % ATMOSPHERE_TRIGGER === 0;
}

export async function analyzeAtmosphere(chatId: number): Promise<void> {
  try {
    const msgs = recentMsgs.get(chatId) ?? [];
    if (msgs.length < 5) return;

    const sample = msgs.slice(-30).map(m => `${m.name}: ${m.text}`).join("\n");
    const avgSent = msgs.reduce((s, m) => s + m.sentiment, 0) / msgs.length;

    const resp = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: `Ты — психолог-аналитик. Проанализируй последние ${msgs.length} сообщений из Telegram-чата.

Сообщения:
${sample}

Средний сентимент: ${avgSent.toFixed(2)} (-1=очень негативно, +1=очень позитивно)

Ответь JSON:
{
  "mood": "одно слово [calm/heated/playful/tense/productive/chaotic/quiet/grieving/celebratory]",
  "mood_ru": "описание настроения по-русски (1 предложение)",
  "notable": "что важного произошло или изменилось в чате (1-2 предложения, или null если ничего особого)",
  "risk": число от 0 до 10 (риск конфликта),
  "recommendation": "что стоит сделать боту-модератору (1 предложение, или null)"
}` }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    }), { label: "atmosphere" });

    const data = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
      mood?: string; mood_ru?: string; notable?: string;
      risk?: number; recommendation?: string;
    };

    lastAtmosphere.set(chatId, { mood: data.mood ?? "calm", ts: Date.now() });

    if (data.notable && data.notable !== "null") {
      await recordChatEvent(
        chatId, "mood_shift",
        data.mood_ru ?? data.notable,
        [], Math.round(data.risk ?? 1),
        data.notable,
      );
    }

    logger.info({ chatId, mood: data.mood, risk: data.risk }, "Atmosphere analyzed");
  } catch (err) {
    logger.error({ err }, "Atmosphere analysis failed");
  }
}

// ─── Get current atmosphere ───────────────────────────────────────────────────

export function getCurrentMood(chatId: number): string {
  const a = lastAtmosphere.get(chatId);
  if (!a) return "calm";
  // Expire after 30 minutes
  if (Date.now() - a.ts > 30 * 60_000) return "calm";
  return a.mood;
}

// ─── Get chat dossier ─────────────────────────────────────────────────────────

export async function getChatDossier(bot: TelegramBot, chatId: number): Promise<string> {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000);

  const events = await db.select().from(chatEventsTable)
    .where(eq(chatEventsTable.chatId, chatId))
    .orderBy(desc(chatEventsTable.recordedAt))
    .limit(100);

  const weekEvents = events.filter(e => e.recordedAt >= weekAgo);
  const allEvents = events;

  if (!allEvents.length) {
    return `📋 <b>Досье чата</b>\n\nСобытий пока не записано — нужно время для анализа.`;
  }

  // Count by type
  const counts: Record<string, number> = {};
  for (const e of allEvents) {
    counts[e.eventType] = (counts[e.eventType] ?? 0) + 1;
  }

  const EVENT_EMOJI: Record<string, string> = {
    conflict: "⚔️", ban: "🔨", mute: "🔇", warn: "⚠️",
    member_add: "➕", member_remove: "➖", rule_change: "📋",
    admin_dispute: "🛡", mood_shift: "🌡", marriage: "💍",
    divorce: "💔", mafia: "🎭", spam_detected: "🚫",
  };

  const countLines = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, cnt]) => `${EVENT_EMOJI[type] ?? "•"} ${type}: ${cnt}`)
    .join("\n");

  // Recent 5 events
  const recent = allEvents.slice(0, 5).map(e => {
    const d = new Date(e.recordedAt);
    const dateStr = `${d.getDate()}.${d.getMonth() + 1}`;
    const emoji = EVENT_EMOJI[e.eventType] ?? "•";
    const resolved = e.resolved ? " ✅" : "";
    return `${emoji} [${dateStr}] ${e.description}${resolved}`;
  }).join("\n");

  // Week stats
  const weekConflicts = weekEvents.filter(e => e.eventType === "conflict" || e.eventType === "admin_dispute").length;
  const weekBans = weekEvents.filter(e => e.eventType === "ban").length;
  const weekJoins = weekEvents.filter(e => e.eventType === "member_add").length;
  const weekLeaves = weekEvents.filter(e => e.eventType === "member_remove").length;

  const mood = getCurrentMood(chatId);
  const MOOD_EMOJI: Record<string, string> = {
    calm: "😌", heated: "🔥", playful: "🎭", tense: "😤",
    productive: "💡", chaotic: "🌀", quiet: "🤫", grieving: "💔",
    celebratory: "🎉",
  };

  return [
    `📋 <b>Досье чата</b>`,
    ``,
    `🌡 <b>Текущее настроение:</b> ${MOOD_EMOJI[mood] ?? "•"} ${mood}`,
    ``,
    `<b>Неделя:</b>`,
    `⚔️ Конфликтов: ${weekConflicts}`,
    `🔨 Банов: ${weekBans}`,
    `➕ Вошли: ${weekJoins}  ➖ Вышли: ${weekLeaves}`,
    ``,
    `<b>За всё время (${allEvents.length} событий):</b>`,
    countLines,
    ``,
    `<b>Последние события:</b>`,
    recent,
  ].join("\n");
}

// ─── /chat_dossier command ────────────────────────────────────────────────────

export async function handleChatDossier(
  bot: TelegramBot, msg: TelegramBot.Message
): Promise<void> {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "это команда только для групп");
    return;
  }
  try {
    const dossier = await getChatDossier(bot, chatId);
    await bot.sendMessage(chatId, dossier, { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "handleChatDossier failed");
    await bot.sendMessage(chatId, "не смог собрать досье, попробуй позже");
  }
}

// ─── Self-governance: Sam reads the chat and reacts ──────────────────────────

type SelfGovAction = "none" | "warn_user" | "mute_user" | "delete_msg" | "calm_down" | "alert_admin";

interface SelfGovDecision {
  action: SelfGovAction;
  userId?: number;
  reason: string;
  samMessage?: string;
}

export async function selfGovernanceCheck(
  chatId: number,
  msg: TelegramBot.Message,
  rules: string | null,
): Promise<SelfGovDecision> {
  const msgs = recentMsgs.get(chatId) ?? [];
  if (msgs.length < 2) return { action: "none", reason: "not enough context" };

  const recentSample = msgs.slice(-15).map(m => `${m.name}: ${m.text}`).join("\n");
  const rulesSection = rules ? `\nПравила чата:\n${rules}\n` : "";
  const currentMsg = `${msg.from?.first_name ?? "User"}: ${msg.text ?? ""}`;

  const prompt = `Ты — интеллектуальный модератор Telegram-чата. Определи, нужно ли вмешаться.
${rulesSection}
Последние сообщения:
${recentSample}

Текущее сообщение:
${currentMsg}

Проверь:
1. Нарушение правил (спам, токсичность, оскорбления, угрозы, нежелательный контент)
2. Нарушение норм морали (не обязательно в правилах, но явно неприемлемо)
3. Эскалация конфликта
4. Дискомфорт участников

Если всё нормально — action: "none".

Ответь JSON:
{
  "action": "none" | "warn_user" | "mute_user" | "delete_msg" | "calm_down" | "alert_admin",
  "reason": "короткая причина или null",
  "sam_message": "что Сэм напишет в чат (неформально, как живой друг, без официоза) или null"
}`;

  try {
    const resp = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
      response_format: { type: "json_object" },
    }), { label: "self-gov" });

    const data = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
      action?: string; reason?: string; sam_message?: string;
    };

    return {
      action: (data.action as SelfGovAction) ?? "none",
      userId: msg.from?.id,
      reason: data.reason ?? "",
      samMessage: data.sam_message ?? undefined,
    };
  } catch {
    return { action: "none", reason: "analysis failed" };
  }
}

// ─── Context string for Sam (passed into system prompt when in group) ─────────

export async function buildGroupContext(chatId: number): Promise<string> {
  const mood = getCurrentMood(chatId);
  const recentEvents = await db.select().from(chatEventsTable)
    .where(eq(chatEventsTable.chatId, chatId))
    .orderBy(desc(chatEventsTable.recordedAt))
    .limit(5);

  if (!recentEvents.length && mood === "calm") return "";

  const lines: string[] = [`\n\n[КОНТЕКСТ ЧАТА]`, `Текущее настроение: ${mood}`];
  if (recentEvents.length > 0) {
    lines.push("Последние события:");
    for (const e of recentEvents) {
      const d = new Date(e.recordedAt);
      lines.push(`• ${d.getDate()}.${d.getMonth() + 1}: ${e.description}`);
    }
  }
  return lines.join("\n");
}
