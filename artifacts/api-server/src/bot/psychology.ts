/**
 * psychology.ts — per-user psychological profiling
 *
 * Runs in the background after every N messages from a user.
 * Persists personality axes, communication style, and generates
 * a Groq-powered dossier on /dosye command.
 */

import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { db } from "@workspace/db";
import { userProfilesTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { withRetry } from "./utils/backoff";
import { analyzeSentiment, isEscalation } from "./utils/sentiment";

const groq = new Groq({ apiKey: process.env["GROQ_API_KEY"]! });

// In-memory buffer: chatId → userId → recent messages (last 30)
const msgBuffer = new Map<string, string[]>();
// Trigger analysis every N new messages from that user in that chat
const ANALYSIS_TRIGGER = 8;
const msgCounter = new Map<string, number>();

function bufKey(chatId: number, userId: number) {
  return `${chatId}:${userId}`;
}

// ─── Record a new message ─────────────────────────────────────────────────────

export function recordPsychMessage(
  chatId: number, userId: number, text: string
): number {
  const key = bufKey(chatId, userId);
  const buf = msgBuffer.get(key) ?? [];
  buf.push(text);
  if (buf.length > 30) buf.shift();
  msgBuffer.set(key, buf);

  const cnt = (msgCounter.get(key) ?? 0) + 1;
  msgCounter.set(key, cnt);
  return cnt;
}

// ─── Should we run analysis now? ─────────────────────────────────────────────

export function shouldAnalyze(chatId: number, userId: number): boolean {
  const key = bufKey(chatId, userId);
  const cnt = msgCounter.get(key) ?? 0;
  return cnt % ANALYSIS_TRIGGER === 0 && cnt > 0;
}

// ─── Heuristic fast update (no Groq, just rule-based) ────────────────────────

function heuristicUpdate(
  text: string,
  prev: typeof userProfilesTable.$inferSelect | null
): Partial<typeof userProfilesTable.$inferInsert> {
  const lower = text.toLowerCase();
  const sent = analyzeSentiment(text);
  const wordCount = text.split(/\s+/).length;

  // Humor markers
  const isHumor = /хаха|хах|хехе|кхе|лол|лмао|ору|ахах|🤣|😂|😹/.test(lower);
  // Question markers
  const isQuestion = /\?|что|как|почему|зачем|когда|где|кто/.test(lower);
  // Apology markers
  const isApology = /прости|извини|сорри|my bad|виноват|виновата/.test(lower);
  // Sarcasm markers
  const isSarcasm = /ну конечно|о да|вааааа|ооо точно|ага ага|наверно|наверное 🙄|прям|как же/.test(lower);
  // Long message → tends extrovert/leader
  const isLong = wordCount > 30;
  // Very short → shy/introvert or just casual
  const isVeryShort = wordCount < 4;

  const updates: Partial<typeof userProfilesTable.$inferInsert> = {};
  const p = prev;

  const lerp = (old: number | null | undefined, delta: number, rate = 0.1) =>
    Math.max(-1, Math.min(1, (old ?? 0) + delta * rate));
  const lerp01 = (old: number | null | undefined, delta: number, rate = 0.1) =>
    Math.max(0, Math.min(1, (old ?? 0.5) + delta * rate));

  if (isEscalation(text)) {
    updates.aggressionScore = lerp01(p?.aggressionScore, 1);
    updates.conflictCount = (p?.conflictCount ?? 0) + 1;
  } else if (sent > 0.4) {
    updates.friendlinessScore = lerp01(p?.friendlinessScore, 0.5);
    updates.aggressionScore = lerp01(p?.aggressionScore, -0.2);
  } else if (sent < -0.3) {
    updates.aggressionScore = lerp01(p?.aggressionScore, 0.3);
    updates.friendlinessScore = lerp01(p?.friendlinessScore, -0.2);
  }

  if (isHumor) updates.humorCount = (p?.humorCount ?? 0) + 1;
  if (isQuestion) updates.questionCount = (p?.questionCount ?? 0) + 1;
  if (isApology) updates.apologyCount = (p?.apologyCount ?? 0) + 1;
  if (isSarcasm) updates.sarcasticScore = lerp01(p?.sarcasticScore, 0.3);
  if (isLong) updates.introvertScore = lerp(p?.introvertScore, -0.2); // long → more extrovert
  if (isVeryShort) updates.introvertScore = lerp(p?.introvertScore, 0.1); // short → slightly introvert

  return updates;
}

// ─── Full Groq-powered analysis ───────────────────────────────────────────────

async function groqAnalysis(
  userId: number, chatId: number,
  messages: string[],
  prev: typeof userProfilesTable.$inferSelect | null
): Promise<void> {
  if (messages.length < 3) return;

  const sample = messages.slice(-20).join("\n");
  const prevSummary = prev?.psychSummary ?? "нет предыдущего анализа";

  const prompt = `Ты — опытный психолог-аналитик. Проанализируй сообщения пользователя из Telegram и составь психологический профиль.

Предыдущий анализ: ${prevSummary}

Последние сообщения пользователя:
${sample}

Ответь JSON (строго):
{
  "introvert_score": число от -1 до 1 (-1=экстраверт, +1=интроверт),
  "sociaphobe_score": число от 0 до 1,
  "aggression_score": число от 0 до 1,
  "friendliness_score": число от 0 до 1,
  "sarcastic_score": число от 0 до 1,
  "activity_level": число от 0 до 1,
  "communication_style": одно слово из [friendly/aggressive/passive/sarcastic/shy/leader/lurker/analytical/emotional],
  "dominant_topics": ["тема1","тема2","тема3"],
  "notable_traits": ["черта1","черта2"],
  "psych_summary": "2-3 предложения, как психолог описывает человека. Конкретно, без воды. Упоминай конкретные паттерны из сообщений."
}`;

  try {
    const resp = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
      response_format: { type: "json_object" },
    }), { label: "psych analysis" });

    const data = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
      introvert_score?: number; sociaphobe_score?: number;
      aggression_score?: number; friendliness_score?: number;
      sarcastic_score?: number; activity_level?: number;
      communication_style?: string; dominant_topics?: string[];
      notable_traits?: string[]; psych_summary?: string;
    };

    const clamp = (v: unknown, min: number, max: number) => {
      const n = Number(v);
      return isNaN(n) ? (min + max) / 2 : Math.max(min, Math.min(max, n));
    };

    await db.insert(userProfilesTable).values({
      userId, chatId,
      introvertScore: clamp(data.introvert_score, -1, 1),
      sociaphobeScore: clamp(data.sociaphobe_score, 0, 1),
      aggressionScore: clamp(data.aggression_score, 0, 1),
      friendlinessScore: clamp(data.friendliness_score, 0, 1),
      sarcasticScore: clamp(data.sarcastic_score, 0, 1),
      activityLevel: clamp(data.activity_level, 0, 1),
      communicationStyle: data.communication_style ?? prev?.communicationStyle ?? "neutral",
      dominantTopics: JSON.stringify(data.dominant_topics ?? []),
      notableTraits: JSON.stringify(data.notable_traits ?? []),
      psychSummary: data.psych_summary ?? null,
      messagesAnalyzed: (prev?.messagesAnalyzed ?? 0) + messages.length,
      conflictCount: prev?.conflictCount ?? 0,
      muteCount: prev?.muteCount ?? 0,
      warnCount: prev?.warnCount ?? 0,
      apologyCount: prev?.apologyCount ?? 0,
      humorCount: prev?.humorCount ?? 0,
      questionCount: prev?.questionCount ?? 0,
      lastAnalyzed: new Date(),
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [userProfilesTable.userId, userProfilesTable.chatId],
      set: {
        introvertScore: clamp(data.introvert_score, -1, 1),
        sociaphobeScore: clamp(data.sociaphobe_score, 0, 1),
        aggressionScore: clamp(data.aggression_score, 0, 1),
        friendlinessScore: clamp(data.friendliness_score, 0, 1),
        sarcasticScore: clamp(data.sarcastic_score, 0, 1),
        activityLevel: clamp(data.activity_level, 0, 1),
        communicationStyle: data.communication_style ?? prev?.communicationStyle ?? "neutral",
        dominantTopics: JSON.stringify(data.dominant_topics ?? []),
        notableTraits: JSON.stringify(data.notable_traits ?? []),
        psychSummary: data.psych_summary ?? null,
        messagesAnalyzed: sql`${userProfilesTable.messagesAnalyzed} + ${messages.length}`,
        lastAnalyzed: new Date(),
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    logger.error({ err, userId, chatId }, "Groq psych analysis failed");
  }
}

// ─── Fast heuristic update (used on every message) ───────────────────────────

export async function updateProfileHeuristic(
  userId: number, chatId: number, text: string
): Promise<void> {
  try {
    const [prev] = await db.select().from(userProfilesTable)
      .where(and(eq(userProfilesTable.userId, userId), eq(userProfilesTable.chatId, chatId)));

    const updates = heuristicUpdate(text, prev ?? null);
    if (Object.keys(updates).length === 0) return;

    await db.insert(userProfilesTable).values({
      userId, chatId, updatedAt: new Date(), ...updates,
    }).onConflictDoUpdate({
      target: [userProfilesTable.userId, userProfilesTable.chatId],
      set: { ...updates, updatedAt: new Date() },
    });
  } catch { /* Non-critical */ }
}

// ─── Full background analysis (called when counter hits threshold) ────────────

export async function runFullPsychAnalysis(
  userId: number, chatId: number
): Promise<void> {
  try {
    const key = bufKey(chatId, userId);
    const messages = msgBuffer.get(key) ?? [];
    if (messages.length < 3) return;
    const [prev] = await db.select().from(userProfilesTable)
      .where(and(eq(userProfilesTable.userId, userId), eq(userProfilesTable.chatId, chatId)));
    await groqAnalysis(userId, chatId, messages, prev ?? null);
  } catch (err) {
    logger.error({ err }, "Full psych analysis failed");
  }
}

// ─── Increment mute/warn counters ────────────────────────────────────────────

export async function incrementModerationCount(
  userId: number, chatId: number,
  type: "mute" | "warn" | "ban"
): Promise<void> {
  try {
    const field = type === "mute" ? userProfilesTable.muteCount : userProfilesTable.warnCount;
    await db.insert(userProfilesTable).values({
      userId, chatId,
      muteCount: type === "mute" ? 1 : 0,
      warnCount: type === "warn" ? 1 : 0,
      conflictCount: type === "ban" ? 1 : 0,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [userProfilesTable.userId, userProfilesTable.chatId],
      set: {
        [field.name]: sql`${field} + 1`,
        updatedAt: new Date(),
      },
    });
  } catch { /* Non-critical */ }
}

// ─── Get dossier ─────────────────────────────────────────────────────────────

export async function getUserDossier(
  userId: number, chatId: number,
  targetName: string
): Promise<string> {
  const [profile] = await db.select().from(userProfilesTable)
    .where(and(eq(userProfilesTable.userId, userId), eq(userProfilesTable.chatId, chatId)));

  if (!profile || !profile.messagesAnalyzed || profile.messagesAnalyzed < 5) {
    return `📂 <b>Досье: ${targetName}</b>\n\nДанных пока недостаточно — нужно больше сообщений в этом чате.`;
  }

  const introLabel = profile.introvertScore !== null
    ? profile.introvertScore > 0.3 ? "интроверт" : profile.introvertScore < -0.3 ? "экстраверт" : "амбиверт"
    : "неизвестно";

  const aggrLabel = profile.aggressionScore !== null
    ? profile.aggressionScore > 0.6 ? "высокая" : profile.aggressionScore > 0.3 ? "средняя" : "низкая"
    : "—";

  const friendLabel = profile.friendlinessScore !== null
    ? profile.friendlinessScore > 0.6 ? "тёплый" : profile.friendlinessScore > 0.3 ? "нейтральный" : "холодный"
    : "—";

  const actLabel = profile.activityLevel !== null
    ? profile.activityLevel > 0.6 ? "активный" : profile.activityLevel > 0.3 ? "умеренный" : "лёрк (молчун)"
    : "—";

  const socLabel = profile.sociaphobeScore !== null
    ? profile.sociaphobeScore > 0.6 ? "выраженный" : profile.sociaphobeScore > 0.3 ? "умеренный" : "нет"
    : "—";

  const topics = (() => {
    try { return (JSON.parse(profile.dominantTopics ?? "[]") as string[]).join(", ") || "—"; }
    catch { return "—"; }
  })();

  const traits = (() => {
    try { return (JSON.parse(profile.notableTraits ?? "[]") as string[]).map(t => `• ${t}`).join("\n") || "—"; }
    catch { return "—"; }
  })();

  const style = profile.communicationStyle ?? "neutral";
  const STYLE_LABELS: Record<string, string> = {
    friendly: "дружелюбный", aggressive: "агрессивный", passive: "пассивный",
    sarcastic: "саркастичный", shy: "застенчивый", leader: "лидер",
    lurker: "наблюдатель", analytical: "аналитичный", emotional: "эмоциональный", neutral: "нейтральный",
  };

  return [
    `📂 <b>Досье: ${targetName}</b>`,
    ``,
    `🧠 <b>Психотип:</b> ${introLabel}`,
    `🗣 <b>Стиль общения:</b> ${STYLE_LABELS[style] ?? style}`,
    `🔥 <b>Агрессивность:</b> ${aggrLabel}`,
    `💛 <b>Теплота:</b> ${friendLabel}`,
    `📊 <b>Активность:</b> ${actLabel}`,
    `🚪 <b>Социофобия:</b> ${socLabel}`,
    profile.sarcasticScore && profile.sarcasticScore > 0.4
      ? `😏 <b>Сарказм:</b> выраженный` : "",
    ``,
    `⚡ <b>Конфликтов:</b> ${profile.conflictCount ?? 0}`,
    `🔇 <b>Мутов:</b> ${profile.muteCount ?? 0}`,
    `⚠️ <b>Варнов:</b> ${profile.warnCount ?? 0}`,
    `😂 <b>Юморесок:</b> ${profile.humorCount ?? 0}`,
    ``,
    `📌 <b>Темы:</b> ${topics}`,
    traits !== "—" ? `\n🔍 <b>Черты:</b>\n${traits}` : "",
    ``,
    profile.psychSummary ? `💬 <b>Анализ:</b>\n${profile.psychSummary}` : "",
    ``,
    `<i>Проанализировано сообщений: ${profile.messagesAnalyzed ?? 0}</i>`,
  ].filter(l => l !== "").join("\n");
}

// ─── /dosye command ───────────────────────────────────────────────────────────

export async function handleDosye(
  bot: TelegramBot, msg: TelegramBot.Message,
  target: TelegramBot.User | null
): Promise<void> {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  if (!isGroup) {
    await bot.sendMessage(chatId, "досье доступно только в групповых чатах");
    return;
  }

  if (!target) {
    await bot.sendMessage(chatId, "укажи пользователя — ответь на его сообщение или @username");
    return;
  }

  const dossier = await getUserDossier(target.id, chatId, target.first_name ?? target.username ?? "Неизвестный");
  await bot.sendMessage(chatId, dossier, { parse_mode: "HTML" });
}
