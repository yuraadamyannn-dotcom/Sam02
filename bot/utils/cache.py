import asyncio
import time
import hashlib
import json
from typing import Any, Optional
from dataclasses import dataclass, field


@dataclass
class CacheEntry:
    value: Any
    created_at: float
    ttl: int

    def is_expired(self) -> bool:
        return (time.time() - self.created_at) > self.ttl


class InMemoryCache:
    def __init__(self, default_ttl: int = 3600, max_size: int = 1000):
        self._store: dict[str, CacheEntry] = {}
        self._default_ttl = default_ttl
        self._max_size = max_size
        self._lock = asyncio.Lock()

    def _make_key(self, namespace: str, *args, **kwargs) -> str:
        raw = json.dumps({"ns": namespace, "args": args, "kwargs": kwargs}, sort_keys=True, default=str)
        return hashlib.md5(raw.encode()).hexdigest()

    async def get(self, key: str) -> Optional[Any]:
        async with self._lock:
            entry = self._store.get(key)
            if entry is None:
                return None
            if entry.is_expired():
                del self._store[key]
                return None
            return entry.value

    async def set(self, key: str, value: Any, ttl: Optional[int] = None) -> None:
        async with self._lock:
            if len(self._store) >= self._max_size:
                self._evict_lru()
            self._store[key] = CacheEntry(
                value=value,
                created_at=time.time(),
                ttl=ttl if ttl is not None else self._default_ttl,
            )

    async def delete(self, key: str) -> None:
        async with self._lock:
            self._store.pop(key, None)

    async def clear_expired(self) -> int:
        async with self._lock:
            expired_keys = [k for k, v in self._store.items() if v.is_expired()]
            for k in expired_keys:
                del self._store[k]
            return len(expired_keys)

    def _evict_lru(self):
        if not self._store:
            return
        oldest_key = min(self._store.keys(), key=lambda k: self._store[k].created_at)
        del self._store[oldest_key]

    def make_key(self, namespace: str, *args, **kwargs) -> str:
        return self._make_key(namespace, *args, **kwargs)

    async def get_stats(self) -> dict:
        async with self._lock:
            total = len(self._store)
            expired = sum(1 for e in self._store.values() if e.is_expired())
            return {"total": total, "active": total - expired, "expired": expired}


cache = InMemoryCache()
