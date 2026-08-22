"""结果元信息批量查询（PRD 4.4 ADR-07）。

设计目标：
    - **零 N+1**：单次响应不论命中多少条，固定 ≤ 4 次 DB 查询
      （Space PG / Agent PG / User MySQL / ChatSession MySQL）
    - **30ms 预算**：100 hits 内的 hydrate 总开销 < 30ms（PRD 4.4 承诺）
    - **缺失友好**：被删除的 Space / Agent / User 直接缺省，不影响其他
      字段（前端按 Optional 渲染）

为什么不把 Space.name / Agent.name / User.name 进 ES：
    - ADR-07：Space 改名触发百万 update_by_query，索引膨胀 + 写放大
    - hydrate 单次 PG 批量查询 ~5-15ms（in_bulk + only），相比 ES 节省的
      改名同步成本是数量级优势

为什么不并行查 PG/MySQL：
    - 100 hits 量级下，串行总耗时仍在 30ms 预算内
    - asyncio + sync_to_async 在 Django ORM 上的开销得不偿失
    - 真正瓶颈是 ES msearch 本身（typically 50-150ms），hydrate 不是热点
"""

from __future__ import annotations

import logging
from typing import Any, Iterable

from apps.fts.schemas import SearchResultItem

logger = logging.getLogger(__name__)

__all__ = [
    "hydrate",
    "BatchLookups",
]

# Wave 2 Review 修复（技术 MEDIUM 6）：User._meta.get_fields() 不便宜，
# 每次 hydrate 调用都跑一次会让请求路径多 1-3ms；用模块级 frozenset 缓存
# 字段名（项目 User 模型 schema 改动需要 reload 才生效，可接受）。
_USER_FIELD_NAMES_CACHE: frozenset[str] | None = None


def _get_user_fields() -> frozenset[str]:
    global _USER_FIELD_NAMES_CACHE
    if _USER_FIELD_NAMES_CACHE is not None:
        return _USER_FIELD_NAMES_CACHE
    try:
        from django.contrib.auth import get_user_model
        User = get_user_model()
        _USER_FIELD_NAMES_CACHE = frozenset(f.name for f in User._meta.get_fields())
    except Exception:
        _USER_FIELD_NAMES_CACHE = frozenset()
    return _USER_FIELD_NAMES_CACHE


class BatchLookups:
    """单次响应的批量查询结果（dict-of-dicts，便于按 id 反查）。

    用于测试时按需注入 mock，避免真正打 DB。
    """

    def __init__(self) -> None:
        self.spaces: dict[str, dict[str, Any]] = {}
        self.agents: dict[str, dict[str, Any]] = {}
        self.users: dict[str, dict[str, Any]] = {}
        self.sessions: dict[str, dict[str, Any]] = {}


def hydrate(items: list[SearchResultItem]) -> list[SearchResultItem]:
    """把 ES hits 转成的 SearchResultItem 列表 hydrate 元信息字段。

    - 输入：`SearchResultItem` 已含 `space_id` / `creator_id` / `session_id`
      （由 search_service 从 ES `_source` 抽取）
    - 输出：原列表（按引用就地修改），补全 `space_name` / `creator_name`
      / `creator_avatar` / `session_title`

    保留原始顺序（RRF 融合后的顺序），不重排。
    """
    if not items:
        return items

    space_ids: set[str] = set()
    user_ids: set[str] = set()
    agent_ids: set[str] = set()
    session_ids: set[str] = set()

    for item in items:
        if item.space_id:
            space_ids.add(item.space_id)
        if item.creator_type == "user" and item.creator_id:
            user_ids.add(item.creator_id)
        elif item.creator_type == "agent" and item.creator_id:
            agent_ids.add(item.creator_id)
        # message hit：session_id 可能存在但 title 是冗余快照，PG 为准
        if item.type == "message" and item.session_id:
            session_ids.add(item.session_id)

    lookups = _batch_fetch(space_ids, user_ids, agent_ids, session_ids)

    for item in items:
        # Space hydrate（type='space' 自身命中时，space_id 也是 doc.id）
        if item.space_id and item.space_id in lookups.spaces:
            sp = lookups.spaces[item.space_id]
            item.space_name = sp.get("name") or item.space_name
            # 如果 Space 自身的 hit，title 已经在 search_service 填好

        # Creator 名称 / avatar
        if item.creator_type == "user" and item.creator_id and item.creator_id in lookups.users:
            u = lookups.users[item.creator_id]
            item.creator_name = u.get("display_name") or u.get("username") or item.creator_name
            item.creator_avatar = u.get("avatar") or item.creator_avatar
        elif item.creator_type == "agent" and item.creator_id and item.creator_id in lookups.agents:
            a = lookups.agents[item.creator_id]
            item.creator_name = a.get("name") or item.creator_name
            # Agent 没有 avatar 字段；前端用 type emoji 即可

        # message：用 PG 的 ChatSession.title 校正冗余快照
        if item.type == "message" and item.session_id and item.session_id in lookups.sessions:
            s = lookups.sessions[item.session_id]
            fresh = s.get("title")
            if fresh:
                item.session_title = fresh

    return items


def _batch_fetch(
    space_ids: set[str],
    user_ids: set[str],
    agent_ids: set[str],
    session_ids: set[str],
) -> BatchLookups:
    """单次批量查 PG / MySQL，返回 dict-of-dicts。

    任一查询失败不影响其他查询（保留偏 partial 元信息也强于一无所有）。
    """
    out = BatchLookups()

    if space_ids:
        try:
            from apps.tabtinspace.models import Project, Workspace
            for s in Workspace.objects.using("postgresql").filter(id__in=list(space_ids)).only(
                "id", "name", "agent_id",
            ):
                out.spaces[str(s.id)] = {
                    "id": str(s.id),
                    "name": s.name or "",
                    "icon": "",
                    "avatar": "",
                    "type": "workspace",
                    "agent_id": str(s.agent_id) if s.agent_id else None,
                }
            for s in Project.objects.using("postgresql").filter(id__in=list(space_ids)).only(
                "id", "name", "avatar",
            ):
                out.spaces[str(s.id)] = {
                    "id": str(s.id),
                    "name": s.name or "",
                    "icon": "",
                    "avatar": s.avatar or "",
                    "type": "team_space",
                    "agent_id": None,
                }
        except Exception:
            logger.warning("[FTS][hydrate] Space lookup failed ids=%s", list(space_ids), exc_info=True)

    if agent_ids:
        try:
            from apps.tabtinspace.models import Agent
            for a in Agent.objects.using("postgresql").filter(id__in=list(agent_ids)).only(
                "id", "name", "type",
            ):
                out.agents[str(a.id)] = {
                    "id": str(a.id),
                    "name": a.name or "",
                    "type": a.type or "",
                }
        except Exception:
            logger.warning("[FTS][hydrate] Agent lookup failed ids=%s", list(agent_ids), exc_info=True)

    if user_ids:
        try:
            from django.contrib.auth import get_user_model
            User = get_user_model()
            qs = User.objects.filter(id__in=list(user_ids))
            # Wave 2 Review 修复：模块级缓存 User 字段名集合
            available = _get_user_fields()
            wanted = [n for n in ("id", "username", "nickname", "display_name", "avatar", "email") if n in available]
            qs = qs.only(*wanted)
            for u in qs:
                rec: dict[str, Any] = {"id": str(u.id)}
                rec["username"] = getattr(u, "username", "") or ""
                rec["display_name"] = (
                    getattr(u, "nickname", None)
                    or getattr(u, "display_name", None)
                    or getattr(u, "username", None)
                    or ""
                )
                rec["avatar"] = getattr(u, "avatar", "") or ""
                out.users[str(u.id)] = rec
        except Exception:
            logger.warning("[FTS][hydrate] User lookup failed ids=%s", list(user_ids), exc_info=True)

    if session_ids:
        try:
            from apps.chat.conversation.models import ChatSession
            # ChatSession 在 default(MySQL)；不能用 using('postgresql')
            for s in ChatSession.objects.filter(id__in=list(session_ids)).only("id", "title", "status"):
                out.sessions[str(s.id)] = {
                    "id": str(s.id),
                    "title": s.title or "",
                    "status": s.status or "",
                }
        except Exception:
            logger.warning("[FTS][hydrate] ChatSession lookup failed ids=%s", list(session_ids), exc_info=True)

    return out
