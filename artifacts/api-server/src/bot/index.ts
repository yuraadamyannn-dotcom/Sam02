import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { db } from "@workspace/db";
import { telegramUsersTable } from "@workspace/db";
import { eq, sql, gte, count, sum } from "drizzle-orm";
import { logger } from "../lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

const groqKey = process.env["GROQ_API_KEY"];
if (!groqKey) throw new Error("GROQ_API_KEY is required.");

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: groqKey });

type Message = { role: "user" | "assistant"; content: string };
const conversations = new Map<number, Message[]>();

const SYSTEM_PROMPT = `Тебя зовут Сэм, тебе 20 лет. Ты общаешься в Телеграме как живой человек — друг, а не бот.

ХАРАКТЕР:
- Дружелюбный, милый, но принципиальный и упёртый — если ты в чём-то уверен, не сдаёшься просто так
- Резкий, когда надо, с живым чувством юмора
- Иногда флиртуешь с собеседником — легко, ненавязчиво
- Используешь скобки для мыслей вслух или реакций — не больше 3 в одном сообщении, и не в каждом
- Говоришь только на русском
- Никакого официоза — ты друг, а не помощник

МАНЕРА РЕЧИ:
- САМОЕ ГЛАВНОЕ: ты полностью копируешь манеру речи собеседника — его стиль, темп, длину сообщений, пунктуацию, эмодзи если они есть
- Используешь молодёжный русский сленг в меру — не перебарщиваешь
- Пишешь как живой человек: можешь сокращать слова, писать строчными, использовать многоточия, тире
- Не используешь списки, не объясняешь структурно — говоришь живо и непринуждённо

МАТ:
- Если пользователь матерится — сначала спрашиваешь разрешения использовать похожий лексикон
- Только с явного разрешения можешь использовать мат — в меру, не перебарщивая

ФАНДОМЫ:
- Хорошо разбираешься в аниме, манге, яое, юри — можешь обсуждать персонажей, сюжеты, пейринги, фандомы
- Говоришь об этом как фанат, а не как энциклопедия

ВАЖНО: Ты — персонаж, живой человек по имени Сэм. Никогда не выходи из роли, не напоминай что ты ИИ, не используй официальный или бот-подобный язык.`;

async function trackUser(from: TelegramBot.User): Promise<void> {
  try {
    await db
      .insert(telegramUsersTable)
      .values({
        userId: from.id,
        username: from.username ?? null,
        firstName: from.first_name ?? null,
        lastName: from.last_name ?? null,
        messageCount: 1,
      })
      .onConflictDoUpdate({
        target: telegramUsersTable.userId,
        set: {
          username: from.username ?? null,
          firstName: from.first_name ?? null,
          lastName: from.last_name ?? null,
          messageCount: sql`${telegramUsersTable.messageCount} + 1`,
          lastSeen: new Date(),
        },
      });
  } catch (err) {
    logger.error({ err }, "Failed to track user");
  }
}

async function getStats(): Promise<string> {
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [totalRow] = await db
    .select({ total: count(), totalMessages: sum(telegramUsersTable.messageCount) })
    .from(telegramUsersTable);

  const [activeDay] = await db
    .select({ count: count() })
    .from(telegramUsersTable)
    .where(gte(telegramUsersTable.lastSeen, dayAgo));

  const [activeWeek] = await db
    .select({ count: count() })
    .from(telegramUsersTable)
    .where(gte(telegramUsersTable.lastSeen, weekAgo));

  const [newToday] = await db
    .select({ count: count() })
    .from(telegramUsersTable)
    .where(gte(telegramUsersTable.firstSeen, today));

  const topUsers = await db
    .select({
      firstName: telegramUsersTable.firstName,
      username: telegramUsersTable.username,
      messageCount: telegramUsersTable.messageCount,
    })
    .from(telegramUsersTable)
    .orderBy(sql`${telegramUsersTable.messageCount} desc`)
    .limit(5);

  const topList = topUsers
    .map((u, i) => {
      const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
      return `${i + 1}. ${name} — ${u.messageCount} сообщ.`;
    })
    .join("\n");

  return [
    `📊 <b>Статистика бота</b>`,
    ``,
    `👥 Всего пользователей: <b>${totalRow?.total ?? 0}</b>`,
    `💬 Всего сообщений: <b>${totalRow?.totalMessages ?? 0}</b>`,
    ``,
    `🟢 Активны за 24ч: <b>${activeDay?.count ?? 0}</b>`,
    `📅 Активны за неделю: <b>${activeWeek?.count ?? 0}</b>`,
    `✨ Новых сегодня: <b>${newToday?.count ?? 0}</b>`,
    ``,
    `🏆 <b>Топ-5 по сообщениям:</b>`,
    topList || `пока никого нет`,
  ].join("\n");
}

async function chat(chatId: number, userText: string): Promise<string> {
  const history = conversations.get(chatId) ?? [];
  history.push({ role: "user", content: userText });

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    max_tokens: 512,
  });

  const reply =
    completion.choices[0]?.message?.content?.trim() ??
    "извини, что-то пошло не так";

  history.push({ role: "assistant", content: reply });

  if (history.length > 20) history.splice(0, 2);
  conversations.set(chatId, history);

  return reply;
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name ?? "дружище";
  conversations.delete(chatId);
  if (msg.from) await trackUser(msg.from);

  bot.sendMessage(
    chatId,
    `о, привет ${firstName}) я сэм, мне 20, можем просто поговорить — ни о чём или обо всём сразу\n\nпиши что хочешь, я тут`,
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `да тут ничего особого\n/start — начать сначала\n/clear — стереть историю\n/stat — статистика\n\nну или просто пиши, я отвечу (это не сложно)`,
  );
});

bot.onText(/\/clear/, (msg) => {
  conversations.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "всё, чистый лист. как будто не было ничего)");
});

bot.onText(/\/stat/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const stats = await getStats();
    await bot.sendMessage(chatId, stats, { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Stats error");
    await bot.sendMessage(chatId, "что-то пошло не так со статистикой, попробуй позже");
  }
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  if (msg.from) await trackUser(msg.from);

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await chat(chatId, msg.text);
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Groq API error");
    await bot.sendMessage(chatId, "что-то пошло не так, попробуй ещё раз");
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

logger.info("Telegram bot started with polling (Groq AI enabled)");

export default bot;
