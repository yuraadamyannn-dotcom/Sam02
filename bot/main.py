"""
Сэм Bot — точка входа.
Инициализирует APIManager с failover Gemini↔Grok и регистрирует все хендлеры.
"""

import asyncio
import logging
import signal
import sys

from telegram import Update
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CommandHandler,
    MessageHandler,
    filters,
    ContextTypes,
)

from config import load_config
from api_manager import APIManager
from utils.logger import bot_logger
from utils.cache import cache
from handlers.text import handle_text
from handlers.voice import handle_voice
from handlers.image import handle_image, handle_document_image
from handlers.music import handle_music, handle_music_command, is_music_request

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("sam_bot")

_api_manager: APIManager | None = None


def get_api_manager() -> APIManager:
    assert _api_manager is not None
    return _api_manager


async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.effective_message.reply_text(
        "Привет! Я Сэм 👋\n\n"
        "Отправь мне:\n"
        "• Текстовое сообщение — отвечу на вопрос\n"
        "• Голосовое сообщение — распознаю и отвечу\n"
        "• Фото — опишу что на нём\n"
        "• `/song <запрос>` — найду песню\n"
        "• `/status` — состояние API\n"
        "• `/help` — справка"
    )


async def cmd_help(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await update.effective_message.reply_text(
        "*Что я умею:*\n\n"
        "🗣 *Голосовые сообщения* — отправь войс, я транскрибирую и отвечу\n"
        "🖼 *Изображения* — анализ фото, OCR текста\n"
        "🎵 *Поиск музыки* — `/song <название или описание>`\n"
        "🌍 *Перевод* — «переведи на английский: текст»\n"
        "📝 *Резюме* — «суммаризуй: длинный текст»\n"
        "💻 *Код* — «напиши код на Python: задача»\n"
        "🔗 *Анализ ссылок* — просто отправь URL\n\n"
        "*Примеры:*\n"
        "• переведи на испанский: Привет, как дела?\n"
        "• найди песню: если я тебя придумал\n"
        "• напиши код на javascript: сортировка массива",
        parse_mode="Markdown",
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    am = get_api_manager()
    status = await am.get_status()
    cache_stats = await cache.get_stats()

    lines = ["*Состояние системы:*\n"]
    for api_name, info in status.items():
        emoji = {"healthy": "✅", "degraded": "⚠️", "down": "❌"}.get(info.get("status", ""), "❓")
        configured = "настроен" if info.get("configured") else "не настроен"
        lines.append(
            f"{emoji} *{api_name.capitalize()}* ({configured})\n"
            f"  Статус: `{info.get('status', 'unknown')}`\n"
            f"  Запросов: {info.get('total', 0)} (успешных: {info.get('successful', 0)})\n"
            f"  Успешность: {info.get('success_rate', 0):.0%}\n"
            f"  Среднее время: {info.get('avg_latency_s', 0):.2f}s\n"
        )

    lines.append(
        f"💾 *Кэш*: {cache_stats['active']} записей "
        f"({cache_stats['expired']} устаревших)"
    )
    await update.effective_message.reply_text("\n".join(lines), parse_mode="Markdown")


async def cmd_clear_cache(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    removed = await cache.clear_expired()
    await update.effective_message.reply_text(f"Кэш очищен. Удалено {removed} устаревших записей.")


async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    text = update.effective_message.text or ""
    am = get_api_manager()

    if is_music_request(text):
        await handle_music(update, ctx, am)
    else:
        await handle_text(update, ctx, am)


async def on_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await handle_voice(update, ctx, get_api_manager())


async def on_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await handle_image(update, ctx, get_api_manager())


async def on_document(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    doc = update.effective_message.document
    if doc and doc.mime_type and doc.mime_type.startswith("image/"):
        await handle_document_image(update, ctx, get_api_manager())


async def post_init(app: Application):
    global _api_manager
    config = app.bot_data["config"]

    _api_manager = APIManager(config)
    await _api_manager.start()
    app.bot_data["api_manager"] = _api_manager

    bot_logger.setup(app.bot, config.admin_telegram_id, config.alert_downtime_threshold)
    logger.info("APIManager initialized and started")


async def post_shutdown(app: Application):
    am: APIManager | None = app.bot_data.get("api_manager")
    if am:
        await am.stop()
    logger.info("APIManager stopped")


async def cmd_song(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    await handle_music_command(update, ctx, get_api_manager())


def main():
    config = load_config()

    app = (
        ApplicationBuilder()
        .token(config.telegram_token)
        .post_init(post_init)
        .post_shutdown(post_shutdown)
        .build()
    )
    app.bot_data["config"] = config

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("clearcache", cmd_clear_cache))
    app.add_handler(CommandHandler("song", cmd_song))

    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, on_text))
    app.add_handler(MessageHandler(filters.VOICE | filters.AUDIO, on_voice))
    app.add_handler(MessageHandler(filters.PHOTO, on_photo))
    app.add_handler(MessageHandler(filters.Document.ALL, on_document))

    logger.info("Starting Sam bot (polling mode)...")

    app.run_polling(
        allowed_updates=Update.ALL_TYPES,
        drop_pending_updates=True,
    )


if __name__ == "__main__":
    main()
