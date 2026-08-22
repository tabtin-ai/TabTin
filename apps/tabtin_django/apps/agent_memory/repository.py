from __future__ import annotations

from typing import Optional
from uuid import UUID

from django.db.models import Count, Q, QuerySet

from apps.agent_memory.models import AgentMemory
from apps.agent_memory.search import apply_keyword_search, rank_by_search_score


class AgentMemoryRepository:
    """Persistence seam for the standalone ``agent_memory`` domain model.

    ``AgentMemory`` 属独立 ``agent_memory`` app（``app_label="agent_memory"``，
    ``db_table="agent_memory_entry"``），其读写由 ``apps/agent_memory/db_router.py``
    （``route_app_labels={"agent_memory"}``）统一路由到与 TabMemo 相同的 PG 库
    ——因此这里不显式 ``.using()``：交给 router 既在 single_pg 也在双库模式下
    正确，且避免与「default 镜像连接」split 造成 ``select_for_update`` 跨连接锁
    等待（manage.py test 下的真实镜像连接， W1 教训）。

    ：本仓储是 AgentMemory 的**唯一读写 seam**——所有后端消费方
    （召回 / 蒸馏管道 / 维护任务 / 兼容路由）都经此收口，禁止各自裸
    ``AgentMemory.objects.*``。``base_qs`` / ``create`` 是给「无当前登录 subject」
    的服务端内部管道用的底座；``scoped`` 及其派生方法是给「有 subject 归属」的
    召回 / 面板读取用的强隔离入口。
    """

    # ── 底座（服务端内部管道：无 subject 上下文，调用方自行圈定范围） ──

    @staticmethod
    def base_qs() -> QuerySet:
        """AgentMemory 的规范基础 QuerySet（router 路由，不显式 using）。

        取代散落各处的显式 ``.using()`` / 旧 ``agent_memory_qs()``——它们现在
        都委托到这里，让「基础 QuerySet 从哪来」只有一个出处。调用方负责叠加
        status / owner / agent 等过滤。
        """
        return AgentMemory.objects.all()

    @staticmethod
    def create(
        *,
        agent_id: str,
        organization_id: str,
        owner_id: Optional[str],
        memo_type: str,
        content_markdown: str = "",
        content_plaintext: str = "",
        content_json: Optional[dict] = None,
        tags: Optional[list] = None,
        ai_tags: Optional[list] = None,
        importance: Optional[int] = None,
        source_url: str = "",
    ) -> AgentMemory:
        """写入一条 Agent 记忆（服务端蒸馏 / 工具管道的规范写入口）。

        强制归属三键：``agent_id`` / ``organization_id`` / ``owner_id`` 必填——
        无法确认归属时明确失败，绝不写无主行（与  一致）。``memo_type`` 非
        记忆类型时归一为 ``about_you``。router 路由写库，不显式 using。
        """
        if not agent_id:
            raise ValueError("agent_id is required for AgentMemory")
        if not organization_id:
            raise ValueError("organization_id is required for AgentMemory")
        if not owner_id:
            raise ValueError("owner_id is required for AgentMemory")
        if memo_type not in set(AgentMemory.MemoType.values):
            memo_type = AgentMemory.MemoType.ABOUT_YOU

        plaintext = content_plaintext or content_markdown
        return AgentMemory.objects.create(
            agent_id=agent_id,
            organization_id=organization_id,
            owner_id=owner_id,
            memo_type=memo_type,
            content_markdown=content_markdown,
            content_plaintext=plaintext,
            content_json=content_json if content_json is not None else {},
            tags=list(tags or []),
            ai_tags=list(ai_tags or []),
            importance=importance,
            source_url=source_url or "",
        )

    @staticmethod
    def scoped(
        *,
        organization_id: str,
        agent_id: str,
        subject_user_id: str,
        include_forgotten: bool = False,
    ) -> QuerySet:
        queryset = AgentMemory.objects.filter(
            organization_id=organization_id,
            agent_id=agent_id,
            owner_id=subject_user_id,
        )
        if not include_forgotten:
            queryset = queryset.filter(forgotten_at__isnull=True)
        return queryset

    @classmethod
    def aggregate_scope(
        cls,
        *,
        organization_id: str,
        agent_id: str,
        subject_user_id: str,
    ) -> QuerySet:
        """Diary / Portrait / Compaction 共用的强隔离查询入口。"""
        if not organization_id or not agent_id or not subject_user_id:
            return cls.base_qs().none()
        return cls.scoped(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=subject_user_id,
        )

    @classmethod
    def list_page(
        cls,
        *,
        organization_id: str,
        agent_id: str,
        subject_user_id: str,
        state: str,
        search: str,
        memory_type: str,
        offset: int,
        limit: int,
        since: Optional[object] = None,
    ) -> tuple[list[AgentMemory], bool]:
        queryset = cls.scoped(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=subject_user_id,
        ).filter(status=state)
        if memory_type:
            queryset = queryset.filter(memo_type=memory_type)
        if since:
            queryset = queryset.filter(created_at__gt=since)

        queryset = queryset.order_by("-created_at", "-id")
        if search:
            filtered = apply_keyword_search(queryset, search)
            if filtered is not queryset:
                rows = rank_by_search_score(list(filtered), search)
                has_more = len(rows) > offset + limit
                return rows[offset : offset + limit], has_more

        rows = list(queryset[offset : offset + limit + 1])
        has_more = len(rows) > limit
        return rows[:limit], has_more

    @classmethod
    def get(
        cls,
        *,
        memory_id: str,
        organization_id: str,
        agent_id: str,
        subject_user_id: str,
        include_forgotten: bool = False,
        for_update: bool = False,
    ) -> Optional[AgentMemory]:
        queryset = cls.scoped(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=subject_user_id,
            include_forgotten=include_forgotten,
        )
        if for_update:
            queryset = queryset.select_for_update()
        return queryset.filter(id=memory_id).first()

    @classmethod
    def stats_by_type(
        cls,
        *,
        organization_id: str,
        agent_id: str,
        subject_user_id: str,
    ) -> dict:
        """按 memo_type 统计当前 (org, agent, subject) 的活跃、未遗忘记忆条数。"""
        rows = (
            cls.scoped(
                organization_id=organization_id,
                agent_id=agent_id,
                subject_user_id=subject_user_id,
            )
            .filter(status=AgentMemory.Status.ACTIVE)
            .values("memo_type")
            .annotate(cnt=Count("id"))
        )
        result = {memo_type: 0 for memo_type in AgentMemory.MemoType.values}
        total = 0
        for row in rows:
            result[row["memo_type"]] = row["cnt"]
            total += row["cnt"]
        return {"total": total, **result}

    @classmethod
    def list_org_diary_page(
        cls,
        *,
        organization_id: str,
        agent_ids: list[str],
        subject_user_id: str,
        state: str,
        search: str,
        cursor_created_at,
        cursor_id: Optional[str],
        limit: int,
    ) -> tuple[list[AgentMemory], bool]:
        """Organization 级跨 Agent diary 分页（keyset on ``(-created_at, -id)``）。

        只读聚合：强制 subject=当前用户、agent_id ∈ 可用集合、memo_type=diary、
        排除 forgotten。search 走统一检索层过滤，排序仍钉新鲜度以便稳定 cursor。
        """
        if not agent_ids:
            return [], False

        queryset = (
            AgentMemory.objects.filter(
                organization_id=organization_id,
                agent_id__in=agent_ids,
                owner_id=subject_user_id,
                forgotten_at__isnull=True,
                status=state,
                memo_type=AgentMemory.MemoType.DIARY,
            )
        )
        if search:
            queryset = apply_keyword_search(queryset, search)
        # 聚合 feed 的 cursor 契约是 (created_at, id)，search 只过滤不改序。
        queryset = queryset.order_by("-created_at", "-id")
        if cursor_created_at is not None and cursor_id:
            try:
                cursor_uuid = UUID(str(cursor_id))
            except (TypeError, ValueError):
                cursor_uuid = None
            if cursor_uuid is not None:
                queryset = queryset.filter(
                    Q(created_at__lt=cursor_created_at)
                    | Q(created_at=cursor_created_at, id__lt=cursor_uuid)
                )

        rows = list(queryset[: limit + 1])
        has_more = len(rows) > limit
        return rows[:limit], has_more
