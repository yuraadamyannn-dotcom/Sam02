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

// Role priority order: special roles added as player count grows
// 4p: Мафия, Шериф, Мирный×2
// 5p: +Мафия
// 6p: +Доктор
// 7p: +Любовница
// 8p: +Комиссар
// 9p: +Маньяк
// 10p: +Церковник
// 11p: +Депутат
// 12p+: extra Мафия, rest Мирный

function buildRoles(count: number): string[] {
  const roles: string[] = [];
  const mafiaCount = count <= 6 ? 2 : count <= 9 ? 2 : 3;

  for (let i = 0; i < mafiaCount; i++) roles.push("Мафия");
  roles.push("Шериф");
  if (count >= 6) roles.push("Доктор");
  if (count >= 7) roles.push("Любовница");
  if (count >= 8) roles.push("Комиссар");
  if (count >= 9) roles.push("Маньяк");
  if (count >= 10) roles.push("Церковник");
  if (count >= 11) roles.push("Депутат");

  while (roles.length < count) roles.push("Мирный");
  return roles.sort(() => Math.random() - 0.5);
}

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
    const roles = buildRoles(playerIds.length);

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

const ROLE_EMOJIS: Record<string, string> = {
  "Мафия": "🔫",
  "Шериф": "🔍",
  "Доктор": "💊",
  "Любовница": "💋",
  "Комиссар": "👮",
  "Маньяк": "🔪",
  "Церковник": "⛪",
  "Депутат": "🏛",
  "Мирный": "👥",
};

export function getRoleEmoji(role: string): string {
  return ROLE_EMOJIS[role] ?? "👤";
}

function getRoleDescription(role: string): string {
  switch (role) {
    case "Мафия":
      return `🔫 <b>Мафия</b>\n\nТы мафиози. Ночью в личке договаривайся с командой — выберите жертву и напишите ведущему. Днём притворяйся мирным, отводи подозрения от своих. 3 убийства подряд — и мафия побеждает.`;
    case "Шериф":
      return `🔍 <b>Шериф</b>\n\nТы страж порядка. Каждую ночь напиши ведущему имя одного игрока для проверки — он скажет: мафия или нет. Используй информацию, чтобы направить голосование. Не раскрывайся слишком рано!`;
    case "Доктор":
      return `💊 <b>Доктор</b>\n\nТы хирург. Каждую ночь напиши ведущему имя игрока для защиты — этой ночью мафия не убьёт его. Себя можно защитить, но только один раз за игру. Угадай кого атакуют — и спаси жизнь.`;
    case "Любовница":
      return `💋 <b>Любовница</b>\n\nТы соблазнительница. Каждую ночь выбираешь одного игрока и "проводишь с ним ночь" — он теряет ночное действие. Если посетишь мафиози — узнаешь что он из мафии, но он тоже узнает о тебе. Играй осторожно.`;
    case "Комиссар":
      return `👮 <b>Комиссар</b>\n\nТы следователь. Раз за ночь можешь "задержать" одного игрока — он лишается ночного действия и не может быть убит этой ночью (но и ты теряешь свою). Помогай горожанам, блокируй ключевых персонажей.`;
    case "Маньяк":
      return `🔪 <b>Маньяк</b>\n\nТы одиночка. Каждую ночь убиваешь одного игрока — независимо от мафии. Твоя цель: остаться последним живым. Ты проигрываешь и мафии, и горожанам — выигрываешь только если все остальные мертвы. Никому не доверяй.`;
    case "Церковник":
      return `⛪ <b>Церковник</b>\n\nТы духовный защитник. Раз в ночь можешь "благословить" одного игрока — если мафия атакует его этой ночью, атака провалится. Благословение одноразовое на каждого. Найди союзников и защити их от тьмы.`;
    case "Депутат":
      return `🏛 <b>Депутат</b>\n\nТы влиятельный политик. У тебя есть депутатская неприкосновенность — одну ночь мафия не может тебя убить (используется автоматически в первую атаку). Также раз за игру можешь потребовать экстренное голосование вне очереди.`;
    default:
      return `👥 <b>Мирный житель</b>\n\nТы обычный горожанин. Твоё оружие — наблюдательность и логика. Следи за поведением игроков днём, ищи подозрительных и голосуй на казнь. Горожане побеждают, если вычислят всю мафию.`;
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
