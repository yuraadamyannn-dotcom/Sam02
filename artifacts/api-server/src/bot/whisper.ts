import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { telegramUsersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";

// ─── Whisper store (in-memory, 10 min TTL) ───────────────────────────────────

interface WhisperData {
  targetId: number;
  targetName: string;
  senderName: string;
  text: string;
  chatId: number;
  expiresAt: number;
}

const whispers = new Map<string, WhisperData>();

function makeId(): string {
  return `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [k, v] of whispers) {
    if (v.expiresAt < now) whispers.delete(k);
  }
}

// ─── Detect ───────────────────────────────────────────────────────────────────

export interface WhisperIntent {
  whisperText: string;
  targetUser?: TelegramBot.User;
  targetUsername?: string;
}

// Match "шёпот" OR "шепот" (both spellings), case-insensitive
// ш[её]пот: brackets match either ё or е
const WHISPER_RE = /^ш[её]пот\s*/i;
const CALLBACK_ALERT_LIMIT = 190;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncateAlert(text: string): string {
  if (text.length <= CALLBACK_ALERT_LIMIT) return text;
  return `${text.slice(0, CALLBACK_ALERT_LIMIT - 1)}…`;
}

export function isWhisperCommand(text: string): boolean {
  return /^ш[её]пот(?:\s|$)/i.test(text.trim());
}

export function detectWhisper(msg: TelegramBot.Message): WhisperIntent | null {
  const text = msg.text ?? "";
  if (!text || !WHISPER_RE.test(text)) return null;

  // Strip the trigger word to get the rest
  const rest = text.replace(WHISPER_RE, "").trim();

  // ── Mode A: reply to someone's message ────────────────────────────────────
  // "шёпот текст" while replying to a message
  if (msg.reply_to_message?.from) {
    const target = msg.reply_to_message.from;
    if (target.is_bot) return null;
    if (!rest) return null;
    return { whisperText: rest, targetUser: target };
  }

  // ── Mode B: direct mention in the message ─────────────────────────────────

  // B1: text_mention entity — user without @username (Telegram-linked display name)
  // Format: "шёпот [Иван] текст"
  const textMentionEntity = msg.entities?.find(
    e => e.type === "text_mention" && e.user && !e.user.is_bot,
  );
  if (textMentionEntity?.user) {
    // Extract text AFTER the mention entity (offsets are in UTF-16 code units)
    const afterOffset = textMentionEntity.offset + textMentionEntity.length;
    // text.slice works by character index; for most Russian text UTF-16 = chars
    const afterMention = text.slice(afterOffset).trim();
    if (afterMention) {
      return { whisperText: afterMention, targetUser: textMentionEntity.user };
    }
    return null;
  }

  // B2: @username mention in text — "шёпот @username текст"
  // rest already has the trigger word stripped
  const m = rest.match(/^@([a-zA-Z0-9_]{5,32})\s+([\s\S]+)$/);
  if (m) {
    return { whisperText: m[2]!.trim(), targetUsername: m[1] };
  }

  return null;
}

// ─── Handle ───────────────────────────────────────────────────────────────────

export async function handleWhisper(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  intent: WhisperIntent,
): Promise<void> {
  const chatId = msg.chat.id;
  const msgId = msg.message_id;
  const from = msg.from!;
  const senderName = from.username ? `@${from.username}` : from.first_name;

  // ── Delete the original message IMMEDIATELY (fire & forget) ───────────────
  // Must happen first so the whisper text is never visible to others
  bot.deleteMessage(chatId, msgId).catch(() => {});

  let targetId: number;
  let targetName: string;

  if (intent.targetUser) {
    targetId = intent.targetUser.id;
    targetName = intent.targetUser.username
      ? `@${intent.targetUser.username}`
      : intent.targetUser.first_name;
  } else if (intent.targetUsername) {
    // Resolve username → ID from DB
    const clean = intent.targetUsername.toLowerCase();
    const rows = await db
      .select()
      .from(telegramUsersTable)
      .where(sql`LOWER(${telegramUsersTable.username}) = ${clean}`)
      .catch(() => [] as typeof telegramUsersTable.$inferSelect[]);
    const row = rows[0];
    if (!row?.userId) {
      await bot.sendMessage(
        chatId,
        `⚠️ Не нашёл @${intent.targetUsername} в базе — они должны были написать в чат хотя бы раз.`,
      );
      return;
    }
    targetId = row.userId;
    targetName = `@${intent.targetUsername}`;
  } else {
    return;
  }

  // Don't whisper to yourself
  if (targetId === from.id) {
    await bot.sendMessage(chatId, "себе шепчешь? 😅");
    return;
  }

  cleanExpired();

  const id = makeId();
  whispers.set(id, {
    targetId,
    targetName,
    senderName,
    text: intent.whisperText,
    chatId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  await bot.sendMessage(
    chatId,
    `🔇 <b>${escapeHtml(senderName)}</b> шепчет что-то <b>${escapeHtml(targetName)}</b>\n` +
    `<i>Только ${escapeHtml(targetName)} может прочитать. Кнопка активна 10 минут.</i>`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "👁 Прочитать шёпот", callback_data: `whisper:${id}` },
        ]],
      },
    },
  );

  logger.info({ chatId, from: from.id, targetId }, "Whisper created");
}

// ─── Callback ─────────────────────────────────────────────────────────────────

export async function handleWhisperCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const user = query.from;
  const parts = (query.data ?? "").split(":");
  const whisperId = parts.slice(1).join(":"); // safe even if id has colons

  if (!whisperId) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const whisper = whispers.get(whisperId);

  if (!whisper || whisper.expiresAt < Date.now()) {
    if (whisper) whispers.delete(whisperId);
    await bot.answerCallbackQuery(query.id, {
      text: "⏱ Шёпот устарел и недоступен",
      show_alert: true,
    });
    return;
  }

  // Wrong user trying to read
  if (user.id !== whisper.targetId) {
    await bot.answerCallbackQuery(query.id, {
      text: "🔒 Это сообщение не для тебя",
      show_alert: true,
    });
    return;
  }

  const revealText = `🔇 ${whisper.senderName} шепчет:\n\n${whisper.text}`;
  if (revealText.length <= CALLBACK_ALERT_LIMIT) {
    await bot.answerCallbackQuery(query.id, {
      text: revealText,
      show_alert: true,
    });
  } else {
    try {
      await bot.sendMessage(user.id, revealText);
      await bot.answerCallbackQuery(query.id, {
        text: "🔇 шёпот отправил тебе в личку",
        show_alert: true,
      });
    } catch {
      await bot.answerCallbackQuery(query.id, {
        text: truncateAlert(revealText),
        show_alert: true,
      });
    }
  }

  // Single-use: remove after reading
  whispers.delete(whisperId);

  // Update the group message to show "read" state
  if (query.message) {
    await bot.editMessageText(
      `🔇 <b>${escapeHtml(whisper.senderName)}</b> прошептал что-то <b>${escapeHtml(whisper.targetName)}</b>\n` +
      `<i>✅ Прочитано ${escapeHtml(user.username ? `@${user.username}` : user.first_name)}</i>`,
      {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      },
    ).catch(() => {});
  }

  logger.info({ whisperId, targetId: user.id }, "Whisper read and consumed");
}
