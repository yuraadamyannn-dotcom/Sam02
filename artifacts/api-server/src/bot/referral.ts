import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { inviteLinksTable, referralsTable, telegramUsersTable } from "@workspace/db";
import { eq, and, count, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

// ─── In-memory captcha state ──────────────────────────────────────────────────
// userId → { chatId, messageId, expiresAt, timer }
interface CaptchaState {
  chatId: number;
  messageId: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingCaptcha = new Map<number, CaptchaState>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isAdmin(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
  return bot.getChatMember(chatId, userId)
    .then(m => ["administrator", "creator"].includes(m.status))
    .catch(() => false);
}

function userName(u: TelegramBot.User): string {
  return u.username ? `@${u.username}` : (u.first_name ?? `id${u.id}`);
}

// ─── /invite — create a personalized Telegram invite link ─────────────────────

export async function handleInvite(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  botUsername: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда /invite работает только в группах", { reply_to_message_id: msg.message_id });
    return;
  }

  try {
    // Create a Telegram native invite link that auto-expires after 7 days
    const expire = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;
    const linkResult = await bot.createChatInviteLink(chatId, {
      name: `${from.first_name ?? from.username ?? from.id} — 7д`,
      expire_date: expire,
    });

    // Save to DB
    await db.insert(inviteLinksTable).values({
      chatId,
      creatorId: from.id,
      inviteLink: linkResult.invite_link,
      name: `${from.first_name}`,
    }).catch(() => {});

    // Also generate a bot deep link for referral tracking
    const refLink = `https://t.me/${botUsername}?start=ref_${chatId}_${from.id}`;

    const text = [
      `🔗 <b>Твоя персональная ссылка-приглашение:</b>`,
      ``,
      `<b>Прямая ссылка в чат (7 дней):</b>`,
      linkResult.invite_link,
      ``,
      `<b>Реферальная ссылка (через бота):</b>`,
      refLink,
      ``,
      `<i>Поделись любой из них — я буду отслеживать кто пришёл через тебя!</i>`,
    ].join("\n");

    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "📋 Скопировать ссылку в чат", url: linkResult.invite_link },
          { text: "🤖 Написать мне в ЛС", url: `https://t.me/${botUsername}?start=ref_${chatId}_${from.id}` },
        ]],
      },
    });
  } catch (err) {
    logger.warn({ err }, "/invite failed");
    await bot.sendMessage(chatId, "не могу создать ссылку — убедись, что у меня есть права администратора для управления приглашениями", {
      reply_to_message_id: msg.message_id,
    });
  }
}

// ─── Record referral when user starts bot via deep link ───────────────────────
// Called from /start ref_{chatId}_{userId} handler in index.ts

export async function recordReferral(
  bot: TelegramBot,
  newUserId: number,
  referrerId: number,
  chatId: number,
): Promise<void> {
  if (newUserId === referrerId) return; // Can't refer yourself

  // Don't double-record for same chat
  const existing = await db.select().from(referralsTable)
    .where(and(
      eq(referralsTable.newUserId, newUserId),
      eq(referralsTable.chatId, chatId),
    )).catch(() => []);
  if (existing.length > 0) return;

  await db.insert(referralsTable).values({ referrerId, newUserId, chatId }).catch(() => {});

  // Look up referrer name
  const [referrerRow] = await db.select().from(telegramUsersTable)
    .where(eq(telegramUsersTable.userId, referrerId)).catch(() => []);
  const refName = referrerRow?.username
    ? `@${referrerRow.username}` : (referrerRow?.firstName ?? `пользователь`);

  // DM the referrer to let them know
  await bot.sendMessage(referrerId,
    `🎉 Новый человек пришёл в чат по твоей ссылке! Уже ${await getReferralCount(referrerId, chatId)} приглашённых.`
  ).catch(() => {});

  logger.info({ referrerId, newUserId, chatId }, "Referral recorded");
  void refName;
}

async function getReferralCount(referrerId: number, chatId: number): Promise<number> {
  const [row] = await db.select({ c: count() }).from(referralsTable)
    .where(and(eq(referralsTable.referrerId, referrerId), eq(referralsTable.chatId, chatId)))
    .catch(() => [{ c: 0 }]);
  return row?.c ?? 0;
}

// ─── /referrals — top inviters leaderboard ────────────────────────────────────

export async function handleReferrals(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда работает только в группах", { reply_to_message_id: msg.message_id });
    return;
  }

  try {
    // Top 10 inviters for this chat
    const rows = await db
      .select({ referrerId: referralsTable.referrerId, cnt: count() })
      .from(referralsTable)
      .where(eq(referralsTable.chatId, chatId))
      .groupBy(referralsTable.referrerId)
      .orderBy(desc(count()))
      .limit(10);

    if (!rows.length) {
      await bot.sendMessage(chatId, "пока никто не приглашал людей через реферальную ссылку 😅\n\nИспользуй /invite чтобы создать свою ссылку!", {
        reply_to_message_id: msg.message_id,
      });
      return;
    }

    // Fetch user names
    const medals = ["🥇", "🥈", "🥉"];
    const lines = await Promise.all(rows.map(async (row, i) => {
      const [u] = await db.select().from(telegramUsersTable)
        .where(eq(telegramUsersTable.userId, row.referrerId)).catch(() => []);
      const name = u?.username ? `@${u.username}` : (u?.firstName ?? `id${row.referrerId}`);
      const medal = medals[i] ?? `${i + 1}.`;
      return `${medal} ${name} — <b>${row.cnt}</b> приглашённых`;
    }));

    const text = [`🏆 <b>Топ пригласителей чата</b>`, ``, ...lines].join("\n");
    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.warn({ err }, "/referrals failed");
    await bot.sendMessage(chatId, "ошибка при загрузке рейтинга").catch(() => {});
  }
}

// ─── /broadcast @user text — mention user in group ────────────────────────────

export async function handleBroadcastMention(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  targetUsername: string,
  text: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда работает только в группах", { reply_to_message_id: msg.message_id });
    return;
  }

  if (!(await isAdmin(bot, chatId, from.id))) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  const clean = targetUsername.replace(/^@/, "");
  const message = `@${clean} ${text}`;
  await bot.sendMessage(chatId, message, {
    reply_to_message_id: msg.message_id,
    reply_markup: {
      inline_keyboard: [[
        { text: "💬 Написать в ЛС", url: `https://t.me/${clean}` },
      ]],
    },
  });
}

// ─── /adduser @user1 @user2 — try to add users to chat ───────────────────────

export async function handleAddUser(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  usernames: string[],
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "команда работает только в группах", { reply_to_message_id: msg.message_id });
    return;
  }

  if (!(await isAdmin(bot, chatId, from.id))) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  if (!usernames.length) {
    await bot.sendMessage(chatId, "укажи username'ы: /adduser @user1 @user2 ...", { reply_to_message_id: msg.message_id });
    return;
  }

  const results: string[] = [];
  for (const raw of usernames.slice(0, 20)) { // Max 20 at a time
    const username = raw.replace(/^@/, "");
    try {
      // Generate a fresh invite link and share it in the group (we can't force-add users without their consent)
      const invLink = await bot.createChatInviteLink(chatId, {
        name: `Для @${username}`,
        member_limit: 1,
      });
      results.push(`✅ @${username} — ссылка: ${invLink.invite_link}`);
      // Rate limit between additions
      await new Promise(r => setTimeout(r, 1500));
    } catch {
      results.push(`❌ @${username} — не удалось`);
    }
  }

  const replyText = [
    `📋 <b>Результаты добавления:</b>`,
    ``,
    ...results,
    ``,
    `<i>Ссылки созданы на одно использование. Отправь их пользователям напрямую.</i>`,
  ].join("\n");

  await bot.sendMessage(chatId, replyText, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

// ─── New member captcha ───────────────────────────────────────────────────────
// When a new member joins, restrict them and ask them to click a button to verify.

export async function startCaptcha(
  bot: TelegramBot,
  chatId: number,
  newUser: TelegramBot.User,
): Promise<void> {
  try {
    // Restrict the new user from sending messages for 3 minutes
    await bot.restrictChatMember(chatId, newUser.id, {
      permissions: {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_voice_notes: false,
        can_send_video_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
        can_change_info: false,
        can_invite_users: false,
        can_pin_messages: false,
      },
      until_date: Math.floor(Date.now() / 1000) + 3 * 60,
    });

    const name = newUser.first_name ?? newUser.username ?? "Новичок";
    const callbackData = `captcha:${chatId}:${newUser.id}`;

    const sentMsg = await bot.sendMessage(
      chatId,
      `👋 ${name}, добро пожаловать!\n\nНажми кнопку ниже в течение <b>2 минут</b> чтобы подтвердить что ты не бот и начать писать.`,
      {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Я не бот, хочу писать!", callback_data: callbackData },
          ]],
        },
      }
    );

    // Auto-kick after 2 min if not verified
    const timer = setTimeout(async () => {
      const pending = pendingCaptcha.get(newUser.id);
      if (!pending) return;
      pendingCaptcha.delete(newUser.id);

      await bot.banChatMember(chatId, newUser.id).catch(() => {});
      // Immediately unban so they can rejoin — we just wanted to remove them
      await bot.unbanChatMember(chatId, newUser.id, { only_if_banned: true }).catch(() => {});
      await bot.deleteMessage(chatId, sentMsg.message_id).catch(() => {});
      await bot.sendMessage(chatId, `⏱ @${newUser.username ?? name} не прошёл проверку и был удалён.`).catch(() => {});
    }, 2 * 60 * 1000);

    pendingCaptcha.set(newUser.id, {
      chatId,
      messageId: sentMsg.message_id,
      expiresAt: Date.now() + 2 * 60 * 1000,
      timer,
    });

    logger.info({ chatId, userId: newUser.id }, "Captcha started");
  } catch {
    // If we don't have restrict permissions, just skip captcha silently
  }
}

// ─── Handle captcha callback button click ─────────────────────────────────────

export async function handleCaptchaCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  chatId: number,
  userId: number,
): Promise<void> {
  // Only the target user can pass their own captcha
  if (query.from.id !== userId) {
    await bot.answerCallbackQuery(query.id, {
      text: "это не твоя кнопка 😅",
      show_alert: false,
    }).catch(() => {});
    return;
  }

  const pending = pendingCaptcha.get(userId);
  if (!pending) {
    await bot.answerCallbackQuery(query.id, { text: "капча уже устарела" }).catch(() => {});
    return;
  }

  clearTimeout(pending.timer);
  pendingCaptcha.delete(userId);

  try {
    // Restore default group permissions
    await bot.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_voice_notes: true,
        can_send_video_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      },
    });

    await bot.answerCallbackQuery(query.id, { text: "✅ Верификация пройдена! Добро пожаловать!" }).catch(() => {});
    await bot.deleteMessage(chatId, pending.messageId).catch(() => {});
    await bot.sendMessage(chatId,
      `✅ ${query.from.first_name ?? `@${query.from.username}`} прошёл проверку и теперь может писать. Добро пожаловать! 👋`
    ).catch(() => {});

    logger.info({ chatId, userId }, "Captcha passed");
  } catch (err) {
    logger.warn({ err }, "Captcha verification failed");
    await bot.answerCallbackQuery(query.id, { text: "ошибка при верификации, обратись к администратору" }).catch(() => {});
  }
}

// ─── /dmlink — get a "write to me in DM" button ──────────────────────────────

export async function handleDmLink(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  botUsername: string,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const startParam = `dm_${from.id}`;

  await bot.sendMessage(chatId,
    `💬 Нажми кнопку ниже чтобы написать мне в личку:`,
    {
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "✉️ Написать Сэму в ЛС", url: `https://t.me/${botUsername}?start=${startParam}` },
        ]],
      },
    }
  );
}

// ─── /invitestats — admin view of referral stats ──────────────────────────────

export async function handleInviteStats(
  bot: TelegramBot,
  msg: TelegramBot.Message,
): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from;
  if (!from) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) return;

  if (!(await isAdmin(bot, chatId, from.id))) {
    await bot.sendMessage(chatId, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }

  const [totalRow] = await db.select({ c: count() }).from(referralsTable)
    .where(eq(referralsTable.chatId, chatId)).catch(() => [{ c: 0 }]);

  const [linksRow] = await db.select({ c: count() }).from(inviteLinksTable)
    .where(eq(inviteLinksTable.chatId, chatId)).catch(() => [{ c: 0 }]);

  const text = [
    `📊 <b>Статистика приглашений</b>`,
    ``,
    `🔗 Всего реферальных переходов: <b>${totalRow?.c ?? 0}</b>`,
    `📋 Создано персональных ссылок: <b>${linksRow?.c ?? 0}</b>`,
    ``,
    `Полный рейтинг: /referrals`,
  ].join("\n");

  await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}
