"""存储分析缓存：统一的读写与失效函数。

所有改变 FileUsage 活跃状态的路径在 transaction.on_commit 中调用
invalidate_storage_analytics(organization_id)，确保事务提交后缓存一致。
"""

import logging

from django.core.cache import cache as django_cache

logger = logging.getLogger(__name__)

CACHE_PREFIX = "oss:storage_analytics:"
FIXED_DIMENSIONS = ("overview", "by_module", "by_member", "by_file_type")

TTL_OVERVIEW = 300
TTL_DETAIL = 600

_ACTIVE_KEYS_SET = "oss:storage_analytics_keys:"


def _key(organization_id: str, dimension: str) -> str:
    return f"{CACHE_PREFIX}{organization_id}:{dimension}"


def get_cached(organization_id: str, dimension: str):
    return django_cache.get(_key(organization_id, dimension))


def set_cached(organization_id: str, dimension: str, data, ttl: int | None = None):
    if ttl is None:
        ttl = TTL_OVERVIEW if dimension == "overview" else TTL_DETAIL
    key = _key(organization_id, dimension)
    django_cache.set(key, data, ttl)
    try:
        set_key = f"{_ACTIVE_KEYS_SET}{organization_id}"
        existing = django_cache.get(set_key) or set()
        existing.add(key)
        django_cache.set(set_key, existing, max(TTL_OVERVIEW, TTL_DETAIL) + 60)
    except Exception:
        pass


def invalidate_storage_analytics(organization_id: str) -> None:
    """清除指定 organization 的全部存储分析缓存（含参数化的大文件缓存键）。"""
    if not organization_id:
        return
    keys = [_key(organization_id, dim) for dim in FIXED_DIMENSIONS]
    try:
        set_key = f"{_ACTIVE_KEYS_SET}{organization_id}"
        extra_keys = django_cache.get(set_key) or set()
        keys.extend(extra_keys)
        django_cache.delete(set_key)
    except Exception:
        pass
    try:
        django_cache.delete_many(list(set(keys)))
    except Exception:
        for k in keys:
            try:
                django_cache.delete(k)
            except Exception:
                pass


def invalidate_safe(organization_id: str) -> None:
    """静默版失效函数，适合在 on_commit 回调中使用。"""
    try:
        invalidate_storage_analytics(str(organization_id))
    except Exception:
        pass
