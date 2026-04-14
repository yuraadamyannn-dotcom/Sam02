import os
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Config:
    telegram_token: str
    gemini_api_key: Optional[str]
    grok_api_key: Optional[str]
    groq_api_key: Optional[str]
    elevenlabs_api_key: Optional[str]
    admin_telegram_id: Optional[int]

    gemini_model_fast: str = "gemini-2.0-flash"
    gemini_model_pro: str = "gemini-1.5-pro"
    grok_model: str = "grok-3-mini"
    grok_base_url: str = "https://api.x.ai/v1"

    circuit_breaker_threshold: int = 3
    circuit_breaker_timeout: int = 60
    health_check_interval: int = 30
    request_timeout: int = 30
    retry_attempts: int = 3

    cache_ttl: int = 3600
    alert_downtime_threshold: int = 300

    polling_mode: bool = True
    webhook_url: Optional[str] = None
    webhook_port: int = 8443


def load_config() -> Config:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    if not token:
        raise EnvironmentError("TELEGRAM_BOT_TOKEN is required")

    admin_id_raw = os.environ.get("ADMIN_TELEGRAM_ID")
    admin_id = int(admin_id_raw) if admin_id_raw and admin_id_raw.isdigit() else None

    return Config(
        telegram_token=token,
        gemini_api_key=os.environ.get("GEMINI_API_KEY"),
        grok_api_key=os.environ.get("GROK_API_KEY"),
        groq_api_key=os.environ.get("GROQ_API_KEY"),
        elevenlabs_api_key=os.environ.get("ELEVENLABS_API_KEY"),
        admin_telegram_id=admin_id,
        polling_mode=os.environ.get("WEBHOOK_URL") is None,
        webhook_url=os.environ.get("WEBHOOK_URL"),
    )
