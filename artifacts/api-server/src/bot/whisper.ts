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

export function detectWhisper(msg: TelegramBot.Message): WhisperIntent | null {
  const text = msg.text ?? "";
  if (!text) return null;
  const WHISPER_RE = /^шё?пот\b/i;

  // Mode A: reply to someone's message — "шёпот текст"
  if (WHISPER_RE.test(text) && msg.reply_to_message?.from) {
    const target = msg.reply_to_message.from;
    if (target.is_bot) return null;
    const whisperText = text.replace(WHISPER_RE, "").trim();
    if (!whisperText) return null;
    return { whisperText, targetUser: target };
  }

  // Mode B: "шёпот @username текст" or with text_mention entity
  if (WHISPER_RE.test(text)) {
    const rest = text.replace(WHISPER_RE, "").trim();

    // Check for text_mention entity (users with no @username, linked by Telegram)
    const textMentionEntity = msg.entities?.find(e => e.type === "text_mention" && e.user);
    if (textMentionEntity?.user) {
      const userEnd = textMentionEntity.offset + textMentionEntity.length;
      const afterMention = text.slice(userEnd).trim();
      if (afterMention) {
        return { whisperText: afterMention, targetUser: textMentionEntity.user };
      }
      return null;
    }

    // @username in text
    const m = rest.match(/^@([a-zA-Z0-9_]{4,32})\s+(.+)$/s);
    if (m) {
      return { whisperText: m[2]!.trim(), targetUsername: m[1] };
    }
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
  const from = msg.from!;
  const senderName = from.username ? `@${from.username}` : from.first_name;

  let targetId: number;
  let targetName: string;

  if (intent.targetUser) {
    targetId = intent.targetUser.id;
    targetName = intent.targetUser.username
      ? `@${intent.targetUser.username}`
      : intent.targetUser.first_name;
  } else if (intent.targetUsername) {
    // Look up in DB
    const clean = intent.targetUsername.toLowerCase();
    const [row] = await db.select().from(telegramUsersTable)
      .where(sql`LOWER(${telegramUsersTable.username}) = ${clean}`)
      .catch(() => []);
    if (!row?.userId) {
      await bot.sendMessage(
        chatId,
        `⚠️ Пользователь @${intent.targetUsername} не найден в базе.\nОн должен был написать в чат хотя бы раз.`,
        { reply_to_message_id: msg.message_id },
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
    await bot.sendMessage(chatId, "себе шепчешь? 😅", { reply_to_message_id: msg.message_id });
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

  // Delete original command message so the text stays secret
  await bot.deleteMessage(chatId, msg.message_id).catch(() => {});

  await bot.sendMessage(
    chatId,
    `🔇 <b>${senderName}</b> шепчет что-то <b>${targetName}</b>\n<i>Только ${targetName} может прочитать это сообщение. Кнопка активна 10 минут.</i>`,
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
  const [, whisperId] = (query.data ?? "").split(":");

  if (!whisperId) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const whisper = whispers.get(whisperId);

  if (!whisper || whisper.expiresAt < Date.now()) {
    if (whisper) whispers.delete(whisperId);
    await bot.answerCallbackQuery(query.id, {
      text: "⏱ Шёпот устарел и больше недоступен",
      show_alert: true,
    });
    return;
  }

  if (user.id !== whisper.targetId) {
    await bot.answerCallbackQuery(query.id, {
      text: "🔒 Это сообщение предназначено не тебе",
      show_alert: true,
    });
    return;
  }

  // Reveal to target
  await bot.answerCallbackQuery(query.id, {
    text: `🔇 ${whisper.senderName} шепчет:\n\n${whisper.text}`,
    show_alert: true,
  });

  // Remove whisper after reading — single use
  whispers.delete(whisperId);

  // Update button to show read status
  if (query.message) {
    await bot.editMessageText(
      `🔇 <b>${whisper.senderName}</b> прошептал что-то <b>${whisper.targetName}</b>\n<i>✅ Сообщение прочитано</i>`,
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
