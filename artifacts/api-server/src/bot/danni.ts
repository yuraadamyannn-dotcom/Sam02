import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import {
  telegramUsersTable, userMemoryTable, messageLogTable, userAnalyticsTable,
  groupWarningsTable, botChatsTable,
} from "@workspace/db";
import { eq, and, count, avg, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { analyzeSentiment } from "./utils/sentiment";

// Owner ID — read from ADMIN_TELEGRAM_ID env secret, fallback to hardcoded
const _envOwnerId = process.env["ADMIN_TELEGRAM_ID"];
export const BOT_OWNER_ID: number = _envOwnerId ? parseInt(_envOwnerId, 10) : 8188102679;
export const BOT_OWNER_USERNAME = "Wuixoll";

export function isOwner(userId: number): boolean {
  return userId === BOT_OWNER_ID;
}

// ─── /danni @user — Full profile ─────────────────────────────────────────────

export async function handleDanniUser(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  targetUser: TelegramBot.User | TelegramBot.Message["reply_to_message"] | null
): Promise<void> {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from?.id ?? 0)) {
    await bot.sendMessage(chatId, "недостаточно прав", { reply_to_message_id: msg.message_id });
    return;
  }

  let userId = (targetUser as TelegramBot.User)?.id || msg.reply_to_message?.from?.id;
  const mentionUsername = (targetUser as TelegramBot.User)?.username;

  // If we have a username but no valid ID, look up in DB
  if ((!userId || userId === 0) && mentionUsername) {
    const cleanName = mentionUsername.replace(/^@/, "").toLowerCase();
    const [found] = await db
      .select({ userId: telegramUsersTable.userId })
      .from(telegramUsersTable)
      .where(sql`LOWER(${telegramUsersTable.username}) = ${cleanName}`)
      .limit(1);
    if (found) userId = found.userId;
  }

  if (!userId) {
    await bot.sendMessage(
      chatId,
      mentionUsername
        ? `Пользователь @${mentionUsername} не найден в базе. Он должен был написать боту хотя бы раз.`
        : "Укажи пользователя: /danni @username или ответь на сообщение",
      { reply_to_message_id: msg.message_id },
    );
    return;
  }

  await bot.sendChatAction(chatId, "typing");

  try {
    // Collect data from our DB
    const [telegramUser] = await db.select().from(telegramUsersTable).where(eq(telegramUsersTable.userId, userId));
    const [memory] = await db.select().from(userMemoryTable).where(eq(userMemoryTable.userId, userId));
    const analyticsRows = await db.select().from(userAnalyticsTable).where(eq(userAnalyticsTable.userId, userId));
    const [warnings] = await db.select({ total: count() }).from(groupWarningsTable).where(eq(groupWarningsTable.userId, userId));

    // Message activity
    const [msgStats] = await db.select({
      total: count(),
      avgSentiment: avg(messageLogTable.sentiment),
    }).from(messageLogTable).where(eq(messageLogTable.userId, userId));

    // Recent messages for NLP analysis
    const recentMsgs = await db.select({ text: messageLogTable.text })
      .from(messageLogTable)
      .where(eq(messageLogTable.userId, userId))
      .orderBy(desc(messageLogTable.createdAt))
      .limit(50);

    // Try to get Telegram profile photos count
    let photoCount = 0;
    try {
      const photos = await bot.getUserProfilePhotos(userId, { limit: 1 });
      photoCount = photos.total_count;
    } catch { /* Not accessible */ }

    // NLP topic analysis from message history
    const allText = recentMsgs.map(m => m.text).join(" ").toLowerCase();
    const topics = extractTopics(allText);

    // Sentiment summary
    const sentimentAvg = Number(msgStats?.avgSentiment ?? 0);
    const sentimentLabel = sentimentAvg > 0.3 ? "😊 Позитивный" : sentimentAvg < -0.3 ? "😡 Негативный" : "😐 Нейтральный";

    // Activity heatmap (simple)
    const totalAnalyticsMsgs = analyticsRows.reduce((s, r) => s + r.messageCount, 0);
    const chatsActive = analyticsRows.length;

    // Build profile
    const username = telegramUser?.username ? `@${telegramUser.username}` : "нет";
    const name = [telegramUser?.firstName, telegramUser?.lastName].filter(Boolean).join(" ") || "—";
    const firstSeen = telegramUser?.firstSeen?.toLocaleDateString("ru-RU") ?? "—";
    const lastSeen = telegramUser?.lastSeen?.toLocaleDateString("ru-RU") ?? "—";

    const profile = [
      `👤 <b>Профиль пользователя</b>`,
      ``,
      `🆔 ID: <code>${userId}</code>`,
      `👤 Имя: <b>${name}</b>`,
      `🔖 Username: ${username}`,
      `🌐 Язык: ${memory?.notes?.match(/язык:([^\n]+)/i)?.[1]?.trim() ?? "—"}`,
      `📷 Фото профиля: ${photoCount}`,
      ``,
      `📊 <b>Активность</b>`,
      `💬 Сообщений в боте: <b>${telegramUser?.messageCount ?? 0}</b>`,
      `📝 Сообщений всего (в чатах): <b>${Number(msgStats?.total ?? 0)}</b>`,
      `🗂 Активных чатов: <b>${chatsActive}</b>`,
      `📅 Первый контакт: ${firstSeen}`,
      `🕐 Последняя активность: ${lastSeen}`,
      ``,
      `🧠 <b>Профилирование</b>`,
      `😊 Тональность: ${sentimentLabel} (${sentimentAvg.toFixed(2)})`,
      topics ? `🏷 Интересы: ${topics}` : "",
      memory?.interests ? `💡 Из памяти: ${memory.interests}` : "",
      memory?.summary ? `📋 Портрет: ${memory.summary}` : "",
      memory?.notes ? `📌 Заметки: ${memory.notes}` : "",
      ``,
      `⚠️ <b>Нарушения</b>`,
      `🚨 Предупреждений: <b>${warnings?.total ?? 0}</b>`,
      analyticsRows.some(a => a.muteCount > 0) ? `🔇 Мутов: <b>${analyticsRows.reduce((s, a) => s + a.muteCount, 0)}</b>` : "",
    ].filter(l => l !== "").join("\n");

    await bot.sendMessage(chatId, profile, {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "🔄 Обновить", callback_data: `danni_refresh:${userId}` },
          { text: "🗑 Удалить данные", callback_data: `danni_delete:${userId}` },
        ]],
      },
    });
  } catch (err) {
    logger.error({ err }, "/danni failed");
    await bot.sendMessage(chatId, "ошибка при сборе данных", { reply_to_message_id: msg.message_id });
  }
}

// ─── /danni_chat — Chat analytics ────────────────────────────────────────────

export async function handleDanniChat(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  if (!isOwner(msg.from?.id ?? 0)) {
    await bot.sendMessage(chatId, "недостаточно прав", { reply_to_message_id: msg.message_id });
    return;
  }

  await bot.sendChatAction(chatId, "typing");

  try {
    const [chatInfo] = await db.select().from(botChatsTable).where(eq(botChatsTable.chatId, chatId));
    const [msgCount] = await db.select({ total: count(), avgSent: avg(messageLogTable.sentiment) })
      .from(messageLogTable).where(eq(messageLogTable.chatId, chatId));
    const [memberCount] = await db.select({ total: count() })
      .from(userAnalyticsTable).where(eq(userAnalyticsTable.chatId, chatId));

    // Top active users
    const topActive = await db.select({
      userId: userAnalyticsTable.userId,
      msgCount: userAnalyticsTable.messageCount,
    }).from(userAnalyticsTable)
      .where(eq(userAnalyticsTable.chatId, chatId))
      .orderBy(desc(userAnalyticsTable.messageCount))
      .limit(5);

    // Message distribution (rough)
    const recentMsgs = await db.select({ userId: messageLogTable.userId, text: messageLogTable.text })
      .from(messageLogTable)
      .where(eq(messageLogTable.chatId, chatId))
      .orderBy(desc(messageLogTable.createdAt))
      .limit(200);

    const allText = recentMsgs.map(m => m.text).join(" ");
    const topics = extractTopics(allText.toLowerCase());

    const sentAvg = Number(msgCount?.avgSent ?? 0);
    const healthLabel = sentAvg > 0.2 ? "✅ Здоровый" : sentAvg < -0.4 ? "🔴 Токсичный" : "🟡 Нейтральный";

    const topList = topActive.map((u, i) => `${i + 1}. ID ${u.userId}: ${u.msgCount} сообщ.`).join("\n");

    const report = [
      `📊 <b>Аналитика чата</b>`,
      ``,
      `🆔 Chat ID: <code>${chatId}</code>`,
      `📌 Название: ${chatInfo?.title ?? msg.chat.title ?? "—"}`,
      `👥 Участников: ${chatInfo?.memberCount ?? memberCount?.total ?? 0}`,
      ``,
      `💬 Сообщений в логе: <b>${Number(msgCount?.total ?? 0)}</b>`,
      `😊 Средняя тональность: <b>${sentAvg.toFixed(2)}</b>`,
      `❤️ Здоровье чата: ${healthLabel}`,
      topics ? `🏷 Темы обсуждений: ${topics}` : "",
      ``,
      `🏆 <b>Топ активных:</b>`,
      topList || "нет данных",
      ``,
      `📋 Логов: последние ${recentMsgs.length} сообщений`,
    ].filter(l => l !== "").join("\n");

    await bot.sendMessage(chatId, report, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.error({ err }, "/danni_chat failed");
    await bot.sendMessage(chatId, "ошибка получения аналитики", { reply_to_message_id: msg.message_id });
  }
}

// ─── /export_data — GDPR export ──────────────────────────────────────────────

export async function handleExportData(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  if (!userId) return;

  const [user] = await db.select().from(telegramUsersTable).where(eq(telegramUsersTable.userId, userId));
  const [memory] = await db.select().from(userMemoryTable).where(eq(userMemoryTable.userId, userId));
  const msgs = await db.select().from(messageLogTable).where(eq(messageLogTable.userId, userId)).limit(100);

  const data = {
    profile: user,
    memory,
    recentMessages: msgs.map(m => ({ text: m.text, at: m.createdAt })),
    exportedAt: new Date().toISOString(),
  };

  const json = JSON.stringify(data, null, 2);
  const text = `📦 <b>Твои данные в боте:</b>\n\n<pre>${json.slice(0, 3500)}</pre>${json.length > 3500 ? "\n...обрезано" : ""}`;
  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractTopics(text: string): string {
  const topicMap: Record<string, string[]> = {
    "аниме/манга": ["аниме","манга","наруто","сасуке","атака","демон","блич","опенинг","яой","юри","isekai"],
    "к-поп": ["bts","stray kids","aespa","кпоп","kpop","эспа","сейв ми","jungkook","blackpink"],
    "игры": ["игра","играю","геймплей","стрим","valve","minecraft","cs2","fortnite","roblox","lol"],
    "музыка": ["песня","трек","слушаю","playlist","spotify","apple music","звук","музыка","рэп","pop"],
    "кино/сериалы": ["сериал","фильм","нетфликс","netflix","сезон","серия","смотрю","кино"],
    "программирование/IT": ["код","python","javascript","typescript","баг","фреймворк","git","api","деплой"],
    "психология": ["психолог","тревога","депрессия","эмоции","отношения","травма","мышление","цель"],
    "общение/флирт": ["нравишься","флирт","отношения","встреча","любовь","краш","свидание"],
  };

  const found: string[] = [];
  for (const [topic, keywords] of Object.entries(topicMap)) {
    if (keywords.some(k => text.includes(k))) found.push(topic);
  }
  return found.slice(0, 4).join(", ");
}

// Log a message for analytics (non-blocking)
export function logMessage(chatId: number, userId: number, username: string | null | undefined, text: string): void {
  const sentiment = analyzeSentiment(text);
  void db.insert(messageLogTable).values({
    chatId, userId, username: username ?? null, text: text.slice(0, 500), sentiment,
  }).catch(() => {});

  // Keep last 500 logs per chat (async cleanup)
  void db.execute(
    sql`DELETE FROM message_log WHERE id NOT IN (SELECT id FROM message_log WHERE chat_id = ${chatId} ORDER BY created_at DESC LIMIT 500)`
  ).catch(() => {});
}

// Update analytics per user per chat
export function updateUserAnalytics(chatId: number, userId: number, sentiment: number): void {
  void db.insert(userAnalyticsTable).values({
    chatId, userId, messageCount: 1, avgSentiment: sentiment, lastActive: new Date(),
  }).onConflictDoUpdate({
    target: [userAnalyticsTable.userId, userAnalyticsTable.chatId],
    set: {
      messageCount: sql`${userAnalyticsTable.messageCount} + 1`,
      avgSentiment: sql`(${userAnalyticsTable.avgSentiment} * 0.9 + ${sentiment} * 0.1)`,
      lastActive: new Date(),
    },
  }).catch(() => {});
}
