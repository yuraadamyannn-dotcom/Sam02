import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { botChatsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { sleep } from "./utils/backoff";
import { BOT_OWNER_ID } from "./danni";

// Track broadcast sessions (owner → awaiting broadcast text)
const pendingBroadcasts = new Map<number, { mode: "all" | "groups" | "private"; startedAt: number }>();

export function hasPendingBroadcast(userId: number): boolean {
  const p = pendingBroadcasts.get(userId);
  if (!p) return false;
  if (Date.now() - p.startedAt > 5 * 60 * 1000) { pendingBroadcasts.delete(userId); return false; }
  return true;
}

export async function handleBroadcastCommand(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from || from.id !== BOT_OWNER_ID) {
    await bot.sendMessage(chatId, "только для владельца", { reply_to_message_id: msg.message_id });
    return;
  }

  pendingBroadcasts.set(from.id, { mode: "all", startedAt: Date.now() });

  await bot.sendMessage(chatId, "📢 <b>Рассылка</b>\n\nВыбери куда отправить:", {
    parse_mode: "HTML",
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📣 Все чаты", callback_data: "broadcast_mode:all" }],
        [{ text: "👥 Только группы", callback_data: "broadcast_mode:groups" }],
        [{ text: "💬 Только личные", callback_data: "broadcast_mode:private" }],
        [{ text: "❌ Отмена", callback_data: "broadcast_cancel" }],
      ],
    },
  });
}

export async function handleBroadcastModeCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
): Promise<void> {
  const chatId = query.message?.chat.id;
  const msgId = query.message?.message_id;
  const from = query.from;
  if (!chatId || !from || from.id !== BOT_OWNER_ID) {
    await bot.answerCallbackQuery(query.id, { text: "Нет прав" });
    return;
  }

  if (query.data === "broadcast_cancel") {
    pendingBroadcasts.delete(from.id);
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageText("Рассылка отменена.", { chat_id: chatId, message_id: msgId });
    return;
  }

  const mode = query.data?.replace("broadcast_mode:", "") as "all" | "groups" | "private";
  pendingBroadcasts.set(from.id, { mode, startedAt: Date.now() });

  await bot.answerCallbackQuery(query.id, { text: "Отправь текст сообщения для рассылки" });
  await bot.editMessageText(
    `📢 Режим: <b>${mode === "all" ? "все чаты" : mode === "groups" ? "только группы" : "только личные"}</b>\n\nТеперь напиши текст рассылки (можно с HTML-форматированием):`,
    { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
  );
}

export async function executeBroadcast(
  bot: TelegramBot,
  ownerChatId: number,
  ownerId: number,
  text: string
): Promise<void> {
  const session = pendingBroadcasts.get(ownerId);
  if (!session) return;
  pendingBroadcasts.delete(ownerId);

  const allChats = await db.select().from(botChatsTable);
  const filtered = allChats.filter(c => {
    if (session.mode === "all") return true;
    if (session.mode === "groups") return c.type === "group" || c.type === "supergroup";
    if (session.mode === "private") return c.type === "private";
    return true;
  });

  const progress = await bot.sendMessage(ownerChatId,
    `📤 Начинаю рассылку в ${filtered.length} чатов...`
  );

  let success = 0, failed = 0;
  for (const chat of filtered) {
    try {
      await bot.sendMessage(chat.chatId, text, { parse_mode: "HTML" });
      success++;
    } catch {
      failed++;
    }
    await sleep(50); // Rate limit
  }

  await bot.editMessageText(
    `✅ Рассылка завершена!\n\n✉️ Отправлено: ${success}\n❌ Ошибок: ${failed}`,
    { chat_id: ownerChatId, message_id: progress.message_id }
  );
}

// Track chat where bot is active
export async function trackBotChat(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;
  const title = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name ?? null;

  try {
    let memberCount: number | undefined;
    if (chatType === "group" || chatType === "supergroup") {
      memberCount = await bot.getChatMemberCount(chatId).catch(() => undefined);
    }

    await db.insert(botChatsTable).values({
      chatId,
      title: title ?? null,
      type: chatType,
      memberCount: memberCount ?? null,
      lastActiveAt: new Date(),
    }).onConflictDoUpdate({
      target: botChatsTable.chatId,
      set: {
        title: title ?? undefined,
        memberCount: memberCount ?? undefined,
        lastActiveAt: new Date(),
      },
    });
  } catch { /* Non-critical */ }
}
