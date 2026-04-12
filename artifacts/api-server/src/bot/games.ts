import TelegramBot from "node-telegram-bot-api";
import { db } from "@workspace/db";
import { marriagesTable } from "@workspace/db";
import { eq, and, or } from "drizzle-orm";
import { logger } from "../lib/logger";

// ─── In-memory game state ─────────────────────────────────────────────────────

interface DuelChallenge {
  challengerId: number;
  challengerName: string;
  targetId: number;
  chatId: number;
  expiresAt: number;
}

interface MarriageProposal {
  proposerId: number;
  proposerName: string;
  targetId: number;
  chatId: number;
  expiresAt: number;
}

interface MafiaGame {
  chatId: number;
  adminId: number;
  players: Map<number, { name: string; role?: string }>;
  phase: "lobby" | "started" | "ended";
  messageId?: number;
}

const duelChallenges = new Map<string, DuelChallenge>();
const marriageProposals = new Map<string, MarriageProposal>();
const mafiaGames = new Map<number, MafiaGame>();

const MAFIA_ROLES = ["Мафия", "Мафия", "Шериф", "Доктор", "Мирный", "Мирный", "Мирный", "Мирный"];

function duelKey(chatId: number, targetId: number) { return `${chatId}:${targetId}`; }
function proposalKey(chatId: number, targetId: number) { return `${chatId}:${targetId}`; }

function userName(user: TelegramBot.User): string {
  return user.username ? `@${user.username}` : (user.first_name ?? "Игрок");
}

// ─── DUEL ────────────────────────────────────────────────────────────────────

export async function handleDuel(bot: TelegramBot, msg: TelegramBot.Message, targetUser: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from!;
  if (!targetUser) {
    await bot.sendMessage(chatId, "Укажи кого вызвать: /duel @username", { reply_to_message_id: msg.message_id });
    return;
  }
  if (targetUser.id === from.id) {
    await bot.sendMessage(chatId, "сам себя вызываешь? вот это уровень 💀", { reply_to_message_id: msg.message_id });
    return;
  }

  const key = duelKey(chatId, targetUser.id);
  duelChallenges.set(key, {
    challengerId: from.id,
    challengerName: userName(from),
    targetId: targetUser.id,
    chatId,
    expiresAt: Date.now() + 2 * 60 * 1000,
  });

  await bot.sendMessage(
    chatId,
    `⚔️ <b>${userName(from)}</b> вызывает на дуэль <b>${userName(targetUser)}</b>!\n\n${userName(targetUser)}, принимаешь вызов? У тебя 2 минуты.`,
    {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Принять вызов", callback_data: `duel_accept:${from.id}:${chatId}` },
          { text: "🏳️ Отказаться", callback_data: `duel_decline:${from.id}:${chatId}` },
        ]],
      },
    }
  );
}

export async function handleDuelCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const msgId = query.message?.message_id;
  const responder = query.from;
  if (!chatId || !responder) { await bot.answerCallbackQuery(query.id); return; }

  const [action, challengerIdStr] = (query.data ?? "").split(":");
  const challengerId = parseInt(challengerIdStr ?? "0");
  const key = duelKey(chatId, responder.id);
  const challenge = duelChallenges.get(key);

  if (!challenge || challenge.challengerId !== challengerId) {
    await bot.answerCallbackQuery(query.id, { text: "Это не твоя дуэль", show_alert: true });
    return;
  }

  if (Date.now() > challenge.expiresAt) {
    duelChallenges.delete(key);
    await bot.answerCallbackQuery(query.id, { text: "Время вышло" });
    await bot.editMessageText("⚔️ Дуэль просрочена — никто не пришёл.", { chat_id: chatId, message_id: msgId, parse_mode: "HTML" });
    return;
  }

  if (action === "duel_decline") {
    duelChallenges.delete(key);
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageText(
      `🏳️ <b>${userName(responder)}</b> отказался от дуэли. Трус, что сказать.`,
      { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
    );
    return;
  }

  duelChallenges.delete(key);
  await bot.answerCallbackQuery(query.id, { text: "Дуэль начинается!" });

  // Roll dice
  const roll1 = Math.floor(Math.random() * 100) + 1;
  const roll2 = Math.floor(Math.random() * 100) + 1;

  await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId });

  const loading = await bot.sendMessage(chatId, "🎲 Дуэлянты занимают позиции...", { parse_mode: "HTML" });

  await new Promise(r => setTimeout(r, 1500));
  await bot.editMessageText(`🎲 Дуэлянты занимают позиции...\n\n🔫 <b>${challenge.challengerName}</b> делает выстрел... [${roll1}/100]`, { chat_id: chatId, message_id: loading.message_id, parse_mode: "HTML" });
  await new Promise(r => setTimeout(r, 1500));

  let result: string;
  if (roll1 === roll2) {
    result = `🤝 <b>Ничья!</b> Оба промахнулись — ${roll1} vs ${roll2}. Честный исход.`;
  } else if (roll1 > roll2) {
    result = `💀 <b>${challenge.challengerName}</b> побеждает! [${roll1} vs ${roll2}]\n<b>${userName(responder)}</b> сражён.`;
  } else {
    result = `💀 <b>${userName(responder)}</b> побеждает! [${roll2} vs ${roll1}]\n<b>${challenge.challengerName}</b> сражён.`;
  }

  await bot.editMessageText(`⚔️ <b>Результат дуэли</b>\n\n${result}`, { chat_id: chatId, message_id: loading.message_id, parse_mode: "HTML" });
}

// ─── MARRY ────────────────────────────────────────────────────────────────────

export async function handleMarry(bot: TelegramBot, msg: TelegramBot.Message, targetUser: TelegramBot.User | null): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from!;
  if (!targetUser) {
    await bot.sendMessage(chatId, "кому предлагать руку и сердце? /marry @username", { reply_to_message_id: msg.message_id });
    return;
  }
  if (targetUser.id === from.id) {
    await bot.sendMessage(chatId, "себе предлагаешь? звучит не очень)", { reply_to_message_id: msg.message_id });
    return;
  }

  // Check existing marriage
  const existingFrom = await db.select().from(marriagesTable).where(
    or(eq(marriagesTable.user1Id, from.id), eq(marriagesTable.user2Id, from.id))
  );
  if (existingFrom.length > 0) {
    await bot.sendMessage(chatId, "ты уже в браке 💍 сначала /divorce", { reply_to_message_id: msg.message_id });
    return;
  }

  const key = proposalKey(chatId, targetUser.id);
  marriageProposals.set(key, {
    proposerId: from.id,
    proposerName: userName(from),
    targetId: targetUser.id,
    chatId,
    expiresAt: Date.now() + 3 * 60 * 1000,
  });

  await bot.sendMessage(
    chatId,
    `💍 <b>${userName(from)}</b> делает предложение <b>${userName(targetUser)}</b>!\n\n${userName(targetUser)}, что ты ответишь?`,
    {
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          { text: "💍 Да!", callback_data: `marry_yes:${from.id}:${chatId}` },
          { text: "💔 Нет", callback_data: `marry_no:${from.id}:${chatId}` },
        ]],
      },
    }
  );
}

export async function handleMarryCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const msgId = query.message?.message_id;
  const responder = query.from;
  if (!chatId || !responder) { await bot.answerCallbackQuery(query.id); return; }

  const [action, proposerIdStr] = (query.data ?? "").split(":");
  const proposerId = parseInt(proposerIdStr ?? "0");
  const key = proposalKey(chatId, responder.id);
  const proposal = marriageProposals.get(key);

  if (!proposal || proposal.proposerId !== proposerId) {
    await bot.answerCallbackQuery(query.id, { text: "Это не твоё предложение", show_alert: true });
    return;
  }

  marriageProposals.delete(key);

  if (action === "marry_no") {
    await bot.answerCallbackQuery(query.id);
    await bot.editMessageText(
      `💔 <b>${userName(responder)}</b> отказал(а). ${proposal.proposerName} — держись.`,
      { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
    );
    return;
  }

  await bot.answerCallbackQuery(query.id, { text: "Поздравляю! 💍" });

  try {
    await db.insert(marriagesTable).values({
      user1Id: proposerId,
      user2Id: responder.id,
      groupId: chatId < 0 ? chatId : null,
    });
  } catch (err) {
    logger.error({ err }, "Failed to save marriage");
  }

  await bot.editMessageText(
    `💍 <b>${proposal.proposerName}</b> и <b>${userName(responder)}</b> теперь поженены!\n\n❤️ Горько!`,
    { chat_id: chatId, message_id: msgId, parse_mode: "HTML" }
  );
}

export async function handleDivorce(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const from = msg.from!;
  const chatId = msg.chat.id;

  const marriages = await db.select().from(marriagesTable).where(
    or(eq(marriagesTable.user1Id, from.id), eq(marriagesTable.user2Id, from.id))
  );

  if (!marriages.length) {
    await bot.sendMessage(chatId, "ты и так свободен)", { reply_to_message_id: msg.message_id });
    return;
  }

  await db.delete(marriagesTable).where(
    or(eq(marriagesTable.user1Id, from.id), eq(marriagesTable.user2Id, from.id))
  );
  await bot.sendMessage(chatId, "💔 Развод оформлен. Грустно, но бывает.", { reply_to_message_id: msg.message_id });
}

export async function handleMarriageStatus(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const from = msg.from!;
  const chatId = msg.chat.id;

  const marriages = await db.select().from(marriagesTable).where(
    or(eq(marriagesTable.user1Id, from.id), eq(marriagesTable.user2Id, from.id))
  );

  if (!marriages.length) {
    await bot.sendMessage(chatId, "ты не в браке — свободная птица)", { reply_to_message_id: msg.message_id });
    return;
  }

  const m = marriages[0]!;
  const since = m.marriedAt.toLocaleDateString("ru-RU");
  const partnerId = m.user1Id === from.id ? m.user2Id : m.user1Id;
  await bot.sendMessage(chatId, `💍 Ты в браке с ID ${partnerId} с ${since}`, { reply_to_message_id: msg.message_id });
}

// ─── MAFIA ────────────────────────────────────────────────────────────────────

export async function handleMafia(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from!;

  if (mafiaGames.has(chatId)) {
    await bot.sendMessage(chatId, "уже идёт игра. /mafiaend чтобы закончить", { reply_to_message_id: msg.message_id });
    return;
  }

  const game: MafiaGame = {
    chatId,
    adminId: from.id,
    players: new Map([[from.id, { name: userName(from) }]]),
    phase: "lobby",
  };
  mafiaGames.set(chatId, game);

  const sentMsg = await bot.sendMessage(
    chatId,
    `🎭 <b>МАФИЯ — набор игроков</b>\n\nОрганизатор: <b>${userName(from)}</b>\nИгроки (1): <b>${userName(from)}</b>\n\nНажми кнопку чтобы войти! Минимум 4 игрока.`,
    {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "🃏 Войти в игру", callback_data: `mafia_join:${chatId}` },
          { text: "🚀 Начать", callback_data: `mafia_start:${chatId}` },
        ]],
      },
    }
  );
  game.messageId = sentMsg.message_id;
}

export async function handleMafiaCallback(bot: TelegramBot, query: TelegramBot.CallbackQuery): Promise<void> {
  const chatId = query.message?.chat.id;
  const msgId = query.message?.message_id;
  const user = query.from;
  if (!chatId || !user) { await bot.answerCallbackQuery(query.id); return; }

  const [action, gameChatIdStr] = (query.data ?? "").split(":");
  const gameChatId = parseInt(gameChatIdStr ?? "0");
  const game = mafiaGames.get(gameChatId);
  if (!game) { await bot.answerCallbackQuery(query.id, { text: "Игра не найдена" }); return; }

  if (action === "mafia_join") {
    if (game.phase !== "lobby") { await bot.answerCallbackQuery(query.id, { text: "Игра уже началась" }); return; }
    if (game.players.has(user.id)) { await bot.answerCallbackQuery(query.id, { text: "Ты уже в игре" }); return; }
    game.players.set(user.id, { name: userName(user) });
    await bot.answerCallbackQuery(query.id, { text: "Ты в игре!" });

    const playerList = Array.from(game.players.values()).map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    await bot.editMessageText(
      `🎭 <b>МАФИЯ — набор игроков</b>\n\nИгроки (${game.players.size}):\n${playerList}\n\nМинимум 4 для старта.`,
      {
        chat_id: chatId, message_id: msgId, parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🃏 Войти в игру", callback_data: `mafia_join:${chatId}` },
            { text: "🚀 Начать", callback_data: `mafia_start:${chatId}` },
          ]],
        },
      }
    );
    return;
  }

  if (action === "mafia_start") {
    if (user.id !== game.adminId) { await bot.answerCallbackQuery(query.id, { text: "Только организатор может начать" }); return; }
    if (game.players.size < 4) { await bot.answerCallbackQuery(query.id, { text: "Нужно минимум 4 игрока!" }); return; }
    game.phase = "started";
    await bot.answerCallbackQuery(query.id);

    // Assign roles
    const playerIds = Array.from(game.players.keys());
    const shuffledRoles = [...MAFIA_ROLES].sort(() => Math.random() - 0.5);
    const rolesNeeded = playerIds.length;
    const extraCivilians = Math.max(0, rolesNeeded - MAFIA_ROLES.length);
    const roles = shuffledRoles.slice(0, rolesNeeded).concat(Array(extraCivilians).fill("Мирный"));
    roles.sort(() => Math.random() - 0.5);

    const mafiaPlayers: string[] = [];
    for (let i = 0; i < playerIds.length; i++) {
      const pid = playerIds[i]!;
      const role = roles[i] ?? "Мирный";
      game.players.get(pid)!.role = role;
      if (role === "Мафия") mafiaPlayers.push(game.players.get(pid)!.name);

      try {
        await bot.sendMessage(pid, `🎭 <b>Мафия началась!</b>\n\nТвоя роль: <b>${role}</b>\n\n${getRoleDescription(role)}`, { parse_mode: "HTML" });
      } catch {
        // User may not have private chat with bot
      }
    }

    const playerList = Array.from(game.players.values()).map((p, i) => `${i + 1}. ${p.name}`).join("\n");
    await bot.editMessageText(
      `🎭 <b>МАФИЯ — игра началась!</b>\n\nИгроки:\n${playerList}\n\nРоли разосланы в личку.\n\n🌙 Наступает ночь... Мафия выбирает жертву.`,
      { chat_id: chatId, message_id: msgId, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } }
    );
    return;
  }
}

function getRoleDescription(role: string): string {
  switch (role) {
    case "Мафия": return "Ты мафиози. Ночью договаривайся с командой и убивайте мирных. Днём — притворяйся своим.";
    case "Шериф": return "Ты шериф. Ночью можешь проверить одного игрока — мафия ты или нет.";
    case "Доктор": return "Ты доктор. Каждую ночь можешь спасти одного игрока от смерти.";
    default: return "Ты мирный житель. Найди мафию и вычисли их с командой на голосовании.";
  }
}

export async function handleMafiaEnd(bot: TelegramBot, msg: TelegramBot.Message): Promise<void> {
  const chatId = msg.chat.id;
  const from = msg.from!;
  const game = mafiaGames.get(chatId);

  if (!game) {
    await bot.sendMessage(chatId, "нет активной игры", { reply_to_message_id: msg.message_id });
    return;
  }
  if (from.id !== game.adminId) {
    await bot.sendMessage(chatId, "только организатор может завершить игру", { reply_to_message_id: msg.message_id });
    return;
  }

  mafiaGames.delete(chatId);

  const roles = Array.from(game.players.entries())
    .map(([, p]) => `• ${p.name}: ${p.role ?? "?"}`)
    .join("\n");

  await bot.sendMessage(chatId, `🎭 <b>Мафия завершена!</b>\n\nРоли игроков:\n${roles}`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
}
