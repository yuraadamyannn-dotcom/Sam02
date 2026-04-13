import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { storePayload, getPayload, hasPrefix } from "./callback_store";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackInfo {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  url: string;
  thumbnailUrl?: string;
}

// ─── Binary discovery ─────────────────────────────────────────────────────────

function findBin(name: string): string {
  // 1. Check nix store directly
  try {
    const store = "/nix/store";
    const entries = fs.readdirSync(store);
    for (const e of entries) {
      if (e.toLowerCase().includes(name.toLowerCase().replace("-", ""))) {
        const bin = path.join(store, e, "bin", name);
        try { if (fs.existsSync(bin)) return bin; } catch { /* */ }
      }
    }
  } catch { /* */ }
  // 2. Common system paths
  for (const p of [`/run/current-system/sw/bin/${name}`, `/usr/bin/${name}`]) {
    try { if (fs.existsSync(p)) return p; } catch { /* */ }
  }
  // 3. Fallback — rely on PATH
  return name;
}

const YT_DLP_BIN = findBin("yt-dlp");
const FFMPEG_BIN = (() => {
  // ffmpeg from replit-runtime-path or nix
  const replitPath = "/nix/store/s41bqqrym7dlk8m3nk74fx26kgrx0kv8-replit-runtime-path/bin/ffmpeg";
  if (fs.existsSync(replitPath)) return replitPath;
  return findBin("ffmpeg");
})();

logger.info({ YT_DLP_BIN, FFMPEG_BIN }, "Music: binary paths resolved");

// ─── Search via yt-dlp ────────────────────────────────────────────────────────

export async function searchYouTube(query: string): Promise<TrackInfo | null> {
  try {
    // Use --dump-json for reliable structured output
    const { stdout } = await execFileAsync(
      YT_DLP_BIN,
      [
        `ytsearch1:${query}`,
        "--dump-json",
        "--no-playlist",
        "--no-warnings",
        "--quiet",
      ],
      { timeout: 20_000, env: { ...process.env, PATH: process.env.PATH ?? "" } }
    );

    const line = stdout.trim().split("\n")[0];
    if (!line) return null;

    const info = JSON.parse(line) as {
      id?: string;
      title?: string;
      uploader?: string;
      channel?: string;
      duration?: number;
      thumbnail?: string;
    };

    if (!info.id) return null;

    return {
      videoId: info.id,
      title: info.title ?? query,
      author: info.uploader ?? info.channel ?? "Неизвестный исполнитель",
      durationSec: info.duration ?? 0,
      url: `https://youtu.be/${info.id}`,
      thumbnailUrl: info.thumbnail,
    };
  } catch (err) {
    logger.warn({ err, query }, "yt-dlp search failed");
    return null;
  }
}

// ─── Download audio via yt-dlp + ffmpeg ───────────────────────────────────────

async function downloadAudio(videoId: string): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const outTemplate = path.join(tmpDir, `sam_${stamp}.%(ext)s`);

  const args = [
    `https://youtu.be/${videoId}`,
    "-x",
    "--audio-format", "mp3",
    "--audio-quality", "5",          // ~128 kbps — быстро и достаточно
    "--postprocessor-args", `ffmpeg:-ar 44100`,
    "-o", outTemplate,
    "--no-playlist",
    "--no-warnings",
    "--quiet",
    "--socket-timeout", "30",
    "--retries", "3",
    "--ffmpeg-location", path.dirname(FFMPEG_BIN),
  ];

  try {
    await execFileAsync(YT_DLP_BIN, args, {
      timeout: 180_000,
      env: { ...process.env, PATH: process.env.PATH ?? "" },
    });

    const expectedFile = path.join(tmpDir, `sam_${stamp}.mp3`);
    if (fs.existsSync(expectedFile)) return expectedFile;

    // Fallback scan — yt-dlp sometimes uses a slightly different name
    const allFiles = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith(`sam_${stamp}`) && f.endsWith(".mp3"))
      .map(f => path.join(tmpDir, f));
    allFiles.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return allFiles[0] ?? null;
  } catch (err) {
    logger.warn({ err, videoId }, "yt-dlp download failed");
    return null;
  }
}

// ─── Lyrics — 4 источника ────────────────────────────────────────────────────

export async function fetchLyrics(query: string): Promise<string | null> {
  // Normalize query: "Title Artist" or "Title - Artist"
  const parts = query.trim().split(/\s*[-–—]\s+|\s{2,}/);
  const titlePart = parts[0]?.trim() ?? query;
  const artistPart = parts[1]?.trim() ?? "";

  // 1. lrclib.net — самый надёжный, нет лимитов
  try {
    const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (res.ok) {
      const data = await res.json() as Array<{ plainLyrics?: string; syncedLyrics?: string }>;
      const first = Array.isArray(data) ? data[0] : null;
      const lyrics = first?.plainLyrics ?? first?.syncedLyrics?.replace(/^\[\d+:\d+\.\d+\] /gm, "");
      if (lyrics && lyrics.length > 30) return lyrics.slice(0, 3800);
    }
  } catch { /* fallthrough */ }

  // 2. api.lyrics.ovh с artist + title
  if (artistPart) {
    try {
      const res = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artistPart)}/${encodeURIComponent(titlePart)}`,
        { signal: AbortSignal.timeout(7000) }
      );
      if (res.ok) {
        const data = await res.json() as { lyrics?: string };
        if (data.lyrics && data.lyrics.length > 30) return data.lyrics.slice(0, 3800);
      }
    } catch { /* fallthrough */ }
  }

  // 3. api.lyrics.ovh с query как artist и title
  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(query)}/${encodeURIComponent(titlePart)}`,
      { signal: AbortSignal.timeout(7000) }
    );
    if (res.ok) {
      const data = await res.json() as { lyrics?: string };
      if (data.lyrics && data.lyrics.length > 30) return data.lyrics.slice(0, 3800);
    }
  } catch { /* fallthrough */ }

  // 4. some-random-api
  try {
    const res = await fetch(
      `https://some-random-api.com/lyrics?title=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "SamBot/1.0" }, signal: AbortSignal.timeout(7000) }
    );
    if (res.ok) {
      const data = await res.json() as { lyrics?: string; error?: string };
      if (!data.error && data.lyrics && data.lyrics.length > 30) return data.lyrics.slice(0, 3800);
    }
  } catch { /* fallthrough */ }

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function cleanUp(file: string): void {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ─── Telegram callback_data for lyrics (≤ 64 bytes) ──────────────────────────

/**
 * Создаёт безопасный callback_data для кнопки "Получить текст".
 * Payload (полный запрос) хранится в памяти; callback_data — короткий ключ.
 */
export function makeLyricsCallbackData(title: string, author: string): string {
  const query = `${title} - ${author}`.slice(0, 200);
  return storePayload("lyr", query); // "lyr:abcdefgh" = 12 bytes ✓
}

export { hasPrefix, getPayload };

// ─── Main: download and send audio ───────────────────────────────────────────

export async function downloadAndSendAudio(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  // Keep sending "upload_voice" action while downloading
  const actionInterval = setInterval(() => {
    bot.sendChatAction(chatId, "upload_voice").catch(() => {});
  }, 4500);

  let audioFile: string | null = null;
  try {
    bot.sendChatAction(chatId, "upload_voice").catch(() => {});
    audioFile = await downloadAudio(track.videoId);
    clearInterval(actionInterval);

    const cbData = makeLyricsCallbackData(track.title, track.author);
    const dur = track.durationSec > 0 ? ` • ${formatDuration(track.durationSec)}` : "";
    const caption = `🎵 <b>${escapeHtml(track.title)}</b>\n👤 ${escapeHtml(track.author)}${dur}`;

    if (!audioFile) {
      // Fallback: send link
      await sendMusicLink(bot, chatId, track, cbData, replyToMessageId);
      return;
    }

    await bot.sendAudio(chatId, audioFile, {
      caption,
      parse_mode: "HTML",
      title: track.title,
      performer: track.author,
      duration: track.durationSec || undefined,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: "📜 Получить текст", callback_data: cbData },
        ]],
      },
    } as TelegramBot.SendAudioOptions);

    logger.info({ chatId, title: track.title, file: audioFile }, "Music: audio sent");
  } catch (err) {
    clearInterval(actionInterval);
    logger.error({ err, chatId, videoId: track.videoId }, "downloadAndSendAudio error");
    // Fallback to link on any error
    const cbData = makeLyricsCallbackData(track.title, track.author);
    await sendMusicLink(bot, chatId, track, cbData, replyToMessageId).catch(() => {});
  } finally {
    clearInterval(actionInterval);
    // Guaranteed cleanup — file is always deleted after send
    if (audioFile) {
      cleanUp(audioFile);
      logger.debug({ file: audioFile }, "Music: temp file cleaned up");
    }
  }
}

// ─── Fallback: send link ──────────────────────────────────────────────────────

async function sendMusicLink(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  cbData: string,
  replyToMessageId?: number
): Promise<void> {
  const dur = track.durationSec > 0 ? ` • ${formatDuration(track.durationSec)}` : "";
  const text = [
    `🎵 <b>${escapeHtml(track.title)}</b>`,
    `👤 ${escapeHtml(track.author)}${dur}`,
    ``,
    track.url,
    `<i>(не смог скачать — слушай по ссылке)</i>`,
  ].join("\n");

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_to_message_id: replyToMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: "📜 Получить текст", callback_data: cbData },
        { text: "▶️ YouTube", url: track.url },
      ]],
    },
  });
}

// ─── Lyrics callback ──────────────────────────────────────────────────────────

export async function handleLyricsCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
): Promise<void> {
  const chatId = query.message?.chat.id;
  const data = query.data ?? "";

  // Answer IMMEDIATELY — removes spinner unconditionally
  await bot.answerCallbackQuery(query.id, { text: "🔍 Ищу текст..." }).catch(() => {});

  logger.info({ userId: query.from.id, data }, "Button pressed: lyrics");

  if (!chatId) return;

  // Resolve payload from in-memory store
  const searchQuery = getPayload(data) ?? decodeURIComponent(data.replace(/^ly[rR]:/, ""));
  if (!searchQuery) {
    await bot.sendMessage(chatId, "⏳ Кнопка устарела — попроси трек снова", {
      reply_to_message_id: query.message?.message_id,
    });
    return;
  }

  await bot.sendChatAction(chatId, "typing").catch(() => {});

  const lyrics = await fetchLyrics(searchQuery);
  if (!lyrics) {
    await bot.sendMessage(chatId, "не нашёл текст — возможно его нет в открытом доступе(", {
      reply_to_message_id: query.message?.message_id,
    });
    return;
  }

  // Split into 3800-char chunks
  const CHUNK = 3800;
  for (let i = 0; i < lyrics.length; i += CHUNK) {
    const chunk = lyrics.slice(i, i + CHUNK);
    await bot.sendMessage(chatId, `<pre>${escapeHtml(chunk)}</pre>`, {
      parse_mode: "HTML",
      reply_to_message_id: i === 0 ? query.message?.message_id : undefined,
    });
  }
}

// ─── sendMusicResult (compat) ─────────────────────────────────────────────────

export async function sendMusicResult(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  await downloadAndSendAudio(bot, chatId, track, replyToMessageId);
}
