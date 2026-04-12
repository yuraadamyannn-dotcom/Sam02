import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const INVIDIOUS_INSTANCES = [
  "https://inv.nadeko.net",
  "https://invidious.fdn.fr",
  "https://invidious.privacyredirect.com",
];

export interface TrackInfo {
  videoId: string;
  title: string;
  author: string;
  durationSec: number;
  url: string;
}

export async function searchYouTube(query: string): Promise<TrackInfo | null> {
  for (const instance of INVIDIOUS_INSTANCES) {
    try {
      const res = await fetch(
        `${instance}/api/v1/search?q=${encodeURIComponent(query)}&type=video&fields=videoId,title,author,lengthSeconds`,
        { headers: { "User-Agent": "SamBot/1.0" }, signal: AbortSignal.timeout(6000) }
      );
      if (!res.ok) continue;
      const data = await res.json() as Array<{ videoId?: string; title?: string; author?: string; lengthSeconds?: number; type?: string }>;
      const videos = Array.isArray(data) ? data.filter(v => v.type === "video" || v.videoId) : [];
      const first = videos[0];
      if (first?.videoId) {
        return {
          videoId: first.videoId,
          title: first.title ?? query,
          author: first.author ?? "Неизвестный исполнитель",
          durationSec: first.lengthSeconds ?? 0,
          url: `https://youtu.be/${first.videoId}`,
        };
      }
    } catch (err) {
      logger.warn({ err, instance }, "Invidious search failed, trying next");
    }
  }
  return null;
}

export async function fetchLyrics(query: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://some-random-api.com/lyrics?title=${encodeURIComponent(query)}`,
      { headers: { "User-Agent": "SamBot/1.0" }, signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json() as { lyrics?: string; error?: string };
    if (data.error || !data.lyrics) return null;
    return data.lyrics.slice(0, 3800);
  } catch {
    return null;
  }
}

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export async function sendMusicResult(
  bot: TelegramBot,
  chatId: number,
  track: TrackInfo,
  replyToMessageId?: number
): Promise<void> {
  const dur = track.durationSec > 0 ? ` • ${formatDuration(track.durationSec)}` : "";
  const text = `🎵 <b>${track.title}</b>\n👤 ${track.author}${dur}\n\n${track.url}`;

  await bot.sendMessage(chatId, text, {
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_to_message_id: replyToMessageId,
    reply_markup: {
      inline_keyboard: [[
        { text: "📝 Текст песни", callback_data: `lyrics:${encodeURIComponent(track.title + " " + track.author).slice(0, 200)}` },
        { text: "▶️ Открыть", url: track.url },
      ]],
    },
  });
}

export async function handleLyricsCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
): Promise<void> {
  const chatId = query.message?.chat.id;
  if (!chatId) { await bot.answerCallbackQuery(query.id); return; }

  const rawQuery = query.data?.replace(/^lyrics:/, "") ?? "";
  const searchQuery = decodeURIComponent(rawQuery);

  await bot.answerCallbackQuery(query.id, { text: "Ищу текст..." });

  const lyrics = await fetchLyrics(searchQuery);
  if (!lyrics) {
    await bot.sendMessage(chatId, "не нашёл текст, сорри(", { reply_to_message_id: query.message?.message_id });
    return;
  }

  const chunks: string[] = [];
  for (let i = 0; i < lyrics.length; i += 3800) {
    chunks.push(lyrics.slice(i, i + 3800));
  }

  for (const chunk of chunks) {
    await bot.sendMessage(chatId, `<pre>${chunk}</pre>`, {
      parse_mode: "HTML",
      reply_to_message_id: chunks.indexOf(chunk) === 0 ? query.message?.message_id : undefined,
    });
  }
}
