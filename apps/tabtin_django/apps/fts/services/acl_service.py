"""FTS ACL: Space membership scoped search.

设计原则：
    - **零越权**：搜索 query 永远带 `organization_id` filter + `space_id`
      白名单
    - **缓存友好**：每次解析一次 PG，结果存 Redis（TTL `FTS_ACL_CACHE_TTL`，
      默认 300s）；SpaceMembership 变动 signal 失效缓存
    - **结构化产物**：返回 `AccessibleSpaces` dataclass，记录当前用户可完整
      访问的 Space IDs

SF-1 retired SpaceShare/ObjectScope as Space-level product objects. Resource-
level sharing remains in TabDoc/TabData permission services and does not grant
whole-Space FTS visibility here.

注意：
    - 缓存 key 用 `fts:acl:{user_id}:{organization_id}`
    - 缓存 value 是 JSON 序列化的 dict（dataclass.to_dict 形式）
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Any

from django.conf import settings
logger = logging.getLogger(__name__)

__all__ = [
    "AccessibleSpaces",
    "get_user_accessible_spaces",
    "build_es_filter",
    "invalidate_user_acl",
    "invalidate_organization_users_acl",
    "_serialize",
    "_deserialize",
    "ACL_CACHE_KEY_PREFIX",
]

ACL_CACHE_KEY_PREFIX = "fts:acl:"


def _cache_key(user_id: str, organization_id: str) -> str:
    return f"{ACL_CACHE_KEY_PREFIX}{user_id}:{organization_id}"


# ── DTO ────────────────────────────────────────────────────────
@dataclass
class AccessibleSpaces:
    """用户在某 Organization 内可完整访问的 Space 集合。

    - `full_access_space_ids`：直接 user / agent membership 可访问的 Space。
      SpaceShare-derived object scope 已由 SF-1 退役，不再作为 FTS ACL 来源。
    - `organization_id`：用于响应/日志关联（请求级冗余存储）
    - `user_id`： org-only 云资产 ES ACL（creator_id 匹配）
    - `cloud_resource_ids`： 用户可见的云资源 resource_id（owner∪显式 ACL）
    - `cached_at`：用于诊断"缓存何时建立"，不参与 ES query
    """

    full_access_space_ids: list[str] = field(default_factory=list)
    organization_id: str = ""
    user_id: str = ""
    cloud_resource_ids: list[str] = field(default_factory=list)
    cached_at: float = 0.0

    def has_any_access(self) -> bool:
        # Space membership 仍是多数索引的门槛；resources 另见 build_es_filter 的 org-only 分支
        return bool(self.full_access_space_ids)

    def all_space_ids(self) -> list[str]:
        return list(dict.fromkeys(self.full_access_space_ids))


def _serialize(acc: AccessibleSpaces) -> str:
    return json.dumps(asdict(acc), separators=(",", ":"))


def _deserialize(payload: str) -> AccessibleSpaces:
    raw = json.loads(payload)
    return AccessibleSpaces(
        full_access_space_ids=list(raw.get("full_access_space_ids") or []),
        organization_id=raw.get("organization_id") or "",
        user_id=raw.get("user_id") or "",
        cloud_resource_ids=list(raw.get("cloud_resource_ids") or []),
        cached_at=float(raw.get("cached_at") or 0.0),
    )


# ── Redis Helper ───────────────────────────────────────────────
def _get_redis():
    """共享 default 缓存的 Redis 连接。"""
    try:
        from django_redis import get_redis_connection
        return get_redis_connection("default")
    except Exception:
        # 未配置 Redis 时（如部分 test runner）允许走"无缓存"路径
        return None


# ── 主入口 ─────────────────────────────────────────────────────
def get_user_accessible_spaces(
    user_id: str,
    organization_id: str,
    *,
    use_cache: bool = True,
) -> AccessibleSpaces:
    """返回 user 在 organization 下的 Space ACL 解析结果。

    - 缓存命中：直接返回（O(1)）
    - 缓存未命中：查 PG（SpaceMembership + Agent membership）→ 写缓存
    - `use_cache=False`：旁路缓存，强制回源（测试/失效后立即热更新场景）
    """
    if not user_id or not organization_id:
        return AccessibleSpaces(organization_id=organization_id or "")

    user_id = str(user_id)
    organization_id = str(organization_id)

    redis = _get_redis() if use_cache else None
    cache_key = _cache_key(user_id, organization_id)

    if redis is not None:
        try:
            raw = redis.get(cache_key)
        except Exception:  # pragma: no cover - Redis 抖动时回源
            logger.warning("[FTS][ACL] redis get failed key=%s", cache_key, exc_info=True)
            raw = None
        if raw:
            try:
                acc = _deserialize(raw.decode() if isinstance(raw, (bytes, bytearray)) else raw)
                # 旧缓存可能缺  字段；补 user_id 以便 org-only 分支生效
                if not acc.user_id:
                    acc.user_id = user_id
                return acc
            except Exception:
                logger.warning("[FTS][ACL] cache decode failed key=%s; will refresh", cache_key, exc_info=True)

    acc = _resolve_from_pg(user_id, organization_id)
    acc.cached_at = time.time()

    if redis is not None:
        ttl = int(getattr(settings, "FTS_ACL_CACHE_TTL", 300) or 300)
        try:
            redis.setex(cache_key, ttl, _serialize(acc))
        except Exception:  # pragma: no cover
            logger.warning("[FTS][ACL] redis setex failed key=%s", cache_key, exc_info=True)

    return acc


def _resolve_cloud_resource_ids(user_id: str) -> list[str]:
    """#7238：拉取用户可见云资源 resource_id（owner ∪ 显式 ACL），供 ES org-only 分支。"""
    try:
        from types import SimpleNamespace

        from apps.tabtinspace.services.cloud_resource_acl import (
            CLOUD_ITEM_TYPES,
            accessible_cloud_resource_ids,
        )
    except Exception:
        logger.exception("[FTS][ACL] cloud_resource_acl import failed")
        return []

    user = SimpleNamespace(id=user_id)
    ids: set[str] = set()
    for item_type in CLOUD_ITEM_TYPES:
        try:
            ids.update(accessible_cloud_resource_ids(user, item_type))
        except Exception:
            logger.warning(
                "[FTS][ACL] accessible_cloud_resource_ids failed user=%s type=%s",
                user_id, item_type, exc_info=True,
            )
    return sorted(ids)


def _resolve_from_pg(user_id: str, organization_id: str) -> AccessibleSpaces:
    """从 PG 拉 membership 权限（同 AccessibleSpaceResolver 思路）。

    Layer 1：用户直接持有的 SpaceMembership。
    Layer 2：云资源 resource_id 白名单，供 resources 索引 org-only ACL。
    """
    full: set[str] = set()

    try:
        from apps.tabtinspace.models import SpaceMembership
    except Exception:
        # PG 不可用直接返回空（fallback 路径会走 partial response）
        logger.exception("[FTS][ACL] models import failed; returning empty ACL")
        return AccessibleSpaces(organization_id=organization_id, user_id=user_id)

    # Layer 1: user 直接 membership
    try:
        full.update(
            str(sid)
            for sid in SpaceMembership.objects.using("postgresql").filter(
                user_id=user_id,
                workspace__organization_id=organization_id,
                is_active=True,
            ).values_list("workspace_id", flat=True)
        )
    except Exception:
        logger.warning(
            "[FTS][ACL] SpaceMembership user query failed user=%s organization=%s",
            user_id, organization_id, exc_info=True,
        )

    cloud_ids = _resolve_cloud_resource_ids(user_id)

    return AccessibleSpaces(
        full_access_space_ids=sorted(full),
        organization_id=organization_id,
        user_id=str(user_id),
        cloud_resource_ids=cloud_ids,
    )


def _org_only_resources_should(accessible: AccessibleSpaces) -> dict[str, Any] | None:
    """#7238：resources 索引上 space_id 缺失的 org-only 文档 ACL。

    对齐 ：
    - tabfiles：ContextItem.created_by（indexed as creator_id）或 FilePermission 白名单
    - tabdoc/tabdata：仅 resource_id ∈ Document/Table owner ∪ 显式 Permission
      （不用 creator_id，避免 created_by ≠ resource.owner 时误召回）
    """
    uid = (accessible.user_id or "").strip()
    if not uid:
        return None

    owner_or_shared: list[dict[str, Any]] = [
        {
            "bool": {
                "filter": [
                    {"term": {"item_type": "tabfiles"}},
                    {"term": {"creator_id": uid}},
                ]
            }
        }
    ]
    if accessible.cloud_resource_ids:
        owner_or_shared.append({"terms": {"resource_id": accessible.cloud_resource_ids}})

    return {
        "bool": {
            "filter": [
                {"bool": {"must_not": {"exists": {"field": "space_id"}}}},
                {
                    "bool": {
                        "should": owner_or_shared,
                        "minimum_should_match": 1,
                    }
                },
            ]
        }
    }


# ── ES Filter 构造（PRD 4.7.C） ────────────────────────────────
def build_es_filter(
    accessible: AccessibleSpaces,
    organization_id: str,
    *,
    logical_index: str = "resources",
) -> dict[str, Any]:
    """构造 bool filter，可直接塞 ES query 的 bool.filter[]。

    Args:
        accessible: 解析得到的 AccessibleSpaces
        organization_id: 强制租户隔离（PRD 5.1，所有索引都有该字段）
        logical_index: 当前正在构造 query 的逻辑索引名；多数索引用
            `space_id`，agents 索引用 `space_ids`。

    Returns:
        bool 查询节点，例如：
            {
              "bool": {
                "filter": [
                  {"term": {"organization_id": "..."}},
                  {"bool": {"should": [
                    {"terms": {"space_id": [...full...]}},
                    # resources 另可含 org-only（space_id missing + ACL）
                  ]}}
                ]
              }
            }

    无任何 access 时返回"必空"过滤器（match_none），ES 直接 0 命中。
    """
    space_acl_field = _space_acl_field_for(logical_index)
    space_should: list[dict[str, Any]] = []
    if accessible.full_access_space_ids:
        space_should.append({"terms": {space_acl_field: accessible.full_access_space_ids}})

    # ：resources 索引纳入 org-only 云资产（不依赖 Space membership 宿主）
    if logical_index == "resources":
        org_only = _org_only_resources_should(accessible)
        if org_only is not None:
            space_should.append(org_only)

    if not space_should:
        return {"bool": {"must_not": {"match_all": {}}}}

    return {
        "bool": {
            "filter": [
                {"term": {"organization_id": organization_id}},
                {"bool": {"should": space_should, "minimum_should_match": 1}},
            ]
        }
    }


def _space_acl_field_for(logical_index: str) -> str:
    """返回该索引用于 Space membership ACL 的字段。"""
    if logical_index == "agents":
        return "space_ids"
    return "space_id"


# ── 缓存失效 ───────────────────────────────────────────────────
def invalidate_user_acl(user_id: str | None, organization_id: str | None) -> int:
    """单 user × organization 的缓存失效。

    返回删除的 key 数（0 或 1）。
    """
    if not user_id or not organization_id:
        return 0
    redis = _get_redis()
    if redis is None:
        return 0
    try:
        return int(redis.delete(_cache_key(str(user_id), str(organization_id))) or 0)
    except Exception:  # pragma: no cover
        logger.warning("[FTS][ACL] invalidate single failed", exc_info=True)
        return 0


def invalidate_organization_users_acl(organization_id: str | None, user_ids: list[str]) -> int:
    """organization 内一批 user 的缓存失效。

    返回删除的 key 数。
    """
    if not organization_id or not user_ids:
        return 0
    redis = _get_redis()
    if redis is None:
        return 0
    keys = [_cache_key(str(u), str(organization_id)) for u in user_ids if u]
    if not keys:
        return 0
    try:
        return int(redis.delete(*keys) or 0)
    except Exception:  # pragma: no cover
        logger.warning("[FTS][ACL] invalidate batch failed", exc_info=True)
        return 0
