"""Обработка голосовых сообщений: STT → AI ответ → TTS."""

import logging
import os
import tempfile
import asyncio
import subprocess
from typing import Optional

from telegram import Update, Voice, Audio
from telegram.ext import ContextTypes

from api_manager import APIManager, AllAPIsUnavailable
from utils.logger import bot_logger

logger = logging.getLogger("sam_bot.voice")

VOICE_SYSTEM = (
    "Ты — Сэм, дружелюбный ассистент. Пользователь отправил голосовое сообщение. "
    "Ответь кратко и по делу. Ответ будет озвучен, поэтому не используй markdown, "
    "списки и специальные символы."
)


async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE, api_manager: APIManager):
    message = update.effective_message
    voice: Optional[Voice] = message.voice or message.audio

    if not voice:
        return

    processing_msg = await message.reply_text("🎙 Слушаю...")

    try:
        voice_file = await ctx.bot.get_file(voice.file_id)
        voice_data = await voice_file.download_as_bytearray()

        ogg_bytes = await _convert_to_ogg(bytes(voice_data))

        try:
            transcription = await api_manager.speech_to_text(ogg_bytes, mime_type="audio/ogg")
        except Exception as exc:
            logger.error(f"STT failed: {exc}")
            await processing_msg.edit_text("Не смог распознать голосовое сообщение. 😔")
            return

        if not transcription.strip():
            await processing_msg.edit_text("Не разобрал речь, попробуй ещё раз.")
            return

        await processing_msg.edit_text(f"📝 *Распознано:* _{transcription}_", parse_mode="Markdown")

        try:
            ai_response = await api_manager.generate_content(
                transcription,
                system=VOICE_SYSTEM,
                priority="speed",
            )
        except AllAPIsUnavailable:
            await message.reply_text("Сервис временно недоступен, попробуйте через минуту. 🙏")
            return

        await message.reply_text(ai_response)

        tts_audio = await _tts(ai_response)
        if tts_audio:
            await message.reply_voice(voice=tts_audio)

    except Exception as exc:
        logger.error(f"Voice handler error: {exc}", exc_info=True)
        await processing_msg.edit_text("Произошла ошибка при обработке голосового сообщения.")


async def _convert_to_ogg(data: bytes) -> bytes:
    """Конвертирует аудио в OGG/Opus для совместимости с Gemini STT."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _convert_sync, data)


def _convert_sync(data: bytes) -> bytes:
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as inp:
        inp.write(data)
        inp_path = inp.name

    out_path = inp_path + ".ogg"
    try:
        result = subprocess.run(
            ["ffmpeg", "-y", "-i", inp_path, "-c:a", "libopus", "-b:a", "24k", out_path],
            capture_output=True, timeout=30
        )
        if result.returncode == 0 and os.path.exists(out_path):
            with open(out_path, "rb") as f:
                return f.read()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    finally:
        for p in (inp_path, out_path):
            if os.path.exists(p):
                os.unlink(p)

    return data


async def _tts(text: str) -> Optional[bytes]:
    """Синтез речи через gTTS (fallback; ElevenLabs можно добавить при наличии ключа)."""
    loop = asyncio.get_event_loop()
    try:
        return await loop.run_in_executor(None, _gtts_sync, text)
    except Exception as exc:
        logger.warning(f"TTS failed: {exc}")
        return None


def _gtts_sync(text: str) -> Optional[bytes]:
    try:
        from gtts import gTTS
        import io
        tts = gTTS(text=text[:500], lang="ru", slow=False)
        buf = io.BytesIO()
        tts.write_to_fp(buf)
        buf.seek(0)
        return buf.read()
    except Exception as exc:
        logger.warning(f"gTTS error: {exc}")
        return None
