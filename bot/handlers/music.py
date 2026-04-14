"""Поиск песен по тексту, мелодии или описанию через AI."""

import logging
import re

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

from api_manager import APIManager, AllAPIsUnavailable
from utils.cache import cache
from utils.logger import bot_logger

logger = logging.getLogger("sam_bot.music")

MUSIC_SYSTEM = """Ты — музыкальный эксперт и помощник по распознаванию песен.
Если пользователь описывает песню (текст, мелодия, настроение) — найди её.
Отвечай строго в формате:
🎵 Название: <название>
🎤 Исполнитель: <исполнитель>
📅 Год: <год>
🎼 Альбом: <альбом>
📖 О песне: <краткое описание 1-2 предложения>
🔗 Поиск: https://www.youtube.com/results?search_query=<название+исполнитель>
🎧 Spotify: https://open.spotify.com/search/<название+исполнитель>

Если не уверен — предложи несколько вариантов. Все URL кодируй правильно (пробелы → +).
"""

MUSIC_TRIGGER_RE = re.compile(
    r"(найди\s+песню|что\s+за\s+песня|узнай\s+песню|определи\s+трек|shazam|распознай)",
    re.IGNORECASE,
)


def is_music_request(text: str) -> bool:
    return bool(MUSIC_TRIGGER_RE.search(text))


async def handle_music(update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager):
    message = update.effective_message
    text = message.text or message.caption or ""

    if not text.strip():
        return

    processing_msg = await message.reply_text("🎵 Ищу песню...")

    cache_key = cache.make_key("music_search", text[:300])
    cached = await cache.get(cache_key)
    if cached:
        await processing_msg.edit_text(cached, parse_mode="Markdown", disable_web_page_preview=True)
        return

    try:
        result = await api_manager.generate_content(
            f"Пользователь ищет песню. Вот его запрос:\n{text}",
            system=MUSIC_SYSTEM,
            priority="quality",
            use_pro=True,
        )
        await cache.set(cache_key, result, ttl=7200)
        await processing_msg.edit_text(
            result,
            parse_mode="Markdown",
            disable_web_page_preview=True,
        )
    except AllAPIsUnavailable:
        await processing_msg.edit_text(
            "Сервис временно недоступен, попробуйте через минуту. 🙏"
        )
    except Exception as exc:
        logger.error(f"Music handler error: {exc}", exc_info=True)
        await processing_msg.edit_text("Не удалось найти песню. Попробуйте описать её точнее.")


async def handle_music_command(
    update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager
):
    """/song <запрос> — явный поиск музыки."""
    message = update.effective_message
    args = " ".join(ctx.args) if ctx.args else ""

    if not args:
        await message.reply_text(
            "Используй: `/song <название или описание песни>`\n\n"
            "Например:\n"
            "• `/song Yesterday Beatles`\n"
            "• `/song песня со свистом и женским голосом грустная`\n"
            "• `/song если я тебя придумал значит полюби меня`",
            parse_mode="Markdown",
        )
        return

    ctx_fake = ctx
    update.effective_message._text = args
    await handle_music(update, ctx_fake, api_manager)
