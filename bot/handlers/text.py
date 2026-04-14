"""Обработка текстовых сообщений с поддержкой translation, summarize, code gen, url analyze."""

import logging
import re
from telegram import Update, Message
from telegram.ext import ContextTypes

from api_manager import APIManager, AllAPIsUnavailable
from utils.cache import cache
from utils.logger import bot_logger

logger = logging.getLogger("sam_bot.text")

TRANSLATE_RE = re.compile(r"^переведи\s+(на\s+)?(\w+)\s*:?\s*(.+)", re.IGNORECASE | re.DOTALL)
SUMMARIZE_RE = re.compile(r"^(краткое?\s+)?изложение|суммаризуй|подведи итог", re.IGNORECASE)
CODE_RE = re.compile(r"^(напиши|создай|сгенерируй)?\s*код\s*(на\s+)?(\w+)?\s*:?\s*(.+)", re.IGNORECASE | re.DOTALL)
URL_RE = re.compile(r"https?://\S+")

SYSTEM_PROMPT = (
    "Ты — Сэм, молодой умный AI-ассистент. "
    "Отвечай лаконично, по делу, на том же языке, на котором написано сообщение. "
    "Не придумывай ничего лишнего."
)


async def handle_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager):
    message: Message = update.effective_message
    text = message.text or ""

    if not text.strip():
        return

    try:
        reply = await _route_text(text, api_manager)
        await message.reply_text(reply, parse_mode="Markdown")
    except AllAPIsUnavailable:
        await message.reply_text(
            "Сервис временно недоступен, попробуйте через минуту. 🙏"
        )
    except Exception as exc:
        logger.error(f"Text handler error: {exc}", exc_info=True)
        await message.reply_text("Произошла ошибка. Попробуйте ещё раз.")


async def _route_text(text: str, api_manager: APIManager) -> str:
    text_stripped = text.strip()

    translate_match = TRANSLATE_RE.match(text_stripped)
    if translate_match:
        lang = translate_match.group(2)
        source = translate_match.group(3)
        cache_key = cache.make_key("translate", lang, source[:200])
        cached = await cache.get(cache_key)
        if cached:
            return cached
        result = await api_manager.translate(source, target_lang=lang)
        await cache.set(cache_key, result)
        return result

    if SUMMARIZE_RE.search(text_stripped):
        lines = text_stripped.split("\n", 1)
        source = lines[1] if len(lines) > 1 else text_stripped
        return await api_manager.summarize(source)

    code_match = CODE_RE.match(text_stripped)
    if code_match:
        lang = code_match.group(3) or "python"
        desc = code_match.group(4)
        return await api_manager.generate_code(desc, language=lang)

    urls = URL_RE.findall(text_stripped)
    if urls and len(text_stripped.split()) <= 3:
        url = urls[0]
        cache_key = cache.make_key("url", url)
        cached = await cache.get(cache_key)
        if cached:
            return cached
        result = await api_manager.analyze_url(url)
        await cache.set(cache_key, result)
        return result

    return await api_manager.generate_content(
        text_stripped,
        system=SYSTEM_PROMPT,
        priority="speed",
    )
