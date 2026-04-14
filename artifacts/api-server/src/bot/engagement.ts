import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import {
  telegramUsersTable, messageLogTable, referralsTable,
  inviteLinksTable, groupWarningsTable, userAnalyticsTable,
} from "@workspace/db";
import { eq, and, desc, count, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isOwner } from "./danni";

// ─── Add-rate limiter: max 50 adds per hour per chat ──────────────────────────

interface RateWindow { count: number; windowStart: number; }
const addRateLimiter = new Map<number, RateWindow>(); // chatId → window

const MAX_ADDS_PER_HOUR = 50;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function checkAddRate(chatId: number): { allowed: boolean; remaining: number; resetsIn: number } {
  const now = Date.now();
  const w = addRateLimiter.get(chatId);

  if (!w || now - w.windowStart > RATE_WINDOW_MS) {
    addRateLimiter.set(chatId, { count: 0, windowStart: now });
    return { allowed: true, remaining: MAX_ADDS_PER_HOUR, resetsIn: RATE_WINDOW_MS };
  }

  const remaining = MAX_ADDS_PER_HOUR - w.count;
  const resetsIn = RATE_WINDOW_MS - (now - w.windowStart);
  return { allowed: remaining > 0, remaining, resetsIn };
}

export function incrementAddRate(chatId: number): void {
  const now = Date.now();
  const w = addRateLimiter.get(chatId);
  if (!w || now - w.windowStart > RATE_WINDOW_MS) {
    addRateLimiter.set(chatId, { count: 1, windowStart: now });
  } else {
    w.count++;
  }
}

// ─── Whitelist: trusted users who skip captcha & rate limits ──────────────────

const whitelists = new Map<number, Set<number>>(); // chatId → Set<userId>

export function isWhitelisted(chatId: number, userId: number): boolean {
  return whitelists.get(chatId)?.has(userId) ?? false;
}

export function addToWhitelist(chatId: number, userId: number): void {
  if (!whitelists.has(chatId)) whitelists.set(chatId, new Set());
  whitelists.get(chatId)!.add(userId);
}

export function removeFromWhitelist(chatId: number, userId: number): void {
  whitelists.get(chatId)?.delete(userId);
}

export function getWhitelist(chatId: number): number[] {
  return [...(whitelists.get(chatId) ?? [])];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function isAdmin(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
  return bot.getChatMember(chatId, userId)
    .then(m => ["administrator", "creator"].includes(m.status))
    .catch(() => false);
}

function fmtTime(ms: number): string {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return `${m} мин`;
  return `${Math.ceil(m / 60)} ч`;
}

// ─── /whitelist — manage trusted users ────────────────────────────────────────

export async function handleWhitelist(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  args: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }

  const adminOk = isOwner(from.id) || await isAdmin(bot, chatId, from.id);
  if (!adminOk) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  const parts = args.trim().split(/\s+/);
  const action = parts[0]?.toLowerCase();

  if (action === "list") {
    const list = getWhitelist(chatId);
    if (!list.length) {
      await bot.sendMessage(chatId, "📋 Белый список пуст", { reply_to_message_id: msg.message_id });
      return;
    }
    const lines = await Promise.all(list.map(async uid => {
      const [u] = await db.select().from(telegramUsersTable).where(eq(telegramUsersTable.userId, uid)).catch(() => []);
      return `• ${u?.username ? `@${u.username}` : (u?.firstName ?? `id${uid}`)} (${uid})`;
    }));
    await bot.sendMessage(chatId, `📋 <b>Белый список (${list.length}):</b>\n${lines.join("\n")}`, {
      parse_mode: "HTML", reply_to_message_id: msg.message_id,
    });
    return;
  }

  // add/remove — need a target user
  let targetId: number | null = null;
  let targetName = "пользователь";

  if (msg.reply_to_message?.from && !msg.reply_to_message.from.is_bot) {
    targetId = msg.reply_to_message.from.id;
    targetName = msg.reply_to_message.from.username
      ? `@${msg.reply_to_message.from.username}` : msg.reply_to_message.from.first_name;
  } else if (parts[1]) {
    const clean = parts[1].replace(/^@/, "").toLowerCase();
    const [u] = await db.select().from(telegramUsersTable)
      .where(sql`LOWER(${telegramUsersTable.username}) = ${clean}`).catch(() => []);
    if (u) { targetId = u.userId; targetName = u.username ? `@${u.username}` : (u.firstName ?? `id${u.userId}`); }
  }

  if (!targetId) {
    await bot.sendMessage(chatId,
      "укажи пользователя: ответом на сообщение или @username\n\n" +
      "/whitelist add @username — добавить в белый список\n" +
      "/whitelist remove @username — убрать\n" +
      "/whitelist list — показать список",
      { reply_to_message_id: msg.message_id }
    );
    return;
  }

  if (action === "add") {
    addToWhitelist(chatId, targetId);
    await bot.sendMessage(chatId, `✅ ${targetName} добавлен в белый список — проходит капчу и лимиты автоматически`, {
      reply_to_message_id: msg.message_id,
    });
  } else if (action === "remove") {
    removeFromWhitelist(chatId, targetId);
    await bot.sendMessage(chatId, `✅ ${targetName} удалён из белого списка`, {
      reply_to_message_id: msg.message_id,
    });
  } else {
    await bot.sendMessage(chatId,
      "📋 <b>Белый список</b>\n\n" +
      "/whitelist add @username — добавить в доверенные\n" +
      "/whitelist remove @username — убрать\n" +
      "/whitelist list — посмотреть список",
      { parse_mode: "HTML", reply_to_message_id: msg.message_id }
    );
  }
}

// ─── /spam_check — check recently added users for spam activity ───────────────

export async function handleSpamCheck(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }

  const adminOk = isOwner(from.id) || await isAdmin(bot, chatId, from.id);
  if (!adminOk) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  await bot.sendChatAction(chatId, "typing");

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Users who first joined (appeared in DB) within the last 24h
    const newUsers = await db.select().from(telegramUsersTable)
      .where(gte(telegramUsersTable.firstSeen, since))
      .orderBy(desc(telegramUsersTable.firstSeen))
      .limit(50)
      .catch(() => [] as typeof telegramUsersTable.$inferSelect[]);

    if (!newUsers.length) {
      await bot.sendMessage(chatId, "📋 Новых участников за последние 24 часа не обнаружено", {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    const results: string[] = [];
    let suspectCount = 0;

    for (const user of newUsers.slice(0, 20)) {
      const [msgCount] = await db.select({ c: count() }).from(messageLogTable)
        .where(and(eq(messageLogTable.userId, user.userId), eq(messageLogTable.chatId, chatId)))
        .catch(() => [{ c: 0 }]);

      const [warnCount] = await db.select({ c: count() }).from(groupWarningsTable)
        .where(and(eq(groupWarningsTable.userId, user.userId), eq(groupWarningsTable.groupId, chatId)))
        .catch(() => [{ c: 0 }]);

      const msgs = Number(msgCount?.c ?? 0);
      const warns = Number(warnCount?.c ?? 0);
      const name = user.username ? `@${user.username}` : (user.firstName ?? `id${user.userId}`);

      // Heuristics: zero messages (lurker/bot) or has warnings
      let status = "✅";
      let flags: string[] = [];
      if (msgs === 0) { flags.push("0 сообщений"); }
      if (warns > 0) { flags.push(`${warns} варн(а)`); }
      if (user.messageCount !== null && user.messageCount < 2) { flags.push("низкая активность"); }

      if (flags.length > 0) {
        status = warns > 0 ? "🔴" : "🟡";
        suspectCount++;
      }

      results.push(`${status} ${name} — ${msgs} сообщ.${flags.length ? ` (⚠️ ${flags.join(", ")})` : ""}`);
    }

    const header = [
      `🔍 <b>Проверка новичков (24ч)</b>`,
      ``,
      `👥 Всего новых: <b>${newUsers.length}</b>`,
      `⚠️ Подозрительных: <b>${suspectCount}</b>`,
      ``,
      `<b>Список:</b>`,
    ].join("\n");

    const body = results.join("\n");
    const footer = `\n\n🟡 — нет активности  🔴 — есть нарушения  ✅ — норм`;

    const full = header + "\n" + body + footer;
    // Telegram message limit
    const chunks = full.match(/.{1,4000}/gs) ?? [full];
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
    }

    logger.info({ chatId, newUsers: newUsers.length, suspects: suspectCount }, "Spam check done");
  } catch (err) {
    logger.error({ err }, "/spam_check failed");
    await bot.sendMessage(chatId, "ошибка при проверке новичков").catch(() => {});
  }
}

// ─── /stats — engagement stats for the group (admin panel) ───────────────────

export async function handleEngagementStats(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const adminOk = isOwner(from.id) || (isGroup && await isAdmin(bot, chatId, from.id));
  if (!adminOk) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  await bot.sendChatAction(chatId, "typing");

  try {
    const now = Date.now();
    const day = new Date(now - 24 * 60 * 60 * 1000);
    const week = new Date(now - 7 * 24 * 60 * 60 * 1000);

    // New users (from DB first seen)
    const [newToday] = await db.select({ c: count() }).from(telegramUsersTable)
      .where(gte(telegramUsersTable.firstSeen, day)).catch(() => [{ c: 0 }]);
    const [newWeek] = await db.select({ c: count() }).from(telegramUsersTable)
      .where(gte(telegramUsersTable.firstSeen, week)).catch(() => [{ c: 0 }]);

    // Referrals for this chat
    const [refTotal] = await db.select({ c: count() }).from(referralsTable)
      .where(eq(referralsTable.chatId, chatId)).catch(() => [{ c: 0 }]);
    const [refWeek] = await db.select({ c: count() }).from(referralsTable)
      .where(and(eq(referralsTable.chatId, chatId), gte(referralsTable.joinedAt, week)))
      .catch(() => [{ c: 0 }]);

    // Top referrer
    const topReferrer = await db
      .select({ referrerId: referralsTable.referrerId, cnt: count() })
      .from(referralsTable)
      .where(eq(referralsTable.chatId, chatId))
      .groupBy(referralsTable.referrerId)
      .orderBy(desc(count()))
      .limit(1)
      .catch(() => []);

    let topRefName = "—";
    if (topReferrer[0]) {
      const [u] = await db.select().from(telegramUsersTable)
        .where(eq(telegramUsersTable.userId, topReferrer[0].referrerId)).catch(() => []);
      topRefName = u?.username ? `@${u.username}` : (u?.firstName ?? `id${topReferrer[0].referrerId}`);
    }

    // Invite links
    const [linksCount] = await db.select({ c: count() }).from(inviteLinksTable)
      .where(eq(inviteLinksTable.chatId, chatId)).catch(() => [{ c: 0 }]);

    // Messages in this chat (last 24h and 7d)
    const [msgsToday] = await db.select({ c: count() }).from(messageLogTable)
      .where(and(eq(messageLogTable.chatId, chatId), gte(messageLogTable.createdAt, day)))
      .catch(() => [{ c: 0 }]);
    const [msgsWeek] = await db.select({ c: count() }).from(messageLogTable)
      .where(and(eq(messageLogTable.chatId, chatId), gte(messageLogTable.createdAt, week)))
      .catch(() => [{ c: 0 }]);

    // Active users in this chat
    const [activeToday] = await db.select({ c: count() }).from(userAnalyticsTable)
      .where(and(eq(userAnalyticsTable.chatId, chatId), gte(userAnalyticsTable.lastActive, day)))
      .catch(() => [{ c: 0 }]);

    // Top 5 most active users in this chat
    const topActive = await db.select({ userId: userAnalyticsTable.userId, msgCount: userAnalyticsTable.messageCount })
      .from(userAnalyticsTable)
      .where(eq(userAnalyticsTable.chatId, chatId))
      .orderBy(desc(userAnalyticsTable.messageCount))
      .limit(5)
      .catch(() => [] as { userId: number; msgCount: number }[]);

    const topLines = await Promise.all(topActive.map(async (r, i) => {
      const [u] = await db.select().from(telegramUsersTable)
        .where(eq(telegramUsersTable.userId, r.userId)).catch(() => []);
      const name = u?.username ? `@${u.username}` : (u?.firstName ?? `id${r.userId}`);
      const medals = ["🥇", "🥈", "🥉", "4.", "5."];
      return `${medals[i]} ${name} — ${r.msgCount} сообщ.`;
    }));

    // Whitelist size
    const wlSize = getWhitelist(chatId).length;

    // Rate window status
    const rateInfo = checkAddRate(chatId);

    const text = [
      `📊 <b>Статистика вовлечённости</b>`,
      ``,
      `━━━ 👋 НОВИЧКИ ━━━`,
      `✨ Новых сегодня: <b>${newToday?.c ?? 0}</b>`,
      `🗓 Новых за неделю: <b>${newWeek?.c ?? 0}</b>`,
      ``,
      `━━━ 🔗 РЕФЕРАЛЬНАЯ СИСТЕМА ━━━`,
      `📩 Всего переходов по ссылкам: <b>${refTotal?.c ?? 0}</b>`,
      `📅 Переходов за неделю: <b>${refWeek?.c ?? 0}</b>`,
      `🏆 Лучший пригласитель: <b>${topRefName}</b>${topReferrer[0] ? ` (${topReferrer[0].cnt} чел.)` : ""}`,
      `📋 Создано invite-ссылок: <b>${linksCount?.c ?? 0}</b>`,
      ``,
      `━━━ 💬 АКТИВНОСТЬ ━━━`,
      `📝 Сообщений сегодня: <b>${msgsToday?.c ?? 0}</b>`,
      `📝 Сообщений за неделю: <b>${msgsWeek?.c ?? 0}</b>`,
      `🟢 Активных сегодня: <b>${activeToday?.c ?? 0}</b>`,
      ``,
      `━━━ 🏆 ТОП-5 АКТИВНЫХ ━━━`,
      topLines.length ? topLines.join("\n") : "нет данных",
      ``,
      `━━━ 🔒 БЕЗОПАСНОСТЬ ━━━`,
      `✅ Белый список: <b>${wlSize}</b> пользователей`,
      `➕ Добавлений в этот час: <b>${MAX_ADDS_PER_HOUR - rateInfo.remaining}</b> / ${MAX_ADDS_PER_HOUR}`,
      rateInfo.remaining < MAX_ADDS_PER_HOUR ? `⏳ Лимит сбросится через: <b>${fmtTime(rateInfo.resetsIn)}</b>` : "",
    ].filter(l => l !== "").join("\n");

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "🔍 Проверить новичков", callback_data: `eng_spamcheck:${chatId}` },
          { text: "🏆 Рейтинг", callback_data: `eng_referrals:${chatId}` },
        ]],
      },
    });
  } catch (err) {
    logger.error({ err }, "/stats failed");
    await bot.sendMessage(chatId, "ошибка при получении статистики").catch(() => {});
  }
}

// ─── /add_users — mass add by generating one-use invite links ─────────────────

export async function handleMassAddUsers(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  usernames: string[],
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }

  const adminOk = isOwner(from.id) || await isAdmin(bot, chatId, from.id);
  if (!adminOk) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  if (!usernames.length) {
    await bot.sendMessage(chatId,
      "📋 <b>Массовое приглашение</b>\n\n" +
      "Укажи username'ы через пробел:\n" +
      "<code>/add_users @user1 @user2 @user3</code>\n\n" +
      "Для каждого будет создана одноразовая ссылка-приглашение.",
      { parse_mode: "HTML", reply_to_message_id: msg.message_id }
    );
    return;
  }

  // Check rate limit
  const rateInfo = checkAddRate(chatId);
  const canAdd = Math.min(usernames.length, rateInfo.remaining);

  if (canAdd === 0) {
    await bot.sendMessage(chatId,
      `⚠️ Лимит добавления исчерпан (${MAX_ADDS_PER_HOUR}/час)\n` +
      `Сброс через: ${fmtTime(rateInfo.resetsIn)}`,
      { reply_to_message_id: msg.message_id }
    );
    return;
  }

  const toProcess = usernames.slice(0, canAdd);
  const skipped = usernames.length - canAdd;

  const progressMsg = await bot.sendMessage(chatId,
    `⏳ Создаю ${toProcess.length} ссылок-приглашений...`,
    { reply_to_message_id: msg.message_id }
  );

  const results: string[] = [];
  for (const raw of toProcess) {
    const username = raw.replace(/^@/, "");
    try {
      const link = await bot.createChatInviteLink(chatId, {
        name: `Для @${username}`,
        member_limit: 1,
        expire_date: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      });
      incrementAddRate(chatId);
      results.push(`✅ @${username} — ${link.invite_link}`);
      await new Promise(r => setTimeout(r, 800)); // Rate limit between API calls
    } catch {
      results.push(`❌ @${username} — не удалось`);
    }
  }

  await bot.deleteMessage(chatId, progressMsg.message_id).catch(() => {});

  const replyLines = [
    `📋 <b>Результаты массового приглашения:</b>`,
    ``,
    ...results,
    skipped > 0 ? `\n⚠️ Ещё ${skipped} пропущено — достигнут лимит (${MAX_ADDS_PER_HOUR}/час)` : "",
    ``,
    `<i>Ссылки действительны 7 дней, одно использование. Отправь их пользователям.</i>`,
  ].filter(l => l !== "").join("\n");

  // Split if too long
  const chunks = replyLines.match(/[\s\S]{1,4000}/g) ?? [replyLines];
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" }).catch(() => {});
  }
}

// ─── /mention — group broadcast with @mention (bypass DM restriction) ─────────

export async function handleMention(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  targetUsername: string,
  text: string,
  botUsername: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }

  const adminOk = isOwner(from.id) || await isAdmin(bot, chatId, from.id);
  if (!adminOk) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  if (!targetUsername || !text) {
    await bot.sendMessage(chatId,
      "📢 <b>Упоминание в группе</b>\n\n" +
      "Использование:\n" +
      "<code>/mention @username текст сообщения</code>\n\n" +
      "Бот напишет в группе, тегнув пользователя с твоим текстом.",
      { parse_mode: "HTML", reply_to_message_id: msg.message_id }
    );
    return;
  }

  const clean = targetUsername.replace(/^@/, "");
  await bot.sendMessage(chatId, `@${clean} ${text}`, {
    reply_markup: {
      inline_keyboard: [[
        { text: "💬 Написать в ЛС", url: `https://t.me/${clean}` },
        { text: "✉️ Написать Сэму", url: `https://t.me/${botUsername}?start=dm_${from.id}` },
      ]],
    },
  });
}

// ─── Engagement stats callback handler ────────────────────────────────────────

export function isEngagementCallback(data: string): boolean {
  return data.startsWith("eng_");
}

export async function handleEngagementCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id;
  if (!chatId) return;

  if (data.startsWith("eng_spamcheck:")) {
    const targetChat = parseInt(data.split(":")[1] ?? "0");
    if (targetChat) {
      await bot.answerCallbackQuery(query.id, { text: "🔍 Проверяю новичков..." });
      await handleSpamCheck(bot, { ...query.message!, chat: { ...query.message!.chat, id: targetChat } } as TelegramBot.Message);
    }
    return;
  }

  if (data.startsWith("eng_referrals:")) {
    await bot.answerCallbackQuery(query.id, { text: "🏆 Загружаю рейтинг..." });
    if (query.message) {
      const { handleReferrals } = await import("./referral");
      await handleReferrals(bot, query.message);
    }
    return;
  }

  await bot.answerCallbackQuery(query.id);
}
