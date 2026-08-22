"""
重要性动态调整任务 — 定时扫描 AgentMemory 表：
1. 高 access_count（≥ 5）且 importance < 5 → 升级 importance（保留 50% 历史访问）
2. 长期未被召回 → 分级归档：
   - importance < 3：30 天无访问即归档
   - importance 3-4：90 天保护期，之后才归档
   - importance = 5：不因零访问而自动归档

#3266 M4.5/C5：读写独立 AgentMemory 表（分家拆表后）。

Beat 调度：每 12 小时运行一次。
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from celery import shared_task

logger = logging.getLogger(__name__)

ACCESS_COUNT_PROMOTE_THRESHOLD = 5
STALE_DAYS = 30
EXTENDED_STALE_DAYS = 90


@shared_task(
    bind=True,
    ignore_result=True,
    max_retries=0,
    time_limit=120,
    soft_time_limit=100,
)
def adjust_memory_importance_task(self, space_id: str, user_id: str):
    """扫描 AgentMemory 表并调整 importance / 归档过期记忆（per-(user, organization) 维度）。"""
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    from apps.services.agent_engine.utils.memory_locks import space_memory_lock

    if not MemoryTableService.is_memory_enabled_for(user_id, space_id):
        return

    # 锁粒度细化到 (space, user)：同一 Space 下不同用户互不阻塞，各自隔离 owner_id 子集。
    with space_memory_lock(
        f"{space_id}:{user_id}", timeout=130, blocking_timeout=10,
    ) as acquired:
        if not acquired:
            logger.info(
                "[ImportanceAdjust] Lock contention, skip space=%s user=%s", space_id, user_id,
            )
            return

        try:
            promoted, archived = _scan_and_adjust(space_id, user_id)
            if promoted or archived:
                logger.info(
                    "[ImportanceAdjust] space=%s promoted=%d archived=%d",
                    space_id, promoted, archived,
                )
        except Exception as exc:
            logger.error("[ImportanceAdjust] Failed: %s", exc, exc_info=True)


def _scan_and_adjust(space_id: str, owner_id: str) -> tuple:
    """返回 (promoted_count, archived_count)。

    TM-19：按 owner_id 过滤，只处理当前 (space, user) 的 memo，避免共享 Space 下
    误升级/误归档他人用户的记忆。
    """
    from apps.agent_memory.models import AgentMemory
    from apps.services.agent_engine.utils.memory_constants import (
        AGENT_MEMO_TYPES,
        get_agent_memo_queryset,
        get_memo_queryset,
    )

    stale_cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)
    extended_stale_cutoff = datetime.now(timezone.utc) - timedelta(days=EXTENDED_STALE_DAYS)

    promoted = 0
    archived = 0
    embedding_failures = 0

    memos = list(
        get_agent_memo_queryset(space_id)
        .filter(memo_type__in=list(AGENT_MEMO_TYPES), owner_id=owner_id)
        .order_by("-created_at")[:500]
    )

    memo_qs = get_memo_queryset()

    for memo in memos:
        access_count = memo.access_count or 0
        importance = memo.importance or 0

        # --- MEM-P1-39: promote 保留 50% 历史访问次数，避免升级后信息销毁 ---
        if access_count >= ACCESS_COUNT_PROMOTE_THRESHOLD and importance < 5:
            new_imp = min(importance + 1, 5)
            halved_count = access_count // 2
            try:
                memo_qs.filter(id=memo.id).update(
                    importance=new_imp,
                    access_count=halved_count,
                )
                promoted += 1
                logger.info(
                    "[ImportanceAdjust] 记忆升级 memo=%s, importance: %d→%d, access_count: %d→%d",
                    memo.id, importance, new_imp, access_count, halved_count,
                )
            except Exception as exc:
                logger.warning("[ImportanceAdjust] Promote failed memo=%s: %s", memo.id, exc)
            continue

        if _should_archive_stale_memo(
            access_count=access_count,
            importance=importance,
            created_at=memo.created_at,
            stale_cutoff=stale_cutoff,
            extended_stale_cutoff=extended_stale_cutoff,
        ):
            try:
                memo_qs.filter(id=memo.id).update(
                    status=AgentMemory.Status.ARCHIVED,
                )
                archived += 1
                if not _cleanup_archived_embedding(str(memo.id)):
                    embedding_failures += 1
            except Exception as exc:
                logger.warning("[ImportanceAdjust] Archive failed memo=%s: %s", memo.id, exc)

    if embedding_failures:
        logger.error(
            "[ImportanceAdjust:METRIC] space=%s embedding_cleanup_failures=%d "
            "— 补偿清扫任务 sweep_orphaned_archived_embeddings 将兜底处理",
            space_id, embedding_failures,
        )

    return (promoted, archived)


def _should_archive_stale_memo(
    *,
    access_count: int,
    importance: int,
    created_at: datetime | None,
    stale_cutoff: datetime,
    extended_stale_cutoff: datetime,
) -> bool:
    """分级归档判据：access_count==0 且超过保护期才归档；importance=5 永不自动归档。"""
    if access_count != 0 or importance >= 5 or not created_at:
        return False
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    if importance < 3:
        return created_at < stale_cutoff
    if 3 <= importance <= 4:
        return created_at < extended_stale_cutoff
    return False


def _cleanup_archived_embedding(memo_id: str) -> bool:
    """归档后尝试删除对应的 embedding。返回 True 表示成功（含无需清理），False 表示失败。"""
    try:
        from apps.rag.models import RecordEmbedding
        deleted, _ = RecordEmbedding.objects.filter(record_id=memo_id).delete()
        if deleted:
            logger.info("[ImportanceAdjust] 已清理归档记忆 embedding memo=%s, count=%d", memo_id, deleted)
        return True
    except Exception as exc:
        logger.error(
            "[ImportanceAdjust:EMBEDDING_CLEANUP_FAILED] memo_id=%s error=%s "
            "— 已归档 Memo 的 embedding 残留，等待补偿清扫任务处理",
            memo_id, exc, exc_info=True,
        )
        return False


@shared_task(
    bind=True,
    ignore_result=True,
    max_retries=0,
    time_limit=180,
    soft_time_limit=160,
)
def sweep_orphaned_archived_embeddings(self):
    """补偿清扫任务：删除已归档 Memo 残留在 rag 表中的 embedding（S2-052 兜底）。

    Beat 调度：每 24 小时运行一次，与 importance_adjust 错峰。
    """
    from apps.agent_memory.models import AgentMemory
    from apps.agent_memory.repository import AgentMemoryRepository
    from apps.rag.models import RecordEmbedding

    BATCH_SIZE = 500
    MAX_SCAN = 5000
    total_deleted = 0
    total_scanned = 0

    # ：AgentMemory 读收口到新领域仓储 base_qs（router 路由，不显式 using）。
    archived_qs = (
        AgentMemoryRepository.base_qs()
        .filter(status=AgentMemory.Status.ARCHIVED)
        .values_list("id", flat=True)
        .order_by("-updated_at")[:MAX_SCAN]
    )
    archived_ids = list(archived_qs)
    if not archived_ids:
        return

    for i in range(0, len(archived_ids), BATCH_SIZE):
        batch = archived_ids[i : i + BATCH_SIZE]
        total_scanned += len(batch)
        try:
            deleted, _ = RecordEmbedding.objects.filter(
                record_id__in=batch,
            ).delete()
            total_deleted += deleted
        except Exception as exc:
            logger.error(
                "[EmbeddingSweep] Batch delete failed at offset=%d: %s",
                i, exc, exc_info=True,
            )

    if total_deleted:
        logger.warning(
            "[EmbeddingSweep:METRIC] cleaned=%d orphaned_embeddings scanned=%d archived_memos",
            total_deleted, total_scanned,
        )
    else:
        logger.info(
            "[EmbeddingSweep] No orphaned embeddings found (scanned=%d)",
            total_scanned,
        )


_DISPATCH_CURSOR_KEY = "orch:importance_adjust:dispatch_cursor"
_DISPATCH_CURSOR_TTL = 3600 * 24


def _parse_pair_cursor(raw):
    """解析复合游标 b"{space_id}:{owner_id}" → (space_id, owner_id) 字符串对。

    空值或旧版单值游标（仅 space_id、无冒号）→ (None, None)，等价从头开始，
    安全兼容历史 Redis 残留。
    """
    if not raw:
        return None, None
    text = raw.decode() if isinstance(raw, bytes) else str(raw)
    if ":" not in text:
        return None, None
    space_part, _, owner_part = text.partition(":")
    return (space_part or None), (owner_part or None)


@shared_task(ignore_result=True, time_limit=120, soft_time_limit=100)
def dispatch_importance_adjust_for_all_spaces():
    """Beat 入口：从 agent memo 取 distinct (space_id, owner_id)，逐对 per-uw gate 后错峰分发。

    记忆是 per-(user, organization) 维度，按 (space_id, owner_id) 对操作，而非遍历 Space
    猜单一 owner（Space 无 owner 字段，旧实现 .only("owner_id") 求值即抛 FieldError）。
    使用 Redis 持久化复合游标 "{space}:{owner}"，超时后下次 Beat 从断点续跑。
    """
    from celery.exceptions import SoftTimeLimitExceeded
    from django.db.models import Q
    from django_redis import get_redis_connection
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    from apps.services.agent_engine.utils.memory_constants import get_agent_memo_queryset

    PAGE_SIZE = 50
    rc = get_redis_connection("default")

    last_space, last_owner = _parse_pair_cursor(rc.get(_DISPATCH_CURSOR_KEY))
    dispatched = 0

    try:
        while True:
            #  M4.5/C5：记忆表挂 agent 维度，分发对偶为 (agent_id, owner_id)，
            # 批量反查 workspace 供任务签名（无 workspace 的 agent 跳过维护）。
            pairs_qs = (
                get_agent_memo_queryset()
                .filter(owner_id__isnull=False)
                .values_list("agent_id", "owner_id")
                .distinct()
                .order_by("agent_id", "owner_id")
            )
            if last_space is not None and last_owner is not None:
                # keyset 分页：(agent_id, owner_id) > 游标（旧 space:owner 游标
                # 语义已变，_parse_pair_cursor 兼容路径会让首轮全量重跑一次）
                pairs_qs = pairs_qs.filter(
                    Q(agent_id__gt=last_space)
                    | Q(agent_id=last_space, owner_id__gt=last_owner)
                )
            page = list(pairs_qs[:PAGE_SIZE])
            if not page:
                break

            from apps.services.agent_engine.utils.memory_constants import (
                resolve_workspace_space_ids_for_agents,
            )
            space_map = resolve_workspace_space_ids_for_agents(
                [agent_id for agent_id, _ in page]
            )

            for agent_id, owner_id in page:
                resolved_space = space_map.get(agent_id)
                if not resolved_space:
                    continue
                space_id_str = str(resolved_space)
                owner_id_str = str(owner_id)
                if not MemoryTableService.is_memory_enabled_for(owner_id_str, space_id_str):
                    continue
                try:
                    adjust_memory_importance_task.apply_async(
                        kwargs={
                            "space_id": space_id_str,
                            "user_id": owner_id_str,
                        },
                        countdown=5 + dispatched * 2,
                    )
                    dispatched += 1
                except Exception as exc:
                    logger.warning(
                        "[Memory] dispatch failed for space=%s owner=%s: %s",
                        space_id_str, owner_id_str, exc,
                    )
                    continue

            last_space, last_owner = str(page[-1][0]), str(page[-1][1])  # agent:owner 游标
            rc.set(_DISPATCH_CURSOR_KEY, f"{last_space}:{last_owner}", ex=_DISPATCH_CURSOR_TTL)

            if len(page) < PAGE_SIZE:
                rc.delete(_DISPATCH_CURSOR_KEY)
                break
    except SoftTimeLimitExceeded:
        if last_space is not None and last_owner is not None:
            rc.set(_DISPATCH_CURSOR_KEY, f"{last_space}:{last_owner}", ex=_DISPATCH_CURSOR_TTL)
        logger.warning(
            "[ImportanceAdjust] dispatch timed out after %d tasks, cursor saved at %s:%s — will resume next beat",
            dispatched, last_space, last_owner,
        )
        return

    if dispatched:
        logger.info("[ImportanceAdjust] Dispatched %d tasks (paged, per-uw)", dispatched)


IMPORTANCE_BEAT_SCHEDULE = {
    "memory-importance-adjust-every-12h": {
        "task": "apps.services.agent_engine.tasks.memory.importance_adjust.dispatch_importance_adjust_for_all_spaces",
        "schedule": 12 * 3600,
        "options": {"queue": "default"},
    },
    "memory-embedding-sweep-every-24h": {
        "task": "apps.services.agent_engine.tasks.memory.importance_adjust.sweep_orphaned_archived_embeddings",
        "schedule": 24 * 3600,
        "options": {"queue": "default"},
    },
}
