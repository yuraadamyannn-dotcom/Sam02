"""
APIManager — интеллектуальный failover между Gemini API и Grok API.
Реализует: circuit breaker, health checks, smart routing, retry logic.
"""

import asyncio
import time
import random
import logging
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Any, Literal

import google.generativeai as genai
from openai import AsyncOpenAI, RateLimitError, APIStatusError, APITimeoutError, APIConnectionError

from config import Config
from utils.logger import bot_logger
from utils.retry import retry_async, with_timeout

logger = logging.getLogger("sam_bot.api_manager")


class APIStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    DOWN = "down"


class AllAPIsUnavailable(Exception):
    pass


@dataclass
class CircuitBreaker:
    name: str
    threshold: int = 3
    timeout: int = 60

    _failures: int = field(default=0, init=False)
    _last_failure_time: float = field(default=0.0, init=False)
    _opened_at: Optional[float] = field(default=None, init=False)
    _status: APIStatus = field(default=APIStatus.HEALTHY, init=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, init=False)

    async def record_success(self):
        async with self._lock:
            self._failures = 0
            if self._status != APIStatus.HEALTHY:
                bot_logger.log_circuit_breaker(self.name, "RECOVERED → healthy")
                await bot_logger.notify_downtime_end(self.name)
            self._status = APIStatus.HEALTHY
            self._opened_at = None

    async def record_failure(self):
        async with self._lock:
            self._failures += 1
            self._last_failure_time = time.time()
            bot_logger.log_circuit_breaker(
                self.name, f"failure #{self._failures}/{self.threshold}"
            )
            if self._failures >= self.threshold:
                if self._status != APIStatus.DOWN:
                    self._opened_at = time.time()
                    bot_logger.log_circuit_breaker(
                        self.name, f"OPENED — blocked for {self.timeout}s"
                    )
                    await bot_logger.notify_downtime_start(self.name)
                self._status = APIStatus.DOWN
            elif self._failures >= max(1, self.threshold - 1):
                self._status = APIStatus.DEGRADED

    async def is_available(self) -> bool:
        async with self._lock:
            if self._status == APIStatus.HEALTHY:
                return True
            if self._status == APIStatus.DOWN and self._opened_at:
                if (time.time() - self._opened_at) >= self.timeout:
                    self._status = APIStatus.DEGRADED
                    self._failures = max(0, self._failures - 1)
                    bot_logger.log_circuit_breaker(self.name, "half-open — testing")
                    return True
                return False
            return True

    @property
    def status(self) -> APIStatus:
        return self._status

    def get_stats(self) -> dict:
        return {
            "name": self.name,
            "status": self._status.value,
            "failures": self._failures,
            "opened_at": self._opened_at,
        }


@dataclass
class APIMetrics:
    name: str
    _total_requests: int = field(default=0, init=False)
    _successful_requests: int = field(default=0, init=False)
    _total_latency: float = field(default=0.0, init=False)
    _last_used: float = field(default=0.0, init=False)

    def record(self, elapsed: float, success: bool):
        self._total_requests += 1
        self._last_used = time.time()
        if success:
            self._successful_requests += 1
            self._total_latency += elapsed

    @property
    def avg_latency(self) -> float:
        if self._successful_requests == 0:
            return float("inf")
        return self._total_latency / self._successful_requests

    @property
    def success_rate(self) -> float:
        if self._total_requests == 0:
            return 1.0
        return self._successful_requests / self._total_requests

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "total": self._total_requests,
            "successful": self._successful_requests,
            "success_rate": round(self.success_rate, 3),
            "avg_latency_s": round(self.avg_latency, 3),
            "last_used": self._last_used,
        }


class APIManager:
    """
    Управляет двумя AI API с автоматическим failover.
    Приоритет: Gemini (основной) → Grok (резервный).
    Умная маршрутизация по типу задачи и скорости ответа.
    """

    GROK_RETRIABLE = (RateLimitError, APITimeoutError, APIConnectionError)
    GEMINI_RETRIABLE = (Exception,)

    def __init__(self, config: Config):
        self.config = config

        self._gemini_cb = CircuitBreaker(
            "Gemini",
            threshold=config.circuit_breaker_threshold,
            timeout=config.circuit_breaker_timeout,
        )
        self._grok_cb = CircuitBreaker(
            "Grok",
            threshold=config.circuit_breaker_threshold,
            timeout=config.circuit_breaker_timeout,
        )

        self._gemini_metrics = APIMetrics("Gemini")
        self._grok_metrics = APIMetrics("Grok")

        self._gemini_client: Optional[Any] = None
        self._grok_client: Optional[AsyncOpenAI] = None

        self._health_task: Optional[asyncio.Task] = None
        self._alert_task: Optional[asyncio.Task] = None

        self._setup_clients()

    def _setup_clients(self):
        if self.config.gemini_api_key:
            genai.configure(api_key=self.config.gemini_api_key)
            logger.info("Gemini client configured")
        else:
            logger.warning("GEMINI_API_KEY not set — Gemini disabled")

        if self.config.grok_api_key:
            self._grok_client = AsyncOpenAI(
                api_key=self.config.grok_api_key,
                base_url=self.config.grok_base_url,
            )
            logger.info("Grok client configured")
        else:
            logger.warning("GROK_API_KEY not set — Grok disabled")

    async def start(self):
        self._health_task = asyncio.create_task(self._health_loop())
        self._alert_task = asyncio.create_task(self._alert_loop())
        logger.info("APIManager started (health check every %ds)", self.config.health_check_interval)

    async def stop(self):
        if self._health_task:
            self._health_task.cancel()
        if self._alert_task:
            self._alert_task.cancel()

    def _choose_primary(
        self, priority: Literal["speed", "quality", "auto"] = "auto"
    ) -> list[str]:
        """
        Умная маршрутизация:
        - quality → Gemini Pro сначала
        - speed   → тот, кто быстрее по avg latency
        - auto    → Gemini основной, 30% шанс на Grok для балансировки
        """
        if priority == "quality":
            return ["gemini", "grok"]
        if priority == "speed":
            if self._gemini_metrics.avg_latency <= self._grok_metrics.avg_latency:
                return ["gemini", "grok"]
            return ["grok", "gemini"]
        if random.random() < 0.30:
            return ["grok", "gemini"]
        return ["gemini", "grok"]

    async def generate_content(
        self,
        prompt: str,
        *,
        image: Optional[bytes] = None,
        audio: Optional[bytes] = None,
        system: Optional[str] = None,
        priority: Literal["speed", "quality", "auto"] = "auto",
        use_pro: bool = False,
    ) -> str:
        order = self._choose_primary(priority)
        last_error: Exception = AllAPIsUnavailable("No APIs configured")

        for api_name in order:
            if api_name == "gemini" and not self.config.gemini_api_key:
                continue
            if api_name == "grok" and not self.config.grok_api_key:
                continue

            cb = self._gemini_cb if api_name == "gemini" else self._grok_cb
            if not await cb.is_available():
                logger.debug(f"{api_name} circuit breaker open, skipping")
                continue

            try:
                start = time.monotonic()
                if api_name == "gemini":
                    result = await with_timeout(
                        self._gemini_generate(prompt, image=image, audio=audio, system=system, use_pro=use_pro),
                        self.config.request_timeout,
                    )
                else:
                    result = await with_timeout(
                        self._grok_generate(prompt, image=image, system=system),
                        self.config.request_timeout,
                    )
                elapsed = time.monotonic() - start

                if not result or not result.strip():
                    raise ValueError(f"{api_name} returned empty response")

                await cb.record_success()
                metrics = self._gemini_metrics if api_name == "gemini" else self._grok_metrics
                metrics.record(elapsed, True)
                bot_logger.log_api_metric(api_name, elapsed, True)
                return result

            except Exception as exc:
                elapsed = time.monotonic() - start
                await cb.record_failure()
                metrics = self._gemini_metrics if api_name == "gemini" else self._grok_metrics
                metrics.record(elapsed, False)
                bot_logger.log_api_metric(api_name, elapsed, False)
                last_error = exc

                next_api = [a for a in order if a != api_name]
                if next_api:
                    bot_logger.log_api_switch(api_name, next_api[0], str(exc)[:100])

        raise AllAPIsUnavailable(f"All APIs failed: {last_error}") from last_error

    async def _gemini_generate(
        self,
        prompt: str,
        *,
        image: Optional[bytes] = None,
        audio: Optional[bytes] = None,
        system: Optional[str] = None,
        use_pro: bool = False,
    ) -> str:
        model_name = self.config.gemini_model_pro if use_pro else self.config.gemini_model_fast
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system,
        )

        parts: list[Any] = []
        if image:
            parts.append({"mime_type": "image/jpeg", "data": image})
        if audio:
            parts.append({"mime_type": "audio/ogg", "data": audio})
        parts.append(prompt)

        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(
            None, lambda: model.generate_content(parts)
        )
        text = response.text
        if not text:
            raise ValueError("Gemini returned empty text")
        return text.strip()

    async def _grok_generate(
        self,
        prompt: str,
        *,
        image: Optional[bytes] = None,
        system: Optional[str] = None,
    ) -> str:
        if not self._grok_client:
            raise RuntimeError("Grok client not initialised")

        messages: list[dict] = []
        if system:
            messages.append({"role": "system", "content": system})

        if image:
            import base64
            b64_image = base64.b64encode(image).decode()
            messages.append({
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64_image}"}},
                    {"type": "text", "text": prompt},
                ],
            })
        else:
            messages.append({"role": "user", "content": prompt})

        response = await self._grok_client.chat.completions.create(
            model=self.config.grok_model,
            messages=messages,
            timeout=self.config.request_timeout,
        )
        text = response.choices[0].message.content
        if not text:
            raise ValueError("Grok returned empty response")
        return text.strip()

    async def speech_to_text(self, audio_data: bytes, mime_type: str = "audio/ogg") -> str:
        """STT через Gemini (мультимодальный), fallback — Groq Whisper."""
        if self.config.gemini_api_key and await self._gemini_cb.is_available():
            try:
                result = await with_timeout(
                    self._gemini_stt(audio_data, mime_type),
                    self.config.request_timeout,
                )
                if result:
                    await self._gemini_cb.record_success()
                    return result
            except Exception as exc:
                await self._gemini_cb.record_failure()
                logger.warning(f"Gemini STT failed: {exc}, falling back to Groq")

        return await self._groq_whisper_stt(audio_data)

    async def _gemini_stt(self, audio_data: bytes, mime_type: str) -> str:
        model = genai.GenerativeModel(self.config.gemini_model_fast)
        parts = [
            {"mime_type": mime_type, "data": audio_data},
            "Transcribe this audio to text. Return only the transcription, no commentary.",
        ]
        loop = asyncio.get_event_loop()
        response = await loop.run_in_executor(None, lambda: model.generate_content(parts))
        return response.text.strip()

    async def _groq_whisper_stt(self, audio_data: bytes) -> str:
        if not self.config.groq_api_key:
            raise AllAPIsUnavailable("No STT API available (no GROQ_API_KEY)")
        import tempfile, os
        from groq import AsyncGroq
        groq_client = AsyncGroq(api_key=self.config.groq_api_key)
        with tempfile.NamedTemporaryFile(suffix=".ogg", delete=False) as f:
            f.write(audio_data)
            tmp_path = f.name
        try:
            with open(tmp_path, "rb") as f:
                transcription = await groq_client.audio.transcriptions.create(
                    model="whisper-large-v3",
                    file=("audio.ogg", f, "audio/ogg"),
                )
            return transcription.text.strip()
        finally:
            os.unlink(tmp_path)

    async def translate(self, text: str, target_lang: str = "ru") -> str:
        return await self.generate_content(
            f"Translate the following text to {target_lang}. Return only the translation:\n\n{text}",
            priority="speed",
        )

    async def summarize(self, text: str) -> str:
        return await self.generate_content(
            f"Summarize this text concisely in the same language:\n\n{text}",
            priority="speed",
        )

    async def analyze_url(self, url: str) -> str:
        return await self.generate_content(
            f"Analyze this URL and provide a brief description of what it likely contains: {url}",
            priority="speed",
        )

    async def generate_code(self, description: str, language: str = "python") -> str:
        return await self.generate_content(
            f"Write {language} code for: {description}\n\nReturn only the code with brief comments.",
            priority="quality",
            use_pro=True,
        )

    async def get_status(self) -> dict:
        return {
            "gemini": {
                **self._gemini_cb.get_stats(),
                **self._gemini_metrics.to_dict(),
                "configured": bool(self.config.gemini_api_key),
            },
            "grok": {
                **self._grok_cb.get_stats(),
                **self._grok_metrics.to_dict(),
                "configured": bool(self.config.grok_api_key),
            },
        }

    async def _health_loop(self):
        await asyncio.sleep(self.config.health_check_interval)
        while True:
            await self._ping_apis()
            await asyncio.sleep(self.config.health_check_interval)

    async def _ping_apis(self):
        if self.config.gemini_api_key and self._gemini_cb.status == APIStatus.DOWN:
            if await self._gemini_cb.is_available():
                try:
                    await with_timeout(
                        self._gemini_generate("ping", system="Reply with OK"),
                        10,
                    )
                    await self._gemini_cb.record_success()
                    logger.info("Gemini health check passed — recovered")
                except Exception:
                    await self._gemini_cb.record_failure()

        if self.config.grok_api_key and self._grok_cb.status == APIStatus.DOWN:
            if await self._grok_cb.is_available():
                try:
                    await with_timeout(self._grok_generate("ping"), 10)
                    await self._grok_cb.record_success()
                    logger.info("Grok health check passed — recovered")
                except Exception:
                    await self._grok_cb.record_failure()

    async def _alert_loop(self):
        while True:
            await asyncio.sleep(60)
            for api_name in ("Gemini", "Grok"):
                await bot_logger.check_and_alert(api_name)
