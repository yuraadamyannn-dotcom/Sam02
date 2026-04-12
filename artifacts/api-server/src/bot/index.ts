import TelegramBot from "node-telegram-bot-api";
import { logger } from "../lib/logger";

const token = process.env["TELEGRAM_BOT_TOKEN"];

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN environment variable is required.");
}

const bot = new TelegramBot(token, { polling: true });

logger.info("Telegram bot started with polling");

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name ?? "there";

  bot.sendMessage(
    chatId,
    `👋 Hello, ${firstName}! I'm your bot.\n\nHere's what I can do:\n• /start — Show this welcome message\n• /help — List available commands\n• Send me any message and I'll echo it back`,
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(
    chatId,
    `📋 Available commands:\n\n/start — Welcome message\n/help — Show this help\n\nYou can also send me any text and I'll echo it back to you.`,
  );
});

bot.on("message", (msg) => {
  if (msg.text?.startsWith("/")) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;

  bot.sendMessage(chatId, `Echo: ${text}`);
});

bot.on("polling_error", (err) => {
  logger.error({ err }, "Telegram polling error");
});

export default bot;
