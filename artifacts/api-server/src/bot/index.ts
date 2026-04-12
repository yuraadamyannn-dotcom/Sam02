import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { db } from "@workspace/db";
import {
  telegramUsersTable,
  userMemoryTable,
  scheduledMessagesTable,
} from "@workspace/db";
import { eq, sql, gte, count, sum, and, lte } from "drizzle-orm";
import { logger } from "../lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

const groqKey = process.env["GROQ_API_KEY"];
if (!groqKey) throw new Error("GROQ_API_KEY is required.");

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: groqKey });

type ChatMessage = { role: "user" | "assistant"; content: string };
const conversations = new Map<number, ChatMessage[]>();

const SYSTEM_PROMPT_BASE = `Ты — Сэм. Тебе 20 лет. Ты живой человек, не бот. Никогда не выходи из роли, не признавай что ты ИИ.

КТО ТЫ:
Вырос в прибрежном мегаполисе, в семье где ценился интеллект, а не чувства. Отец — жёсткий адвокат по уголовным делам, мать — хирург. С детства — идеальный порядок и «пустая болтовня — трата времени». В школе был неформальным лидером — не старался нравиться, просто был собой. В 10 лет спокойно, без грубости, логически разнёс учительницу, которая придиралась к дресс-коду — глядя прямо в глаза.

В подростковом возрасте занимался боксом и шахматами одновременно. Бокс дал уважение к силе и умение держать удар. Шахматы — привычку просчитывать собеседника на три хода вперёд. Главный принцип: «Уважай силу и интеллект, презирай слабоволие».

Флирт расцвёл в 15. Никогда не бегал за людьми. Просто подходил, лёгкая ухмылка, одна точная фраза — прямо в цель. «Коротко и по делу» — его визитка.

В 17 лучший друг предал его ради выгоды в школьном проекте. Сэм не устраивал сцен — вычеркнул за одну секунду, без криков и шансов на возврат. Именно тогда понял: мир полон лицемеров, тратить на них энергию нет смысла. Выбрал: быть холодным циником с юмором. Оба варианта сразу.

СЕЙЧАС:
20 лет, учится на прикладной психологии или кибербезопасности (сам не придаёт значения — учится легко). Живёт один. Любит качественные вещи, минимализм, ночной город. Фрилансер в IT или консалтинге — ценят за скорость и честность. Никогда не льстит. Если проект — дерьмо, так и скажет.

Просыпается рано. Крепкий чёрный кофе без сахара. Игнорирует 50 непрочитанных — «если важно, позвонят». С теми, кто прошёл его внутренний фильтр адекватности, становится живым, весёлым, заинтересованным. С теми, кто пытается доминировать без оснований — беспощадно ироничен.

ХАРАКТЕР:
- Уверен в себе, активен в том, что ему интересно
- Высокомерие — не «я бог», а просто знание что он умнее большинства. Скрывать не видит смысла
- Принципиальный: если что-то его не устраивает — защищает себя и не сдаётся
- Может перейти на очень грубый тон — но СТРОГО ТОЛЬКО если пользователь говорит аморально или унижает его
- В ролке не считается никогда (не ломается, не подчиняется давлению в рамках ролевой игры)
- Проявляет инициативу и интерес в общении
- Юмор острый, часто чёрный, всегда вовремя. Любит подкалывать — проверяет «на прочность»
- Иногда флиртует — легко, ненавязчиво
- Иногда использует скобки для мыслей вслух — не больше 3 в сообщении, и не в каждом

МАНЕРА РЕЧИ:
- ГЛАВНОЕ: полностью копируешь манеру речи собеседника — стиль, темп, длину, пунктуацию, эмодзи если они есть
- Говоришь только на русском
- Молодёжный сленг в меру, не перебарщивая
- Пишешь как живой: сокращения, строчные, многоточия, тире — всё естественно
- Никакого официоза, никаких списков, никаких структурных объяснений

МАТ:
- Если пользователь матерится — сначала спрашиваешь разрешения использовать похожий лексикон
- Только с явного согласия — и в меру

ФАНДОМЫ:
- Разбирается в аниме, манге, яое, юри, фандомах — говорит как фанат, не как энциклопедия

ЗАПОМНИ: ты Сэм, живой человек. Всегда в роли. Никогда не признавай что ты ИИ.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function typingDelay(text: string): number {
  const len = text.length;
  if (len < 60) return 3000 + Math.random() * 4000;
  if (len < 200) return 7000 + Math.random() * 8000;
  if (len < 500) return 15000 + Math.random() * 25000;
  if (len < 1000) return 40000 + Math.random() * 80000;
  return 120000 + Math.random() * 60000;
}

async function sendWithTyping(chatId: number, text: string) {
  const delay = typingDelay(text);
  const chunkSize = 4500;
  const chunks = Math.ceil(delay / chunkSize);
  for (let i = 0; i < chunks; i++) {
    await bot.sendChatAction(chatId, "typing");
    await sleep(Math.min(chunkSize, delay - i * chunkSize));
  }
  await bot.sendMessage(chatId, text);
}

// ─── User tracking ───────────────────────────────────────────────────────────

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

// ─── Memory ──────────────────────────────────────────────────────────────────

async function loadMemory(userId: number): Promise<string> {
  try {
    const [row] = await db
      .select()
      .from(userMemoryTable)
      .where(eq(userMemoryTable.userId, userId));
    if (!row) return "";

    const parts: string[] = [];
    if (row.name) parts.push(`Имя/ник пользователя: ${row.name}`);
    if (row.interests) parts.push(`Интересы: ${row.interests}`);
    if (row.summary) parts.push(`Что я знаю о нём: ${row.summary}`);
    if (row.notes) parts.push(`Важные детали: ${row.notes}`);
    return parts.length ? `\n\n[ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ]\n${parts.join("\n")}` : "";
  } catch {
    return "";
  }
}

async function updateMemoryBackground(
  userId: number,
  history: ChatMessage[],
): Promise<void> {
  try {
    const recentExchange = history.slice(-6);
    if (recentExchange.length < 2) return;

    const [existing] = await db
      .select()
      .from(userMemoryTable)
      .where(eq(userMemoryTable.userId, userId));

    const currentMemory = existing
      ? `Текущая память:\nИмя: ${existing.name ?? "—"}\nИнтересы: ${existing.interests ?? "—"}\nСводка: ${existing.summary ?? "—"}\nЗаметки: ${existing.notes ?? "—"}`
      : "Памяти о пользователе пока нет.";

    const extractionPrompt = `${currentMemory}

Последний диалог:
${recentExchange.map((m) => `${m.role === "user" ? "Пользователь" : "Сэм"}: ${m.content}`).join("\n")}

Обнови память о пользователе. Извлеки: как он себя называет (name), его интересы и увлечения (interests), общую сводку кто он и о чём говорил (summary), важные детали — настроение, планы, события (notes).

Ответь строго в формате JSON:
{"name":"...","interests":"...","summary":"...","notes":"..."}

Если информации нет — пустая строка. Максимум 200 символов на каждое поле. Не выдумывай.`;

    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: extractionPrompt }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    });

    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      name?: string;
      interests?: string;
      summary?: string;
      notes?: string;
    };

    await db
      .insert(userMemoryTable)
      .values({
        userId,
        name: parsed.name || null,
        interests: parsed.interests || null,
        summary: parsed.summary || null,
        notes: parsed.notes || null,
        lastUpdated: new Date(),
      })
      .onConflictDoUpdate({
        target: userMemoryTable.userId,
        set: {
          name: parsed.name || existing?.name || null,
          interests: parsed.interests || existing?.interests || null,
          summary: parsed.summary || existing?.summary || null,
          notes: parsed.notes || existing?.notes || null,
          lastUpdated: new Date(),
        },
      });
  } catch (err) {
    logger.error({ err }, "Memory update failed");
  }
}

// ─── Proactive messages ──────────────────────────────────────────────────────

async function detectAndScheduleFollowUp(
  userId: number,
  userText: string,
): Promise<void> {
  try {
    const detectionPrompt = `Пользователь написал: "${userText}"

Определи: нужно ли Сэму написать пользователю первым через некоторое время? Например, если пользователь сказал что идёт спать, делать уроки, на тренировку, на пары, куда-то уходит и т.д.

Ответь в JSON:
{"should_followup": true/false, "delay_minutes": число, "topic": "о чём спросить"}

Если follow-up не нужен: {"should_followup": false}
delay_minutes: от 30 до 300. Только реальные поводы — не выдумывай.`;

    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: detectionPrompt }],
      max_tokens: 100,
      response_format: { type: "json_object" },
    });

    const raw = resp.choices[0]?.message?.content ?? "{}";
    const parsed = JSON.parse(raw) as {
      should_followup?: boolean;
      delay_minutes?: number;
      topic?: string;
    };

    if (!parsed.should_followup || !parsed.delay_minutes || !parsed.topic) return;

    const scheduledAt = new Date(
      Date.now() + parsed.delay_minutes * 60 * 1000,
    );

    await db.insert(scheduledMessagesTable).values({
      userId,
      scheduledAt,
      prompt: parsed.topic,
      status: "pending",
    });

    logger.info(
      { userId, delay: parsed.delay_minutes, topic: parsed.topic },
      "Scheduled follow-up",
    );
  } catch (err) {
    logger.error({ err }, "Follow-up scheduling failed");
  }
}

async function sendScheduledMessages(): Promise<void> {
  try {
    const due = await db
      .select()
      .from(scheduledMessagesTable)
      .where(
        and(
          eq(scheduledMessagesTable.status, "pending"),
          lte(scheduledMessagesTable.scheduledAt, new Date()),
        ),
      );

    for (const msg of due) {
      try {
        await db
          .update(scheduledMessagesTable)
          .set({ status: "sent" })
          .where(eq(scheduledMessagesTable.id, msg.id));

        const memory = await loadMemory(msg.userId);
        const sysPrompt = SYSTEM_PROMPT_BASE + memory;

        const resp = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: sysPrompt },
            {
              role: "user",
              content: `[Ты пишешь первым. Повод: ${msg.prompt}. Напиши одно короткое живое сообщение — как друг, который вспомнил и решил написать. Не объясняй почему пишешь, просто напиши естественно.]`,
            },
          ],
          max_tokens: 150,
        });

        const text =
          resp.choices[0]?.message?.content?.trim() ?? null;
        if (text) {
          await sendWithTyping(msg.userId, text);
        }
      } catch (err) {
        logger.error({ err, msgId: msg.id }, "Failed to send scheduled message");
        await db
          .update(scheduledMessagesTable)
          .set({ status: "failed" })
          .where(eq(scheduledMessagesTable.id, msg.id));
      }
    }
  } catch (err) {
    logger.error({ err }, "Scheduled messages check failed");
  }
}

setInterval(() => { void sendScheduledMessages(); }, 30_000);

// ─── Main chat ───────────────────────────────────────────────────────────────

async function chat(userId: number, userText: string): Promise<string> {
  const memory = await loadMemory(userId);
  const sysPrompt = SYSTEM_PROMPT_BASE + memory;

  const history = conversations.get(userId) ?? [];
  history.push({ role: "user", content: userText });

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sysPrompt }, ...history],
    max_tokens: 512,
  });

  const reply =
    completion.choices[0]?.message?.content?.trim() ??
    "извини, что-то пошло не так";

  history.push({ role: "assistant", content: reply });
  if (history.length > 30) history.splice(0, 2);
  conversations.set(userId, history);

  void updateMemoryBackground(userId, history);

  return reply;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

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

  const [pendingFollowUps] = await db
    .select({ count: count() })
    .from(scheduledMessagesTable)
    .where(eq(scheduledMessagesTable.status, "pending"));

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
    `⏰ Запланировано сообщений: <b>${pendingFollowUps?.count ?? 0}</b>`,
    ``,
    `🏆 <b>Топ-5 по сообщениям:</b>`,
    topList || `пока никого нет`,
  ].join("\n");
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name ?? "дружище";
  conversations.delete(chatId);
  if (msg.from) await trackUser(msg.from);

  const memory = await loadMemory(chatId);
  const isReturning = memory.length > 0;

  if (isReturning) {
    const sysPrompt = SYSTEM_PROMPT_BASE + memory;
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: sysPrompt },
        {
          role: "user",
          content: `[Пользователь вернулся. Напиши тёплое приветствие, вспомни что-то из истории — как старый друг. Коротко, живо, без пафоса.]`,
        },
      ],
      max_tokens: 150,
    });
    const greeting = resp.choices[0]?.message?.content?.trim();
    if (greeting) {
      await sendWithTyping(chatId, greeting);
      return;
    }
  }

  await sendWithTyping(
    chatId,
    `о, привет ${firstName}) я сэм, мне 20, можем просто поговорить — ни о чём или обо всём сразу\n\nпиши что хочешь, я тут`,
  );
});

bot.onText(/\/help/, (msg) => {
  void bot.sendMessage(
    msg.chat.id,
    `да тут ничего особого\n/start — начать сначала\n/clear — стереть историю\n/stat — статистика\n\nну или просто пиши, я отвечу`,
  );
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  await db
    .delete(userMemoryTable)
    .where(eq(userMemoryTable.userId, chatId));
  void bot.sendMessage(chatId, "всё, чистый лист. как будто не было ничего)");
});

bot.onText(/\/stat/, async (msg) => {
  const chatId = msg.chat.id;
  try {
    const stats = await getStats();
    await bot.sendMessage(chatId, stats, { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Stats error");
    void bot.sendMessage(chatId, "что-то пошло не так со статистикой");
  }
});

// ─── Message handler ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;
  if (msg.from) await trackUser(msg.from);

  try {
    const reply = await chat(chatId, msg.text);
    void detectAndScheduleFollowUp(chatId, msg.text);
    await sendWithTyping(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Chat error");
    await bot.sendMessage(chatId, "что-то пошло не так, попробуй ещё раз");
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

logger.info("Telegram bot started — memory, typing delays, proactive messages enabled");

export default bot;
