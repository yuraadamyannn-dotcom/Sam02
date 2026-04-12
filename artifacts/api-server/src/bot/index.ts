import TelegramBot from "node-telegram-bot-api";
import Groq from "groq-sdk";
import { logger } from "../lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required.");

const groqKey = process.env["GROQ_API_KEY"];
if (!groqKey) throw new Error("GROQ_API_KEY is required.");

const bot = new TelegramBot(token, { polling: true });
const groq = new Groq({ apiKey: groqKey });

type Message = { role: "user" | "assistant"; content: string };
const conversations = new Map<number, Message[]>();

const SYSTEM_PROMPT =
  "You are a helpful, concise, and friendly assistant inside a Telegram bot. Keep your responses short and conversational — aim for 1-3 sentences unless more detail is clearly needed.";

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
    "Sorry, I couldn't generate a response.";

  history.push({ role: "assistant", content: reply });

  if (history.length > 20) history.splice(0, 2);
  conversations.set(chatId, history);

  return reply;
}

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name ?? "there";
  conversations.delete(chatId);

  bot.sendMessage(
    chatId,
    `👋 Hi ${firstName}! I'm an AI assistant powered by Groq.\n\nJust send me any message and I'll respond. I remember our conversation as we go.\n\nCommands:\n/start — Restart and clear history\n/help — Show help\n/clear — Clear conversation history`,
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📋 Commands:\n\n/start — Restart the bot and clear history\n/help — Show this message\n/clear — Clear conversation history\n\nOtherwise, just chat with me — I'm powered by Groq AI and remember our conversation context.`,
  );
});

bot.onText(/\/clear/, (msg) => {
  conversations.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, "🧹 Conversation history cleared. Fresh start!");
});

bot.on("message", async (msg) => {
  if (msg.text?.startsWith("/")) return;
  if (!msg.text) return;

  const chatId = msg.chat.id;

  try {
    await bot.sendChatAction(chatId, "typing");
    const reply = await chat(chatId, msg.text);
    await bot.sendMessage(chatId, reply);
  } catch (err) {
    logger.error({ err }, "Groq API error");
    await bot.sendMessage(
      chatId,
      "⚠️ Something went wrong. Please try again.",
    );
  }
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

logger.info("Telegram bot started with polling (Groq AI enabled)");

export default bot;
