from __future__ import annotations

import time
from collections import defaultdict

from redis.asyncio import Redis

from app.core.config import get_settings


class RateLimiter:
    def __init__(self) -> None:
        self.settings = get_settings()
        self._fallback: dict[str, tuple[int, float]] = defaultdict(lambda: (0, 0.0))

    async def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        redis: Redis | None = None
        try:
            redis = Redis.from_url(self.settings.redis_url, decode_responses=True,
                                   socket_connect_timeout=1, socket_timeout=2)
            bucket = f"semperfi:rate:{key}:{int(time.time() // window_seconds)}"
            count = await redis.incr(bucket)
            if count == 1:
                await redis.expire(bucket, window_seconds)
            return count <= limit
        except Exception:
            if self.settings.environment == "production":
                return False
            count, reset = self._fallback[key]
            now = time.monotonic()
            if now > reset:
                self._fallback[key] = (1, now + window_seconds)
                return True
            self._fallback[key] = (count + 1, reset)
            return count + 1 <= limit
        finally:
            if redis:
                await redis.aclose()


rate_limiter = RateLimiter()
