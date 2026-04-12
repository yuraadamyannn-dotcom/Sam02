import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { groupSettingsTable, groupCommandsTable, groupWarningsTable } from "@workspace/db";
import { eq, and, count } from "drizzle-orm";
import { logger } from "../lib/logger";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isGroup(msg: TelegramBot.Message): boolean {
  return msg.chat.type === "group" || msg.chat.type === "supergroup";
}

async function isAdmin(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch { return false; }
}

export async function handleGroupCommand(
  bot: TelegramBot,
  msg: TelegramBot.Message,
  text: string
): Promise<boolean> {
  if (!isGroup(msg)) return false;
  const chatId = msg.chat.id;
  const lower = text.toLowerCase().trim();

  const cmds = await db.select().from(groupCommandsTable).where(eq(groupCommandsTable.groupId, chatId));
  const match = cmds.find(c => lower === c.trigger.toLowerCase() || lower.startsWith(c.trigger.toLowerCase() + " "));
  if (!match) return false;

  if (match.responseType === "sticker") {
    await bot.sendSticker(chatId, match.response, { reply_to_message_id: msg.message_id });
  } else {
    await bot.sendMessage(chatId, match.response, { reply_to_message_id: msg.message_id });
  }
  return true;
}

// ─── Rules ───────────────────────────────────────────────────────────────────

export async function handleRules(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  if (!isGroup(msg)) { await bot.sendMessage(msg.chat.id, "это для групп", { reply_to_message_id: msg.message_id }); return; }
  const [settings] = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, msg.chat.id));
  if (!settings?.rules) {
    await bot.sendMessage(msg.chat.id, "правила ещё не установлены. Админ может: /setrules [текст]", { reply_to_message_id: msg.message_id });
    return;
  }
  await bot.sendMessage(msg.chat.id, `📋 <b>Правила чата:</b>\n\n${settings.rules}`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

export async function handleSetRules(bot: TelegramBot, msg: TelegramBot.Message, rules: string): Promise<void> {
  if (!isGroup(msg)) { await bot.sendMessage(msg.chat.id, "это для групп", { reply_to_message_id: msg.message_id }); return; }
  if (!msg.from || !(await isAdmin(bot, msg.chat.id, msg.from.id))) {
    await bot.sendMessage(msg.chat.id, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!rules.trim()) { await bot.sendMessage(msg.chat.id, "напиши правила после команды", { reply_to_message_id: msg.message_id }); return; }

  await db.insert(groupSettingsTable)
    .values({ groupId: msg.chat.id, rules: rules.trim() })
    .onConflictDoUpdate({ target: groupSettingsTable.groupId, set: { rules: rules.trim(), updatedAt: new Date() } });

  await bot.sendMessage(msg.chat.id, "✅ Правила установлены", { reply_to_message_id: msg.message_id });
}

// ─── Welcome ─────────────────────────────────────────────────────────────────

export async function handleSetWelcome(bot: TelegramBot, msg: TelegramBot.Message, text: string): Promise<void> {
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, msg.chat.id, msg.from.id))) {
    await bot.sendMessage(msg.chat.id, "только для администраторов", { reply_to_message_id: msg.message_id });
    return;
  }
  await db.insert(groupSettingsTable)
    .values({ groupId: msg.chat.id, welcomeMsg: text.trim() || null })
    .onConflictDoUpdate({ target: groupSettingsTable.groupId, set: { welcomeMsg: text.trim() || null, updatedAt: new Date() } });

  await bot.sendMessage(msg.chat.id, "✅ Приветствие установлено. Используй {name} для имени пользователя.", { reply_to_message_id: msg.message_id });
}

export async function handleNewMember(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const [settings] = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, chatId));
  if (!settings?.welcomeMsg) return;

  for (const member of msg.new_chat_members ?? []) {
    const name = member.first_name ?? member.username ?? "Новый участник";
    const text = settings.welcomeMsg.replace(/\{name\}/g, name);
    await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  }
}

// ─── Ban / Kick ───────────────────────────────────────────────────────────────

export async function handleBan(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) { await bot.sendMessage(chatId, "только для групп", { reply_to_message_id: msg.message_id }); return; }
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя: /ban @username или ответь на сообщение", { reply_to_message_id: msg.message_id }); return; }

  try {
    await bot.banChatMember(chatId, target.id);
    await bot.sendMessage(chatId, `🚫 <b>${target.first_name ?? target.username}</b> забанен.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.error({ err }, "Ban failed");
    await bot.sendMessage(chatId, "не смог забанить — проверь права бота", { reply_to_message_id: msg.message_id });
  }
}

export async function handleUnban(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя", { reply_to_message_id: msg.message_id }); return; }

  try {
    await bot.unbanChatMember(chatId, target.id);
    await bot.sendMessage(chatId, `✅ <b>${target.first_name ?? target.username}</b> разбанен.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.error({ err }, "Unban failed");
    await bot.sendMessage(chatId, "не смог разбанить", { reply_to_message_id: msg.message_id });
  }
}

// ─── Mute ────────────────────────────────────────────────────────────────────

export async function handleMute(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null, minutes = 60): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя: /mute @username [минуты]", { reply_to_message_id: msg.message_id }); return; }

  const untilDate = Math.floor(Date.now() / 1000) + minutes * 60;
  try {
    await bot.restrictChatMember(chatId, target.id, {
      permissions: { can_send_messages: false, can_send_other_messages: false, can_add_web_page_previews: false },
      until_date: untilDate,
    });
    await bot.sendMessage(chatId, `🔇 <b>${target.first_name ?? target.username}</b> замучен на ${minutes} мин.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.error({ err }, "Mute failed");
    await bot.sendMessage(chatId, "не смог замутить — проверь права бота", { reply_to_message_id: msg.message_id });
  }
}

export async function handleUnmute(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя", { reply_to_message_id: msg.message_id }); return; }

  try {
    await bot.restrictChatMember(chatId, target.id, {
      permissions: { can_send_messages: true, can_send_other_messages: true, can_add_web_page_previews: true, can_send_polls: true },
    });
    await bot.sendMessage(chatId, `🔊 <b>${target.first_name ?? target.username}</b> размучен.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  } catch (err) {
    logger.error({ err }, "Unmute failed");
    await bot.sendMessage(chatId, "не смог размутить", { reply_to_message_id: msg.message_id });
  }
}

// ─── Warnings ────────────────────────────────────────────────────────────────

export async function handleWarn(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null, reason?: string): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя: /warn @username [причина]", { reply_to_message_id: msg.message_id }); return; }

  await db.insert(groupWarningsTable).values({
    groupId: chatId,
    userId: target.id,
    reason: reason ?? null,
    issuedBy: msg.from.id,
  });

  const [{ warnCount }] = await db.select({ warnCount: count() }).from(groupWarningsTable)
    .where(and(eq(groupWarningsTable.groupId, chatId), eq(groupWarningsTable.userId, target.id)));

  const name = target.first_name ?? target.username ?? "Пользователь";
  const warnText = `⚠️ <b>${name}</b> получает предупреждение ${warnCount}/3${reason ? `\nПричина: ${reason}` : ""}`;

  if (Number(warnCount) >= 3) {
    try {
      await bot.banChatMember(chatId, target.id);
      await bot.sendMessage(chatId, `${warnText}\n\n🚫 3 предупреждения — автобан!`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
    } catch {
      await bot.sendMessage(chatId, `${warnText}\n\n(не смог забанить — проверь права бота)`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
    }
  } else {
    await bot.sendMessage(chatId, warnText, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
  }
}

export async function handleWarns(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  const checkTarget = target ?? msg.from;
  if (!checkTarget) return;

  const warns = await db.select().from(groupWarningsTable)
    .where(and(eq(groupWarningsTable.groupId, chatId), eq(groupWarningsTable.userId, checkTarget.id)));

  const name = checkTarget.first_name ?? checkTarget.username ?? "Пользователь";
  if (!warns.length) {
    await bot.sendMessage(chatId, `✅ У <b>${name}</b> нет предупреждений.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
    return;
  }
  const list = warns.map((w, i) => `${i + 1}. ${w.reason ?? "без причины"} (${new Date(w.createdAt).toLocaleDateString("ru-RU")})`).join("\n");
  await bot.sendMessage(chatId, `⚠️ <b>${name}</b> — предупреждений: ${warns.length}/3\n\n${list}`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

export async function handleUnwarn(bot: TelegramBot, msg: TelegramBot.Message, target: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!target) { await bot.sendMessage(chatId, "укажи пользователя", { reply_to_message_id: msg.message_id }); return; }

  const warns = await db.select().from(groupWarningsTable)
    .where(and(eq(groupWarningsTable.groupId, chatId), eq(groupWarningsTable.userId, target.id)));

  if (!warns.length) {
    await bot.sendMessage(chatId, "у пользователя нет предупреждений", { reply_to_message_id: msg.message_id });
    return;
  }

  const last = warns[warns.length - 1]!;
  await db.delete(groupWarningsTable).where(eq(groupWarningsTable.id, last.id));
  await bot.sendMessage(chatId, `✅ Последнее предупреждение у <b>${target.first_name ?? target.username}</b> снято.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

// ─── Custom commands ──────────────────────────────────────────────────────────

export async function handleAddCmd(bot: TelegramBot, msg: TelegramBot.Message, trigger: string, response: string): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }
  if (!trigger || !response) {
    await bot.sendMessage(chatId, "формат: /addcmd !команда текст ответа", { reply_to_message_id: msg.message_id });
    return;
  }

  await db.insert(groupCommandsTable)
    .values({ groupId: chatId, trigger: trigger.toLowerCase(), response, responseType: "text", createdBy: msg.from.id })
    .onConflictDoNothing();

  await bot.sendMessage(chatId, `✅ Команда <code>${trigger}</code> добавлена.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

export async function handleDelCmd(bot: TelegramBot, msg: TelegramBot.Message, trigger: string): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;
  if (!msg.from || !(await isAdmin(bot, chatId, msg.from.id))) {
    await bot.sendMessage(chatId, "у тебя нет прав", { reply_to_message_id: msg.message_id });
    return;
  }

  const cmds = await db.select().from(groupCommandsTable)
    .where(and(eq(groupCommandsTable.groupId, chatId), eq(groupCommandsTable.trigger, trigger.toLowerCase())));

  if (!cmds.length) { await bot.sendMessage(chatId, "команда не найдена", { reply_to_message_id: msg.message_id }); return; }
  await db.delete(groupCommandsTable).where(eq(groupCommandsTable.id, cmds[0]!.id));
  await bot.sendMessage(chatId, `✅ Команда <code>${trigger}</code> удалена.`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

export async function handleListCmds(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;

  const cmds = await db.select().from(groupCommandsTable).where(eq(groupCommandsTable.groupId, chatId));
  if (!cmds.length) {
    await bot.sendMessage(chatId, "нет пользовательских команд. Добавь: /addcmd !привет Всем привет!", { reply_to_message_id: msg.message_id });
    return;
  }
  const list = cmds.map(c => `• <code>${c.trigger}</code> → ${c.response.slice(0, 50)}${c.response.length > 50 ? "..." : ""}`).join("\n");
  await bot.sendMessage(chatId, `📋 <b>Команды чата:</b>\n\n${list}`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}

// ─── Group stats ──────────────────────────────────────────────────────────────

export async function handleGroupStats(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  if (!isGroup(msg)) return;

  try {
    const chatInfo = await bot.getChat(chatId);
    const memberCount = await bot.getChatMemberCount(chatId);
    const [{ warnTotal }] = await db.select({ warnTotal: count() }).from(groupWarningsTable).where(eq(groupWarningsTable.groupId, chatId));
    const [{ cmdCount }] = await db.select({ cmdCount: count() }).from(groupCommandsTable).where(eq(groupCommandsTable.groupId, chatId));

    const text = [
      `📊 <b>Статистика чата</b>`,
      ``,
      `👥 Участников: <b>${memberCount}</b>`,
      `⚠️ Предупреждений выдано: <b>${warnTotal}</b>`,
      `📝 Кастомных команд: <b>${cmdCount}</b>`,
      ``,
      `🤖 Бот: <b>Сэм</b>`,
      `📋 /rules — правила`,
      `📜 /cmds — команды`,
    ].join("\n");

    await bot.sendMessage(chatId, text, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
    void chatInfo;
  } catch (err) {
    logger.error({ err }, "Group stats failed");
    await bot.sendMessage(chatId, "не смог получить статистику", { reply_to_message_id: msg.message_id });
  }
}
