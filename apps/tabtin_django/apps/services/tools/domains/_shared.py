"""
Shared utilities for Agent tools.

Provides commonly-used helpers (e.g. user loading) with built-in
caching to avoid redundant DB queries across multiple tool calls
within the same Agent conversation.

BO-027/BO-028: Cache backend migrated from in-process dict to Django
cache (Redis-backed) so that invalidation is globally visible across
all Gunicorn/Celery worker processes.
"""

import threading
from typing import Optional

import logging

logger = logging.getLogger(__name__)

# ──────────────────────────────────
# Cached user loader (Redis-backed)
# ──────────────────────────────────

# SDI-016: TTL 从 300s 降至 30s，缩短账号禁用后工具层仍代为执行的窗口
_USER_CACHE_TTL = 30
_CACHE_KEY_PREFIX = "orchestration:tool_user:"

# Legacy stubs — real cache now uses Django cache (Redis).
# Kept to avoid ImportError in existing test code that directly
# imports these names.
_user_cache: dict[str, tuple] = {}
_user_cache_lock = threading.Lock()


def _cache_key(user_id: str) -> str:
    return f"{_CACHE_KEY_PREFIX}{user_id}"


def invalidate_user_cache(user_id: str) -> None:
    """Remove a specific user from the shared Redis cache.

    Called when an account is deactivated to ensure tools
    stop acting on behalf of the disabled user immediately.
    Effective across all worker processes (BO-027 / BO-028).
    """
    from django.core.cache import cache
    cache.delete(_cache_key(user_id))
    with _user_cache_lock:
        _user_cache.pop(user_id, None)


def load_user(user_id: Optional[str]):
    """Load a user object by ID with Redis-backed caching.

    Caches user objects for up to ``_USER_CACHE_TTL`` seconds to avoid
    repeated DB queries when multiple tools are called in the same
    conversation.

    Args:
        user_id: The user ID string.

    Returns:
        User object or None if user does not exist or is inactive.
    """
    if not user_id:
        return None

    from django.core.cache import cache

    key = _cache_key(user_id)
    cached = cache.get(key)
    if cached is not None:
        if not cached.is_active:
            cache.delete(key)
            return None
        return cached

    from django.contrib.auth import get_user_model
    User = get_user_model()
    user_obj = User.objects.filter(id=user_id).first()

    if user_obj is None or not user_obj.is_active:
        return None

    cache.set(key, user_obj, _USER_CACHE_TTL)
    return user_obj
