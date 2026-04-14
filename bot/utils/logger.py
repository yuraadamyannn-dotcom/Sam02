import logging
import asyncio
import time
from typing import Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from telegram import Bot

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)

logger = logging.getLogger("sam_bot")


class BotLogger:
    def __init__(self):
        self._bot: Optional["Bot"] = None
        self._admin_id: Optional[int] = None
        self._downtime_start: dict[str, Optional[float]] = {}
        self._alert_threshold: int = 300
        self._alert_lock = asyncio.Lock()

    def setup(self, bot: "Bot", admin_id: Optional[int], alert_threshold: int = 300):
        self._bot = bot
        self._admin_id = admin_id
        self._alert_threshold = alert_threshold

    def info(self, msg: str, **kwargs):
        logger.info(msg, **kwargs)

    def warning(self, msg: str, **kwargs):
        logger.warning(msg, **kwargs)

    def error(self, msg: str, **kwargs):
        logger.error(msg, **kwargs)

    def log_api_switch(self, from_api: str, to_api: str, reason: str):
        logger.warning(
            f"[FAILOVER] {from_api} → {to_api} | reason: {reason}"
        )

    def log_api_metric(self, api: str, elapsed: float, success: bool):
        status = "OK" if success else "FAIL"
        logger.info(f"[METRIC] {api} | {status} | {elapsed:.2f}s")

    def log_circuit_breaker(self, api: str, action: str):
        logger.warning(f"[CIRCUIT BREAKER] {api} | {action}")

    async def notify_downtime_start(self, api: str):
        async with self._alert_lock:
            if api not in self._downtime_start or self._downtime_start[api] is None:
                self._downtime_start[api] = time.time()

    async def notify_downtime_end(self, api: str):
        async with self._alert_lock:
            self._downtime_start[api] = None

    async def check_and_alert(self, api: str):
        if not self._bot or not self._admin_id:
            return
        async with self._alert_lock:
            start = self._downtime_start.get(api)
            if start and (time.time() - start) >= self._alert_threshold:
                duration_min = int((time.time() - start) // 60)
                try:
                    await self._bot.send_message(
                        chat_id=self._admin_id,
                        text=(
                            f"⚠️ *API Alert*\n"
                            f"`{api}` недоступен уже *{duration_min} мин*.\n"
                            f"Бот работает через резервный API."
                        ),
                        parse_mode="Markdown",
                    )
                    self._downtime_start[api] = time.time() + self._alert_threshold
                except Exception as e:
                    logger.error(f"Failed to send admin alert: {e}")


bot_logger = BotLogger()
