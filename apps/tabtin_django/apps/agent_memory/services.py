from __future__ import annotations

import base64
from dataclasses import dataclass
from datetime import datetime
from typing import Optional
from uuid import UUID

from django.db import transaction
from django.utils import timezone
from django.utils.dateparse import parse_datetime

from apps.agent_memory.error_codes import ErrorCode, ServiceError
from apps.agent_memory.models import AgentMemory
from apps.agent_memory.repository import AgentMemoryRepository
from apps.agent_memory.search import read_score
from apps.agent.models import Agent
from apps.tabtinspace.models import Space
from apps.tabtinspace.services.base import BaseService


DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 100
MAX_SEARCH_CHARS = 500

# 旧 TabMemo ``source=agent, memo_type=diary`` 兼容策略（首发）：
# Organization 级「Agent 日记」只读 AgentMemory 正典，不与 TabMemo 历史行混排猜重。
# 历史行已由 tabmemo.0025 迁入 AgentMemory；残留未迁行不在本 feed 出现。
LEGACY_TABMEMO_DIARY_POLICY = "agent_memory_canonical_readonly"


@dataclass(frozen=True)
class MemoryScope:
    organization_id: str
    agent_id: str
    subject_user_id: str


def _uuid_string(value: object, field_name: str) -> str:
    try:
        return str(UUID(str(value)))
    except (TypeError, ValueError) as exc:
        raise ServiceError(
            ErrorCode.INVALID_SCOPE,
            f"{field_name} 格式非法",
            status=400,
        ) from exc


def _encode_diary_cursor(created_at: datetime, memory_id: object) -> str:
    raw = f"{created_at.isoformat()}|{memory_id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_diary_cursor(cursor: str) -> tuple[Optional[datetime], Optional[str]]:
    if not cursor:
        return None, None
    padded = cursor + "=" * (-len(cursor) % 4)
    try:
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        created_raw, memory_id = raw.split("|", 1)
    except (ValueError, UnicodeDecodeError) as exc:
        raise ServiceError(
            ErrorCode.INVALID_CURSOR,
            "cursor 格式非法",
            status=400,
        ) from exc
    created_at = parse_datetime(created_raw)
    if created_at is None:
        raise ServiceError(
            ErrorCode.INVALID_CURSOR,
            "cursor 格式非法",
            status=400,
        )
    try:
        memory_id = str(UUID(str(memory_id)))
    except (TypeError, ValueError) as exc:
        raise ServiceError(
            ErrorCode.INVALID_CURSOR,
            "cursor 格式非法",
            status=400,
        ) from exc
    return created_at, memory_id


class AgentMemoryService:
    """Canonical memory service; every read and write is subject-scoped."""

    def __init__(self, user):
        if not user or not getattr(user, "id", None):
            raise ServiceError(ErrorCode.UNAUTHORIZED, "请先登录", status=401)
        self.user = user
        self.access = BaseService(user=user)

    def resolve_scope(
        self,
        *,
        organization_id: str,
        agent_id: Optional[str] = None,
        space_id: Optional[str] = None,
    ) -> MemoryScope:
        organization_id = _uuid_string(organization_id, "organization_id")
        if bool(agent_id) == bool(space_id):
            raise ServiceError(
                ErrorCode.INVALID_SCOPE,
                "agent_id 与 space_id 必须且只能提供一个",
                status=400,
            )
        if not self.access.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED,
                "无权访问该 Organization",
                status=403,
            )

        if agent_id:
            resolved_agent_id = _uuid_string(agent_id, "agent_id")
            agent = Agent.objects.filter(
                id=resolved_agent_id,
                organization_id=organization_id,
                is_active=True,
            ).first()
            if not agent:
                raise ServiceError(
                    ErrorCode.AGENT_NOT_FOUND,
                    "Agent 不存在或不可用",
                    status=404,
                )
            if not self.access.check_agent_owner(agent):
                raise ServiceError(
                    ErrorCode.AGENT_ACCESS_DENIED,
                    "无权使用该 Agent",
                    status=403,
                )
        else:
            resolved_space_id = _uuid_string(space_id, "space_id")
            from apps.tabtinspace.services.host_resolver import host_organization_id, resolve_host
            space = resolve_host(resolved_space_id)
            if (
                space is None
                or str(getattr(space, "organization_id", "")) != str(organization_id)
            ):
                space = None
            if not space or not self.access.check_space_permission(
                resolved_space_id, "viewer"
            ):
                raise ServiceError(
                    ErrorCode.SPACE_ACCESS_DENIED,
                    "无权访问该 Space",
                    status=403,
                )
            from apps.services.agent_engine.utils.memory_constants import (
                resolve_space_execution_agent_id,
            )

            resolved_agent_id = resolve_space_execution_agent_id(resolved_space_id)
            if not resolved_agent_id:
                raise ServiceError(
                    ErrorCode.AGENT_NOT_RESOLVED,
                    "该 Space 未绑定可用 Agent",
                    status=400,
                )
            agent = Agent.objects.filter(
                id=resolved_agent_id,
                organization_id=organization_id,
                is_active=True,
            ).first()
            if not agent:
                raise ServiceError(
                    ErrorCode.AGENT_NOT_FOUND,
                    "Agent 不存在或不可用",
                    status=404,
                )
            # 与 agent 直挂分支同一授权口径：记忆归属 = Agent owner × subject。
            # space 只用于解析执行 agent，不因 Space 成员身份扩张对他人 Agent
            # 的记忆读写权。团队 Space 多用户读路径见后续波次接口约定。
            if not self.access.check_agent_owner(agent):
                raise ServiceError(
                    ErrorCode.AGENT_ACCESS_DENIED,
                    "无权使用该 Agent",
                    status=403,
                )

        return MemoryScope(
            organization_id=organization_id,
            agent_id=str(resolved_agent_id),
            subject_user_id=str(self.user.id),
        )

    def _assert_subject_scope(self, scope: MemoryScope) -> None:
        if str(scope.subject_user_id) != str(self.user.id):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED,
                "记忆 subject 必须是当前用户",
                status=403,
            )

    def _memory_enabled(self, scope: MemoryScope) -> bool:
        """隐私总闸（ 读侧）：读 (subject, organization) 的 record_style.enabled。

        与 record() 写侧、画像 GET、蒸馏链路同一口径——``resolve_record_preference``
        读取异常时 fail-closed（返回 ``False``，不召回不返回）。用户关闭记忆后，
        list/get/stats 一律当作空，绝不返回既有记忆内容。
        """
        from apps.tabmemo.services.record_style_service import (
            resolve_record_preference,
        )

        enabled, _ = resolve_record_preference(
            scope.subject_user_id, scope.organization_id
        )
        return bool(enabled)

    def list_memories(
        self,
        *,
        scope: MemoryScope,
        search: str = "",
        memory_type: str = "",
        state: str = AgentMemory.Status.ACTIVE,
        cursor: str = "",
        limit: int = DEFAULT_PAGE_SIZE,
        governance_view: bool = False,
    ) -> dict:
        """列出当前 (org, agent, subject) 的记忆。

        ``governance_view``（ 治理闭环缺口）：默认 ``False``——总闸关闭时
        fail-closed 返回空页，这是运行时召回 / ``memory_search`` 工具的唯一
        契约，绝不能因为治理面板要看历史数据就放宽。治理面板（人工查看/忘记
        历史条目）显式传 ``True`` 时，总闸关闭也照常返回条目列表，**只是为了
        让用户能在关闭后仍找到旧记忆点「忘记」**——不代表运行时会重新召回或
        注入这些内容（召回路径永远不传本参数）。
        """
        self._assert_subject_scope(scope)
        search = (search or "").strip()
        if len(search) > MAX_SEARCH_CHARS:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                f"search 不能超过 {MAX_SEARCH_CHARS} 个字符",
                status=400,
            )
        if memory_type and memory_type not in AgentMemory.MemoType.values:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "memory_type 非法",
                status=400,
            )
        if state not in AgentMemory.Status.values:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "state 非法",
                status=400,
            )
        if cursor and not str(cursor).isdigit():
            raise ServiceError(
                ErrorCode.INVALID_CURSOR,
                "cursor 格式非法",
                status=400,
            )
        offset = int(cursor or 0)
        safe_limit = max(1, min(int(limit), MAX_PAGE_SIZE))
        memory_enabled = self._memory_enabled(scope)
        #  读侧总闸：记忆关闭时默认返回空页（fail-closed，与画像 GET 对称）——
        # 不召回、不返回任何既有记忆内容。governance_view=True 时例外放行读取
        # （见方法 docstring），运行时召回路径永远不传该参数。
        if not memory_enabled and not governance_view:
            return {
                "items": [],
                "next_cursor": "",
                "has_more": False,
                "limit": safe_limit,
                "memory_enabled": False,
            }
        rows, has_more = AgentMemoryRepository.list_page(
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
            state=state,
            search=search,
            memory_type=memory_type,
            offset=offset,
            limit=safe_limit,
        )
        return {
            "items": [self.serialize(memory) for memory in rows],
            "next_cursor": str(offset + safe_limit) if has_more else "",
            "has_more": has_more,
            "limit": safe_limit,
            "memory_enabled": memory_enabled,
        }

    def stats(self, *, scope: MemoryScope, governance_view: bool = False) -> dict:
        """按类型统计当前 (agent, subject, org) 的活跃记忆条数。

        与 ``list_memories`` 同一归属不变量：强制 (org, agent, subject) 且
        排除已遗忘行。用于日记 / 记忆面板的分类计数。``governance_view`` 语义
        与 ``list_memories`` 一致（ 治理闭环缺口）。
        """
        self._assert_subject_scope(scope)
        memory_enabled = self._memory_enabled(scope)
        #  读侧总闸：记忆关闭时统计默认恒零（fail-closed）——不泄漏「有多少条记忆」。
        if not memory_enabled and not governance_view:
            zero = {memo_type: 0 for memo_type in AgentMemory.MemoType.values}
            return {"total": 0, "memory_enabled": False, **zero}
        result = AgentMemoryRepository.stats_by_type(
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
        )
        return {**result, "memory_enabled": memory_enabled}

    def list_org_diary_feed(
        self,
        *,
        organization_id: str,
        search: str = "",
        state: str = AgentMemory.Status.ACTIVE,
        cursor: str = "",
        limit: int = DEFAULT_PAGE_SIZE,
    ) -> dict:
        """Organization 级跨 Agent diary 只读聚合。

        权限：Organization viewer + 当前用户拥有的 active Agent；subject 钉当前用户。
        普通日记页不接受 governance_view——关记忆后一律空页。
        兼容：只读 AgentMemory 正典（见 ``LEGACY_TABMEMO_DIARY_POLICY``）。
        """
        organization_id = _uuid_string(organization_id, "organization_id")
        if not self.access.check_organization_permission(organization_id, "viewer"):
            raise ServiceError(
                ErrorCode.PERMISSION_DENIED,
                "无权访问该 Organization",
                status=403,
            )
        search = (search or "").strip()
        if len(search) > MAX_SEARCH_CHARS:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                f"search 不能超过 {MAX_SEARCH_CHARS} 个字符",
                status=400,
            )
        if state not in AgentMemory.Status.values:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "state 非法",
                status=400,
            )
        safe_limit = max(1, min(int(limit), MAX_PAGE_SIZE))
        subject_user_id = str(self.user.id)
        probe_scope = MemoryScope(
            organization_id=organization_id,
            agent_id="",
            subject_user_id=subject_user_id,
        )
        memory_enabled = self._memory_enabled(probe_scope)
        if not memory_enabled:
            return {
                "items": [],
                "next_cursor": "",
                "has_more": False,
                "limit": safe_limit,
                "memory_enabled": False,
                "legacy_policy": LEGACY_TABMEMO_DIARY_POLICY,
            }

        agents = list(
            Agent.objects.filter(
                organization_id=organization_id,
                is_active=True,
            )
            .filter(self.access.owned_agent_filter())
            .only("id", "name", "settings")
        )
        agent_by_id = {str(agent.id): agent for agent in agents}
        agent_ids = list(agent_by_id.keys())
        cursor_created_at, cursor_id = _decode_diary_cursor(cursor)
        rows, has_more = AgentMemoryRepository.list_org_diary_page(
            organization_id=organization_id,
            agent_ids=agent_ids,
            subject_user_id=subject_user_id,
            state=state,
            search=search,
            cursor_created_at=cursor_created_at,
            cursor_id=cursor_id,
            limit=safe_limit,
        )
        items = [
            self.serialize_diary_feed_item(
                memory,
                agent=agent_by_id.get(str(memory.agent_id)),
            )
            for memory in rows
        ]
        next_cursor = ""
        if has_more and rows:
            next_cursor = _encode_diary_cursor(rows[-1].created_at, rows[-1].id)
        return {
            "items": items,
            "next_cursor": next_cursor,
            "has_more": has_more,
            "limit": safe_limit,
            "memory_enabled": memory_enabled,
            "legacy_policy": LEGACY_TABMEMO_DIARY_POLICY,
        }

    def serialize_diary_feed_item(
        self,
        memory: AgentMemory,
        *,
        agent: Optional[Agent] = None,
    ) -> dict:
        agent_name = ""
        agent_avatar = None
        if agent is not None:
            agent_name = agent.name or ""
            settings = agent.settings if isinstance(agent.settings, dict) else {}
            avatar_url = (settings.get("avatar_url") or "").strip()
            avatar_key = (settings.get("avatar_key") or "").strip()
            agent_avatar = avatar_url or avatar_key or None
        return {
            "id": str(memory.id),
            "agent_id": str(memory.agent_id),
            "agent_name": agent_name,
            "agent_avatar": agent_avatar,
            "memory_type": AgentMemory.MemoType.DIARY,
            "content": memory.content_markdown or memory.content_plaintext or "",
            "tags": list(memory.tags or []),
            "importance": memory.importance,
            "source_ref": memory.source_url or "",
            "created_at": memory.created_at.isoformat(),
            "updated_at": memory.updated_at.isoformat(),
        }

    def get_memory(self, *, scope: MemoryScope, memory_id: str) -> AgentMemory:
        self._assert_subject_scope(scope)
        #  读侧总闸：记忆关闭时按「不存在」处理（fail-closed）——不返回既有内容，
        # 与 forget 后排除、越权 404 同一表现，不区分「关了」与「本就没有」。
        if not self._memory_enabled(scope):
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "记忆不存在或无权访问",
                status=404,
            )
        memory = AgentMemoryRepository.get(
            memory_id=_uuid_string(memory_id, "memory_id"),
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
        )
        if not memory:
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "记忆不存在或无权访问",
                status=404,
            )
        return memory

    def record(
        self,
        *,
        scope: MemoryScope,
        memory_type: str,
        content: str,
        title: str = "",
        importance: Optional[int] = None,
        tags: Optional[list[str]] = None,
        source_ref: str = "",
    ) -> AgentMemory:
        self._assert_subject_scope(scope)
        # 隐私总闸：与 capture / task_summary / daily_diary 蒸馏链路同一口径，
        # 用户「全部关闭」（record_style enabled=False，或读取异常 fail-closed）
        # 时任何显式写记忆入口也必须停，不能只挡自动蒸馏。
        from apps.tabmemo.services.record_style_service import (
            resolve_record_preference,
        )

        enabled, _ = resolve_record_preference(
            scope.subject_user_id, scope.organization_id
        )
        if not enabled:
            raise ServiceError(
                ErrorCode.RECORD_DISABLED,
                "记忆记录已关闭，无法写入",
                status=409,
            )
        content = (content or "").strip()
        if not content:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "content 不能为空",
                status=400,
            )
        if memory_type not in AgentMemory.MemoType.values:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "memory_type 非法",
                status=400,
            )
        if importance is not None and not 1 <= importance <= 5:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "importance 必须在 1-5 之间",
                status=400,
            )
        return AgentMemory.objects.create(
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            owner_id=scope.subject_user_id,
            memo_type=memory_type,
            title=(title or "").strip(),
            content_plaintext=content,
            content_markdown=content,
            importance=importance,
            tags=list(tags or []),
            source_url=source_ref or "",
        )

    @transaction.atomic
    def correct(
        self,
        *,
        scope: MemoryScope,
        memory_id: str,
        content: str,
        memory_type: Optional[str] = None,
    ) -> AgentMemory:
        self._assert_subject_scope(scope)
        # 隐私总闸：correct 会归档原行并**新建替代记忆行**（写入新内容 = 记），
        # 与 record 同口径过总闸——关闭时不再写入（invariant「写入过隐私总闸」）。
        # 对比：forget / archive 是「删除/移除」，即便总闸关闭也应放行（清理永远允许）。
        if not self._memory_enabled(scope):
            raise ServiceError(
                ErrorCode.RECORD_DISABLED,
                "记忆记录已关闭，无法更正",
                status=409,
            )
        content = (content or "").strip()
        if not content:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "content 不能为空",
                status=400,
            )
        if memory_type is not None and memory_type not in AgentMemory.MemoType.values:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "memory_type 非法",
                status=400,
            )
        original = AgentMemoryRepository.get(
            memory_id=_uuid_string(memory_id, "memory_id"),
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
            for_update=True,
        )
        if not original or original.status != AgentMemory.Status.ACTIVE:
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "可修正的记忆不存在或无权访问",
                status=404,
            )

        original.status = AgentMemory.Status.ARCHIVED
        original.save(update_fields=["status", "updated_at"])
        return AgentMemory.objects.create(
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            owner_id=scope.subject_user_id,
            memo_type=memory_type or original.memo_type,
            title=original.title,
            content_plaintext=content,
            content_markdown=content,
            importance=original.importance,
            tags=list(original.tags or []),
            ai_tags=list(original.ai_tags or []),
            source_url=original.source_url,
            supersedes=original,
        )

    @transaction.atomic
    def archive(self, *, scope: MemoryScope, memory_id: str) -> bool:
        self._assert_subject_scope(scope)
        memory = AgentMemoryRepository.get(
            memory_id=_uuid_string(memory_id, "memory_id"),
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
            for_update=True,
        )
        if not memory:
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "记忆不存在或无权访问",
                status=404,
            )
        if memory.status == AgentMemory.Status.ARCHIVED:
            return False
        memory.status = AgentMemory.Status.ARCHIVED
        memory.save(update_fields=["status", "updated_at"])
        return True

    @transaction.atomic
    def forget(self, *, scope: MemoryScope, memory_id: str) -> bool:
        self._assert_subject_scope(scope)
        memory = AgentMemoryRepository.get(
            memory_id=_uuid_string(memory_id, "memory_id"),
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
            include_forgotten=True,
            for_update=True,
        )
        if not memory:
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "记忆不存在或无权访问",
                status=404,
            )
        if memory.forgotten_at is not None:
            return False
        memory.status = AgentMemory.Status.ARCHIVED
        memory.forgotten_at = timezone.now()
        memory.save(update_fields=["status", "forgotten_at", "updated_at"])
        return True

    @transaction.atomic
    def adjust_importance(
        self,
        *,
        scope: MemoryScope,
        memory_id: str,
        importance: Optional[int] = None,
        useful: Optional[bool] = None,
    ) -> AgentMemory:
        """更新记忆重要度 / 处理「有用」反馈（ 前端记忆治理）。

        - ``importance``：设定绝对重要度（1-5）。
        - ``useful``：轻量反馈——``True`` 上调一档、``False`` 下调一档（1-5 内夹取），
          并在 ``useful=True`` 时累计 ``access_count``（沿用后台 importance_adjust
          的「命中/有用」信号维度）。
        - 归属强制 (org, agent, subject)；``forgotten`` 行与非活跃行拒绝（走
          ``AgentMemoryRepository.get`` 默认排除 forgotten，非 ACTIVE 显式 404）。
        - 同时给定 ``importance`` 与 ``useful`` 时以 ``importance`` 绝对值为准。

        隐私总闸：**刻意不 gate**。这里只调整既有活跃行的 importance / access_count
        （元数据，不写入新内容、不 recall、不 inject），且总闸关闭时读侧已 fail-closed、
        UI 根本取不到该行来反馈——留白与「correct=记 → gate」「forget=删 → 放行」的
        划分一致：只有「写入新内容」才过总闸。
        """
        self._assert_subject_scope(scope)
        if importance is None and useful is None:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "importance 与 useful 至少提供一个",
                status=400,
            )
        if importance is not None and not 1 <= importance <= 5:
            raise ServiceError(
                ErrorCode.INVALID_CONTENT,
                "importance 必须在 1-5 之间",
                status=400,
            )
        memory = AgentMemoryRepository.get(
            memory_id=_uuid_string(memory_id, "memory_id"),
            organization_id=scope.organization_id,
            agent_id=scope.agent_id,
            subject_user_id=scope.subject_user_id,
            for_update=True,
        )
        if not memory or memory.status != AgentMemory.Status.ACTIVE:
            raise ServiceError(
                ErrorCode.MEMORY_NOT_FOUND,
                "记忆不存在或无权访问",
                status=404,
            )

        update_fields = ["importance", "updated_at"]
        if importance is not None:
            memory.importance = importance
        else:
            base = memory.importance if memory.importance is not None else 3
            memory.importance = (
                min(5, base + 1) if useful else max(1, base - 1)
            )
            if useful:
                memory.access_count = (memory.access_count or 0) + 1
                update_fields.append("access_count")
        memory.save(update_fields=update_fields)
        return memory

    @staticmethod
    def serialize(memory: AgentMemory) -> dict:
        return {
            "id": str(memory.id),
            "organization_id": str(memory.organization_id),
            "agent_id": str(memory.agent_id),
            "subject_user_id": str(memory.owner_id),
            "memory_type": memory.memo_type,
            "title": memory.title or "",
            "content": memory.content_markdown or memory.content_plaintext or "",
            "importance": memory.importance,
            "tags": list(memory.tags or []),
            "state": memory.status,
            "source_ref": memory.source_url or "",
            "supersedes_memory_id": (
                str(memory.supersedes_id) if memory.supersedes_id else None
            ),
            "created_at": memory.created_at.isoformat(),
            "updated_at": memory.updated_at.isoformat(),
            # ：检索层可观测分数（命中不同关键词个数）；未走 search 打分
            # 路径时为 None。候选集隐含阈值（score>=1），低于阈值的行不会进结果。
            "score": read_score(memory),
        }
