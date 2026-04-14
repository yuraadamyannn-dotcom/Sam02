import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { logger } from "../lib/logger";
import { withRetry } from "./utils/backoff";
import { recordBotActivity } from "./group_guard";

// ─── Static interactive content ───────────────────────────────────────────────

const POLLS: { question: string; options: string[] }[] = [
  { question: "Что круче?", options: ["Аниме", "Дорамы", "Западные сериалы", "Кино"] },
  { question: "Ваш хайп прямо сейчас?", options: ["Музыка", "Игры", "Соцсети", "Учёба/работа"] },
  { question: "Лучшее время суток?", options: ["Утро", "День", "Вечер", "Глубокая ночь"] },
  { question: "Кто ты?", options: ["Чистый интроверт", "Чистый экстраверт", "Зависит от настроения", "Социопат в хорошем смысле"] },
  { question: "Как общаешься чаще всего?", options: ["Голосовые", "Текстом", "Стикерами", "Мемами"] },
  { question: "Что не можешь без телефона?", options: ["Музыка", "Соцсети", "Мессенджеры", "Вполне могу"] },
  { question: "Твой режим?", options: ["Сова 🦉", "Жаворонок 🐦", "Без режима"] },
  { question: "Что важнее в человеке?", options: ["Честность", "Юмор", "Верность", "Ум"] },
];

const WOULD_YOU_RATHER: { question: string; options: string[] }[] = [
  { question: "Что бы вы выбрали?", options: ["Всегда знать правду", "Слышать только то, что хочешь"] },
  { question: "Что бы вы выбрали?", options: ["Читать мысли", "Становиться невидимым"] },
  { question: "Что бы вы выбрали?", options: ["Жить в прошлом", "Жить в будущем"] },
  { question: "Что бы вы выбрали?", options: ["Никогда не спать", "Никогда не есть"] },
  { question: "Что бы вы выбрали?", options: ["Уметь летать", "Уметь дышать под водой"] },
  { question: "Что бы вы выбрали?", options: ["Знать дату своей смерти", "Не знать никогда"] },
];

const WORD_STARTERS: string[] = [
  "Ассоциации — я начинаю: «небо». Кто следующий?",
  "Игра — каждый пишет слово на последнюю букву предыдущего. Начинаю: «апельсин»",
  "Закончи историю одним предложением: «Он открыл дверь и увидел...»",
  "Одним словом опиши своё сегодняшнее настроение",
  "Напиши первое слово, которое пришло в голову",
  "Ассоциация с зимой — одним словом. Поехали",
  "Назови любимый фильм — но только одним прилагательным, без названия. Остальные угадывают",
  "Что первое приходит в голову, когда слышишь «Россия»?",
];

type InteractiveKind = "poll" | "would_you_rather" | "word_game" | "trivia";

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function startRandomInteractive(
  bot: TelegramBot,
  groq: Groq,
  systemPrompt: string,
  chatId: number,
): Promise<boolean> {
  // Weighted random: polls & word games are lightweight; trivia requires Groq call
  const weights: [InteractiveKind, number][] = [
    ["poll", 30],
    ["would_you_rather", 25],
    ["word_game", 25],
    ["trivia", 20],
  ];

  const totalWeight = weights.reduce((s, [, w]) => s + w, 0);
  let roll = Math.random() * totalWeight;
  let kind: InteractiveKind = "poll";
  for (const [k, w] of weights) {
    roll -= w;
    if (roll <= 0) { kind = k; break; }
  }

  try {
    switch (kind) {
      case "poll": {
        const item = POLLS[Math.floor(Math.random() * POLLS.length)]!;
        await bot.sendPoll(chatId, item.question, item.options, { is_anonymous: false });
        recordBotActivity(chatId);
        return true;
      }

      case "would_you_rather": {
        const item = WOULD_YOU_RATHER[Math.floor(Math.random() * WOULD_YOU_RATHER.length)]!;
        await bot.sendPoll(chatId, item.question, item.options, { is_anonymous: false });
        recordBotActivity(chatId);
        return true;
      }

      case "word_game": {
        const text = WORD_STARTERS[Math.floor(Math.random() * WORD_STARTERS.length)]!;
        await bot.sendMessage(chatId, text);
        recordBotActivity(chatId);
        return true;
      }

      case "trivia": {
        const resp = await withRetry(() => groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: `[Задай чату один короткий интересный вопрос-угадайку. Тема на выбор: аниме, игры, музыка, интересный факт, история, наука. Вопрос без ответа — пусть угадывают в комментариях. Максимум 2 предложения.]`,
            },
          ],
          max_tokens: 80,
          temperature: 1.0,
        }), { label: "trivia" });

        const text = resp.choices[0]?.message?.content?.trim();
        if (text) {
          await bot.sendMessage(chatId, text);
          recordBotActivity(chatId);
          return true;
        }
        return false;
      }
    }
  } catch (err) {
    logger.warn({ err, kind }, "Interactive failed (non-critical)");
    return false;
  }
}
