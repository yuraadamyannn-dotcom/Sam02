import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";
import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const execFileAsync = promisify(execFile);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrackInfo {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  url: string;
}

// ─── yt-dlp binary ───────────────────────────────────────────────────────────

// Absolute path to yt-dlp as installed by Nix — avoids PATH lookup issues
// inside the Node.js child process. Falls back to "yt-dlp" if not found.
const YT_DLP_BIN = (() => {
  const nixPath = "/nix/var/nix/profiles/default/bin/yt-dlp";
  const nixRunPath = "/run/current-system/sw/bin/yt-dlp";
  for (const p of [nixPath, nixRunPath]) {
    try { if (fs.existsSync(p)) return p; } catch { /* */ }
  }
  // Scan nix store for yt-dlp binary
  try {
    const store = "/nix/store";
    const entries = fs.readdirSync(store);
    for (const e of entries) {
      if (e.includes("yt-dlp")) {
        const bin = path.join(store, e, "bin", "yt-dlp");
        if (fs.existsSync(bin)) return bin;
      }
    }
  } catch { /* */ }
  return "yt-dlp";
})();

// ─── Search via yt-dlp ────────────────────────────────────────────────────────

export async function searchYouTube(query: string): Promise<TrackInfo | null> {
  try {
    const { stdout } = await execFileAsync(
      YT_DLP_BIN,
      [
        `ytsearch1:${query}`,
        "--print", "%(id)s\n%(title)s\n%(uploader)s\n%(duration)s",
        "--no-playlist",
        "--default-search", "ytsearch",
        "--no-warnings",
        "--quiet",
      ],
      { timeout: 20_000 }
    );
    const lines = stdout.trim().split("\n");
    if (lines.length < 2) return null;
    const [videoId, title, author, durationStr] = lines;
    if (!videoId || videoId.length < 5) return null;
    return {
      videoId: videoId.trim(),
      title: (title ?? query).trim(),
      author: (author ?? "Неизвестный исполнитель").trim(),
      durationSec: parseInt(durationStr ?? "0", 10) || 0,
      url: `https://youtu.be/${videoId.trim()}`,
    };
  } catch (err) {
    logger.warn({ err, query }, "yt-dlp search failed");
    return null;
  }
}

// ─── Download audio via yt-dlp ────────────────────────────────────────────────

async function downloadAudio(videoId: string): Promise<string | null> {
  const tmpDir = os.tmpdir();
  const outTemplate = path.join(tmpDir, `sam_music_${Date.now()}_%(id)s.%(ext)s`);

  try {
    await execFileAsync(
      YT_DLP_BIN,
      [
        `https://youtu.be/${videoId}`,
        "-x",
        "--audio-format", "mp3",
        "--audio-quality", "5",           // 0=best, 9=worst — 5 is ~128kbps, fast
        "-o", outTemplate,
        "--no-playlist",
        "--no-warnings",
        "--quiet",
        "--socket-timeout", "30",
        "--retries", "3",
      ],
      { timeout: 120_000 }
    );

    // Find the downloaded file
    const expectedFile = outTemplate
      .replace("%(id)s", videoId)
      .replace("%(ext)s", "mp3");

    if (fs.existsSync(expectedFile)) return expectedFile;

    // Fallback: scan tmpDir for the file (yt-dlp may rename slightly)
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith("sam_music_") && f.endsWith(".mp3"))
      .map(f => path.join(tmpDir, f));
    files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch (err) {
    logger.warn({ err, videoId }, "yt-dlp download failed");
    return null;
  }
}

// ─── Lyrics API ──────────────────────────────────────────────────────────────

export async function fetchLyrics(query: string): Promise<string | null> {
  // Try to split query into artist + title if it looks like "Title Artist"
  const parts = query.split(/\s{2,}|\s*[-–—]\s*/);
  const title = parts[0]?.trim() ?? query;
  const artist = parts[1]?.trim() ?? "";

  // 1. lyrics.ovh — free, no key required
  if (artist) {
    try {
      const res = await fetch(
        `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
        { signal: AbortSignal.timeout(8000) }
      );
      if (res.ok) {
        const data = await res.json() as { lyrics?: string };
        if (data.lyrics && data.lyrics.length > 20) {
          return data.lyrics.slice(0, 3800);
        }
      }
    } catch { /* fallthrough */ }
  }

  // 2. lyrics.ovh with full query as title, empty artist
  try {
    const res = await fetch(
      `https://api.lyrics.ovh/v1/${encodeURIComponent(query)}/${encodeURIComponent(title)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as { lyrics?: string };
      if (data.lyrics && data.lyrics.length > 20) {
        return data.lyrics.slice(0, 3800);
      }
    }
  } catch { /* fallthrough */ }

  // 3. some-random-api fallback
  try {
    const res = await fetch(
      `https://some-random-api.com/lyrics?title=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "SamBot/1.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as { lyrics?: string; error?: string };
      if (!data.error && data.lyrics && data.lyrics.length > 20) {
        return data.lyrics.slice(0, 3800);
      }
    }
  } catch { /* fallthrough */ }

  // 4. lrclib — free, no key
  try {
    const res = await fetch(
      `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = await res.json() as Array<{ plainLyrics?: string; syncedLyrics?: string }>;
      const first = Array.isArray(data) ? data[0] : null;
      const lyrics = first?.plainLyrics ?? first?.syncedLyrics;
      if (lyrics && lyrics.length > 20) return lyrics.slice(0, 3800);
    }
  } catch { /* fallthrough */ }

  return null;
}

// ─── Format helpers ───────────────────────────────────────────────────────────

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function cleanUp(file: string) {
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch { /* ignore */ }
}

// ─── Main: download and send audio ───────────────────────────────────────────

export async function downloadAndSendAudio(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  // Send "uploading audio" action
  const actionInterval = setInterval(() => {
    bot.sendChatAction(chatId, "upload_voice").catch(() => {});
  }, 4000);

  let audioFile: string | null = null;
  try {
    await bot.sendChatAction(chatId, "upload_voice").catch(() => {});
    audioFile = await downloadAudio(track.videoId);

    clearInterval(actionInterval);

    if (!audioFile) {
      // Fallback: send link with buttons if download failed
      await sendMusicLink(bot, chatId, track, replyToMessageId);
      return;
    }

    const dur = track.durationSec > 0 ? ` • ${formatDuration(track.durationSec)}` : "";
    const caption = `🎵 <b>${escapeHtml(track.title)}</b>\n👤 ${escapeHtml(track.author)}${dur}`;

    const lyricsData = `lyrics:${encodeURIComponent((track.title + " " + track.author).slice(0, 180))}`;

    await bot.sendAudio(chatId, audioFile, {
      caption,
      parse_mode: "HTML",
      title: track.title,
      performer: track.author,
      duration: track.durationSec || undefined,
      reply_to_message_id: replyToMessageId,
      reply_markup: {
        inline_keyboard: [[
          { text: "📜 Получить текст", callback_data: lyricsData },
        ]],
      },
    } as TelegramBot.SendAudioOptions);
  } catch (err) {
    clearInterval(actionInterval);
    logger.error({ err, chatId, track: track.videoId }, "downloadAndSendAudio failed");
    // Fallback to link
    await sendMusicLink(bot, chatId, track, replyToMessageId).catch(() => {});
  } finally {
    clearInterval(actionInterval);
    if (audioFile) cleanUp(audioFile);
  }
}

// ─── Fallback: send link if download fails ───────────────────────────────────

async function sendMusicLink(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  const dur = track.durationSec > 0 ? ` • ${formatDuration(track.durationSec)}` : "";
  const text = `🎵 <b>${escapeHtml(track.title)}</b>\n👤 ${escapeHtml(track.author)}${dur}\n\n${track.url}\n\n<i>(не смог скачать — слушай по ссылке)</i>`;
  const lyricsData = `lyrics:${encodeURIComponent((track.title + " " + track.author).slice(0, 180))}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_to_message_id: replyToMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: "📜 Получить текст", callback_data: lyricsData },
        { text: "▶️ Открыть", url: track.url },
      ]],
    },
  });
}

// ─── sendMusicResult (kept for compatibility) ─────────────────────────────────

export async function sendMusicResult(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  await downloadAndSendAudio(bot, chatId, track, replyToMessageId);
}

// ─── Lyrics callback handler ──────────────────────────────────────────────────

export async function handleLyricsCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
): Promise<void> {
  const chatId = query.message?.chat.id;

  // Answer IMMEDIATELY to remove spinner
  await bot.answerCallbackQuery(query.id, { text: "🔍 Ищу текст..." }).catch(() => {});

  if (!chatId) return;

  const rawQuery = query.data?.replace(/^lyrics:/, "") ?? "";
  const searchQuery = decodeURIComponent(rawQuery);

  // Show typing
  await bot.sendChatAction(chatId, "typing").catch(() => {});

  const lyrics = await fetchLyrics(searchQuery);
  if (!lyrics) {
    await bot.sendMessage(chatId, "не нашёл текст, сорри(", {
      reply_to_message_id: query.message?.message_id,
    });
    return;
  }

  // Split into 3800-char chunks to respect Telegram limit
  const chunks: string[] = [];
  for (let i = 0; i < lyrics.length; i += 3800) {
    chunks.push(lyrics.slice(i, i + 3800));
  }

  for (let i = 0; i < chunks.length; i++) {
    await bot.sendMessage(chatId, `<pre>${escapeHtml(chunks[i]!)}</pre>`, {
      parse_mode: "HTML",
      reply_to_message_id: i === 0 ? query.message?.message_id : undefined,
    });
  }
}

// ─── HTML escaping ────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
