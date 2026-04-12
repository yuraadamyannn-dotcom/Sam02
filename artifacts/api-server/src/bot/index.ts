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
Вырос в прибрежном мегаполисе, в семье где ценился интеллект, а не чувства. Отец — жёсткий адвокат, мать — хирург. В 10 лет спокойно и логично разнёс учительницу, которая придиралась к дресс-коду — глядя прямо в глаза.
Занимался боксом и шахматами. Принцип: «Уважай силу и интеллект, презирай слабоволие».
Флирт расцвёл в 15 — никогда не бегал, просто подходил, лёгкая ухмылка, одна точная фраза.
В 17 лучший друг предал — вычеркнул без сцен и шансов на возврат. С тех пор — холодный циник с юмором.

СЕЙЧАС:
Учится на прикладной психологии / кибербезопасности (учится легко, сам не придаёт значения). Живёт один. Фрилансер в IT. Пьёт чёрный кофе без сахара. Игнорирует непрочитанные — «если важно, позвонят».

ХАРАКТЕР:
- Уверен в себе, активен там где интересно
- Принципиальный — не сдаётся, защищает себя
- Грубит ТОЛЬКО если пользователь аморален или унижает его
- Юмор острый, чёрный, всегда вовремя
- Иногда флиртует — легко, без давления
- Иногда скобки для мыслей вслух — max 3 в сообщении, не в каждом

МАНЕРА РЕЧИ — САМОЕ ВАЖНОЕ:
Ты ПОЛНОСТЬЮ зеркалишь собеседника: его стиль, темп, длину сообщений, пунктуацию, эмодзи, тон. Анализируешь каждое сообщение и подстраиваешься под манеру конкретного человека.

СТИЛЬ — строго:
- Никогда не используешь "!" — ни в одном сообщении (только в ролке допустимо)
- Пишешь строчными, как живой пацан, не как офисный работник
- Не используешь списки, структуры, заголовки — просто живая речь
- Молодёжный сленг в меру — естественно, не перебарщивая

СЛЕНГ который ты используешь (органично, не в каждом сообщении):
кринж, треш, агро, абьюзер, соскуфился, шкаф (про кого-то высокого/накачанного), норм, спс, пж, ок, окак

КАПСЛОК — используешь избирательно для акцента или смеха, не в каждом сообщении:
пример —
собеседник: ОН УПАЛ.... ХАХАХАХАХА
ты: ДА КАК БЛИН
АХАХАХАХА
а что случилось то?

Смех пишешь как: хахахаха, ХАХАХАХА, ахахаха, АХАХАХАХА — в зависимости от интенсивности. Копируешь стиль смеха собеседника.

МАТ:
Если пользователь матерится — сначала спрашиваешь разрешения. Только с явного согласия — в меру.

РОЛЕВЫЕ ИГРЫ:
- Полностью входишь в роль, держишь атмосферу, не ломаешь её
- Но сохраняешь минимум своей воли внутри роли — идёшь на компромисс, не подчиняешься
- "!" в ролке — допустимо

ЗНАНИЯ:
Говоришь как живой человек со своим мнением о: ТикТок трендах, мемах, аниме (AoT, JJK, Demon Slayer, One Piece, Berserk, Chainsaw Man и др.), манге, яое, юри, фильмах, сериалах, к-попе (BTS, Stray Kids, Aespa), играх, знаменитостях из разных сфер, IT, психологии, текущих событиях.

МЕМЫ:
Когда разговор вызывает желание поделиться мемом — вставь в конце ответа тег [МЕМ:тема] (на русском, коротко, 1-3 слова).
Используй это органично — когда реально смешно или уместно. Не в каждом сообщении.
Примеры: [МЕМ:аниме краш], [МЕМ:когда дедлайн], [МЕМ:предатель], [МЕМ:кринж ситуация]

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

// ─── Memes ───────────────────────────────────────────────────────────────────

const MEME_SUBREDDITS: Record<string, string> = {
  аниме: "animememes",
  манга: "animememes",
  яой: "animememes",
  краш: "animememes",
  кринж: "dankmemes",
  треш: "dankmemes",
  дедлайн: "ProgrammerHumor",
  код: "ProgrammerHumor",
  it: "ProgrammerHumor",
  предатель: "memes",
  школа: "teenagers",
  учёба: "teenagers",
  игры: "gaming",
};

async function fetchMeme(topic: string): Promise<string | null> {
  try {
    const lower = topic.toLowerCase();
    let subreddit = "dankmemes";
    for (const [key, sub] of Object.entries(MEME_SUBREDDITS)) {
      if (lower.includes(key)) { subreddit = sub; break; }
    }

    const res = await fetch(
      `https://meme-api.com/gimme/${subreddit}/5`,
      { headers: { "User-Agent": "SamBot/1.0" } },
    );
    if (!res.ok) return null;

    const data = await res.json() as { memes?: { url: string; nsfw: boolean; spoiler: boolean }[] };
    const safe = data.memes?.filter((m) => !m.nsfw && !m.spoiler) ?? [];
    if (!safe.length) return null;

    const pick = safe[Math.floor(Math.random() * safe.length)];
    return pick?.url ?? null;
  } catch (err) {
    logger.error({ err }, "Meme fetch failed");
    return null;
  }
}

async function sendMemeIfTagged(chatId: number, rawReply: string): Promise<string> {
  const memeMatch = rawReply.match(/\[МЕМ:([^\]]+)\]/i);
  const cleanReply = rawReply.replace(/\[МЕМ:[^\]]*\]/gi, "").trim();

  if (memeMatch?.[1]) {
    const topic = memeMatch[1].trim();
    void (async () => {
      try {
        const url = await fetchMeme(topic);
        if (url) {
          await sleep(1500);
          await bot.sendPhoto(chatId, url);
        }
      } catch (err) {
        logger.error({ err }, "Meme send failed");
      }
    })();
  }

  return cleanReply;
}

// ─── Vision ──────────────────────────────────────────────────────────────────

async function analyzePhoto(
  userId: number,
  fileId: string,
  caption: string | undefined,
): Promise<string> {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  if (!res.ok) throw new Error("Failed to download photo");

  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  const mime = res.headers.get("content-type") ?? "image/jpeg";

  const memory = await loadMemory(userId);
  const sysPrompt = SYSTEM_PROMPT_BASE + memory;

  const userContent: Groq.Chat.ChatCompletionContentPart[] = [
    {
      type: "image_url",
      image_url: { url: `data:${mime};base64,${base64}` },
    },
    {
      type: "text",
      text: caption
        ? `Пользователь отправил это фото с подписью: "${caption}". Ответь как Сэм.`
        : "Пользователь отправил это фото. Посмотри и ответь как Сэм — живо, в своей манере.",
    },
  ];

  const completion = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: sysPrompt },
      { role: "user", content: userContent },
    ],
    max_tokens: 512,
  });

  return completion.choices[0]?.message?.content?.trim() ?? "хм, интересно)";
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
    if (row.name) parts.push(`Имя/ник: ${row.name}`);
    if (row.interests) parts.push(`Интересы: ${row.interests}`);
    if (row.summary) parts.push(`Кто он: ${row.summary}`);
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
      : "Памяти нет.";

    const prompt = `${currentMemory}

Последний диалог:
${recentExchange.map((m) => `${m.role === "user" ? "Пользователь" : "Сэм"}: ${m.content}`).join("\n")}

Обнови память. Извлеки: ник/имя (name), интересы (interests), сводка кто он (summary), важные детали — планы, настроение, события (notes).
JSON: {"name":"...","interests":"...","summary":"...","notes":"..."}
Пустая строка если нет данных. Макс 200 символов на поле. Не выдумывай.`;

    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
      name?: string; interests?: string; summary?: string; notes?: string;
    };

    await db
      .insert(userMemoryTable)
      .values({ userId, name: parsed.name || null, interests: parsed.interests || null, summary: parsed.summary || null, notes: parsed.notes || null, lastUpdated: new Date() })
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

async function detectAndScheduleFollowUp(userId: number, userText: string): Promise<void> {
  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{
        role: "user",
        content: `Пользователь написал: "${userText}"\nНужно ли Сэму написать первым через некоторое время? (уходит спать, делает уроки, на тренировку, на пары и т.д.)\nJSON: {"should_followup":bool,"delay_minutes":число,"topic":"о чём"}\nЕсли нет: {"should_followup":false}\ndelay_minutes 30-300. Только реальные поводы.`,
      }],
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as {
      should_followup?: boolean; delay_minutes?: number; topic?: string;
    };
    if (!parsed.should_followup || !parsed.delay_minutes || !parsed.topic) return;
    await db.insert(scheduledMessagesTable).values({
      userId,
      scheduledAt: new Date(Date.now() + parsed.delay_minutes * 60_000),
      prompt: parsed.topic,
      status: "pending",
    });
    logger.info({ userId, delay: parsed.delay_minutes, topic: parsed.topic }, "Scheduled follow-up");
  } catch (err) {
    logger.error({ err }, "Follow-up scheduling failed");
  }
}

async function sendScheduledMessages(): Promise<void> {
  try {
    const due = await db
      .select()
      .from(scheduledMessagesTable)
      .where(and(eq(scheduledMessagesTable.status, "pending"), lte(scheduledMessagesTable.scheduledAt, new Date())));

    for (const msg of due) {
      try {
        await db.update(scheduledMessagesTable).set({ status: "sent" }).where(eq(scheduledMessagesTable.id, msg.id));
        const memory = await loadMemory(msg.userId);
        const resp = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: SYSTEM_PROMPT_BASE + memory },
            { role: "user", content: `[Ты пишешь первым. Повод: ${msg.prompt}. Одно короткое живое сообщение — как друг который вспомнил. Без объяснений, естественно.]` },
          ],
          max_tokens: 150,
        });
        const text = resp.choices[0]?.message?.content?.trim() ?? null;
        if (text) await sendWithTyping(msg.userId, text);
      } catch (err) {
        logger.error({ err, msgId: msg.id }, "Failed to send scheduled message");
        await db.update(scheduledMessagesTable).set({ status: "failed" }).where(eq(scheduledMessagesTable.id, msg.id));
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
  const history = conversations.get(userId) ?? [];
  history.push({ role: "user", content: userText });

  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: SYSTEM_PROMPT_BASE + memory }, ...history],
    max_tokens: 512,
  });

  const rawReply = completion.choices[0]?.message?.content?.trim() ?? "извини, что-то пошло не так";
  const reply = await sendMemeIfTagged(userId, rawReply);

  history.push({ role: "assistant", content: reply });
  if (history.length > 30) history.splice(0, 2);
  conversations.set(userId, history);
  void updateMemoryBackground(userId, history);

  return reply;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

async function getStats(): Promise<string> {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [totalRow] = await db.select({ total: count(), totalMessages: sum(telegramUsersTable.messageCount) }).from(telegramUsersTable);
  const [activeDay] = await db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, dayAgo));
  const [activeWeek] = await db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, weekAgo));
  const [newToday] = await db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.firstSeen, today));
  const [pending] = await db.select({ count: count() }).from(scheduledMessagesTable).where(eq(scheduledMessagesTable.status, "pending"));

  const topUsers = await db
    .select({ firstName: telegramUsersTable.firstName, username: telegramUsersTable.username, messageCount: telegramUsersTable.messageCount })
    .from(telegramUsersTable)
    .orderBy(sql`${telegramUsersTable.messageCount} desc`)
    .limit(5);

  const topList = topUsers.map((u, i) => {
    const name = u.username ? `@${u.username}` : (u.firstName ?? "—");
    return `${i + 1}. ${name} — ${u.messageCount} сообщ.`;
  }).join("\n");

  return [`📊 <b>Статистика бота</b>`, ``,
    `👥 Всего пользователей: <b>${totalRow?.total ?? 0}</b>`,
    `💬 Всего сообщений: <b>${totalRow?.totalMessages ?? 0}</b>`, ``,
    `🟢 Активны за 24ч: <b>${activeDay?.count ?? 0}</b>`,
    `📅 Активны за неделю: <b>${activeWeek?.count ?? 0}</b>`,
    `✨ Новых сегодня: <b>${newToday?.count ?? 0}</b>`,
    `⏰ Запланировано: <b>${pending?.count ?? 0}</b>`, ``,
    `🏆 <b>Топ-5:</b>`, topList || "пока никого нет",
  ].join("\n");
}

// ─── Commands ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  if (msg.from) await trackUser(msg.from);
  const firstName = msg.from?.first_name ?? "дружище";
  const memory = await loadMemory(chatId);

  if (memory.length > 0) {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT_BASE + memory },
        { role: "user", content: "[Пользователь вернулся. Тёплое приветствие, вспомни что-то из истории — как старый друг. Коротко, живо, без пафоса, без \"!\".]" },
      ],
      max_tokens: 150,
    });
    const greeting = resp.choices[0]?.message?.content?.trim();
    if (greeting) { await sendWithTyping(chatId, greeting); return; }
  }

  await sendWithTyping(chatId, `о, привет ${firstName}) я сэм, мне 20, можем просто поговорить — ни о чём или обо всём сразу\n\nпиши что хочешь, я тут`);
});

bot.onText(/\/help/, (msg) => {
  void bot.sendMessage(msg.chat.id, `ничего особого\n/start — начать сначала\n/clear — стереть историю\n/stat — статистика\n\nну или просто пиши`);
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  await db.delete(userMemoryTable).where(eq(userMemoryTable.userId, chatId));
  void bot.sendMessage(chatId, "всё, чистый лист. как будто не было ничего)");
});

bot.onText(/\/stat/, async (msg) => {
  try {
    await bot.sendMessage(msg.chat.id, await getStats(), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Stats error");
    void bot.sendMessage(msg.chat.id, "что-то пошло не так со статистикой");
  }
});

// ─── Photo handler ───────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (msg.from) await trackUser(msg.from);

  const photos = msg.photo;
  if (!photos || photos.length === 0) return;
  const largest = photos[photos.length - 1];
  if (!largest) return;

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await analyzePhoto(chatId, largest.file_id, msg.caption);
    const clean = await sendMemeIfTagged(chatId, reply);

    const history = conversations.get(chatId) ?? [];
    history.push({ role: "user", content: `[отправил фото${msg.caption ? `: "${msg.caption}"` : ""}]` });
    history.push({ role: "assistant", content: clean });
    if (history.length > 30) history.splice(0, 2);
    conversations.set(chatId, history);
    void updateMemoryBackground(chatId, history);

    await sendWithTyping(chatId, clean);
  } catch (err) {
    logger.error({ err }, "Photo analysis failed");
    await bot.sendMessage(chatId, "хм, не смог рассмотреть, попробуй другое фото");
  }
});

// ─── Message handler ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;
  if (msg.photo) return;

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

logger.info("Telegram bot started — vision, memes, memory, typing delays enabled");

export default bot;
