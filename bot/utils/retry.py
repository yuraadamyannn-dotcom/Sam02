import asyncio
import random
import functools
import logging
from typing import Callable, TypeVar, Any, Tuple, Type

logger = logging.getLogger("sam_bot.retry")

T = TypeVar("T")


async def retry_async(
    func: Callable,
    *args,
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    jitter: bool = True,
    retriable_exceptions: Tuple[Type[Exception], ...] = (Exception,),
    **kwargs,
) -> Any:
    last_exc: Exception = RuntimeError("No attempts made")

    for attempt in range(1, attempts + 1):
        try:
            return await func(*args, **kwargs)
        except retriable_exceptions as exc:
            last_exc = exc
            if attempt == attempts:
                break

            delay = min(base_delay * (2 ** (attempt - 1)), max_delay)
            if jitter:
                delay += random.uniform(0, delay * 0.3)

            logger.debug(
                f"Attempt {attempt}/{attempts} failed ({type(exc).__name__}: {exc}). "
                f"Retrying in {delay:.2f}s..."
            )
            await asyncio.sleep(delay)

    raise last_exc


def with_retry(
    attempts: int = 3,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    jitter: bool = True,
    retriable_exceptions: Tuple[Type[Exception], ...] = (Exception,),
):
    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            return await retry_async(
                func,
                *args,
                attempts=attempts,
                base_delay=base_delay,
                max_delay=max_delay,
                jitter=jitter,
                retriable_exceptions=retriable_exceptions,
                **kwargs,
            )
        return wrapper
    return decorator


async def with_timeout(coro, timeout: float):
    try:
        return await asyncio.wait_for(coro, timeout=timeout)
    except asyncio.TimeoutError:
        raise TimeoutError(f"Request timed out after {timeout}s")
