"""Обработка изображений: анализ, OCR, генерация описаний."""

import logging
from typing import Optional

from telegram import Update, PhotoSize
from telegram.ext import ContextTypes

from api_manager import APIManager, AllAPIsUnavailable
from utils.cache import cache
from utils.logger import bot_logger

logger = logging.getLogger("sam_bot.image")

IMAGE_SYSTEM = (
    "Ты — Сэм, умный ассистент с функцией анализа изображений. "
    "Описывай изображения точно и полезно. Отвечай на том же языке, что и вопрос пользователя."
)

DEFAULT_PROMPT = (
    "Опиши это изображение подробно. "
    "Если на изображении есть текст — воспроизведи его дословно. "
    "Укажи: что изображено, цвета, контекст, любой заметный текст или символы."
)


async def handle_image(update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager):
    message = update.effective_message
    photos = message.photo

    if not photos:
        return

    caption = message.caption or ""
    prompt = caption.strip() if caption.strip() else DEFAULT_PROMPT

    processing_msg = await message.reply_text("🔍 Анализирую изображение...")

    try:
        photo: PhotoSize = max(photos, key=lambda p: p.file_size or 0)
        photo_file = await ctx.bot.get_file(photo.file_id)
        image_data: bytes = await photo_file.download_as_bytearray()

        cache_key = cache.make_key("image_analysis", photo.file_unique_id, prompt[:100])
        cached = await cache.get(cache_key)
        if cached:
            await processing_msg.edit_text(cached, parse_mode="Markdown")
            return

        try:
            result = await api_manager.generate_content(
                prompt,
                image=bytes(image_data),
                system=IMAGE_SYSTEM,
                priority="quality",
                use_pro=True,
            )
        except AllAPIsUnavailable:
            await processing_msg.edit_text(
                "Сервис временно недоступен, попробуйте через минуту. 🙏"
            )
            return

        await cache.set(cache_key, result, ttl=3600)
        await processing_msg.edit_text(result, parse_mode="Markdown")

    except Exception as exc:
        logger.error(f"Image handler error: {exc}", exc_info=True)
        await processing_msg.edit_text("Не удалось проанализировать изображение.")


async def handle_document_image(
    update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager
):
    """Обрабатывает документы с изображениями (JPG/PNG как document)."""
    message = update.effective_message
    doc = message.document

    if not doc or not doc.mime_type or not doc.mime_type.startswith("image/"):
        return

    caption = message.caption or ""
    prompt = caption.strip() if caption.strip() else DEFAULT_PROMPT
    processing_msg = await message.reply_text("🔍 Анализирую изображение...")

    try:
        doc_file = await ctx.bot.get_file(doc.file_id)
        image_data: bytes = await doc_file.download_as_bytearray()

        try:
            result = await api_manager.generate_content(
                prompt,
                image=bytes(image_data),
                system=IMAGE_SYSTEM,
                priority="quality",
                use_pro=True,
            )
        except AllAPIsUnavailable:
            await processing_msg.edit_text(
                "Сервис временно недоступен, попробуйте через минуту. 🙏"
            )
            return

        await processing_msg.edit_text(result, parse_mode="Markdown")

    except Exception as exc:
        logger.error(f"Document image handler error: {exc}", exc_info=True)
        await processing_msg.edit_text("Не удалось проанализировать изображение.")
