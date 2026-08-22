from __future__ import annotations

from typing import Optional

from django.core.cache import cache

EXECUTION_AGENT_CACHE_PREFIX = "orchestration:execution_agent:"
EXECUTION_AGENT_CACHE_TTL = 300


def build_execution_agent_cache_key(thread_id: str) -> str:
    return f"{EXECUTION_AGENT_CACHE_PREFIX}{thread_id}"


def get_cached_execution_agent_id(thread_id: str) -> Optional[str]:
    try:
        cached = cache.get(build_execution_agent_cache_key(thread_id))
    except Exception:
        return None

    if isinstance(cached, dict):
        cached = cached.get("agent_id")

    return str(cached) if cached else None


def set_cached_execution_agent(thread_id: str, agent_id: str, token: str) -> None:
    try:
        cache.set(
            build_execution_agent_cache_key(thread_id),
            {"agent_id": str(agent_id), "token": token},
            timeout=EXECUTION_AGENT_CACHE_TTL,
        )
    except Exception:
        return None


def clear_cached_execution_agent(thread_id: str, token: Optional[str] = None) -> None:
    cache_key = build_execution_agent_cache_key(thread_id)
    try:
        if token is None:
            cache.delete(cache_key)
            return None

        cached = cache.get(cache_key)
        if isinstance(cached, dict):
            if cached.get("token") == token:
                cache.delete(cache_key)
            return None

        if cached is not None:
            cache.delete(cache_key)
    except Exception:
        return None
