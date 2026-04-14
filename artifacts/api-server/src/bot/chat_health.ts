import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { logger } from "../lib/logger";
import { withRetry } from "./utils/backoff";

// ─── Per-chat sentiment history for health tracking ───────────────────────────

const chatSentimentHistory = new Map<number, number[]>();

export function recordSentimentForHealth(chatId: number, sentiment: number): void {
  const hist = chatSentimentHistory.get(chatId) ?? [];
  hist.push(sentiment);
  if (hist.length > 200) hist.splice(0, hist.length - 200);
  chatSentimentHistory.set(chatId, hist);
}

export function getRecentSentiments(chatId: number): number[] {
  return chatSentimentHistory.get(chatId) ?? [];
}

// ─── DM offended user ─────────────────────────────────────────────────────────
// Sends a private support message to someone who was attacked/insulted in chat.
// Silently no-ops if the user has never started a DM with the bot (Telegram limitation).

export async function dmOffendedUser(
  bot: TelegramBot,
  groq: Groq,
  systemPrompt: string,
  chatTitle: string,
  victimId: number,
  victimName: string,
  attackerName: string,
): Promise<void> {
  try {
    const resp = await withRetry(() => groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: `[Ты пишешь в личку ${victimName}. В чате "${chatTitle}" на них жёстко наехал ${attackerName}. Напиши короткое тёплое слово поддержки — 1-2 предложения, живо и по-человечески, без пафоса. Не говори что ты бот и не упоминай что ты написал "первым" — просто поддержи.]`,
        },
      ],
      max_tokens: 100,
      temperature: 0.85,
    }), { label: "dm offended" });

    const text = resp.choices[0]?.message?.content?.trim();
    if (text) {
      await bot.sendMessage(victimId, text).catch(() => {
        // Silently fail — user may not have started a DM with the bot
      });
    }
  } catch (err) {
    logger.warn({ err }, "DM offended user failed (non-critical)");
  }
}

// ─── DM admins about conflict ─────────────────────────────────────────────────
// Notifies all human group admins privately when a conflict is detected and acted on.

export async function dmAdmins(
  bot: TelegramBot,
  chatId: number,
  chatTitle: string,
  aggressorName: string,
  victimName: string | null,
  action: "mute_30m" | "ban",
): Promise<void> {
  try {
    const admins = await bot.getChatAdministrators(chatId).catch(() => [] as TelegramBot.ChatMember[]);
    const humanAdmins = admins.filter(a => !a.user.is_bot);
    if (!humanAdmins.length) return;

    const actionLabel = action === "ban" ? "🔨 забанен" : "🔇 замучен на 30 минут";
    const victimLine = victimName ? `\n👤 Пострадавший: <b>${victimName}</b>` : "";

    const message = [
      `⚠️ <b>Конфликт в чате</b>`,
      `📍 Чат: <b>${chatTitle}</b>`,
      ``,
      `🔴 Агрессор: <b>${aggressorName}</b> → ${actionLabel}${victimLine}`,
      ``,
      `<i>Сэм автоматически вмешался. Зайди в чат чтобы оценить ситуацию.</i>`,
    ].join("\n");

    for (const admin of humanAdmins) {
      await bot.sendMessage(admin.user.id, message, { parse_mode: "HTML" }).catch(() => {
        // Silently fail if admin hasn't DMed the bot
      });
    }

    logger.info({ chatId, aggressorName, adminsNotified: humanAdmins.length }, "Admins notified of conflict");
  } catch (err) {
    logger.warn({ err }, "DM admins failed (non-critical)");
  }
}

// ─── Chat health report ───────────────────────────────────────────────────────
// Generates a detailed health report: members, admins, atmosphere index.

export async function getChatHealthReport(
  bot: TelegramBot,
  chatId: number,
  recentSentiments: number[],
): Promise<string> {
  try {
    const [memberCount, admins] = await Promise.all([
      bot.getChatMembersCount(chatId).catch(() => 0),
      bot.getChatAdministrators(chatId).catch(() => [] as TelegramBot.ChatMember[]),
    ]);

    const humanAdmins = (admins as TelegramBot.ChatMember[]).filter(a => !a.user.is_bot);

    const last50 = recentSentiments.slice(-50);
    const avgSentiment = last50.length
      ? last50.reduce((a, b) => a + b, 0) / last50.length
      : 0;

    const atmosphereLabel =
      avgSentiment > 0.35 ? "😄 Отличная" :
      avgSentiment > 0.15 ? "😊 Хорошая" :
      avgSentiment > -0.1 ? "😐 Нейтральная" :
      avgSentiment > -0.3 ? "😟 Напряжённая" : "😡 Токсичная";

    const healthScore = Math.min(100, Math.max(0, Math.round(((avgSentiment + 1) / 2) * 100)));
    const filledBars = Math.floor(healthScore / 10);
    const healthBar = "█".repeat(filledBars) + "░".repeat(10 - filledBars);

    const adminList = humanAdmins.length > 0
      ? humanAdmins.map(a => {
          const name = a.user.username ? `@${a.user.username}` : (a.user.first_name ?? "—");
          const role = a.status === "creator" ? " 👑" : "";
          return `• ${name}${role}`;
        }).join("\n")
      : "• нет данных";

    const sampleSize = last50.length;
    const positiveRatio = sampleSize
      ? Math.round((last50.filter(s => s > 0.1).length / sampleSize) * 100)
      : 0;
    const negativeRatio = sampleSize
      ? Math.round((last50.filter(s => s < -0.1).length / sampleSize) * 100)
      : 0;

    return [
      `🏥 <b>Здоровье чата</b>`,
      ``,
      `👥 Участников: <b>${memberCount}</b>`,
      `👑 Администраторов: <b>${humanAdmins.length}</b>`,
      ``,
      `🌡 Атмосфера: ${atmosphereLabel}`,
      `💯 Индекс здоровья: <b>${healthScore}/100</b>`,
      `${healthBar}`,
      ``,
      `📊 На основе <b>${sampleSize}</b> последних сообщений:`,
      `✅ Позитивных: <b>${positiveRatio}%</b>`,
      `❌ Негативных: <b>${negativeRatio}%</b>`,
      ``,
      `<b>Администраторы:</b>`,
      adminList,
    ].join("\n");
  } catch (err) {
    logger.warn({ err }, "Chat health report failed");
    return "не удалось получить данные о здоровье чата";
  }
}
