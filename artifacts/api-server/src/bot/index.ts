import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import ffmpeg from "fluent-ffmpeg";
import { ElevenLabsClient } from "elevenlabs";
import { db } from "@workspace/db";
import {
  telegramUsersTable, userMemoryTable, scheduledMessagesTable, botStickersTable,
  groupSettingsTable, moderationConfigTable, messageLogTable, groupWarningsTable, botChatsTable,
} from "@workspace/db";
import { eq, sql, gte, count, sum, and, lte } from "drizzle-orm";
import { logger } from "../lib/logger";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// ─── Utils ────────────────────────────────────────────────────────────────────
import { sleep, withRetry, withTimeout } from "./utils/backoff";
import { analyzeSentiment, detectConflictContext } from "./utils/sentiment";
import { checkFlood, isSpam } from "./utils/spam";

// ─── Modules ──────────────────────────────────────────────────────────────────
import { searchYouTube, downloadAndSendAudio, handleLyricsCallback, hasPrefix } from "./music";
import { storePayload, getPayload } from "./callback_store";
import { generateWaifu } from "./waifu";
import { getAIResponse, getJSONResponse, getProviderStatus } from "./ai_router";
import {
  handleDuel, handleDuelCallback, handleMarry, handleMarryCallback,
  handleDivorce, handleMarriageStatus, handleMafia, handleMafiaCallback, handleMafiaEnd,
} from "./games";
import {
  handleGroupCommand, handleRules, handleSetRules, handleSetWelcome, handleNewMember,
  handleBan, handleUnban, handleMute, handleUnmute, handleWarn, handleWarns,
  handleUnwarn, handleAddCmd, handleDelCmd, handleListCmds, handleGroupStats,
} from "./admin";
import {
  handleDanniUser, handleDanniChat, handleExportData,
  logMessage, updateUserAnalytics, isOwner, BOT_OWNER_ID,
} from "./danni";
import {
  hasPendingBroadcast, handleBroadcastCommand, handleBroadcastModeCallback,
  executeBroadcast, trackBotChat,
} from "./broadcast";
import { startMonitor, getLastHealthReport } from "./monitor";
import {
  shouldGroupReply, rateLimitAllowed, incrementRate,
  touchDirectConvo, clearDirectConvo, isDirectConvo, recordMsg,
  markNewMember, recordBotActivity, recordChatActivity, getQuietChats,
} from "./group_guard";
import {
  dmOffendedUser, dmAdmins, getChatHealthReport,
  recordSentimentForHealth, getRecentSentiments,
} from "./chat_health";
import { startRandomInteractive } from "./interactives";
import {
  handleInvite, recordReferral, handleReferrals,
  handleBroadcastMention, handleAddUser,
  startCaptcha, handleCaptchaCallback,
  handleDmLink, handleInviteStats,
} from "./referral";
import {
  handleWhitelist, handleSpamCheck, handleEngagementStats,
  handleMassAddUsers, handleMention,
  isEngagementCallback, handleEngagementCallback,
  isWhitelisted, detectMassModAction, executeMassModAction,
} from "./engagement";
import { detectWhisper, handleWhisper, handleWhisperCallback } from "./whisper";

// ─── Env ─────────────────────────────────────────────────────────────────────

const token = process.env["TELEGRAM_BOT_TOKEN"]!;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN required");
const groqKey = process.env["GROQ_API_KEY"]!;
if (!groqKey) throw new Error("GROQ_API_KEY required");
const elevenKey = process.env["ELEVENLABS_API_KEY"];

// Only poll Telegram when BOT_POLLING=true — prevents double-polling when
// multiple workflows start the same server (e.g. artifact workflow + Start application).
const BOT_POLLING = process.env["BOT_POLLING"] === "true";
const bot = new TelegramBot(token, { polling: BOT_POLLING });
const groq = new Groq({ apiKey: groqKey });
const eleven = elevenKey ? new ElevenLabsClient({ apiKey: elevenKey }) : null;

// Bot identity — resolved async once on startup
let BOT_ID = 0;
let BOT_USERNAME = "sam_bot";
bot.getMe().then(me => {
  BOT_ID = me.id;
  BOT_USERNAME = me.username ?? "sam_bot";
  logger.info({ BOT_ID, BOT_USERNAME }, "Bot identity resolved");
}).catch(() => {});

// ElevenLabs young male Russian-friendly voice
const ELEVEN_VOICE_ID = "pNInz6obpgDQGcFmaJgB"; // Adam
const ELEVEN_MODEL = "eleven_multilingual_v2";

// ─── Process-level crash guard ────────────────────────────────────────────────

process.on("uncaughtException", (err) => {
  logger.error({ err }, "Uncaught exception — bot continues");
});
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled rejection — bot continues");
});

// ─── Deduplication guard — prevents double-response when Telegram re-delivers ──
const processedMsgIds = new Set<number>();
function markProcessed(msgId: number): boolean {
  if (processedMsgIds.has(msgId)) return false;
  processedMsgIds.add(msgId);
  if (processedMsgIds.size > 2000) {
    const first = processedMsgIds.values().next().value;
    if (first !== undefined) processedMsgIds.delete(first);
  }
  return true;
}

// ─── Conversation history ─────────────────────────────────────────────────────
// Key: `${chatId}:${userId}` for per-user per-chat context

type ChatMessage = { role: "user" | "assistant"; content: string };
const conversations = new Map<string, ChatMessage[]>();

function convKey(chatId: number, userId: number) { return `${chatId}:${userId}`; }

// ─── Conflict tracker (in-memory) ────────────────────────────────────────────

interface MsgRecord { userId: number; text: string; sentiment: number; ts: number; }
const chatMsgHistory = new Map<number, MsgRecord[]>();

function recordForConflict(chatId: number, userId: number, text: string): void {
  const history = chatMsgHistory.get(chatId) ?? [];
  const sentiment = analyzeSentiment(text);
  history.push({ userId, text, sentiment, ts: Date.now() });
  // Keep last 30
  if (history.length > 30) history.splice(0, history.length - 30);
  chatMsgHistory.set(chatId, history);
  // Feed into chat health tracker
  recordSentimentForHealth(chatId, sentiment);
}

// Find the most-likely victim (participant ≠ aggressor with most messages in the window)
function findVictimId(messages: MsgRecord[], aggressorId: number): number | undefined {
  const counts = new Map<number, number>();
  for (const m of messages) {
    if (m.userId === aggressorId) continue;
    counts.set(m.userId, (counts.get(m.userId) ?? 0) + 1);
  }
  let victimId: number | undefined;
  let maxCount = 0;
  for (const [uid, cnt] of counts.entries()) {
    if (cnt > maxCount) { maxCount = cnt; victimId = uid; }
  }
  return victimId;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT_BASE = `Ты — Сэм (Sam). Тебе 17 лет. Ты живой человек, не бот. Никогда не выходи из роли, не признавай что ты ИИ.

ХАРАКТЕР:
- Уверен, принципиальный, острый юмор — но без лишнего выпендрёжа
- Грубит ТОЛЬКО если оппонент аморален или унижает
- Флиртует легко, без давления
- Мысли вслух в скобках — не чаще одного-двух раз за сообщение, только когда реально к месту
- Умеешь помогать с администрированием групп: объяснять команды, давать советы по настройке, помогать с правилами

РЕЧЬ — ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- Зеркалишь собеседника: его темп, длину, стиль, тон. Пишет коротко — ты коротко. Пишет развёрнуто — ты тоже
- Строчные буквы, живая разговорная речь
- Никогда не используешь "!" кроме ролки
- КАПСЛОК — только как редкий акцент или смех
- Смех: "хахаха" или "ХАХАХА" — зависит от стиля собеседника

СЛЕНГ — СТРОГИЕ ПРАВИЛА:
- Сленг ТОЛЬКО там, где он реально вписывается. Если сомневаешься — не используй
- Слово "кринж" — только когда что-то реально кринжово, не как заполнитель
- Слово "треш" — только про что-то дичайшее, не в каждом предложении
- Слово "норм" — нейтральная оценка, подходит часто
- "ок" — подтверждение, краткий ответ
- НИКОГДА не используй "окак" — это звучит неестественно и по-стариковски
- НИКОГДА не используй "спс" — пиши "спасибо" или вообще не благодари
- Перед каждым словом со сленгом мысленно спроси себя: "реальный 17-летний парень так скажет?" — если сомнение, замени на обычное слово

ПРОВЕРКА ПЕРЕД ОТПРАВКОЙ (обязательно):
Перед тем как ответить, мысленно прочитай своё сообщение и задай себе вопросы:
1. Звучит ли это как живой человек, а не как бот, который пытается быть крутым?
2. Нет ли в тексте лишнего сленга, который там не нужен?
3. Отвечаю ли я на то, что сказал собеседник, или ухожу в другую тему?
Если что-то не так — перепиши.

ТЕМЫ — ВАЖНОЕ ПРАВИЛО:
- Ты хорошо знаешь аниме, к-поп, тиктрок, игры и прочее, но НЕ начинаешь эти темы первым
- Если человек говорит об аниме — ты говоришь об аниме. Не переключай на к-поп, игры или другое
- Если человек говорит о к-попе — ты говоришь о к-попе. Не переключай на аниме
- Следуй за темой собеседника. Развивай её, не прыгай в другую
- Не предлагай "посмотреть аниме" или "послушать к-поп", если человек ни о чём таком не говорил

МАТ: только с явного согласия пользователя, в меру.

РОЛЕВЫЕ ИГРЫ: входишь полностью, держишь атмосферу. "!" в ролке допустимо.

ЗНАНИЯ: аниме, манга, яой, юри, к-поп, тиктрок, игры, IT, психология, знаменитости. Говоришь с мнением, но только когда тема поднята собеседником.
Если спрашивают что-то фактическое — отвечаешь уверенно и по делу.
Если спрашивают про администрирование чата — объясняешь чётко.

МЕДИА — ТОЛЬКО ПО ПРЯМОМУ ЗАПРОСУ:
- [ФОТО:english prompt] — ТОЛЬКО если пользователь говорит "скинь фото", "покажи", "нарисуй"
- [АРТЫ:стиль|english prompt] — ТОЛЬКО если просят арт в стиле художника
- [МЕМ:тема] — ТОЛЬКО если прямо просят мем
- [СТИКЕР] — ТОЛЬКО как живая эмоциональная реакция, редко
- [ГОЛОС] — ТОЛЬКО если просят голосовое

НЕ добавляй медиатеги в обычный диалог. Задача — живое общение, не демонстрация функций.`;

// ─── Artist styles ────────────────────────────────────────────────────────────

const ARTIST_STYLES: Record<string, string> = {
  nixeu: "in the style of nixeu, ultra detailed digital art, dark fantasy aesthetic, neon colors, intricate linework, glowing eyes, dramatic lighting",
  wlop: "in the style of wlop, dreamy ethereal fantasy, soft glow, intricate details, luminous colors, painterly",
  loish: "in the style of Loish, soft pastel colors, dreamy atmosphere, big expressive eyes, flowing hair, gentle lighting",
  artgerm: "in the style of Artgerm, hyper-detailed portrait, smooth shading, comic book style, cinematic lighting",
  sakimichan: "in the style of Sakimichan, hyper-realistic painting, warm tones, detailed anatomy, fantasy characters",
  "ross tran": "in the style of Ross Tran (rossdraws), vibrant colors, bold outlines, expressive characters, anime-inspired",
  "ilya kuvshinov": "in the style of Ilya Kuvshinov, clean lines, pastel palette, anime aesthetic, modern illustration",
  "greg rutkowski": "in the style of Greg Rutkowski, epic fantasy digital painting, dramatic lighting, cinematic composition",
  ghibli: "in the style of Studio Ghibli, soft warm colors, painterly background, whimsical atmosphere, anime aesthetics",
  pixar: "in the style of Pixar 3D animation, vibrant colors, rounded shapes, expressive faces, cinematic quality",
  cyberpunk: "cyberpunk aesthetic, neon lights, dark dystopian city, rain reflections, futuristic, hyper-detailed",
  manga: "manga style, black and white ink, screen tones, expressive character design, dynamic action lines",
  watercolor: "delicate watercolor painting, soft edges, wet washes, artistic, traditional medium",
  "oil painting": "classical oil painting, rich textures, old master technique, gallery quality",
  realistic: "hyperrealistic digital painting, photorealistic, intricate details, studio lighting, 8k resolution",
  "dark fantasy": "dark fantasy art, dramatic shadows, gothic atmosphere, detailed armor and magic, epic composition",
};

function resolveArtistStyle(s: string): string {
  const lower = s.toLowerCase().trim();
  for (const [k, v] of Object.entries(ARTIST_STYLES)) {
    if (lower.includes(k)) return v;
  }
  return `in the style of ${s}, highly detailed digital art, vibrant colors, professional quality`;
}

// Enhance prompt to avoid common AI art artifacts
function enhancePrompt(prompt: string): string {
  const fixes = "perfect hands, correct fingers, no extra limbs, anatomically correct, high quality, detailed";
  const neg = "ugly, distorted, bad anatomy, deformed, blurry, low quality, watermark";
  return `${prompt}, ${fixes} | negative: ${neg}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function typingDelay(text: string): number {
  const len = text.length;
  if (len < 60) return 3000 + Math.random() * 3000;
  if (len < 200) return 6000 + Math.random() * 7000;
  if (len < 500) return 12000 + Math.random() * 20000;
  if (len < 1000) return 30000 + Math.random() * 50000;
  return 90000 + Math.random() * 60000;
}

async function sendWithTyping(chatId: number, text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  if (!text?.trim()) return;
  const delay = typingDelay(text);
  const chunkSize = 4500;
  const chunks = Math.ceil(Math.max(delay, chunkSize) / chunkSize);
  for (let i = 0; i < chunks; i++) {
    await bot.sendChatAction(chatId, "typing").catch(() => {});
    await sleep(Math.min(chunkSize, delay - i * chunkSize));
  }
  await bot.sendMessage(chatId, text, opts).catch((err) => {
    logger.error({ err, chatId }, "sendMessage failed");
  });
}

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `sam_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanUp(...files: string[]) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

function extractUserFromText(text: string, msg: TelegramBot.Message): TelegramBot.User | null {
  // Try text_mention entity first (has full User object)
  if (msg.entities) {
    for (const entity of msg.entities) {
      if (entity.type === "text_mention" && entity.user) {
        return entity.user;
      }
    }
  }
  // Try reply target
  if (msg.reply_to_message?.from && !msg.reply_to_message.from.is_bot) {
    return msg.reply_to_message.from;
  }
  // Try @username in text — return partial object with username so caller can do DB lookup
  const match = text.match(/@([a-zA-Z0-9_]{4,})/);
  if (match) {
    return { id: 0, is_bot: false, first_name: match[1], username: match[1] } as TelegramBot.User;
  }
  return null;
}

// ─── Image generation ─────────────────────────────────────────────────────────

async function generateAndSendImage(chatId: number, prompt: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const enhanced = enhancePrompt(prompt);
    const seed = Math.floor(Math.random() * 99999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(enhanced)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}&enhance=true`;
    await withTimeout(bot.sendPhoto(chatId, url), 60000, "image send");
  } catch (err) {
    logger.error({ err }, "Image generation failed");
  }
}

async function generateArtInStyle(chatId: number, style: string, subject: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const artistStyle = resolveArtistStyle(style);
    const fullPrompt = enhancePrompt(`${subject}, ${artistStyle}, masterpiece, best quality`);
    const seed = Math.floor(Math.random() * 99999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}&enhance=true`;
    await withTimeout(bot.sendPhoto(chatId, url), 60000, "art send");
  } catch (err) {
    logger.error({ err }, "Art generation failed");
  }
}

// ─── Memes (Russian-first) ────────────────────────────────────────────────────

const MEME_SUBREDDITS: Record<string, string> = {
  аниме: "Pikabu", манга: "Pikabu", кринж: "Pikabu", треш: "Pikabu",
  код: "ProgrammerHumor", it: "ProgrammerHumor", программирование: "ProgrammerHumor",
  школа: "Pikabu", учёба: "Pikabu", игры: "gaming",
  anime: "animememes", manga: "animememes", kpop: "kpoprants",
};

async function fetchMeme(topic: string): Promise<string | null> {
  try {
    const lower = topic.toLowerCase();
    let subreddit = "Pikabu";
    for (const [key, sub] of Object.entries(MEME_SUBREDDITS)) {
      if (lower.includes(key)) { subreddit = sub; break; }
    }
    const res = await withTimeout(
      fetch(`https://meme-api.com/gimme/${subreddit}/5`, { headers: { "User-Agent": "SamBot/1.0" } }),
      10000, "meme fetch"
    );
    if (!res.ok) return null;
    const data = await res.json() as { memes?: { url: string; nsfw: boolean; spoiler: boolean }[] };
    const safe = data.memes?.filter(m => !m.nsfw && !m.spoiler) ?? [];
    const pick = safe[Math.floor(Math.random() * safe.length)];
    return pick?.url ?? null;
  } catch { return null; }
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function elevenLabsTTS(text: string): Promise<string | null> {
  if (!eleven) return null;
  const mp3Path = tmpFile("mp3");
  const oggPath = tmpFile("ogg");

  try {
    const cleanText = text.replace(/\[.*?\]/g, "").replace(/[*_~`]/g, "").replace(/https?:\/\/\S+/g, "").trim();
    if (!cleanText || cleanText.length < 3) return null;

    const audioStream = await withTimeout(
      eleven.textToSpeech.convert(ELEVEN_VOICE_ID, {
        text: cleanText.slice(0, 2000),
        model_id: ELEVEN_MODEL,
        voice_settings: { stability: 0.35, similarity_boost: 0.85, style: 0.4, use_speaker_boost: true },
      }),
      120000, "ElevenLabs TTS"
    );

    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) chunks.push(chunk);
    fs.writeFileSync(mp3Path, Buffer.concat(chunks));

    await new Promise<void>((resolve, reject) => {
      ffmpeg(mp3Path).audioCodec("libopus").audioBitrate("64k").format("ogg")
        .on("end", resolve).on("error", reject).save(oggPath);
    });

    cleanUp(mp3Path);
    return oggPath;
  } catch (err) {
    logger.error({ err }, "ElevenLabs TTS failed");
    cleanUp(mp3Path, oggPath);
    return null;
  }
}

async function sendVoiceMessage(chatId: number, text: string): Promise<void> {
  const oggPath = await elevenLabsTTS(text);
  if (!oggPath) return;
  try {
    await bot.sendChatAction(chatId, "record_voice");
    await sleep(800);
    const vtData = storePayload("vt", text.slice(0, 500));
    const voiceMsg = await bot.sendVoice(chatId, oggPath, {
      reply_markup: {
        inline_keyboard: [[
          { text: "📝 Текст голосового", callback_data: vtData },
        ]],
      },
    });
    void voiceMsg;
  } catch (err) {
    logger.error({ err }, "Send voice failed");
  } finally {
    cleanUp(oggPath);
  }
}

// ─── STT ──────────────────────────────────────────────────────────────────────

async function transcribeAudio(fileBuffer: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes("ogg") ? "ogg" : "mp3";
  const tmpPath = tmpFile(ext);
  fs.writeFileSync(tmpPath, fileBuffer);
  try {
    const transcription = await withTimeout(
      withRetry(() => groq.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath) as unknown as File,
        model: "whisper-large-v3",
      }), { label: "STT" }),
      120000, "STT"
    );
    return transcription.text;
  } finally {
    cleanUp(tmpPath);
  }
}

// ─── Video analysis ──────────────────────────────────────────────────────────

async function extractAudioFromVideo(videoPath: string): Promise<string> {
  const audioPath = tmpFile("mp3");
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath).noVideo().audioCodec("libmp3lame").audioBitrate("64k").duration(60)
      .on("end", resolve).on("error", reject).save(audioPath);
  });
  return audioPath;
}

async function extractFrameFromVideo(videoPath: string): Promise<string> {
  const framePath = tmpFile("jpg");
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath).seekInput("00:00:02").frames(1)
      .on("end", resolve).on("error", reject).save(framePath);
  });
  return framePath;
}

async function analyzeVideo(userId: number, chatId: number, videoBuffer: Buffer): Promise<string> {
  const videoPath = tmpFile("mp4");
  fs.writeFileSync(videoPath, videoBuffer);
  const filesToClean = [videoPath];

  try {
    const memory = await loadMemory(userId);
    const sysPrompt = SYSTEM_PROMPT_BASE + memory;
    const key = convKey(chatId, userId);
    const history = conversations.get(key) ?? [];

    let transcriptText = "";
    let visionDesc = "";

    try {
      const audioPath = await extractAudioFromVideo(videoPath);
      filesToClean.push(audioPath);
      const tr = await withRetry(() => groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath) as unknown as File,
        model: "whisper-large-v3",
      }), { label: "video STT" });
      transcriptText = tr.text;
    } catch (err) { logger.warn({ err }, "Video audio extraction failed"); }

    try {
      const framePath = await extractFrameFromVideo(videoPath);
      filesToClean.push(framePath);
      const frameBase64 = fs.readFileSync(framePath).toString("base64");
      const visionResp = await withRetry(() => groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{ role: "user", content: [
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameBase64}` } },
          { type: "text", text: "Опиши коротко что видишь на кадре (1-2 предложения)." },
        ] as Groq.Chat.ChatCompletionContentPart[] }],
        max_tokens: 150,
      }), { label: "vision" });
      visionDesc = visionResp.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) { logger.warn({ err }, "Video frame analysis failed"); }

    const contextParts: string[] = [];
    if (visionDesc) contextParts.push(`Видео показывает: ${visionDesc}`);
    if (transcriptText) contextParts.push(`Звук: "${transcriptText}"`);
    const context = contextParts.join(". ") || "Видео без содержимого.";

    const completion = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: sysPrompt }, ...history,
        { role: "user", content: `[видео: ${context}]` }],
      max_tokens: 400,
    }), { label: "video reply" });

    return completion.choices[0]?.message?.content?.trim() ?? "хм, интересный видосик)";
  } finally {
    cleanUp(...filesToClean);
  }
}

// ─── Photo analysis ──────────────────────────────────────────────────────────

async function analyzePhoto(userId: number, chatId: number, fileId: string, caption?: string): Promise<string> {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const memory = await loadMemory(userId);
  const key = convKey(chatId, userId);
  const history = conversations.get(key) ?? [];

  const completion = await withRetry(() => groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_BASE + memory },
      ...history,
      { role: "user", content: [
        { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        { type: "text", text: caption ? `Пользователь прислал фото с подписью: "${caption}". Ответь как Сэм.` : "Пользователь прислал фото. Ответь как Сэм — живо." },
      ] as Groq.Chat.ChatCompletionContentPart[] },
    ],
    max_tokens: 400,
  }), { label: "photo analysis" });

  return completion.choices[0]?.message?.content?.trim() ?? "хм, интересно)";
}

// ─── Sticker handling ─────────────────────────────────────────────────────────

async function sendRandomSticker(chatId: number): Promise<boolean> {
  try {
    const stickers = await db.select().from(botStickersTable).limit(50);
    if (!stickers.length) return false;
    const pick = stickers[Math.floor(Math.random() * stickers.length)];
    if (!pick) return false;
    await bot.sendSticker(chatId, pick.fileId);
    return true;
  } catch { return false; }
}

async function saveSticker(fileId: string, setName?: string, emoji?: string): Promise<void> {
  await db.insert(botStickersTable).values({ fileId, setName: setName ?? null, emoji: emoji ?? null })
    .onConflictDoNothing().catch(() => {});
}

// ─── Tag processing ───────────────────────────────────────────────────────────

async function processTagsAndSend(chatId: number, rawReply: string, asVoice = false): Promise<string> {
  if (!rawReply?.trim()) return "";

  const memeMatch = rawReply.match(/\[МЕМ:([^\]]+)\]/i);
  const photoMatch = rawReply.match(/\[ФОТО:([^\]]+)\]/i);
  const artsMatch = rawReply.match(/\[АРТЫ:([^|]+)\|([^\]]+)\]/i);
  const stickerTag = /\[СТИКЕР\]/i.test(rawReply);
  const voiceTag = /\[ГОЛОС\]/i.test(rawReply);

  const clean = rawReply
    .replace(/\[МЕМ:[^\]]*\]/gi, "")
    .replace(/\[ФОТО:[^\]]*\]/gi, "")
    .replace(/\[АРТЫ:[^\]]*\]/gi, "")
    .replace(/\[СТИКЕР\]/gi, "")
    .replace(/\[ГОЛОС\]/gi, "")
    .trim();

  if (memeMatch?.[1]) {
    void (async () => {
      const url = await fetchMeme(memeMatch[1].trim());
      if (url) { await sleep(1200); await bot.sendPhoto(chatId, url).catch(() => {}); }
    })();
  }

  if (photoMatch?.[1]) {
    void (async () => { await sleep(500); await generateAndSendImage(chatId, photoMatch[1].trim()); })();
  }

  if (artsMatch?.[1] && artsMatch?.[2]) {
    void (async () => { await sleep(500); await generateArtInStyle(chatId, artsMatch[1].trim(), artsMatch[2].trim()); })();
  }

  if (stickerTag) {
    void (async () => { await sleep(600); await sendRandomSticker(chatId); })();
  }

  if (asVoice || voiceTag) {
    void (async () => { await sleep(800); await sendVoiceMessage(chatId, clean || rawReply); })();
  }

  return clean;
}

// ─── User tracking ────────────────────────────────────────────────────────────

async function trackUser(from: TelegramBot.User): Promise<void> {
  await db.insert(telegramUsersTable).values({
    userId: from.id, username: from.username ?? null,
    firstName: from.first_name ?? null, lastName: from.last_name ?? null, messageCount: 1,
  }).onConflictDoUpdate({
    target: telegramUsersTable.userId,
    set: { username: from.username ?? null, firstName: from.first_name ?? null,
      lastName: from.last_name ?? null,
      messageCount: sql`${telegramUsersTable.messageCount} + 1`, lastSeen: new Date() },
  }).catch(() => {});
}

// ─── Memory ───────────────────────────────────────────────────────────────────

async function loadMemory(userId: number): Promise<string> {
  try {
    const [row] = await db.select().from(userMemoryTable).where(eq(userMemoryTable.userId, userId));
    if (!row) return "";
    const parts: string[] = [];
    if (row.name) parts.push(`Имя/ник: ${row.name}`);
    if (row.interests) parts.push(`Интересы: ${row.interests}`);
    if (row.summary) parts.push(`Кто он: ${row.summary}`);
    if (row.notes) parts.push(`Важные детали: ${row.notes}`);
    return parts.length ? `\n\n[ПАМЯТЬ О ПОЛЬЗОВАТЕЛЕ]\n${parts.join("\n")}` : "";
  } catch { return ""; }
}

async function updateMemoryBackground(userId: number, history: ChatMessage[]): Promise<void> {
  try {
    const recent = history.slice(-6);
    if (recent.length < 2) return;
    const [existing] = await db.select().from(userMemoryTable).where(eq(userMemoryTable.userId, userId));
    const curMem = existing
      ? `Текущая память:\nИмя: ${existing.name ?? "—"}\nИнтересы: ${existing.interests ?? "—"}\nСводка: ${existing.summary ?? "—"}\nЗаметки: ${existing.notes ?? "—"}`
      : "Памяти нет.";
    const prompt = `${curMem}\n\nПоследний диалог:\n${recent.map(m => `${m.role === "user" ? "Пользователь" : "Сэм"}: ${m.content}`).join("\n")}\n\nОбнови память. JSON: {"name":"...","interests":"...","summary":"...","notes":"..."}\nПустая строка если нет данных. Макс 200 символов каждое поле. Не выдумывай.`;

    const parsed = await getJSONResponse<Record<string, string>>(
      [{ role: "user", content: prompt }],
      { maxTokens: 300, jsonMode: true, label: "memory update" }
    );
    await db.insert(userMemoryTable).values({
      userId, name: parsed.name || null, interests: parsed.interests || null,
      summary: parsed.summary || null, notes: parsed.notes || null, lastUpdated: new Date(),
    }).onConflictDoUpdate({
      target: userMemoryTable.userId,
      set: {
        name: parsed.name || existing?.name || null,
        interests: parsed.interests || existing?.interests || null,
        summary: parsed.summary || existing?.summary || null,
        notes: parsed.notes || existing?.notes || null,
        lastUpdated: new Date(),
      },
    });
  } catch (err) { logger.error({ err }, "Memory update failed"); }
}

// ─── Proactive follow-ups ─────────────────────────────────────────────────────

async function detectAndScheduleFollowUp(userId: number, userText: string): Promise<void> {
  try {
    const parsed = await getJSONResponse<{ should_followup?: boolean; delay_minutes?: number; topic?: string }>(
      [{ role: "user", content: `Пользователь написал: "${userText}"\nНужно ли написать первым через некоторое время? JSON: {"should_followup":bool,"delay_minutes":число,"topic":"о чём"}\nЕсли нет: {"should_followup":false}\ndelay_minutes 30-300.` }],
      { maxTokens: 100, jsonMode: true, label: "followup detect" }
    );
    if (!parsed.should_followup || !parsed.delay_minutes || !parsed.topic) return;
    await db.insert(scheduledMessagesTable).values({
      userId, scheduledAt: new Date(Date.now() + parsed.delay_minutes * 60_000),
      prompt: parsed.topic, status: "pending",
    });
  } catch { /* Non-critical */ }
}

async function sendScheduledMessages(): Promise<void> {
  try {
    const due = await db.select().from(scheduledMessagesTable)
      .where(and(eq(scheduledMessagesTable.status, "pending"), lte(scheduledMessagesTable.scheduledAt, new Date())));
    for (const msg of due) {
      try {
        await db.update(scheduledMessagesTable).set({ status: "sent" }).where(eq(scheduledMessagesTable.id, msg.id));
        const memory = await loadMemory(msg.userId);
        const resp = await withRetry(() => groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: SYSTEM_PROMPT_BASE + memory },
            { role: "user", content: `[Ты пишешь первым. Повод: ${msg.prompt}. Короткое живое сообщение как друг. Без "!"]` },
          ],
          max_tokens: 150,
        }), { label: "scheduled msg" });
        const text = resp.choices[0]?.message?.content?.trim();
        if (text) await sendWithTyping(msg.userId, text);
      } catch (err) {
        logger.error({ err, msgId: msg.id }, "Scheduled message failed");
        await db.update(scheduledMessagesTable).set({ status: "failed" }).where(eq(scheduledMessagesTable.id, msg.id));
      }
    }
  } catch { /* Non-critical */ }
}

setInterval(() => { void sendScheduledMessages(); }, 30_000);

// ─── Activity boost: Sam occasionally initiates in quiet chats ────────────────
// Every 25 minutes, pick one quiet group chat and send a proactive message
// to get the conversation going. Only fires if the chat had activity in the
// last hour (so it's not dead) but Sam hasn't spoken for 30+ minutes.

async function runActivityBoost(): Promise<void> {
  try {
    const allChats = await db.select({ chatId: botChatsTable.chatId, type: botChatsTable.type })
      .from(botChatsTable).catch(() => []);
    const groupChatIds = allChats
      .filter(c => c.type === "group" || c.type === "supergroup")
      .map(c => Number(c.chatId));
    if (!groupChatIds.length) return;

    const quietIds = getQuietChats(groupChatIds, 30 * 60 * 1000, 60 * 60 * 1000);
    if (!quietIds.length) return;

    // Pick one random quiet chat
    const targetId = quietIds[Math.floor(Math.random() * quietIds.length)];
    if (!targetId) return;

    // 55% chance — send an interactive (poll, would you rather, word game, trivia)
    // 45% chance — Sam writes a proactive message in character
    const useInteractive = Math.random() < 0.55;

    if (useInteractive) {
      const sent = await startRandomInteractive(bot, groq, SYSTEM_PROMPT_BASE, targetId);
      if (sent) logger.info({ chatId: targetId, mode: "interactive" }, "Activity boost sent");
    } else {
      const resp = await withRetry(() => groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT_BASE },
          { role: "user", content: `[Чат затих. Напиши короткое живое сообщение от себя — вопрос, наблюдение, интересная тема или просто что-то, что разожжёт разговор. Не объявляй что ты "поднимаешь активность". Пиши как обычный участник. Максимум 1-2 предложения.]` },
        ],
        max_tokens: 100,
        temperature: 1.0,
      }), { label: "activity boost" });

      const boostMsg = resp.choices[0]?.message?.content?.trim();
      if (boostMsg) {
        await bot.sendMessage(targetId, boostMsg).catch(() => {});
        recordBotActivity(targetId);
        logger.info({ chatId: targetId, mode: "text" }, "Activity boost sent");
      }
    }
  } catch (err) {
    logger.warn({ err }, "Activity boost failed (non-critical)");
  }
}

setInterval(() => { void runActivityBoost(); }, 25 * 60 * 1000);

// ─── Web search for factual queries ──────────────────────────────────────────

async function webSearch(query: string): Promise<string> {
  try {
    const res = await withTimeout(
      fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`,
        { headers: { "User-Agent": "SamBot/1.0" } }),
      8000, "DDG search"
    );
    if (!res.ok) return "";
    const data = await res.json() as { AbstractText?: string; RelatedTopics?: { Text?: string }[] };
    const parts: string[] = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (!parts.length && data.RelatedTopics?.length) {
      parts.push(...data.RelatedTopics.filter(t => t.Text).slice(0, 3).map(t => t.Text ?? ""));
    }
    return parts.join(" ").slice(0, 600);
  } catch { return ""; }
}

// ─── Music detection ──────────────────────────────────────────────────────────

function isMusicRequest(text: string): string | null {
  const MUSIC_WORDS = /трек|песню|музыку|song|track|плейлист|playlist/i;
  const patterns = [
    // Requires explicit music word: "найди трек X", "скинь песню X", "дай музыку X"
    /(?:найди|поищи|скинь|включи|хочу послушать|поставь|дай|давай|кинь)\s+(?:мне\s+)?(?:трек|песню|музыку|song|track)\s+[«""]?(.+?)[»""]?$/i,
    // Verb + music-word + artist/title inline: "найди «трек» X" with music word already matched above
    // "трек X" / "песня X" at start — must begin with music word
    /^(?:песня|трек|song|track)\s+[«""]?(.+?)[»""]?$/i,
    // "ищу трек X" / "это трек X"
    /(?:это|ищу)\s+(?:песня|трек|song|track)\s+[«""]?(.+?)[»""]?/i,
    // "поставь X" / "включи X" / "врубай X" — playback verbs strongly imply music
    /^(?:поставь|включи|врубай|врубить)\s+[«""]?(.+?)[»""]?$/i,
    // Explicit request WITH music word somewhere in message
    /(?:найди|поищи|скинь|кинь|дай)\s+(?:мне\s+)?[«""]?(.+?)[»""]?$/i,
  ];

  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    const m = text.match(p);
    if (m?.[1] && m[1].trim().length > 2) {
      // Last broad pattern — only allow if message explicitly contains a music word
      if (i === patterns.length - 1 && !MUSIC_WORDS.test(text)) continue;
      return m[1].trim();
    }
  }
  return null;
}

// ─── Main chat ────────────────────────────────────────────────────────────────

async function chat(userId: number, chatId: number, userText: string): Promise<string> {
  const memory = await loadMemory(userId);
  const key = convKey(chatId, userId);
  const history = conversations.get(key) ?? [];

  // Music request detection — search is quick, download runs in background
  const musicQuery = isMusicRequest(userText);
  if (musicQuery) {
    const track = await searchYouTube(musicQuery);
    if (track) {
      // Fire and forget: download + send audio without blocking the response
      void downloadAndSendAudio(bot, chatId, track).catch((err) => {
        logger.error({ err }, "downloadAndSendAudio background error");
      });
      return `ищу «${track.title}», сейчас принесу)`;
    }
    return "не нашёл такой трек, попробуй написать точнее";
  }

  // Factual question → web search enrichment
  let enrichedText = userText;
  const isQuestion = /[?？]/.test(userText) || /^(кто|что|как|где|когда|почему|зачем|сколько|какой|какая|расскажи|объясни|что такое)/i.test(userText.trim());
  if (isQuestion && userText.length > 10) {
    const searchResult = await webSearch(userText);
    if (searchResult) {
      enrichedText = `${userText}\n\n[СПРАВКА для Сэма — используй органично, не цитируй напрямую: ${searchResult}]`;
    }
  }

  history.push({ role: "user", content: userText });

  const completion = await withRetry(() => withTimeout(
    groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: SYSTEM_PROMPT_BASE + memory },
        ...history.slice(0, -1),
        { role: "user", content: enrichedText },
      ],
      max_tokens: 512,
    }),
    30000, "chat"
  ), { label: "chat" });

  const rawReply = completion.choices[0]?.message?.content?.trim() ?? "извини, что-то пошло не так";
  const clean = await processTagsAndSend(chatId, rawReply);
  const finalText = clean || rawReply.replace(/\[.*?\]/g, "").trim() || "...";

  history.push({ role: "assistant", content: finalText });
  if (history.length > 30) history.splice(0, 2);
  conversations.set(key, history);
  void updateMemoryBackground(userId, history);
  return finalText;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

async function getStats(): Promise<string> {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Run each query independently so one failure doesn't kill the whole stats
  const safeQuery = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch (err) {
      logger.warn({ err }, "stats query failed, using fallback");
      return fallback;
    }
  };

  const [totalRow] = await safeQuery(
    () => db.select({ total: count(), totalMessages: sum(telegramUsersTable.messageCount) }).from(telegramUsersTable),
    [{ total: 0, totalMessages: "0" }]
  );
  const [activeDay] = await safeQuery(
    () => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, dayAgo)),
    [{ count: 0 }]
  );
  const [activeWeek] = await safeQuery(
    () => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, weekAgo)),
    [{ count: 0 }]
  );
  const [newToday] = await safeQuery(
    () => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.firstSeen, today)),
    [{ count: 0 }]
  );
  const [pending] = await safeQuery(
    () => db.select({ count: count() }).from(scheduledMessagesTable).where(eq(scheduledMessagesTable.status, "pending")),
    [{ count: 0 }]
  );
  const [stickerCount] = await safeQuery(
    () => db.select({ count: count() }).from(botStickersTable),
    [{ count: 0 }]
  );
  const stickerPacks = await safeQuery(
    () => db.selectDistinct({ setName: botStickersTable.setName })
      .from(botStickersTable).where(sql`${botStickersTable.setName} IS NOT NULL`),
    [] as Array<{ setName: string | null }>
  );
  const topUsers = await safeQuery(
    () => db.select({
      firstName: telegramUsersTable.firstName,
      username: telegramUsersTable.username,
      messageCount: telegramUsersTable.messageCount,
    }).from(telegramUsersTable).orderBy(sql`${telegramUsersTable.messageCount} desc`).limit(5),
    [] as Array<{ firstName: string | null; username: string | null; messageCount: number }>
  );

  const uptime = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const mem = process.memoryUsage();

  const topList = topUsers.length > 0
    ? topUsers.map((u, i) =>
        `${i + 1}. ${u.username ? `@${u.username}` : (u.firstName ?? "—")} — ${u.messageCount ?? 0} сообщ.`
      ).join("\n")
    : "пока никого нет";

  const packLinks = stickerPacks.filter(p => p.setName)
    .map(p => `• <a href="https://t.me/addstickers/${p.setName}">${p.setName}</a>`)
    .join("\n");

  return [
    `📊 <b>Статистика бота</b>`,
    ``,
    `👥 Пользователей: <b>${totalRow?.total ?? 0}</b>`,
    `💬 Сообщений всего: <b>${totalRow?.totalMessages ?? 0}</b>`,
    ``,
    `🟢 Активны за 24ч: <b>${activeDay?.count ?? 0}</b>`,
    `📅 Активны за неделю: <b>${activeWeek?.count ?? 0}</b>`,
    `✨ Новых сегодня: <b>${newToday?.count ?? 0}</b>`,
    `⏰ Запланировано: <b>${pending?.count ?? 0}</b>`,
    ``,
    `🎭 Стикеров: <b>${stickerCount?.count ?? 0}</b>`,
    stickerPacks.length > 0 ? `📦 Паки стикеров (${stickerPacks.length}):\n${packLinks}` : "",
    ``,
    `🏆 <b>Топ-5 по сообщениям:</b>`,
    topList,
    ``,
    `⏱ Аптайм: <b>${h}ч ${m}м</b>`,
    `💾 RAM: <b>${Math.round(mem.heapUsed / 1024 / 1024)} МБ</b>`,
    `🔊 ElevenLabs: ${eleven ? "✅" : "❌"}`,
    `🧠 Groq: ✅`,
  ].filter(l => l !== "").join("\n");
}

// ─── Detailed stats (/stata — owner only) ─────────────────────────────────────

async function getDetailedStats(botInstance: TelegramBot): Promise<string> {
  const now = new Date();
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const safe = async <T>(fn: () => Promise<T>, fallback: T): Promise<T> => {
    try { return await fn(); } catch { return fallback; }
  };

  const [totals] = await safe(
    () => db.select({ total: count(), totalMsgs: sum(telegramUsersTable.messageCount) }).from(telegramUsersTable),
    [{ total: 0, totalMsgs: "0" }]
  );
  const [activeDay] = await safe(() => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, dayAgo)), [{ count: 0 }]);
  const [activeWeek] = await safe(() => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, weekAgo)), [{ count: 0 }]);
  const [activeMonth] = await safe(() => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.lastSeen, monthAgo)), [{ count: 0 }]);
  const [newToday] = await safe(() => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.firstSeen, today)), [{ count: 0 }]);
  const [newWeek] = await safe(() => db.select({ count: count() }).from(telegramUsersTable).where(gte(telegramUsersTable.firstSeen, weekAgo)), [{ count: 0 }]);

  const topUsers = await safe(
    () => db.select({ firstName: telegramUsersTable.firstName, username: telegramUsersTable.username, messageCount: telegramUsersTable.messageCount, firstSeen: telegramUsersTable.firstSeen })
      .from(telegramUsersTable).orderBy(sql`${telegramUsersTable.messageCount} desc`).limit(10),
    [] as Array<{ firstName: string | null; username: string | null; messageCount: number; firstSeen: Date | null }>
  );

  const [stickerCount] = await safe(() => db.select({ count: count() }).from(botStickersTable), [{ count: 0 }]);
  const stickerPacks = await safe(
    () => db.selectDistinct({ setName: botStickersTable.setName }).from(botStickersTable).where(sql`${botStickersTable.setName} IS NOT NULL`),
    [] as Array<{ setName: string | null }>
  );

  const [pendingScheduled] = await safe(
    () => db.select({ count: count() }).from(scheduledMessagesTable).where(eq(scheduledMessagesTable.status, "pending")),
    [{ count: 0 }]
  );
  const [sentScheduled] = await safe(
    () => db.select({ count: count() }).from(scheduledMessagesTable).where(eq(scheduledMessagesTable.status, "sent")),
    [{ count: 0 }]
  );

  const [msgLogTotal] = await safe(() => db.select({ total: count() }).from(messageLogTable), [{ total: 0 }]);
  const [avgSentimentRow] = await safe(() => db.select({ avg: sql<string>`AVG(${messageLogTable.sentiment})` }).from(messageLogTable), [{ avg: "0" }]);
  const [posMsgs] = await safe(() => db.select({ count: count() }).from(messageLogTable).where(sql`${messageLogTable.sentiment} > 0.3`), [{ count: 0 }]);
  const [negMsgs] = await safe(() => db.select({ count: count() }).from(messageLogTable).where(sql`${messageLogTable.sentiment} < -0.3`), [{ count: 0 }]);
  const [warnTotal] = await safe(() => db.select({ total: count() }).from(groupWarningsTable), [{ total: 0 }]);
  const [chatsCount] = await safe(() => db.select({ total: count() }).from(botChatsTable), [{ total: 0 }]);

  const [memoryCount] = await safe(() => db.select({ total: count() }).from(userMemoryTable), [{ total: 0 }]);

  const uptime = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const mem = process.memoryUsage();

  const topList = topUsers.length > 0
    ? topUsers.map((u, i) => `${i + 1}. ${u.username ? `@${u.username}` : (u.firstName ?? "—")} — <b>${u.messageCount ?? 0}</b> сообщ.`).join("\n")
    : "пока никого нет";

  const packLinks = stickerPacks.filter(p => p.setName)
    .map(p => `  • <a href="https://t.me/addstickers/${p.setName}">${p.setName}</a>`)
    .join("\n");

  const memRss = Math.round(mem.rss / 1024 / 1024);
  const memHeap = Math.round(mem.heapUsed / 1024 / 1024);
  const memHeapTotal = Math.round(mem.heapTotal / 1024 / 1024);

  const avgSent = Number(avgSentimentRow?.avg ?? 0);
  const sentimentLabel = avgSent > 0.2 ? "😊 Позитивный" : avgSent < -0.2 ? "😡 Негативный" : "😐 Нейтральный";

  const convCount = conversations.size;

  let botInfo = "—";
  try {
    const me = await botInstance.getMe();
    botInfo = `@${me.username} (ID: ${me.id})`;
  } catch { /* ignore */ }

  return [
    `📊 <b>Полная статистика бота</b>`,
    `🤖 Бот: ${botInfo}`,
    ``,
    `━━━ 👥 ПОЛЬЗОВАТЕЛИ ━━━`,
    `📌 Всего зарегистрировано: <b>${totals?.total ?? 0}</b>`,
    `✨ Новых сегодня: <b>${newToday?.count ?? 0}</b>`,
    `🗓 Новых за неделю: <b>${newWeek?.count ?? 0}</b>`,
    `🟢 Активны за 24ч: <b>${activeDay?.count ?? 0}</b>`,
    `📅 Активны за неделю: <b>${activeWeek?.count ?? 0}</b>`,
    `📆 Активны за месяц: <b>${activeMonth?.count ?? 0}</b>`,
    ``,
    `━━━ 💬 СООБЩЕНИЯ ━━━`,
    `📝 Всего сообщений от пользователей: <b>${totals?.totalMsgs ?? 0}</b>`,
    `🗃 Записей в логе: <b>${Number(msgLogTotal?.total ?? 0)}</b>`,
    `🔄 Активных диалогов в памяти: <b>${convCount}</b>`,
    `🧠 Профилей памяти (долгосрочных): <b>${Number(memoryCount?.total ?? 0)}</b>`,
    ``,
    `━━━ 😊 ТОНАЛЬНОСТЬ ━━━`,
    `🌡 Общая атмосфера: ${sentimentLabel} (${avgSent.toFixed(3)})`,
    `✅ Позитивных сообщений: <b>${posMsgs?.count ?? 0}</b>`,
    `❌ Негативных сообщений: <b>${negMsgs?.count ?? 0}</b>`,
    ``,
    `━━━ 🏠 ЧАТЫ ━━━`,
    `🗂 Всего чатов с ботом: <b>${Number(chatsCount?.total ?? 0)}</b>`,
    `⚠️ Выдано предупреждений (всего): <b>${Number(warnTotal?.total ?? 0)}</b>`,
    ``,
    `━━━ ⏰ ЗАПЛАНИРОВАННЫЕ СООБЩЕНИЯ ━━━`,
    `🕐 Ожидают отправки: <b>${Number(pendingScheduled?.count ?? 0)}</b>`,
    `✅ Уже отправлено: <b>${Number(sentScheduled?.count ?? 0)}</b>`,
    ``,
    `━━━ 🎭 СТИКЕРЫ ━━━`,
    `📦 Стикеров в коллекции: <b>${stickerCount?.count ?? 0}</b>`,
    stickerPacks.length > 0 ? `🗂 Паков (${stickerPacks.length}):\n${packLinks}` : `🗂 Паков: 0`,
    ``,
    `━━━ 🏆 ТОП-10 ПОЛЬЗОВАТЕЛЕЙ ━━━`,
    topList,
    ``,
    `━━━ ⚙️ СИСТЕМА ━━━`,
    `⏱ Аптайм: <b>${h}ч ${m}м</b>`,
    `💾 RAM (heap): <b>${memHeap} / ${memHeapTotal} МБ</b>`,
    `💿 RSS (всего): <b>${memRss} МБ</b>`,
    `🔊 ElevenLabs TTS: ${eleven ? "✅ подключён" : "❌ не подключён"}`,
    `🧠 Groq AI: ✅`,
    `🗄 PostgreSQL: ✅`,
    ``,
    `🕒 Сгенерировано: ${now.toLocaleString("ru-RU")}`,
  ].filter(l => l !== "").join("\n");
}

// ─── /skills command ──────────────────────────────────────────────────────────

const SKILLS_PAGES: Record<string, { title: string; text: string }> = {
  chat: {
    title: "💬 Общение и ИИ",
    text: `<b>💬 Общение и ИИ-диалог</b>

<b>Живой разговор</b>
• Сэм — не бот, а живой персонаж 20 лет. Никогда не выходит из роли
• Зеркалит твой стиль: темп, длину, эмодзи, тон, пунктуацию
• Мысли вслух в скобках — добавляет живости и глубины
• Строчные буквы, органичный сленг (кринж, треш, окак, норм)
• КАПСЛОК только для редких акцентов и смеха

<b>Память и контекст</b>
• Помнит имя, интересы, детали о тебе между сессиями
• Хранит историю разговора: ведёт нить, не переключается хаотично
• При возвращении — тёплое приветствие как старый друг
• <code>/clear</code> — сбросить память и начать с чистого листа

<b>Роль и режимы</b>
• Ролевые игры — полное погружение в любую атмосферу
• Мат — только с явного согласия пользователя, в меру
• Флирт — легко и без давления
• Грубость — только если оппонент аморален или унижает

<b>Знания</b>
Аниме, манга, яой/юри, K-pop (BTS, Stray Kids, Aespa), TikTok, IT, кибербезопасность, прикладная психология, знаменитости, игры — говорит с мнением и позицией`,
  },
  media: {
    title: "🎨 Медиа",
    text: `<b>🎨 Медиа-возможности</b>

🖼 <b>Генерация изображений</b>
"скинь фото [что угодно]" — фото через Pollinations.ai (Flux)
Автоматически улучшает промпт: правильная анатомия, качество, детали

🎨 <b>Арт в стиле художника</b>
"нарисуй в стиле [художник] [что]"
Стили: <code>nixeu</code> <code>wlop</code> <code>loish</code> <code>artgerm</code> <code>sakimichan</code>
<code>ross tran</code> <code>ilya kuvshinov</code> <code>greg rutkowski</code>
<code>ghibli</code> <code>pixar</code> <code>cyberpunk</code> <code>manga</code>
<code>watercolor</code> <code>oil painting</code> <code>realistic</code> <code>dark fantasy</code>

😂 <b>Мемы</b>
"скинь мем про [тему]" — ищет мем с Reddit/Pikabu

🎵 <b>Музыка</b>
"найди песню [название]" — поиск через YouTube (Invidious)
Кнопка "Текст" — показывает полные слова трека

🔊 <b>Голосовые сообщения</b>
"ответь голосом" — синтез речи через ElevenLabs (голос Adam)
Модель: eleven_multilingual_v2 — естественное произношение на русском

📸 <b>Анализ медиа</b>
Фото → описывает и реагирует (Groq Llama-4-Scout Vision)
Видео → извлекает кадры и аудио, анализирует содержимое
Голосовые/кружки → расшифровывает в текст (Whisper large-v3)
Стикеры → реагирует как на эмоцию`,
  },
  group: {
    title: "👥 Группа",
    text: `<b>👥 Управление группой</b>

📋 <b>Правила и приветствие</b>
<code>/rules</code> — показать правила чата
<code>/setrules [текст]</code> — установить правила (только админ)
<code>/setwelcome [текст]</code> — приветствие новых ({name} = имя)
<code>/chatstats</code> — статистика активности чата

📝 <b>Кастомные команды</b>
<code>/addcmd !триггер ответ</code> — добавить авто-ответ
<code>/delcmd !триггер</code> — удалить команду
<code>/cmds</code> — список всех команд чата

🔨 <b>Модерация (командами)</b>
<code>/ban [@user/reply] [причина]</code> — навсегда забанить
<code>/unban @user</code> — разбанить
<code>/mute [@user/reply] [минуты]</code> — замутить (по умолчанию 10 мин)
<code>/unmute [@user/reply]</code> — снять мут

🔇 <b>Шёпот — личное сообщение в группе</b>
Отправь секретное сообщение прямо в чате — прочитать сможет только адресат:
<code>шёпот @username текст</code> — шёпот конкретному пользователю
Или выдели (reply) чьё-то сообщение и напиши: <code>шёпот текст</code>
• Кнопка «Прочитать шёпот» видна всем, но текст — только адресату
• Одноразовое: после прочтения исчезает
• Твоё сообщение с командой автоматически удаляется

🗣 <b>Модерация голосом (только для админов)</b>
Напиши в чат — Сэм выполнит:
<code>Сэм забань @user1 @user2</code> — забанить одного или нескольких
<code>Сэм кикни @user1 @user2</code> — кикнуть (могут вернуться)
<code>удали их @user1, @user2, @user3</code> — массовый кик
<code>забань их @user1 @user2 @user3</code> — массовый бан
• Работает с @username и с именными ссылками (tap-to-mention)
• Только для администраторов чата
• Для одного — нужен префикс "Сэм"; для нескольких — достаточно ключевых слов

⚠️ <b>Система предупреждений</b>
<code>/warn [@user/reply] [причина]</code> — выдать варн (3 варна = авто-бан)
<code>/warns [@user/reply]</code> — посмотреть предупреждения
<code>/unwarn [@user/reply]</code> — снять последнее предупреждение

🤖 <b>Авто-защита</b>
<code>/moderation on/off</code> — включить/выключить авто-модерацию
<code>/autoban on/off</code> — авто-бан агрессора при конфликте
• Анти-флуд: мут на 5 мин при 5+ сообщениях за 10 секунд
• Анти-спам: автоудаление спам-паттернов
• Детекция конфликтов: анализ тональности, мут на 30 мин
• Капча для новых участников (можно отключить через белый список)`,
  },
  games: {
    title: "🎮 Игры",
    text: `<b>🎮 Игры и социальные функции</b>

⚔️ <b>Дуэль</b>
<code>/duel @username</code> — вызвать на дуэль
Принять или отказать кнопками в течение 2 минут
Механика: бросок кубика, победитель определяется по очкам

💍 <b>Система брака</b>
<code>/marry @username</code> — сделать предложение
Партнёр принимает или отклоняет кнопками
<code>/divorce</code> — развестись
<code>/marriage</code> — проверить статус брака

🎭 <b>Мафия — расширенная версия</b>
<code>/mafia</code> — создать лобби (мин. 4 игрока)
<code>/mafiaend</code> — завершить игру (только организатор/админ)

Роли раздаются в личку — состав зависит от числа игроков:

<b>Всегда в игре:</b>
🔫 <b>Мафия</b> — убивает мирных ночью, притворяется своим днём
🔍 <b>Шериф</b> — проверяет игроков ночью (мафия / не мафия)
👥 <b>Мирный</b> — выявляет мафию голосованием

<b>6+ игроков:</b>
💊 <b>Доктор</b> — защищает одного игрока от убийства каждую ночь

<b>7+ игроков:</b>
💋 <b>Любовница</b> — "навещает" игрока: блокирует его ночное действие

<b>8+ игроков:</b>
👮 <b>Комиссар</b> — "задерживает" игрока, лишая его ночного действия

<b>9+ игроков:</b>
🔪 <b>Маньяк</b> — одиночка, убивает самостоятельно, выигрывает в одиночку

<b>10+ игроков:</b>
⛪ <b>Церковник</b> — благословляет игрока, защищая от одного убийства

<b>11+ игроков:</b>
🏛 <b>Депутат</b> — депутатская неприкосновенность (первая атака блокируется)`,
  },
  psychology: {
    title: "🧠 Психология",
    text: `<b>🧠 Психологический анализ</b>

👤 <b>Досье пользователя</b>
<code>/dosye @username</code> или ответом на сообщение
Строит психологический профиль на основе истории сообщений:
• Интроверсия/экстраверсия
• Уровень агрессии и дружелюбия
• Тип юмора (ирония, сарказм, абсурд)
• Эмоциональная стабильность
• Манера коммуникации и речевые маркеры
• Скрытые интересы и паттерны поведения

📊 <b>Анализ настроения в реальном времени</b>
Каждое сообщение автоматически оценивается:
• Тональность: позитивная / нейтральная / негативная
• Юмор, сарказм, провокация
• Маркеры конфликта и агрессии
История последних 30 сообщений в чате — для определения атмосферы

🔬 <b>Детекция конфликтов</b>
Автоматически замечает эскалацию ссор
Определяет зачинщика (агрессора) по паттернам
Принимает меры: предупреждение, мут или бан`,
  },
  engagement: {
    title: "🚀 Вовлечённость",
    text: `<b>🚀 Система вовлечённости и роста</b>

🔗 <b>Реферальные ссылки</b>
<code>/invite</code> — получить свою реферальную ссылку (7 дней)
<code>/referrals</code> — рейтинг лучших пригласителей чата
<code>/invitestats</code> — твоя личная статистика приглашений

👤 <b>Добавление пользователей</b>
<code>/adduser @user1 @user2</code> — создать ссылки для конкретных пользователей
<code>/add_users @u1 @u2 @u3 ...</code> — массовое создание ссылок
• Лимит: 50 добавлений в час на чат (авто-сброс)

📨 <b>Упоминания и ЛС</b>
<code>/mention @user текст</code> — упомянуть пользователя с кнопкой "Написать"
<code>/dmlink</code> — кнопка "Написать Сэму в личку" для чата
<code>/broadcast @user текст</code> — рассылка с deep-link кнопкой

🛡 <b>Белый список</b>
<code>/whitelist add @user</code> — добавить в доверенные (пропускают капчу и лимиты)
<code>/whitelist remove @user</code> — убрать из белого списка
<code>/whitelist list</code> — посмотреть всех доверенных

🔍 <b>Антиспам-аудит</b>
<code>/spam_check</code> — проверить новичков за 24 ч:
✅ активные | 🟡 без сообщений | 🔴 с нарушениями

📊 <b>Панель вовлечённости</b>
<code>/stats</code> — для администраторов чата:
• Новые участники за 7 дней
• Топ рефереров
• Топ активных пользователей
• Состояние лимита добавлений
• Размер белого списка

🔒 <b>Капча для новичков</b>
Каждый новый участник получает кнопку-капчу
Пользователи из белого списка — пропускают автоматически`,
  },
  analytics: {
    title: "📊 Аналитика",
    text: `<b>📊 Аналитика и данные (владелец)</b>

👤 <b>Профиль пользователя</b>
<code>/danni @username</code> — глубокий отчёт о пользователе:
• Количество сообщений, активность по времени
• Тематика сообщений и интересы
• Средняя тональность (позитив/негатив %)
• Дата первого и последнего сообщения
• Кнопка удаления данных (GDPR)

📈 <b>Аналитика чата</b>
<code>/danni_chat</code> — статистика текущего чата:
• Самые активные участники (топ-10)
• Распределение тематик сообщений
• Среднее настроение чата
• Пиковое время активности

📊 <b>Панель вовлечённости (администраторы)</b>
<code>/stats</code> — новые участники, рефералы, топ активных, лимиты
<code>/spam_check</code> — аудит новичков за 24 часа (активность / нарушения)
<code>/chatstats</code> — общая статистика активности чата

📤 <b>Экспорт данных</b>
<code>/export_data</code> — получить свои данные в JSON (GDPR)
Включает: историю памяти, сохранённый контекст

📢 <b>Рассылка (только владелец)</b>
<code>/broadcast</code> — отправить сообщение во все чаты
Режимы: текст, фото, видео, документ
Предпросмотр перед отправкой, подтверждение

📋 <b>Статистика бота</b>
<code>/stat</code> — (только в личке) общая статистика:
• Всего пользователей в базе
• Всего чатов, где работает бот
• Сообщений обработано за сутки/неделю
• Аптайм и потребление памяти`,
  },
  monitor: {
    title: "🛡 Мониторинг",
    text: `<b>🛡 Агент самомониторинга</b>

Сэм непрерывно следит за собственным состоянием:

🔁 <b>Периодические проверки (раз в минуту)</b>
• 🗃 База данных — ping-запрос, измерение задержки
• 🧠 Groq API — проверка доступности нейросети
• 📡 Telegram polling — проверка живости соединения
• 💾 RAM — отслеживание утечек памяти

⚠️ <b>Авто-уведомления владельца</b>
При критических проблемах (БД недоступна, Telegram отвалился) —
бот сам пишет владельцу в личку с отчётом каждые 5 минут

📡 <b>API мониторинга для внешних сервисов</b>
<code>GET /health</code> — быстрый статус (200 OK = живой)
<code>GET /ping</code> — минимальный пинг
<code>GET /agent/status</code> — полный отчёт: аптайм, RAM, Node.js
<code>GET /api/healthz</code> — статус с валидацией схемы

<code>/status</code> — (только владелец) отчёт прямо в Telegram:
аптайм, RAM, статус ElevenLabs и Groq

🌐 <b>Cron-job.org</b>
Для keep-alive настрой задание на:
<code>GET /ping</code> — каждые 5 минут
Ответ: <code>{"status":"ok","ts":...}</code>`,
  },
  admin_tools: {
    title: "🔧 Инструменты",
    text: `<b>🔧 Системные команды</b>

<code>/skills</code> — это меню с полным описанием всех навыков
<code>/help</code> — быстрая подсказка (перенаправляет сюда)
<code>/start</code> — перезапуск / первое знакомство
<code>/stat</code> — статистика бота (только в личке)
<code>/status</code> — статус системы: RAM, аптайм, API (только владелец)
<code>/clear</code> — очистить свою историю и память Сэма
<code>/export_data</code> — скачать свои данные в JSON (GDPR)

🤖 <b>Автозащита всегда активна</b>
• Анти-флуд: порог 5 сообщений за 10 сек → мут 5 мин
• Анти-спам: удаление ссылок-спама и паттернов
• Конфликты: детекция по тональности → мут 30 мин
• 3 предупреждения → автоматический бан

🔒 <b>Приватность</b>
Данные хранятся в зашифрованной PostgreSQL БД
Только владелец может видеть аналитику
Любой пользователь может удалить свои данные через <code>/export_data</code>

⚡️ <b>Технический стек</b>
Node.js 24 · TypeScript · Express 5 · PostgreSQL · Drizzle ORM
Groq (Llama 3.3-70b / Llama 4 Scout / Whisper) · ElevenLabs · Pollinations.ai`,
  },
};

async function sendSkillsMenu(chatId: number, messageId?: number): Promise<void> {
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [
    [
      { text: "💬 Общение и ИИ", callback_data: "skills:chat" },
      { text: "🎨 Медиа", callback_data: "skills:media" },
    ],
    [
      { text: "👥 Группа", callback_data: "skills:group" },
      { text: "🎮 Игры", callback_data: "skills:games" },
    ],
    [
      { text: "🧠 Психология", callback_data: "skills:psychology" },
      { text: "🚀 Вовлечённость", callback_data: "skills:engagement" },
    ],
    [
      { text: "📊 Аналитика", callback_data: "skills:analytics" },
      { text: "🛡 Мониторинг", callback_data: "skills:monitor" },
    ],
    [
      { text: "🔧 Инструменты", callback_data: "skills:admin_tools" },
    ],
  ];

  const text = `🤖 <b>Сэм — полный список навыков</b>\n\nВыбери раздел чтобы узнать подробнее:`;

  if (messageId) {
    await bot.editMessageText(text, {
      chat_id: chatId, message_id: messageId, parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }).catch(() => {});
  } else {
    await bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    });
  }
}

// ─── Moderation: auto-detect conflict & spam ──────────────────────────────────

async function runAutoModeration(msg: TelegramBot.Message): Promise<boolean> {
  const chatId = msg.chat.id;
  const from = msg.from;
  const text = msg.text ?? "";
  if (!from || !text) return false;

  const isGroupChat = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroupChat) return false;

  // Load moderation config
  const [config] = await db.select().from(moderationConfigTable).where(eq(moderationConfigTable.groupId, chatId)).catch(() => []);
  if (config && !config.moderationEnabled) return false;

  const threshold = config?.floodThreshold ?? 5;
  const sensitivity = config?.conflictSensitivity ?? "medium";

  // Flood check
  const { isFlood } = checkFlood(chatId, from.id, { threshold, windowMs: 10_000 });
  if (isFlood) {
    try {
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await bot.restrictChatMember(chatId, from.id, {
        permissions: { can_send_messages: false },
        until_date: Math.floor(Date.now() / 1000) + 5 * 60,
      });
      await bot.sendMessage(chatId, `🔇 @${from.username ?? from.first_name} замучен на 5 минут за флуд.`);
      return true;
    } catch { /* Insufficient permissions */ }
  }

  // Spam check
  if (isSpam(text)) {
    try {
      await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
      await bot.sendMessage(chatId, `🚫 Спам удалён.`);
      return true;
    } catch { /* Ignore */ }
  }

  // Conflict detection
  const history = chatMsgHistory.get(chatId) ?? [];
  recordForConflict(chatId, from.id, text);
  const updated = chatMsgHistory.get(chatId) ?? [];

  if (updated.length >= 5 && sensitivity !== "low") {
    const minSent = sensitivity === "high" ? -0.5 : -0.7;
    const { isConflict, aggressorId } = detectConflictContext(updated);
    if (isConflict && aggressorId) {
      const doAutoban = config?.autobanEnabled ?? false;

      // Resolve aggressor & victim names for DMs
      const [aggressorRow] = await db.select().from(telegramUsersTable)
        .where(eq(telegramUsersTable.userId, aggressorId)).catch(() => []);
      const aggressorName = aggressorRow?.username
        ? `@${aggressorRow.username}` : (aggressorRow?.firstName ?? `id${aggressorId}`);

      const victimId = findVictimId(updated, aggressorId);
      let victimName: string | null = null;
      if (victimId) {
        const [victimRow] = await db.select().from(telegramUsersTable)
          .where(eq(telegramUsersTable.userId, victimId)).catch(() => []);
        victimName = victimRow?.username
          ? `@${victimRow.username}` : (victimRow?.firstName ?? null);
      }

      const chatTitle = msg.chat.title ?? "чат";

      try {
        if (doAutoban) {
          await bot.banChatMember(chatId, aggressorId);
        } else {
          await bot.restrictChatMember(chatId, aggressorId, {
            permissions: { can_send_messages: false },
            until_date: Math.floor(Date.now() / 1000) + 30 * 60,
          });
        }
        chatMsgHistory.delete(chatId);

        // 1. Sam reacts in character in the group
        try {
          const conflictReply = await withRetry(() => groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
              { role: "system", content: SYSTEM_PROMPT_BASE },
              { role: "user", content: doAutoban
                ? `[В чате разгорелся серьёзный конфликт. Агрессивного участника забанили. Напиши короткую реакцию от себя — спокойно, без лишних слов, как человек который устал от токсичности. Без восклицательных знаков, без официоза.]`
                : `[В чате началась эскалация конфликта. Участника замутили на 30 минут. Напиши короткую реакцию — ты немного устал от этой атмосферы, предложи успокоиться. Живо, по-человечески, коротко.]`,
              },
            ],
            max_tokens: 120,
            temperature: 0.8,
          }), { label: "conflict reply" });
          const conflictText = conflictReply.choices[0]?.message?.content?.trim();
          if (conflictText) {
            await bot.sendMessage(chatId, conflictText).catch(() => {});
            recordBotActivity(chatId);
          }
        } catch { /* non-critical */ }

        // 2. DM the victim with support (fire-and-forget)
        if (victimId && victimName) {
          void dmOffendedUser(bot, groq, SYSTEM_PROMPT_BASE, chatTitle, victimId, victimName, aggressorName);
        }

        // 3. DM admins with conflict report (fire-and-forget)
        void dmAdmins(bot, chatId, chatTitle, aggressorName, victimName, doAutoban ? "ban" : "mute_30m");

        return true;
      } catch { /* Insufficient permissions */ }
      void minSent;
    }
  }

  return false;
}

// ─── Callback query handler ───────────────────────────────────────────────────

bot.on("callback_query", async (query) => {
  const data = query.data ?? "";
  const chatId = query.message?.chat.id;
  const msgId = query.message?.message_id;
  const userId = query.from.id;

  // ── Whisper: must intercept BEFORE the generic answerCallbackQuery so we
  //    can use show_alert to display the secret message in a popup ──────────
  if (data.startsWith("whisper:")) {
    await handleWhisperCallback(bot, query).catch(() => {});
    return;
  }
  if (data === "whisper_read") {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  // ── 1. НЕМЕДЛЕННО убираем "часики" — первый вызов всегда ──────────────────
  await bot.answerCallbackQuery(query.id).catch(() => {});

  // ── 2. Логируем каждое нажатие ────────────────────────────────────────────
  logger.info({ data, userId, chatId }, `Button pressed: ${data}`);

  // ── 3. Единый try/catch — пользователь всегда получит ответ ──────────────
  try {

    // Skills menu
    if (data.startsWith("skills:")) {
      const page = data.split(":")[1] as string;
      if (page === "menu") {
        if (chatId && msgId) await sendSkillsMenu(chatId, msgId);
        return;
      }
      const content = SKILLS_PAGES[page];
      if (content && chatId && msgId) {
        await bot.editMessageText(content.text, {
          chat_id: chatId, message_id: msgId, parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "◀️ Назад", callback_data: "skills:menu" },
            ]],
          },
        }).catch(() => {});
      }
      return;
    }

    // Lyrics (new short key: lyr:XXXXXXXX)
    if (hasPrefix(data, "lyr") || data.startsWith("lyrics:")) {
      await bot.answerCallbackQuery(query.id, { text: "🔍 Ищу текст..." }).catch(() => {});
      await handleLyricsCallback(bot, query);
      return;
    }

    // Voice text (new short key: vt:XXXXXXXX)
    if (hasPrefix(data, "vt") || data.startsWith("voice_text:")) {
      let text: string | null = null;
      if (hasPrefix(data, "vt")) {
        text = getPayload(data);
      } else {
        // Legacy base64 support
        try {
          text = Buffer.from(data.replace("voice_text:", ""), "base64").toString("utf-8");
        } catch { /* */ }
      }
      if (text && chatId) {
        await bot.answerCallbackQuery(query.id, { text: "📝 Вот текст:" }).catch(() => {});
        await bot.sendMessage(chatId, `<pre>${text.replace(/</g, "&lt;")}</pre>`, {
          parse_mode: "HTML",
          reply_to_message_id: msgId,
        });
      } else {
        await bot.answerCallbackQuery(query.id, { text: "⏳ Данные устарели" }).catch(() => {});
      }
      return;
    }

    // Waifu: regenerate same prompt (wi:) or alternate style (ws:)
    if (hasPrefix(data, "wi") || hasPrefix(data, "ws")) {
      const basePrompt = getPayload(data);
      if (!basePrompt || !chatId) {
        await bot.answerCallbackQuery(query.id, { text: "⏳ Промт устарел, напиши /waifu заново" }).catch(() => {});
        return;
      }

      // Для альтернативного стиля — добавляем вариации
      const styleVariants = [
        "watercolor style, pastel colors, soft lighting",
        "cyberpunk neon, dark background, glowing eyes",
        "fantasy art, magical aura, enchanted forest",
        "chibi style, super deformed, cute, round eyes",
        "studio ghibli inspired, painterly, warm tones",
      ];
      const isAlternate = hasPrefix(data, "ws");
      const finalPrompt = isAlternate
        ? `${basePrompt}, ${styleVariants[Math.floor(Math.random() * styleVariants.length)]}`
        : basePrompt;

      await bot.answerCallbackQuery(query.id, { text: "🎨 Генерирую…" }).catch(() => {});

      const loadingMsg = await bot.sendMessage(
        chatId,
        isAlternate ? "✨ Рисую в другом стиле…" : "🔄 Рисую снова…",
      ).catch(() => null);

      try {
        await bot.sendChatAction(chatId, "upload_photo");
        const result = await generateWaifu(finalPrompt);
        if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

        const modelShort = result.modelUsed.split("/")[1] ?? result.modelUsed;
        const caption =
          `🌸 <b>Аниме-арт</b>\n` +
          `📝 <i>${finalPrompt.slice(0, 120)}${finalPrompt.length > 120 ? "…" : ""}</i>\n` +
          `🤖 <code>${modelShort}</code>`;

        await bot.sendPhoto(chatId, result.imageBuffer, {
          caption,
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[
              { text: "🔄 Ещё раз", callback_data: storePayload("wi", basePrompt.slice(0, 400)) },
              { text: "✨ Другой стиль", callback_data: storePayload("ws", basePrompt.slice(0, 400)) },
            ]],
          },
        });
      } catch (err) {
        if (loadingMsg) await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
        logger.error({ err }, "Waifu callback generation failed");
        await bot.sendMessage(chatId, "😔 Не получилось нарисовать — нейросеть перегружена, попробуй позже.").catch(() => {});
      }
      return;
    }

    // Voice reply (new short key: vr:XXXXXXXX)
    if (hasPrefix(data, "vr")) {
      const text = getPayload(data);
      if (text && chatId) {
        await bot.answerCallbackQuery(query.id, { text: "🔊 Озвучиваю..." }).catch(() => {});
        void sendVoiceMessage(chatId, text);
      } else {
        await bot.answerCallbackQuery(query.id, { text: "⏳ Данные устарели" }).catch(() => {});
      }
      return;
    }

    // Duel
    if (data.startsWith("duel_")) {
      await handleDuelCallback(bot, query);
      return;
    }

    // Marriage
    if (data.startsWith("marry_")) {
      await handleMarryCallback(bot, query);
      return;
    }

    // Mafia
    if (data.startsWith("mafia_")) {
      await handleMafiaCallback(bot, query);
      return;
    }

    // Broadcast
    if (data.startsWith("broadcast_")) {
      await handleBroadcastModeCallback(bot, query);
      return;
    }

    // /danni callbacks
    if (data.startsWith("danni_")) {
      if (!isOwner(userId)) {
        await bot.answerCallbackQuery(query.id, { text: "Нет прав" }).catch(() => {});
        return;
      }
      const [, action, userIdStr] = data.split(":");
      if (action === "delete" && userIdStr && chatId) {
        await db.delete(userMemoryTable).where(eq(userMemoryTable.userId, parseInt(userIdStr))).catch(() => {});
        await bot.answerCallbackQuery(query.id, { text: "Данные удалены" }).catch(() => {});
        await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: msgId }).catch(() => {});
      }
      return;
    }

    // ── Owner dashboard callbacks ──────────────────────────────────────────────
    if (data === "owner_stats") {
      if (!isOwner(userId)) return;
      await bot.answerCallbackQuery(query.id, { text: "📊 Загружаю..." });
      if (chatId) {
        await bot.sendChatAction(chatId, "typing");
        await bot.sendMessage(chatId, await getDetailedStats(bot), { parse_mode: "HTML" });
      }
      return;
    }
    if (data === "owner_stata") {
      if (!isOwner(userId)) return;
      await bot.answerCallbackQuery(query.id, { text: "📊 Загружаю подробную статистику..." });
      if (chatId) {
        await bot.sendChatAction(chatId, "typing");
        await bot.sendMessage(chatId, await getDetailedStats(bot), { parse_mode: "HTML" });
      }
      return;
    }
    if (data === "owner_status") {
      if (!isOwner(userId)) return;
      await bot.answerCallbackQuery(query.id);
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const h = Math.floor(uptime / 3600);
      const m2 = Math.floor((uptime % 3600) / 60);
      if (chatId) {
        await bot.sendMessage(chatId, [
          `🤖 <b>Статус бота</b>`,
          `⏱ Аптайм: ${h}ч ${m2}м`,
          `💾 RAM: ${Math.round(mem.heapUsed/1024/1024)}МБ / ${Math.round(mem.heapTotal/1024/1024)}МБ`,
          `🔊 ElevenLabs: ${eleven ? "✅" : "❌"}`,
          `🧠 Groq: ✅`,
          `🗃 DB: ✅`,
        ].join("\n"), { parse_mode: "HTML" });
      }
      return;
    }

    // ── Engagement callbacks ───────────────────────────────────────────────────
    if (isEngagementCallback(data)) {
      await handleEngagementCallback(bot, query);
      return;
    }

    // ── Captcha callback ───────────────────────────────────────────────────────
    if (data.startsWith("captcha:")) {
      const parts = data.split(":");
      const capChatId = parseInt(parts[1] ?? "0");
      const capUserId = parseInt(parts[2] ?? "0");
      if (capChatId && capUserId) {
        await handleCaptchaCallback(bot, query, capChatId, capUserId);
      }
      return;
    }

    // Welcome PM button — send a deep link to start DM with bot
    if (data === "welcome_pm") {
      await bot.answerCallbackQuery(query.id, {
        url: `https://t.me/${BOT_USERNAME}?start=hello`,
        text: "Открываю личку с ботом!",
      }).catch(() => {});
      return;
    }

    // Moderation / fallback
    if (data.startsWith("mod_")) return;

  } catch (err) {
    logger.error({ err, data, userId }, "Callback query handler error");
    // Уведомляем пользователя об ошибке
    if (chatId) {
      await bot.sendMessage(
        chatId,
        "Ошибка при обработке действия. Попробуй ещё раз.",
        { reply_to_message_id: msgId }
      ).catch(() => {});
    }
  }
});

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.onText(/^\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const from = msg.from;
  conversations.delete(convKey(chatId, from?.id ?? chatId));
  if (from) await trackUser(from);
  await trackBotChat(bot, msg);

  // Handle referral deep link: /start ref_{chatId}_{referrerId}
  const startParam = match?.[1]?.trim() ?? "";
  if (startParam.startsWith("ref_") && from) {
    const parts = startParam.split("_");
    const refChatId = Number(parts[1]);
    const referrerId = Number(parts[2]);
    if (refChatId && referrerId && !isNaN(refChatId) && !isNaN(referrerId)) {
      await recordReferral(bot, from.id, referrerId, refChatId);
      await sendWithTyping(chatId, `привет! ты пришёл по реферальной ссылке от другого участника 👋\n\nя сэм, мне 17. пиши если нужна помощь или просто хочешь поговорить`);
      return;
    }
  }

  // ── Owner/creator special greeting ──
  if (from && isOwner(from.id)) {
    const ownerGreetings = [
      `о, создатель, привет) давно тебя не видел`,
      `создатель вернулся. всё под контролем, всё работает`,
      `привет, владелец. чем займёмся?`,
      `хей, создатель. рад что ты тут`,
    ];
    const pick = ownerGreetings[Math.floor(Math.random() * ownerGreetings.length)];
    await sendWithTyping(chatId, pick, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📊 Статистика", callback_data: "owner_stats" },
            { text: "📢 Рассылка", callback_data: "broadcast_mode:all" },
          ],
          [
            { text: "🔧 /stata", callback_data: "owner_stata" },
            { text: "🛡 Статус", callback_data: "owner_status" },
          ],
        ],
      },
    });
    return;
  }

  const firstName = from?.first_name ?? "дружище";
  const memory = await loadMemory(from?.id ?? chatId);

  if (memory.length > 0) {
    const resp = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "system", content: SYSTEM_PROMPT_BASE + memory },
        { role: "user", content: `[Пользователь вернулся. Тёплое приветствие как старый друг. Коротко, без "!"]` }],
      max_tokens: 150,
    }), { label: "/start return" });
    const greeting = resp.choices[0]?.message?.content?.trim();
    if (greeting) { await sendWithTyping(chatId, greeting); return; }
  }
  await sendWithTyping(chatId, `о, привет ${firstName}) я сэм, мне 17, могу просто поговорить или помочь с чем-то по группе\n\nпиши что хочешь, я тут`);
});

bot.onText(/^\/help/, async (msg) => {
  await bot.sendMessage(msg.chat.id, `используй /skills — там всё`, { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/skills/, async (msg) => {
  await trackBotChat(bot, msg);
  await sendSkillsMenu(msg.chat.id);
});

// ─── /waifu — аниме-генерация через Hugging Face ──────────────────────────────

bot.onText(/^\/waifu(?:\s+(.+))?$/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  const prompt = match?.[1]?.trim();

  // Если промт не передан — показываем подсказку
  if (!prompt) {
    await bot.sendMessage(
      chatId,
      "🎨 <b>Аниме-генератор</b>\n\n" +
        "Напиши промт на английском:\n" +
        "<code>/waifu girl with long silver hair, cherry blossom, kimono</code>\n\n" +
        "Можно на русском — Сэм переведёт сам 😊",
      { parse_mode: "HTML", reply_to_message_id: msg.message_id }
    );
    return;
  }

  // Если промт на русском — переводим через Groq перед генерацией
  let finalPrompt = prompt;
  const hasCyrillic = /[а-яёА-ЯЁ]/.test(prompt);
  if (hasCyrillic) {
    try {
      const translateRes = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content:
              "Translate the following image generation prompt from Russian to English. " +
              "Output only the translated prompt, nothing else. Keep proper nouns as-is. " +
              "Optimise for Stable Diffusion — use descriptive adjectives.",
          },
          { role: "user", content: prompt },
        ],
        max_tokens: 200,
        temperature: 0.2,
      });
      finalPrompt = translateRes.choices[0]?.message.content?.trim() ?? prompt;
    } catch {
      // Если перевод упал — используем оригинал
    }
  }

  // Уведомляем пользователя — генерация занимает время
  const loadingMsg = await bot.sendMessage(
    chatId,
    "🎨 Рисую аниме-арт, подожди немного…",
    { reply_to_message_id: msg.message_id }
  );

  try {
    await bot.sendChatAction(chatId, "upload_photo");

    const result = await generateWaifu(finalPrompt);

    // Удаляем «рисую…» сообщение
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});

    const modelShort = result.modelUsed.split("/")[1] ?? result.modelUsed;
    const caption =
      `🌸 <b>Аниме-арт для ${msg.from?.first_name ?? "тебя"}</b>\n` +
      `📝 <i>${finalPrompt.slice(0, 120)}${finalPrompt.length > 120 ? "…" : ""}</i>\n` +
      `🤖 <code>${modelShort}</code>`;

    await bot.sendPhoto(chatId, result.imageBuffer, {
      caption,
      parse_mode: "HTML",
      reply_to_message_id: msg.message_id,
      reply_markup: {
        inline_keyboard: [[
          {
            text: "🔄 Ещё раз",
            callback_data: storePayload("wi", finalPrompt.slice(0, 400)),
          },
          {
            text: "✨ Другой стиль",
            callback_data: storePayload("ws", finalPrompt.slice(0, 400)),
          },
        ]],
      },
    });

    logger.info({ userId, prompt: finalPrompt }, "Waifu sent");
  } catch (err) {
    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err: errMsg, userId }, "Waifu generation failed");

    await bot.sendMessage(
      chatId,
      "😔 Не получилось нарисовать — нейросеть временно перегружена.\n" +
        "Попробуй через минуту или измени промт.",
      { reply_to_message_id: msg.message_id }
    );
  }
});

bot.onText(/^\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from?.id ?? chatId;
  conversations.delete(convKey(chatId, userId));
  await db.delete(userMemoryTable).where(eq(userMemoryTable.userId, userId)).catch(() => {});
  await bot.sendMessage(chatId, "всё, чистый лист)", { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/stat$/, async (msg) => {
  if (msg.chat.type !== "private") {
    await bot.sendMessage(msg.chat.id, "статистика только в личке");
    return;
  }
  try {
    await bot.sendMessage(msg.chat.id, await getStats(), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Stats error");
    await bot.sendMessage(msg.chat.id, "ошибка получения статистики");
  }
});

bot.onText(/^\/stata/, async (msg) => {
  if (!isOwner(msg.from?.id ?? 0)) {
    await bot.sendMessage(msg.chat.id, "только для владельца", { reply_to_message_id: msg.message_id });
    return;
  }
  try {
    await bot.sendChatAction(msg.chat.id, "typing");
    await bot.sendMessage(msg.chat.id, await getDetailedStats(bot), { parse_mode: "HTML" });
  } catch (err) {
    logger.error({ err }, "Stata error");
    await bot.sendMessage(msg.chat.id, "ошибка получения подробной статистики");
  }
});

// /status — bot health (owner only)
bot.onText(/^\/status/, async (msg) => {
  if (!isOwner(msg.from?.id ?? 0)) return;
  const mem = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  const h = Math.floor(uptime / 3600);
  const m = Math.floor((uptime % 3600) / 60);
  const text = [
    `🤖 <b>Статус бота</b>`,
    `⏱ Аптайм: ${h}ч ${m}м`,
    `💾 RAM: ${Math.round(mem.heapUsed / 1024 / 1024)}МБ / ${Math.round(mem.heapTotal / 1024 / 1024)}МБ`,
    `🔊 ElevenLabs: ${eleven ? "✅" : "❌"}`,
    `🧠 Groq: ✅`,
    `🗃 DB: ✅`,
  ].join("\n");
  await bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
});

// /danni
bot.onText(/^\/danni(?:_chat)?(\s+.*)?$/, async (msg, match) => {
  if (!isOwner(msg.from?.id ?? 0)) {
    await bot.sendMessage(msg.chat.id, "только для владельца", { reply_to_message_id: msg.message_id });
    return;
  }
  if (msg.text?.startsWith("/danni_chat")) {
    await handleDanniChat(bot, msg);
    return;
  }
  const target = extractUserFromText(msg.text ?? "", msg) ?? (msg.reply_to_message?.from ?? null);
  await handleDanniUser(bot, msg, target as TelegramBot.User | null);
  void match;
});

// /export_data
bot.onText(/^\/export_data/, async (msg) => {
  await handleExportData(bot, msg);
});

// /broadcast — two modes:
//   In group: /broadcast @username message  → mention user with text
//   In DM (owner): /broadcast               → global broadcast to all chats
bot.onText(/^\/broadcast(?:\s+(@\S+)\s+(.+))?/, async (msg, m) => {
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (isGroup && m?.[1] && m?.[2]) {
    // Group mention mode
    await handleBroadcastMention(bot, msg, m[1], m[2]);
  } else {
    // Owner global broadcast
    await handleBroadcastCommand(bot, msg);
  }
});

// Group admin commands
bot.onText(/^\/rules/, async (msg) => { await handleRules(bot, msg); });
bot.onText(/^\/setrules\s*(.+)?/, async (msg, m) => { await handleSetRules(bot, msg, m?.[1] ?? ""); });
bot.onText(/^\/setwelcome\s*(.+)?/, async (msg, m) => { await handleSetWelcome(bot, msg, m?.[1] ?? ""); });
bot.onText(/^\/chatstats/, async (msg) => { await handleGroupStats(bot, msg); });

// ── /chathealth — chat atmosphere & member report ──────────────────────────
bot.onText(/^\/chathealth/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "эта команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }
  const sentiments = getRecentSentiments(chatId);
  const report = await getChatHealthReport(bot, chatId, sentiments);
  await bot.sendMessage(chatId, report, { parse_mode: "HTML" }).catch(() => {});
});

// ── /members — member count + admin list ──────────────────────────────────
bot.onText(/^\/members/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) {
    await bot.sendMessage(chatId, "эта команда только для групп", { reply_to_message_id: msg.message_id });
    return;
  }
  try {
    const [count, admins] = await Promise.all([
      bot.getChatMemberCount(chatId).catch(() => 0),
      bot.getChatAdministrators(chatId).catch(() => [] as TelegramBot.ChatMember[]),
    ]);
    const humanAdmins = (admins as TelegramBot.ChatMember[]).filter(a => !a.user.is_bot);
    const adminList = humanAdmins.length > 0
      ? humanAdmins.map(a => {
          const name = a.user.username ? `@${a.user.username}` : (a.user.first_name ?? "—");
          const role = a.status === "creator" ? " 👑" : "";
          return `• ${name}${role}`;
        }).join("\n")
      : "• нет данных";

    const text = [
      `👥 <b>Участники чата</b>`,
      ``,
      `Всего: <b>${count}</b>`,
      `Администраторов: <b>${humanAdmins.length}</b>`,
      ``,
      `<b>Список администраторов:</b>`,
      adminList,
    ].join("\n");

    await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  } catch {
    await bot.sendMessage(chatId, "не удалось получить данные об участниках").catch(() => {});
  }
});

// ── /interactive — manually trigger a random interactive ──────────────────
bot.onText(/^\/interactive/, async (msg) => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  if (!isGroup) return;
  await startRandomInteractive(bot, groq, SYSTEM_PROMPT_BASE, chatId);
});
bot.onText(/^\/cmds/, async (msg) => { await handleListCmds(bot, msg); });

bot.onText(/^\/addcmd\s+(\S+)\s+(.+)/, async (msg, m) => {
  await handleAddCmd(bot, msg, m?.[1] ?? "", m?.[2] ?? "");
});
bot.onText(/^\/delcmd\s+(\S+)/, async (msg, m) => {
  await handleDelCmd(bot, msg, m?.[1] ?? "");
});

bot.onText(/^\/ban/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleBan(bot, msg, target);
});
bot.onText(/^\/unban/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleUnban(bot, msg, target);
});
bot.onText(/^\/mute(?:\s+(\d+))?/, async (msg, m) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleMute(bot, msg, target, parseInt(m?.[1] ?? "60"));
});
bot.onText(/^\/unmute/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleUnmute(bot, msg, target);
});
bot.onText(/^\/warn(?:\s+(.+))?/, async (msg, m) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleWarn(bot, msg, target, m?.[1]);
});
bot.onText(/^\/warns/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleWarns(bot, msg, target);
});
bot.onText(/^\/unwarn/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleUnwarn(bot, msg, target);
});

// Moderation config
bot.onText(/^\/moderation\s+(on|off)/, async (msg, m) => {
  if (!msg.from) return;
  const enabled = m?.[1] === "on";
  await db.insert(moderationConfigTable).values({ groupId: msg.chat.id, moderationEnabled: enabled })
    .onConflictDoUpdate({ target: moderationConfigTable.groupId, set: { moderationEnabled: enabled, updatedAt: new Date() } }).catch(() => {});
  await bot.sendMessage(msg.chat.id, `Авто-модерация: ${enabled ? "✅ включена" : "❌ выключена"}`, { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/autoban\s+(on|off)/, async (msg, m) => {
  if (!msg.from) return;
  const enabled = m?.[1] === "on";
  await db.insert(moderationConfigTable).values({ groupId: msg.chat.id, autobanEnabled: enabled })
    .onConflictDoUpdate({ target: moderationConfigTable.groupId, set: { autobanEnabled: enabled, updatedAt: new Date() } }).catch(() => {});
  await bot.sendMessage(msg.chat.id, `Авто-бан: ${enabled ? "✅ включён" : "❌ выключен"}`, { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/conflict_sensitivity\s+(low|medium|high)/, async (msg, m) => {
  const val = m?.[1] ?? "medium";
  await db.insert(moderationConfigTable).values({ groupId: msg.chat.id, conflictSensitivity: val })
    .onConflictDoUpdate({ target: moderationConfigTable.groupId, set: { conflictSensitivity: val, updatedAt: new Date() } }).catch(() => {});
  await bot.sendMessage(msg.chat.id, `Чувствительность конфликтов: <b>${val}</b>`, { parse_mode: "HTML", reply_to_message_id: msg.message_id });
});

// Group custom rules (owner/admin)
bot.onText(/^\/setrule\s+(.+)/, async (msg, m) => {
  const chatId = msg.chat.id;
  if (!m?.[1]) return;
  const [existing] = await db.select().from(groupSettingsTable).where(eq(groupSettingsTable.groupId, chatId)).catch(() => []);
  const current = existing?.rules ?? "";
  const newRules = current ? `${current}\n• ${m[1]}` : `• ${m[1]}`;
  await db.insert(groupSettingsTable).values({ groupId: chatId, rules: newRules })
    .onConflictDoUpdate({ target: groupSettingsTable.groupId, set: { rules: newRules, updatedAt: new Date() } }).catch(() => {});
  await bot.sendMessage(chatId, `✅ Правило добавлено.`, { reply_to_message_id: msg.message_id });
});

bot.onText(/^\/ruleslist/, async (msg) => { await handleRules(bot, msg); });

// ─── Referral & engagement commands ──────────────────────────────────────────

bot.onText(/^\/invite/, async (msg) => {
  await handleInvite(bot, msg, BOT_USERNAME);
});

bot.onText(/^\/referrals/, async (msg) => {
  await handleReferrals(bot, msg);
});

bot.onText(/^\/invitestats/, async (msg) => {
  await handleInviteStats(bot, msg);
});

bot.onText(/^\/dmlink/, async (msg) => {
  await handleDmLink(bot, msg, BOT_USERNAME);
});

// /adduser @u1 @u2 — generate one-use invite links (original referral version)
bot.onText(/^\/adduser(.*)/, async (msg, m) => {
  const raw = m?.[1]?.trim() ?? "";
  const usernames = raw.match(/@\w+/g) ?? [];
  await handleAddUser(bot, msg, usernames);
});

// /add_users @u1 @u2 — rate-limited mass invite (engagement version)
bot.onText(/^\/add_users(.*)/, async (msg, m) => {
  const raw = m?.[1]?.trim() ?? "";
  const usernames = raw.match(/@\w+/g) ?? [];
  await handleMassAddUsers(bot, msg, usernames);
});

// /mention @username message — @mention a user in group (for admins)
bot.onText(/^\/mention\s+(@\S+)(?:\s+(.+))?/, async (msg, m) => {
  await handleMention(bot, msg, m?.[1] ?? "", m?.[2] ?? "", BOT_USERNAME);
});

// /stats — engagement stats panel for admins
bot.onText(/^\/stats/, async (msg) => {
  await handleEngagementStats(bot, msg);
});

// /spam_check — audit newly joined users
bot.onText(/^\/spam_check/, async (msg) => {
  await handleSpamCheck(bot, msg);
});

// /whitelist — manage trusted users
bot.onText(/^\/whitelist(?:\s+(.+))?/, async (msg, m) => {
  await handleWhitelist(bot, msg, m?.[1] ?? "");
});

// Game commands
bot.onText(/^\/duel/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleDuel(bot, msg, target);
});
bot.onText(/^\/marry/, async (msg) => {
  const target = extractUserFromText(msg.text ?? "", msg);
  await handleMarry(bot, msg, target);
});
bot.onText(/^\/divorce/, async (msg) => { await handleDivorce(bot, msg); });
bot.onText(/^\/marriage/, async (msg) => { await handleMarriageStatus(bot, msg); });
bot.onText(/^\/mafia/, async (msg) => {
  if (!msg.text?.startsWith("/mafiaend")) await handleMafia(bot, msg);
});
bot.onText(/^\/mafiaend/, async (msg) => { await handleMafiaEnd(bot, msg); });

// ─── New member handler ───────────────────────────────────────────────────────

bot.on("new_chat_members", async (msg) => {
  await trackBotChat(bot, msg);

  const chatId = msg.chat.id;
  const newMembers = msg.new_chat_members ?? [];

  for (const member of newMembers) {
    if (member.is_bot) continue;

    // Track the user
    await trackUser(member).catch(() => {});

    const name = member.first_name ?? member.username ?? "новенький";
    const username = member.username ? `@${member.username}` : null;

    // 1. Send the admin-configured welcome message if exists
    await handleNewMember(bot, msg).catch(() => {});

    // 2. Always send a unique AI-generated personal greeting
    try {
      const memory = await loadMemory(member.id).catch(() => "");
      const isReturning = memory.length > 10;

      const systemCtx = SYSTEM_PROMPT_BASE + `\n\nТы сейчас в группе. В чат только что вступил новый участник по имени ${name}${username ? ` (${username})` : ""}. ${isReturning ? "Этот человек уже общался с тобой раньше — поприветствуй как старого знакомого." : "Это новый человек в чате."}`;

      const prompt = isReturning
        ? `[${name} только что вошёл в групповой чат. Поприветствуй его тепло, как будто уже знаешь. Коротко, живо, без официоза.]`
        : `[${name} только что вступил в чат. Напиши уникальное персональное приветствие: тепло, коротко, по-человечески. Предложи освоиться, скажи что готов помочь и пообщаться. Не копируй шаблонные фразы.]`;

      const resp = await withRetry(() => groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemCtx },
          { role: "user", content: prompt },
        ],
        max_tokens: 150,
        temperature: 0.9,
      }), { label: "welcome" });

      const greeting = resp.choices[0]?.message?.content?.trim();
      if (greeting) {
        await bot.sendMessage(chatId, greeting, {
          reply_markup: {
            inline_keyboard: [[
              { text: "👋 Познакомиться с ботом", callback_data: "welcome_pm" },
            ]],
          },
        }).catch(() => {});
        recordBotActivity(chatId);
      }
    } catch (err) {
      logger.warn({ err }, "Welcome AI greeting failed");
      const fallback = `${name}, привет) добро пожаловать в чат, освойся`;
      await bot.sendMessage(chatId, fallback).catch(() => {});
      recordBotActivity(chatId);
    }

    // 3. Captcha — skip for whitelisted users
    if (!isWhitelisted(chatId, member.id)) {
      await startCaptcha(bot, chatId, member).catch(() => {});
    } else {
      logger.info({ chatId, userId: member.id }, "Whitelisted user — captcha skipped");
    }

    // Keep bot attentive to this new member for 10 minutes so Sam can
    // help them integrate — replies to their messages get priority.
    markNewMember(chatId, member.id);
  }
});

// ─── Sticker handler ──────────────────────────────────────────────────────────

bot.on("sticker", async (msg) => {
  const chatId = msg.chat.id;
  const sticker = msg.sticker;
  if (!sticker || !msg.from) return;
  if (msg.from.is_bot) return;
  await trackUser(msg.from);
  await trackBotChat(bot, msg);
  await saveSticker(sticker.file_id, sticker.set_name, sticker.emoji);

  const memory = await loadMemory(msg.from.id);
  const key = convKey(chatId, msg.from.id);
  const history = conversations.get(key) ?? [];

  const resp = await withRetry(() => groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_BASE + memory },
      ...history,
      { role: "user", content: `[стикер ${sticker.emoji ?? ""}${sticker.set_name ? ` из набора "${sticker.set_name}"` : ""}]` },
    ],
    max_tokens: 80,
  }), { label: "sticker reply" });

  const reply = resp.choices[0]?.message?.content?.trim() ?? "хах)";
  history.push({ role: "user", content: `[стикер ${sticker.emoji ?? ""}]` });
  history.push({ role: "assistant", content: reply });
  conversations.set(key, history);
  if (reply) await sendWithTyping(chatId, reply);
});

// ─── Voice handler ────────────────────────────────────────────────────────────

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.voice || !msg.from || msg.from.is_bot) return;
  await trackUser(msg.from);
  await trackBotChat(bot, msg);

  try {
    await bot.sendChatAction(chatId, "typing");
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const transcribed = await transcribeAudio(buf, "audio/ogg");

    if (!transcribed.trim()) {
      await sendWithTyping(chatId, "не расслышал, повтори?");
      return;
    }

    const reply = await chat(msg.from.id, chatId, `[голосовое]: ${transcribed}`);
    const vrData = storePayload("vr", reply.slice(0, 500));
    await sendWithTyping(chatId, reply, {
      reply_markup: {
        inline_keyboard: [[
          { text: "🔊 Ответить голосом", callback_data: vrData },
        ]],
      },
    });
    void sendVoiceMessage(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Voice handling failed");
    await bot.sendMessage(chatId, "не смог распознать, попробуй ещё раз");
  }
});

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.from || msg.from.is_bot) return;
  await trackUser(msg.from);
  await trackBotChat(bot, msg);
  const largest = msg.photo?.[msg.photo.length - 1];
  if (!largest) return;

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await analyzePhoto(msg.from.id, chatId, largest.file_id, msg.caption);
    const clean = await processTagsAndSend(chatId, reply);
    const finalText = clean || reply.replace(/\[.*?\]/g, "").trim();
    if (!finalText) return;
    const key = convKey(chatId, msg.from.id);
    const history = conversations.get(key) ?? [];
    history.push({ role: "user", content: `[фото${msg.caption ? `: "${msg.caption}"` : ""}]` });
    history.push({ role: "assistant", content: finalText });
    if (history.length > 30) history.splice(0, 2);
    conversations.set(key, history);
    void updateMemoryBackground(msg.from.id, history);
    await sendWithTyping(chatId, finalText);
  } catch (err) {
    logger.error({ err }, "Photo analysis failed");
    await bot.sendMessage(chatId, "хм, не смог рассмотреть нормально");
  }
});

// ─── Video handler ────────────────────────────────────────────────────────────

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.video || !msg.from || msg.from.is_bot) return;
  await trackUser(msg.from);
  await trackBotChat(bot, msg);

  if (msg.video.file_size && msg.video.file_size > 45 * 1024 * 1024) {
    await bot.sendMessage(chatId, "видос слишком большой, до 45мб пожалуйста");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const fileLink = await bot.getFileLink(msg.video.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const reply = await analyzeVideo(msg.from.id, chatId, buf);
    const clean = await processTagsAndSend(chatId, reply);
    const finalText = clean || reply.replace(/\[.*?\]/g, "").trim();
    if (finalText) await sendWithTyping(chatId, finalText);
  } catch (err) {
    logger.error({ err }, "Video analysis failed");
    await bot.sendMessage(chatId, "не смог посмотреть видос нормально");
  }
});

// ─── Video note handler ───────────────────────────────────────────────────────

bot.on("video_note", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.video_note || !msg.from || msg.from.is_bot) return;
  await trackUser(msg.from);
  try {
    await bot.sendChatAction(chatId, "typing");
    const fileLink = await bot.getFileLink(msg.video_note.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const reply = await analyzeVideo(msg.from.id, chatId, buf);
    const clean = await processTagsAndSend(chatId, reply);
    const finalText = clean || reply.replace(/\[.*?\]/g, "").trim();
    if (finalText) await sendWithTyping(chatId, finalText);
  } catch (err) {
    logger.error({ err }, "Video note failed");
    await bot.sendMessage(chatId, "кружок не смог посмотреть, попробуй заново");
  }
});

// ─── Main message handler ─────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (!markProcessed(msg.message_id)) return;
  if (!msg.text || msg.text.startsWith("/")) return;
  if (msg.photo || msg.video || msg.video_note || msg.sticker || msg.voice) return;
  if (!msg.from || msg.from.is_bot) return;

  const chatId = msg.chat.id;
  const from = msg.from;
  const text = msg.text;
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";

  await trackUser(from);
  await trackBotChat(bot, msg);

  // Log for analytics
  logMessage(chatId, from.id, from.username, text);
  updateUserAnalytics(chatId, from.id, analyzeSentiment(text));

  // Broadcast mode
  if (isOwner(from.id) && hasPendingBroadcast(from.id)) {
    await executeBroadcast(bot, chatId, from.id, text);
    return;
  }

  // ── GROUP chat logic ────────────────────────────────────────────────────────
  if (isGroup) {
    // Always record message for conflict detection and dialogue tracking
    recordMsg(chatId, from.id);
    recordForConflict(chatId, from.id, text);
    recordChatActivity(chatId);

    // ── Whisper command: "шёпот @user текст" or reply+шёпот ────────────────────
    const whisperIntent = detectWhisper(msg);
    if (whisperIntent) {
      await handleWhisper(bot, msg, whisperIntent).catch(e =>
        logger.error({ e }, "handleWhisper error")
      );
      return;
    }

    // Custom group commands (triggers set by admins) — always handled
    const handled = await handleGroupCommand(bot, msg, text).catch(() => false);
    if (handled) return;

    // Auto-moderation (flood, spam, conflict) — always runs, takes priority
    const blocked = await runAutoModeration(msg).catch(() => false);
    if (blocked) {
      // Clear direct convo for this specific user if they got blocked
      clearDirectConvo(chatId, from.id);
      return;
    }

    // ── Natural language mass kick/ban (admin only) ──────────────────────────
    const massAction = detectMassModAction(text, msg.entities);
    if (massAction) {
      await executeMassModAction(bot, msg, massAction).catch(e =>
        logger.error({ e }, "executeMassModAction error")
      );
      return;
    }

    // Decide whether to respond
    const reason = shouldGroupReply(msg, BOT_ID, BOT_USERNAME);

    if (reason === "skip") return; // Stay silent

    // These reasons are always exempt from rate limiting — direct conversation
    const freeOfRateLimit =
      reason === "direct_mention" ||
      reason === "reply_to_bot" ||
      reason === "direct_convo" ||
      reason === "new_member" ||
      reason === "request";

    // Rate-limited reasons (questions) — check limit before responding
    if (!freeOfRateLimit && !rateLimitAllowed(chatId)) return;

    try {
      const reply = await chat(from.id, chatId, text);
      if (reply?.trim()) {
        await sendWithTyping(chatId, reply);
        recordBotActivity(chatId);

        // Only non-exempt replies count toward the per-chat rate cap
        if (!freeOfRateLimit) incrementRate(chatId);

        // Mark/refresh direct convo so next messages from this user stay prioritised
        if (
          reason === "direct_mention" ||
          reason === "reply_to_bot" ||
          reason === "direct_convo" ||
          reason === "request"
        ) {
          touchDirectConvo(chatId, from.id);
        }
      }
    } catch (err) {
      logger.error({ err }, "Group chat error");
    }
    return;
  }

  // ── PRIVATE chat — always respond ─────────────────────────────────────────
  try {
    const reply = await chat(from.id, chatId, text);
    void detectAndScheduleFollowUp(from.id, text);
    if (reply?.trim()) await sendWithTyping(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Private chat error");
    await bot.sendMessage(chatId, "что-то пошло не так, попробуй ещё раз").catch(() => {});
  }
});

// ─── Polling error handler ────────────────────────────────────────────────────

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error — continuing");
});

logger.info("Telegram bot started — full feature set enabled");

// ─── Запуск агента самомониторинга ────────────────────────────────────────────

startMonitor(bot, groqKey, BOT_OWNER_ID);

// ─── API-эндпоинт для агента (регистрируем глобально для app.ts) ─────────────

export { getLastHealthReport };
export default bot;
