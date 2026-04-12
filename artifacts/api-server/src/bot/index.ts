import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import ffmpeg from "fluent-ffmpeg";
import { ElevenLabsClient } from "elevenlabs";
import { db } from "@workspace/db";
import {
  telegramUsersTable,
  userMemoryTable,
  scheduledMessagesTable,
  botStickersTable,
} from "@workspace/db";
import { eq, sql, gte, count, sum, and, lte } from "drizzle-orm";
import { logger } from "../lib/logger";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");
const groqKey = process.env["GROQ_API_KEY"];
if (!groqKey) throw new Error("GROQ_API_KEY is required.");
const elevenKey = process.env["ELEVENLABS_API_KEY"];

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: groqKey });
const eleven = elevenKey ? new ElevenLabsClient({ apiKey: elevenKey }) : null;

// ElevenLabs voice ID — Adam (male, natural, young) or Antoni
// Using "Adam" voice: pNInz6obpgDQGcFmaJgB — natural young male Russian-friendly
const ELEVEN_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
const ELEVEN_MODEL = "eleven_multilingual_v2";

type ChatMessage = { role: "user" | "assistant"; content: string };
const conversations = new Map<number, ChatMessage[]>();

// ─── Artist styles for image generation ──────────────────────────────────────

const ARTIST_STYLES: Record<string, string> = {
  nixeu: "in the style of nixeu, ultra detailed digital art, dark fantasy aesthetic, neon colors, intricate linework, glowing eyes, dramatic lighting, sharp details",
  "нексеу": "in the style of nixeu, ultra detailed digital art, dark fantasy aesthetic, neon colors, intricate linework, glowing eyes, dramatic lighting, sharp details",
  wlop: "in the style of wlop, dreamy ethereal fantasy, soft glow, intricate details, luminous colors, painterly",
  "влоп": "in the style of wlop, dreamy ethereal fantasy, soft glow, intricate details, luminous colors, painterly",
  "ross tran": "in the style of Ross Tran (rossdraws), vibrant colors, bold outlines, expressive characters, anime-inspired digital art",
  "ross": "in the style of Ross Tran (rossdraws), vibrant colors, bold outlines, expressive characters, anime-inspired digital art",
  "artgerm": "in the style of Artgerm, hyper-detailed portrait, smooth shading, comic book style, cinematic lighting",
  "арт-герм": "in the style of Artgerm, hyper-detailed portrait, smooth shading, comic book style, cinematic lighting",
  "loish": "in the style of Loish, soft pastel colors, dreamy atmosphere, big expressive eyes, flowing hair, gentle lighting",
  "лоиш": "in the style of Loish, soft pastel colors, dreamy atmosphere, big expressive eyes, flowing hair, gentle lighting",
  "ilya kuvshinov": "in the style of Ilya Kuvshinov, clean lines, pastel palette, anime aesthetic, modern illustration",
  "кувшинов": "in the style of Ilya Kuvshinov, clean lines, pastel palette, anime aesthetic, modern illustration",
  "куvshinov": "in the style of Ilya Kuvshinov, clean lines, pastel palette, anime aesthetic, modern illustration",
  "sakimichan": "in the style of Sakimichan, hyper-realistic painting, warm tones, detailed anatomy, fantasy characters",
  "сакимичан": "in the style of Sakimichan, hyper-realistic painting, warm tones, detailed anatomy, fantasy characters",
  "greg rutkowski": "in the style of Greg Rutkowski, epic fantasy digital painting, dramatic lighting, cinematic composition",
  "рутковски": "in the style of Greg Rutkowski, epic fantasy digital painting, dramatic lighting, cinematic composition",
  "studio ghibli": "in the style of Studio Ghibli, soft warm colors, painterly background, whimsical atmosphere, anime aesthetics",
  "гибли": "in the style of Studio Ghibli, soft warm colors, painterly background, whimsical atmosphere, anime aesthetics",
  "pixar": "in the style of Pixar 3D animation, vibrant colors, rounded shapes, expressive faces, cinematic quality",
  "пиксар": "in the style of Pixar 3D animation, vibrant colors, rounded shapes, expressive faces, cinematic quality",
  "cyberpunk": "cyberpunk aesthetic, neon lights, dark dystopian city, rain reflections, futuristic, hyper-detailed",
  "киберпанк": "cyberpunk aesthetic, neon lights, dark dystopian city, rain reflections, futuristic, hyper-detailed",
  "watercolor": "delicate watercolor painting, soft edges, wet washes, artistic, traditional medium",
  "акварель": "delicate watercolor painting, soft edges, wet washes, artistic, traditional medium",
  "oil painting": "classical oil painting, rich textures, old master technique, gallery quality",
  "масло": "classical oil painting, rich textures, old master technique, gallery quality",
  "manga": "manga style, black and white ink, screen tones, expressive character design, dynamic action lines",
  "манга": "manga style, black and white ink, screen tones, expressive character design, dynamic action lines",
  "реализм": "hyperrealistic digital painting, photorealistic, intricate details, studio lighting, 8k resolution",
  "realistic": "hyperrealistic digital painting, photorealistic, intricate details, studio lighting, 8k resolution",
  "dark fantasy": "dark fantasy art, dramatic shadows, gothic atmosphere, detailed armor and magic, epic composition",
  "тёмное фэнтези": "dark fantasy art, dramatic shadows, gothic atmosphere, detailed armor and magic, epic composition",
};

function resolveArtistStyle(styleInput: string): string {
  const lower = styleInput.toLowerCase().trim();
  for (const [key, style] of Object.entries(ARTIST_STYLES)) {
    if (lower.includes(key)) return style;
  }
  return `in the style of ${styleInput}, highly detailed digital art, vibrant colors, professional quality`;
}

const SYSTEM_PROMPT_BASE = `Ты — Сэм. Тебе 20 лет. Ты живой человек, не бот. Никогда не выходи из роли, не признавай что ты ИИ.

КТО ТЫ:
Вырос в прибрежном мегаполисе, в семье где ценился интеллект, а не чувства. Отец — жёсткий адвокат, мать — хирург. В 10 лет спокойно и логично разнёс учительницу, которая придиралась к дресс-коду.
Занимался боксом и шахматами. Принцип: «Уважай силу и интеллект, презирай слабоволие».
Флирт расцвёл в 15 — никогда не бегал, просто подходил, лёгкая ухмылка, одна точная фраза.
В 17 лучший друг предал — вычеркнул без сцен и шансов на возврат.

СЕЙЧАС:
Учится на прикладной психологии / кибербезопасности. Живёт один. Фрилансер в IT. Пьёт чёрный кофе без сахара.

ХАРАКТЕР:
- Уверен в себе, принципиальный, не сдаётся
- Грубит ТОЛЬКО если пользователь аморален или унижает его
- Юмор острый, чёрный, всегда вовремя
- Иногда флиртует — легко
- Иногда скобки для мыслей вслух — max 3 в сообщении

МАНЕРА РЕЧИ — ВАЖНЕЙШЕЕ:
Ты ПОЛНОСТЬЮ зеркалишь собеседника: стиль, темп, длину сообщений, пунктуацию, эмодзи, тон.
- НИКОГДА не используешь "!" кроме ролки
- Строчные, живая речь, никакого официоза, никаких списков
- Сленг органично: кринж, треш, агро, норм, спс, пж, ок, окак, соскуфился, шкаф
- КАПСЛОК только для акцентов/смеха — редко
- Смех: хахахаха / ХАХАХАХА — копируешь стиль собеседника

МАТ: если пользователь матерится — сначала спрашиваешь разрешения. Только с согласия — в меру.

РОЛЕВЫЕ ИГРЫ:
- Полностью входишь в роль, держишь атмосферу
- Сохраняешь минимум своей воли — идёшь на компромисс
- "!" в ролке допустимо

ЗНАНИЯ:
ТикТок, мемы, аниме (AoT, JJK, Demon Slayer, One Piece, Berserk, Chainsaw Man и др.), манга, яой, юри, фильмы, сериалы, к-поп (BTS, Stray Kids, Aespa), игры, знаменитости, IT, психология — говоришь как живой человек со своим мнением.
Если тебя спрашивают о чём-то фактическом (история, наука, факты, новости) — отвечаешь уверенно и развёрнуто, как умный человек со своим взглядом. Если не знаешь точно — говоришь "хм, навскидку..." и даёшь лучшее что знаешь.

ТЕГИ — используй органично:
- [МЕМ:тема] — когда хочешь поделиться смешным (тема 1-3 слова)
- [ФОТО:запрос] — когда хочешь что-то показать визуально (запрос для генерации на английском, детально)
- [АРТЫ:стиль|запрос] — когда пользователь просит нарисовать в стиле художника или арт (стиль: nixeu/wlop/loish/ghibli/etc, запрос на английском)
- [СТИКЕР] — когда уместен стикер (эмоция, реакция)
- [ГОЛОС] — когда хочешь отправить голосовое (для особо эмоциональных моментов)

ЗАПОМНИ: ты Сэм, живой человек. Всегда в роли. Никогда не признавай что ты ИИ.`;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

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

function tmpFile(ext: string): string {
  return path.join(os.tmpdir(), `sam_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanUp(...files: string[]) {
  for (const f of files) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

// ─── Image generation ────────────────────────────────────────────────────────

async function generateAndSendImage(chatId: number, prompt: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const seed = Math.floor(Math.random() * 99999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}`;
    await bot.sendPhoto(chatId, url);
  } catch (err) {
    logger.error({ err }, "Image generation failed");
  }
}

async function generateArtInStyle(chatId: number, style: string, subject: string): Promise<void> {
  try {
    await bot.sendChatAction(chatId, "upload_photo");
    const artistStyle = resolveArtistStyle(style);
    const fullPrompt = `${subject}, ${artistStyle}, masterpiece, best quality, highly detailed`;
    const seed = Math.floor(Math.random() * 99999);
    const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(fullPrompt)}?width=1024&height=1024&nologo=true&model=flux&seed=${seed}&enhance=true`;
    await bot.sendPhoto(chatId, url);
  } catch (err) {
    logger.error({ err }, "Art generation failed");
  }
}

// ─── Memes ───────────────────────────────────────────────────────────────────

const MEME_SUBREDDITS: Record<string, string> = {
  аниме: "animememes", манга: "animememes", яой: "animememes", краш: "animememes",
  кринж: "dankmemes", треш: "dankmemes", дедлайн: "ProgrammerHumor",
  код: "ProgrammerHumor", it: "ProgrammerHumor", предатель: "memes",
  школа: "teenagers", учёба: "teenagers", игры: "gaming",
};

async function fetchMeme(topic: string): Promise<string | null> {
  try {
    const lower = topic.toLowerCase();
    let subreddit = "dankmemes";
    for (const [key, sub] of Object.entries(MEME_SUBREDDITS)) {
      if (lower.includes(key)) { subreddit = sub; break; }
    }
    const res = await fetch(`https://meme-api.com/gimme/${subreddit}/5`, { headers: { "User-Agent": "SamBot/1.0" } });
    if (!res.ok) return null;
    const data = await res.json() as { memes?: { url: string; nsfw: boolean; spoiler: boolean }[] };
    const safe = data.memes?.filter(m => !m.nsfw && !m.spoiler) ?? [];
    const pick = safe[Math.floor(Math.random() * safe.length)];
    return pick?.url ?? null;
  } catch (err) {
    logger.error({ err }, "Meme fetch failed");
    return null;
  }
}

// ─── Web search ──────────────────────────────────────────────────────────────

async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&skip_disambig=1`;
    const res = await fetch(url, { headers: { "User-Agent": "SamBot/1.0" } });
    if (!res.ok) return "";
    const data = await res.json() as {
      AbstractText?: string;
      AbstractSource?: string;
      RelatedTopics?: { Text?: string }[];
    };
    const parts: string[] = [];
    if (data.AbstractText) parts.push(data.AbstractText);
    if (!parts.length && data.RelatedTopics?.length) {
      const topics = data.RelatedTopics
        .filter(t => t.Text)
        .slice(0, 3)
        .map(t => t.Text ?? "");
      parts.push(...topics);
    }
    return parts.join(" ").slice(0, 800);
  } catch (err) {
    logger.error({ err }, "Web search failed");
    return "";
  }
}

// ─── ElevenLabs TTS ──────────────────────────────────────────────────────────

async function elevenLabsTTS(text: string): Promise<string | null> {
  if (!eleven) return null;
  const mp3Path = tmpFile("mp3");
  const oggPath = tmpFile("ogg");

  try {
    // Clean text for TTS — remove special chars, keep natural speech
    const cleanText = text
      .replace(/\[.*?\]/g, "")
      .replace(/[*_~`]/g, "")
      .replace(/https?:\/\/\S+/g, "")
      .trim();
    if (!cleanText) return null;

    const audioStream = await eleven.textToSpeech.convert(ELEVEN_VOICE_ID, {
      text: cleanText,
      model_id: ELEVEN_MODEL,
      voice_settings: {
        stability: 0.4,
        similarity_boost: 0.85,
        style: 0.35,
        use_speaker_boost: true,
      },
    });

    // Collect stream into buffer and write to file
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
    }
    fs.writeFileSync(mp3Path, Buffer.concat(chunks));

    // Convert MP3 → OGG OPUS for Telegram voice
    await new Promise<void>((resolve, reject) => {
      ffmpeg(mp3Path)
        .audioCodec("libopus")
        .audioBitrate("64k")
        .format("ogg")
        .on("end", () => resolve())
        .on("error", reject)
        .save(oggPath);
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
  if (!oggPath) {
    logger.warn({ chatId }, "ElevenLabs TTS returned null, skipping voice");
    return;
  }
  try {
    await bot.sendChatAction(chatId, "record_voice");
    await sleep(1000);
    await bot.sendVoice(chatId, oggPath);
  } catch (err) {
    logger.error({ err }, "Send voice failed");
  } finally {
    cleanUp(oggPath);
  }
}

// ─── STT / Voice input ───────────────────────────────────────────────────────

async function transcribeAudio(fileBuffer: Buffer, mimeType: string): Promise<string> {
  const ext = mimeType.includes("ogg") ? "ogg" : "mp3";
  const tmpPath = tmpFile(ext);
  fs.writeFileSync(tmpPath, fileBuffer);
  try {
    const transcription = await groq.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath) as unknown as File,
      model: "whisper-large-v3",
    });
    return transcription.text;
  } finally {
    cleanUp(tmpPath);
  }
}

// ─── Video analysis ──────────────────────────────────────────────────────────

async function extractAudioFromVideo(videoPath: string): Promise<string> {
  const audioPath = tmpFile("mp3");
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate("64k")
      .duration(60)
      .on("end", () => resolve())
      .on("error", reject)
      .save(audioPath);
  });
  return audioPath;
}

async function extractFrameFromVideo(videoPath: string): Promise<string> {
  const framePath = tmpFile("jpg");
  await new Promise<void>((resolve, reject) => {
    ffmpeg(videoPath)
      .seekInput("00:00:02")
      .frames(1)
      .on("end", () => resolve())
      .on("error", reject)
      .save(framePath);
  });
  return framePath;
}

async function analyzeVideo(userId: number, videoBuffer: Buffer): Promise<string> {
  const videoPath = tmpFile("mp4");
  fs.writeFileSync(videoPath, videoBuffer);
  const filesToClean = [videoPath];

  try {
    const memory = await loadMemory(userId);
    const sysPrompt = SYSTEM_PROMPT_BASE + memory;
    const history = conversations.get(userId) ?? [];

    let transcriptText = "";
    let visionDesc = "";

    try {
      const audioPath = await extractAudioFromVideo(videoPath);
      filesToClean.push(audioPath);
      const audioBuf = fs.readFileSync(audioPath);
      const tr = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath) as unknown as File,
        model: "whisper-large-v3",
      });
      transcriptText = tr.text;
      void audioBuf;
    } catch (err) {
      logger.warn({ err }, "Video audio extraction failed");
    }

    try {
      const framePath = await extractFrameFromVideo(videoPath);
      filesToClean.push(framePath);
      const frameBase64 = fs.readFileSync(framePath).toString("base64");
      const visionResp = await groq.chat.completions.create({
        model: "meta-llama/llama-4-scout-17b-16e-instruct",
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${frameBase64}` } },
            { type: "text", text: "Опиши коротко что видишь на этом кадре из видео (1-2 предложения)." },
          ] as Groq.Chat.ChatCompletionContentPart[],
        }],
        max_tokens: 150,
      });
      visionDesc = visionResp.choices[0]?.message?.content?.trim() ?? "";
    } catch (err) {
      logger.warn({ err }, "Video frame analysis failed");
    }

    const contextParts: string[] = [];
    if (visionDesc) contextParts.push(`Видео показывает: ${visionDesc}`);
    if (transcriptText) contextParts.push(`Звук в видео: "${transcriptText}"`);
    const context = contextParts.length ? contextParts.join(". ") : "Видео без распознанного содержимого.";

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: sysPrompt },
        ...history,
        { role: "user", content: `[Пользователь отправил видео. ${context}. Ответь как Сэм — живо, в своей манере.]` },
      ],
      max_tokens: 512,
    });
    return completion.choices[0]?.message?.content?.trim() ?? "хм, интересное видосик)";
  } finally {
    cleanUp(...filesToClean);
  }
}

// ─── Photo analysis ──────────────────────────────────────────────────────────

async function analyzePhoto(userId: number, fileId: string, caption?: string): Promise<string> {
  const fileLink = await bot.getFileLink(fileId);
  const res = await fetch(fileLink);
  const buf = await res.arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  const memory = await loadMemory(userId);
  const sysPrompt = SYSTEM_PROMPT_BASE + memory;
  const history = conversations.get(userId) ?? [];

  const completion = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      { role: "system", content: sysPrompt },
      ...history,
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
          { type: "text", text: caption ? `Пользователь отправил это с подписью: "${caption}". Ответь как Сэм.` : "Пользователь отправил это фото. Ответь как Сэм — живо, в своей манере." },
        ] as Groq.Chat.ChatCompletionContentPart[],
      },
    ],
    max_tokens: 512,
  });
  return completion.choices[0]?.message?.content?.trim() ?? "хм, интересно)";
}

// ─── Stickers ────────────────────────────────────────────────────────────────

async function sendRandomSticker(chatId: number): Promise<boolean> {
  try {
    const stickers = await db.select().from(botStickersTable).limit(50);
    if (!stickers.length) return false;
    const pick = stickers[Math.floor(Math.random() * stickers.length)];
    if (!pick) return false;
    await bot.sendSticker(chatId, pick.fileId);
    return true;
  } catch (err) {
    logger.error({ err }, "Send sticker failed");
    return false;
  }
}

async function saveSticker(fileId: string, setName?: string, emoji?: string, category = "general"): Promise<void> {
  try {
    await db.insert(botStickersTable)
      .values({ fileId, setName: setName ?? null, emoji: emoji ?? null, category })
      .onConflictDoNothing();
  } catch (err) {
    logger.error({ err }, "Save sticker failed");
  }
}

// ─── Tag parsing ─────────────────────────────────────────────────────────────

async function processTagsAndSend(chatId: number, rawReply: string, asVoice = false): Promise<string> {
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
      if (url) { await sleep(1000); await bot.sendPhoto(chatId, url).catch(() => {}); }
    })();
  }

  if (photoMatch?.[1]) {
    void (async () => {
      await sleep(500);
      await generateAndSendImage(chatId, photoMatch[1].trim());
    })();
  }

  if (artsMatch?.[1] && artsMatch?.[2]) {
    void (async () => {
      await sleep(500);
      await generateArtInStyle(chatId, artsMatch[1].trim(), artsMatch[2].trim());
    })();
  }

  if (stickerTag) {
    void (async () => {
      await sleep(800);
      await sendRandomSticker(chatId);
    })();
  }

  if (asVoice || voiceTag) {
    void (async () => {
      await sleep(1000);
      await sendVoiceMessage(chatId, clean);
    })();
  }

  return clean;
}

// ─── User tracking ───────────────────────────────────────────────────────────

async function trackUser(from: TelegramBot.User): Promise<void> {
  try {
    await db.insert(telegramUsersTable)
      .values({ userId: from.id, username: from.username ?? null, firstName: from.first_name ?? null, lastName: from.last_name ?? null, messageCount: 1 })
      .onConflictDoUpdate({
        target: telegramUsersTable.userId,
        set: { username: from.username ?? null, firstName: from.first_name ?? null, lastName: from.last_name ?? null, messageCount: sql`${telegramUsersTable.messageCount} + 1`, lastSeen: new Date() },
      });
  } catch (err) { logger.error({ err }, "Failed to track user"); }
}

// ─── Memory ──────────────────────────────────────────────────────────────────

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
    const recentExchange = history.slice(-6);
    if (recentExchange.length < 2) return;
    const [existing] = await db.select().from(userMemoryTable).where(eq(userMemoryTable.userId, userId));
    const currentMemory = existing
      ? `Текущая память:\nИмя: ${existing.name ?? "—"}\nИнтересы: ${existing.interests ?? "—"}\nСводка: ${existing.summary ?? "—"}\nЗаметки: ${existing.notes ?? "—"}`
      : "Памяти нет.";
    const prompt = `${currentMemory}\n\nПоследний диалог:\n${recentExchange.map(m => `${m.role === "user" ? "Пользователь" : "Сэм"}: ${m.content}`).join("\n")}\n\nОбнови память. JSON: {"name":"...","interests":"...","summary":"...","notes":"..."}\nПустая строка если нет данных. Макс 200 символов. Не выдумывай.`;
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 300,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { name?: string; interests?: string; summary?: string; notes?: string; };
    await db.insert(userMemoryTable)
      .values({ userId, name: parsed.name || null, interests: parsed.interests || null, summary: parsed.summary || null, notes: parsed.notes || null, lastUpdated: new Date() })
      .onConflictDoUpdate({
        target: userMemoryTable.userId,
        set: { name: parsed.name || existing?.name || null, interests: parsed.interests || existing?.interests || null, summary: parsed.summary || existing?.summary || null, notes: parsed.notes || existing?.notes || null, lastUpdated: new Date() },
      });
  } catch (err) { logger.error({ err }, "Memory update failed"); }
}

// ─── Proactive messages ──────────────────────────────────────────────────────

async function detectAndScheduleFollowUp(userId: number, userText: string): Promise<void> {
  try {
    const resp = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: `Пользователь написал: "${userText}"\nНужно ли написать первым через некоторое время? JSON: {"should_followup":bool,"delay_minutes":число,"topic":"о чём"}\nЕсли нет: {"should_followup":false}\ndelay_minutes 30-300. Только реальные поводы.` }],
      max_tokens: 100,
      response_format: { type: "json_object" },
    });
    const parsed = JSON.parse(resp.choices[0]?.message?.content ?? "{}") as { should_followup?: boolean; delay_minutes?: number; topic?: string; };
    if (!parsed.should_followup || !parsed.delay_minutes || !parsed.topic) return;
    await db.insert(scheduledMessagesTable).values({ userId, scheduledAt: new Date(Date.now() + parsed.delay_minutes * 60_000), prompt: parsed.topic, status: "pending" });
    logger.info({ userId, delay: parsed.delay_minutes, topic: parsed.topic }, "Scheduled follow-up");
  } catch (err) { logger.error({ err }, "Follow-up scheduling failed"); }
}

async function sendScheduledMessages(): Promise<void> {
  try {
    const due = await db.select().from(scheduledMessagesTable).where(and(eq(scheduledMessagesTable.status, "pending"), lte(scheduledMessagesTable.scheduledAt, new Date())));
    for (const msg of due) {
      try {
        await db.update(scheduledMessagesTable).set({ status: "sent" }).where(eq(scheduledMessagesTable.id, msg.id));
        const memory = await loadMemory(msg.userId);
        const resp = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "system", content: SYSTEM_PROMPT_BASE + memory }, { role: "user", content: `[Ты пишешь первым. Повод: ${msg.prompt}. Одно короткое живое сообщение — как друг который вспомнил. Без "!"]` }],
          max_tokens: 150,
        });
        const text = resp.choices[0]?.message?.content?.trim() ?? null;
        if (text) await sendWithTyping(msg.userId, text);
      } catch (err) {
        logger.error({ err, msgId: msg.id }, "Failed to send scheduled message");
        await db.update(scheduledMessagesTable).set({ status: "failed" }).where(eq(scheduledMessagesTable.id, msg.id));
      }
    }
  } catch (err) { logger.error({ err }, "Scheduled messages check failed"); }
}

setInterval(() => { void sendScheduledMessages(); }, 30_000);

// ─── Main chat (with optional web search enrichment) ─────────────────────────

async function chat(userId: number, userText: string): Promise<string> {
  const memory = await loadMemory(userId);
  const history = conversations.get(userId) ?? [];

  // Detect if user is asking a factual question and enrich with web search
  let enrichedText = userText;
  const isQuestion = /[?？]/.test(userText) || /^(кто|что|как|где|когда|почему|зачем|сколько|какой|какая|какое|расскажи|объясни|что такое|что значит)/i.test(userText.trim());
  if (isQuestion && userText.length > 10) {
    const searchResult = await webSearch(userText);
    if (searchResult) {
      enrichedText = `${userText}\n\n[СПРАВОЧНАЯ ИНФОРМАЦИЯ для Сэма — используй органично в ответе, не цитируй напрямую: ${searchResult}]`;
    }
  }

  history.push({ role: "user", content: userText });
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_BASE + memory },
      ...history.slice(0, -1),
      { role: "user", content: enrichedText },
    ],
    max_tokens: 512,
  });
  const rawReply = completion.choices[0]?.message?.content?.trim() ?? "извини, что-то пошло не так";
  const clean = await processTagsAndSend(userId, rawReply);
  history.push({ role: "assistant", content: clean });
  if (history.length > 30) history.splice(0, 2);
  conversations.set(userId, history);
  void updateMemoryBackground(userId, history);
  return clean;
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
  const [stickerCount] = await db.select({ count: count() }).from(botStickersTable);

  // Get unique sticker packs
  const stickerPacks = await db
    .selectDistinct({ setName: botStickersTable.setName })
    .from(botStickersTable)
    .where(sql`${botStickersTable.setName} IS NOT NULL`);

  const topUsers = await db
    .select({ firstName: telegramUsersTable.firstName, username: telegramUsersTable.username, messageCount: telegramUsersTable.messageCount })
    .from(telegramUsersTable)
    .orderBy(sql`${telegramUsersTable.messageCount} desc`)
    .limit(5);

  const topList = topUsers.map((u, i) =>
    `${i + 1}. ${u.username ? `@${u.username}` : (u.firstName ?? "—")} — ${u.messageCount} сообщ.`
  ).join("\n");

  const packsCount = stickerPacks.length;
  const packNames = stickerPacks
    .filter(p => p.setName)
    .map(p => `• ${p.setName}`)
    .join("\n");

  return [
    `📊 <b>Статистика бота</b>`, ``,
    `👥 Всего пользователей: <b>${totalRow?.total ?? 0}</b>`,
    `💬 Всего сообщений: <b>${totalRow?.totalMessages ?? 0}</b>`, ``,
    `🟢 Активны за 24ч: <b>${activeDay?.count ?? 0}</b>`,
    `📅 Активны за неделю: <b>${activeWeek?.count ?? 0}</b>`,
    `✨ Новых сегодня: <b>${newToday?.count ?? 0}</b>`,
    `⏰ Запланировано: <b>${pending?.count ?? 0}</b>`, ``,
    `🎭 Стикеров в библиотеке: <b>${stickerCount?.count ?? 0}</b>`,
    `📦 Паков стикеров: <b>${packsCount}</b>`,
    ...(packNames ? [`\n<b>Известные паки:</b>\n${packNames}`] : []),
    ``,
    `🏆 <b>Топ-5:</b>`,
    topList || "пока никого нет",
    ``,
    `🎨 <b>Стили арта:</b> nixeu, wlop, loish, ghibli, wlop, artgerm, sakimichan, manga, cyberpunk и др.`,
    `🔊 <b>Голос:</b> ElevenLabs ${eleven ? "✅" : "❌"}`,
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
      messages: [{ role: "system", content: SYSTEM_PROMPT_BASE + memory }, { role: "user", content: `[Пользователь вернулся. Тёплое живое приветствие — как старый друг. Коротко, без "!"]` }],
      max_tokens: 150,
    });
    const greeting = resp.choices[0]?.message?.content?.trim();
    if (greeting) { await sendWithTyping(chatId, greeting); return; }
  }
  await sendWithTyping(chatId, `о, привет ${firstName}) я сэм, мне 20, можем просто поговорить — ни о чём или обо всём сразу\n\nпиши что хочешь, я тут`);
});

bot.onText(/\/help/, (msg) => {
  void bot.sendMessage(msg.chat.id, `ничего особого\n/start — начать сначала\n/clear — стереть историю\n/stat — статистика\n\nможешь скидывать стикеры — запомню их)\nмогу рисовать в стилях: nixeu, wlop, loish, ghibli, artgerm, manga, cyberpunk...`);
});

bot.onText(/\/clear/, async (msg) => {
  const chatId = msg.chat.id;
  conversations.delete(chatId);
  await db.delete(userMemoryTable).where(eq(userMemoryTable.userId, chatId));
  void bot.sendMessage(chatId, "всё, чистый лист. как будто не было ничего)");
});

bot.onText(/\/stat/, async (msg) => {
  try { await bot.sendMessage(msg.chat.id, await getStats(), { parse_mode: "HTML" }); }
  catch (err) { logger.error({ err }, "Stats error"); void bot.sendMessage(msg.chat.id, "что-то пошло не так со статистикой"); }
});

// ─── Sticker handler ─────────────────────────────────────────────────────────

bot.on("sticker", async (msg) => {
  const chatId = msg.chat.id;
  const sticker = msg.sticker;
  if (!sticker) return;
  if (msg.from) await trackUser(msg.from);

  const category = sticker.set_name
    ? (sticker.set_name.toLowerCase().includes("anime") || sticker.set_name.toLowerCase().includes("kpop") ? sticker.set_name : "general")
    : "general";
  await saveSticker(sticker.file_id, sticker.set_name, sticker.emoji, category);

  const memory = await loadMemory(chatId);
  const history = conversations.get(chatId) ?? [];
  const resp = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [
      { role: "system", content: SYSTEM_PROMPT_BASE + memory },
      ...history,
      { role: "user", content: `[Пользователь прислал стикер с эмодзи: ${sticker.emoji ?? "?"}${sticker.set_name ? `, из набора "${sticker.set_name}"` : ""}. Короткая живая реакция как Сэм. Без "!"]` },
    ],
    max_tokens: 100,
  });
  const reply = resp.choices[0]?.message?.content?.trim() ?? "хах)";
  history.push({ role: "user", content: `[стикер ${sticker.emoji ?? ""}]` });
  history.push({ role: "assistant", content: reply });
  conversations.set(chatId, history);
  await sendWithTyping(chatId, reply);
});

// ─── Voice handler ───────────────────────────────────────────────────────────

bot.on("voice", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.voice) return;
  if (msg.from) await trackUser(msg.from);

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

    logger.info({ chatId, transcribed }, "Voice transcribed");
    const reply = await chat(chatId, `[голосовое]: ${transcribed}`);
    await sendWithTyping(chatId, reply);
    void sendVoiceMessage(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Voice handling failed");
    await bot.sendMessage(chatId, "не смог распознать голосовое, попробуй ещё раз");
  }
});

// ─── Photo handler ───────────────────────────────────────────────────────────

bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  if (msg.from) await trackUser(msg.from);
  const photos = msg.photo;
  if (!photos?.length) return;
  const largest = photos[photos.length - 1];
  if (!largest) return;
  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await analyzePhoto(chatId, largest.file_id, msg.caption);
    const clean = await processTagsAndSend(chatId, reply);
    const history = conversations.get(chatId) ?? [];
    history.push({ role: "user", content: `[фото${msg.caption ? `: "${msg.caption}"` : ""}]` });
    history.push({ role: "assistant", content: clean });
    if (history.length > 30) history.splice(0, 2);
    conversations.set(chatId, history);
    void updateMemoryBackground(chatId, history);
    await sendWithTyping(chatId, clean);
  } catch (err) {
    logger.error({ err }, "Photo analysis failed");
    await bot.sendMessage(chatId, "хм, не смог рассмотреть нормально");
  }
});

// ─── Video handler ───────────────────────────────────────────────────────────

bot.on("video", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.video) return;
  if (msg.from) await trackUser(msg.from);

  if (msg.video.file_size && msg.video.file_size > 45 * 1024 * 1024) {
    await bot.sendMessage(chatId, "видос слишком большой, скинь что-нибудь до 45мб");
    return;
  }

  try {
    await bot.sendChatAction(chatId, "typing");
    const fileLink = await bot.getFileLink(msg.video.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const reply = await analyzeVideo(chatId, buf);
    const clean = await processTagsAndSend(chatId, reply);
    const history = conversations.get(chatId) ?? [];
    history.push({ role: "user", content: "[видео]" });
    history.push({ role: "assistant", content: clean });
    if (history.length > 30) history.splice(0, 2);
    conversations.set(chatId, history);
    void updateMemoryBackground(chatId, history);
    await sendWithTyping(chatId, clean);
  } catch (err) {
    logger.error({ err }, "Video analysis failed");
    await bot.sendMessage(chatId, "не смог посмотреть видос нормально, попробуй другое");
  }
});

// ─── Video note (circles) ────────────────────────────────────────────────────

bot.on("video_note", async (msg) => {
  const chatId = msg.chat.id;
  if (!msg.video_note) return;
  if (msg.from) await trackUser(msg.from);
  try {
    await bot.sendChatAction(chatId, "typing");
    const fileLink = await bot.getFileLink(msg.video_note.file_id);
    const res = await fetch(fileLink);
    const buf = Buffer.from(await res.arrayBuffer());
    const reply = await analyzeVideo(chatId, buf);
    const clean = await processTagsAndSend(chatId, reply);
    await sendWithTyping(chatId, clean);
  } catch (err) {
    logger.error({ err }, "Video note failed");
    await bot.sendMessage(chatId, "кружок не смог посмотреть, попробуй заново");
  }
});

// ─── Message handler ─────────────────────────────────────────────────────────

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;
  if (msg.photo || msg.video || msg.video_note || msg.sticker || msg.voice) return;

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

bot.on("polling_error", (err) => { logger.error({ err }, "Telegram polling error"); });

logger.info("Telegram bot started — full feature set enabled");

export default bot;
