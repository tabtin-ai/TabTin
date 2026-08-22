"""
记忆合并/压缩任务 — 定时扫描 AgentMemory 表，
将文本相似度 > 阈值的记忆对用 LLM 合并为精炼版本。

#3266 M4.5/C5：读写独立 AgentMemory 表（分家拆表后）。

Beat 调度：每 6 小时运行一次，每次最多处理 5 组重复。
"""

from __future__ import annotations

import json
import hashlib
import logging
from typing import Any, Dict, List, Optional

from celery import shared_task

logger = logging.getLogger(__name__)

MERGE_SIMILARITY_THRESHOLD = 0.75
MAX_MERGE_GROUPS_PER_RUN = 5


class CompactionPersistenceError(RuntimeError):
    """The Provider completed but the merged-memory write did not commit."""


def _parse_memory_compaction_result(content: str) -> Dict[str, Any]:
    from apps.services.agent_engine.utils.memory_utils import strip_code_fence

    try:
        merged = json.loads(strip_code_fence(content))
    except json.JSONDecodeError as exc:
        raise ValueError("memory_compaction 结果不是合法 JSON") from exc
    if not isinstance(merged, dict) or not merged.get("content"):
        raise ValueError("memory_compaction 结果缺少 content")
    return merged


def validate_memory_compaction_result(content: str) -> None:
    """Validate the existing compaction parser contract before settlement."""
    _parse_memory_compaction_result(content)



@shared_task(
    bind=True,
    ignore_result=True,
    max_retries=2,
    default_retry_delay=60,
    time_limit=300,
    soft_time_limit=280,
    # P0: queue 由 CELERY_TASK_ROUTES → ai_background 控制，禁止 decorator 绑部署拓扑
)
def compact_memories_task(
    self, space_id: str, user_id: str, selected_model_id: str = ""
):
    """扫描并合并高度相似的记忆片段（v2：基于 Memo 表，per-(user, organization) 维度）。"""
    from celery.exceptions import SoftTimeLimitExceeded
    from apps.services.common.thread_context import clear_context
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    from apps.services.agent_engine.utils.memory_locks import space_memory_lock

    clear_context()

    try:
        from apps.services.billing.organization_resolver import (
            resolve_organization_id_from_space,
        )
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )

        organization_id = resolve_organization_id_from_space(space_id) or ""
        execution = resolve_workspace_memory_worker(
            scene_key="memory_compaction",
            organization_id=organization_id,
            user_id=user_id,
            selected_model_id=selected_model_id,
        )
        if not execution.enabled:
            return
        if not MemoryTableService.is_memory_enabled_for(user_id, space_id):
            return

        lock_ttl = compact_memories_task.time_limit + 30
        # 锁粒度细化到 (space, user)：同一 Space 下不同用户的维护任务互不阻塞，
        # 各自只处理 owner_id 隔离的 memo 子集。
        with space_memory_lock(
            f"{space_id}:{user_id}", timeout=lock_ttl, blocking_timeout=10,
        ) as acquired:
            if not acquired:
                logger.info(
                    "[Compaction] Lock contention, skip space=%s user=%s", space_id, user_id,
                )
                return

            try:
                groups = _find_similar_groups(space_id, user_id)
                if not groups:
                    logger.debug("[Compaction] No similar groups found for space=%s", space_id)
                    return

                merged_count = 0
                celery_task_id = str(getattr(self.request, "id", "") or "")
                for group in groups[:MAX_MERGE_GROUPS_PER_RUN]:
                    ok = _merge_group(
                        group,
                        space_id,
                        user_id,
                        task_id=celery_task_id,
                        selected_model_id=execution.selected_model_id,
                    )
                    if ok:
                        merged_count += 1

                logger.info(
                    "[Compaction] Merged %d/%d groups for space=%s",
                    merged_count, len(groups), space_id,
                )
            except SoftTimeLimitExceeded:
                logger.error(
                    "[Compaction] SoftTimeLimitExceeded: space=%s — not retrying", space_id,
                )
            except Exception as exc:
                logger.error("[Compaction] Failed for space=%s: %s", space_id, exc, exc_info=True)
                raise self.retry(exc=exc)
    finally:
        clear_context()


def _find_similar_groups(space_id: str, owner_id: str) -> List[List[Dict[str, Any]]]:
    """找出 AgentMemory 表中文本相似度 > 阈值的记忆组（Jaccard bigram）。

    TM-19：按 owner_id 过滤，只在同一 (space, user) 的 memo 内合并——避免共享
    Space 下把用户 A 的记忆 LLM 改写后归属给 B、并把 A 的原件归档的隐私 bug。
    """
    from apps.agent_memory.repository import AgentMemoryRepository
    from apps.services.agent_engine.utils.memory_constants import (
        AGENT_MEMO_TYPES,
        resolve_space_execution_agent_id,
    )
    from apps.services.billing.organization_resolver import (
        resolve_organization_id_from_space,
    )

    organization_id = resolve_organization_id_from_space(space_id) or ""
    agent_id = resolve_space_execution_agent_id(space_id) or ""
    if not organization_id or not agent_id or not owner_id:
        return []

    memos = list(
        AgentMemoryRepository.aggregate_scope(
            organization_id=organization_id,
            agent_id=agent_id,
            subject_user_id=owner_id,
        )
        .filter(memo_type__in=list(AGENT_MEMO_TYPES))
        .order_by("-created_at")[:200]
    )

    if len(memos) < 2:
        return []

    memo_data = []
    for m in memos:
        content = m.content_plaintext or m.content_markdown or ""
        if not content.strip():
            continue
        memo_data.append({
            "memo_id": str(m.id),
            "organization_id": str(m.organization_id),
            "owner_id": str(m.owner_id),
            "agent_id": str(m.agent_id),
            "content": content.strip(),
            "memo_type": m.memo_type,
            "importance": m.importance,
            "tags": m.tags or [],
        })

    if len(memo_data) < 2:
        return []

    token_sets = {md["memo_id"]: _tokenize(md["content"].lower()) for md in memo_data}

    used: set = set()
    groups: List[List[Dict[str, Any]]] = []

    for i in range(len(memo_data)):
        mid_i = memo_data[i]["memo_id"]
        if mid_i in used:
            continue

        set_i = token_sets[mid_i]
        if not set_i:
            continue

        group = [memo_data[i]]

        for j in range(i + 1, len(memo_data)):
            mid_j = memo_data[j]["memo_id"]
            if mid_j in used:
                continue
            set_j = token_sets[mid_j]
            if not set_j:
                continue

            all_similar = all(
                _jaccard(token_sets[g["memo_id"]], set_j) >= MERGE_SIMILARITY_THRESHOLD
                for g in group
            )
            if all_similar:
                group.append(memo_data[j])

        if len(group) >= 2:
            for g in group:
                used.add(g["memo_id"])
            groups.append(group)

    return groups


_CJK_SAMPLE_SIZE = 500
_CJK_RATIO_THRESHOLD = 0.1


def _tokenize(text: str) -> set:
    """分词：中文用 bigram，其它语言按空格分词。扫描前 500 字符按 CJK 比例决定策略。"""
    sample = text[:_CJK_SAMPLE_SIZE]
    non_space = [c for c in sample if not c.isspace()]
    if not non_space:
        return set()

    cjk_count = sum(1 for c in non_space if "\u4e00" <= c <= "\u9fff")
    cjk_ratio = cjk_count / len(non_space)

    if cjk_ratio >= _CJK_RATIO_THRESHOLD:
        cleaned = "".join(c for c in text if not c.isspace())
        if len(cleaned) < 2:
            return {cleaned} if cleaned else set()
        return {cleaned[i : i + 2] for i in range(len(cleaned) - 1)}
    return set(text.split())


def _jaccard(set_a: set, set_b: set) -> float:
    if not set_a or not set_b:
        return 0.0
    intersection = len(set_a & set_b)
    union = len(set_a | set_b)
    return intersection / union if union else 0.0


def _merge_group(
    group: List[Dict[str, Any]],
    space_id: str,
    user_id: str,
    task_id: str = "",
    selected_model_id: str = "",
) -> bool:
    """用 LLM 合并一组相似记忆，写入新 Memo 并归档旧 Memo。"""
    from apps.services.agent_engine.utils.memory_constants import normalize_agent_memo_type
    from apps.services.llm.services.chat import unified_llm_call
    from apps.services.billing.organization_resolver import resolve_organization_id_from_space

    organization_id = resolve_organization_id_from_space(space_id) or ""
    if not organization_id:
        return False

    from apps.agent_memory.isolation import (
        MemoryAggregationScope,
        assert_compaction_group_scope,
    )
    from apps.services.agent_engine.utils.memory_constants import (
        resolve_space_execution_agent_id,
    )

    agent_id = resolve_space_execution_agent_id(space_id) or ""
    if not agent_id:
        return False
    assert_compaction_group_scope(
        MemoryAggregationScope(
            organization_id=organization_id,
            subject_user_id=user_id,
            agent_id=agent_id,
        ),
        group,
    )
    group_text = "\n---\n".join(g.get("content", "") for g in group)

    memo_ids = sorted(str(item.get("memo_id") or "") for item in group)
    group_digest = hashlib.sha256("|".join(memo_ids).encode()).hexdigest()[:20]
    from apps.services.llm.services._runtime.background_invocation import (
        build_background_scene_invocation,
    )

    business_identity = f"{organization_id}:{user_id}:{group_digest}"
    invocation_context = build_background_scene_invocation(
        scene_key="memory_compaction",
        business_identity=business_identity,
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
        business_object_type="memory_compaction_group",
        business_object_id=group_digest,
        task_id=task_id,
        retry_source="celery" if task_id else "",
    )

    try:
        llm_result = unified_llm_call(
            scene_key="memory_compaction",
            variables={"memories": group_text},
            user_id=user_id or "",
            organization_id=organization_id,
            selected_model_id=selected_model_id or None,
            invocation_context=invocation_context,
            result_validator=validate_memory_compaction_result,
        )
    except Exception as exc:
        logger.warning("[Compaction] unified_llm_call failed: %s", exc)
        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        if is_retryable_background_error(exc):
            raise
        return False

    merged = _parse_memory_compaction_result(llm_result.content)

    importance = merged.get("importance", 3)
    try:
        importance = max(1, min(int(importance), 5))
    except (TypeError, ValueError):
        importance = 3

    memo_type = normalize_agent_memo_type(merged.get("type", "事实"))

    tags = merged.get("tags") or []
    if not isinstance(tags, list):
        tags = [str(tags)] if tags else []
    tags = [t for t in tags if isinstance(t, str)]

    old_ids = [g["memo_id"] for g in group if g.get("memo_id")]

    try:
        from apps.agent_memory.repository import AgentMemoryRepository
        #  M4.5/C5：合并产物写独立 AgentMemory 表；解析不到执行
        # agent 时放弃合并（记忆必须归属 Agent）。
        new_memo = AgentMemoryRepository.create(
            agent_id=agent_id,
            organization_id=organization_id,
            owner_id=user_id or None,
            memo_type=memo_type,
            content_markdown=merged["content"],
            tags=tags,
            importance=importance,
            source_url="compaction",
        )
    except Exception as exc:
        logger.warning("[Compaction] Failed to create merged memory: %s", exc)
        raise CompactionPersistenceError(
            "failed to persist compacted memory"
        ) from exc

    archived_ids = _archive_old_memos(old_ids)

    # 回滚判据必须是「归档后是否仍有旧 memo 处于 ACTIVE」，而不是
    # len(archived_ids) < len(old_ids) 的数量比较（bugbot 评审  high）。
    # _archive_old_memos 只归档当时仍 ACTIVE 的 id，并发维护 / 重复跑 compaction
    # 时部分 old_id 可能已被别处归档，archived_ids 长度天然 < old_ids——这属
    # 「已经不 active」的正常情况，不是失败。用数量比较会把它误判为失败，先归档
    # 旧 memo 再回滚新合并 memo，导致整组相似记忆全部 ARCHIVED、无任何 ACTIVE
    # 副本 → Agent 记忆丢失。真正的失败是：归档 DB 操作异常，导致旧 memo 仍 ACTIVE
    # 与新合并 memo 并存（检索重复）。故改为复查残留 ACTIVE 数。
    if old_ids:
        still_active = _count_active_memos(old_ids)
        if still_active > 0:
            logger.warning(
                "[Compaction] Archive incomplete for group (old_ids=%s, archived=%s, "
                "still_active=%d), rolling back merged memo=%s",
                old_ids, archived_ids, still_active, new_memo.id,
            )
            _rollback_merged_memo(str(new_memo.id))
            raise CompactionPersistenceError(
                "failed to archive source memories after compaction"
            )

    return True


def _count_active_memos(memo_ids: List[str]) -> int:
    """复查给定 memo_id 中仍处于 ACTIVE 的数量（归档回滚判据）。

    查询异常时保守返回 len(memo_ids)（视为「可能仍 active」触发回滚），
    避免异常被吞后误判归档成功而留 duplicate active。
    """
    from apps.agent_memory.models import AgentMemory
    from apps.services.agent_engine.utils.memory_constants import get_memo_queryset

    if not memo_ids:
        return 0
    try:
        return get_memo_queryset().filter(
            id__in=memo_ids,
            status=AgentMemory.Status.ACTIVE,
        ).count()
    except Exception as exc:
        logger.error(
            "[Compaction] Failed to count active memos for rollback check "
            "(ids=%s): %s — treating as still-active to trigger rollback",
            memo_ids, exc, exc_info=True,
        )
        return len(memo_ids)


def _rollback_merged_memo(memo_id: str) -> None:
    """归档失败时回滚刚创建的合并 memo，避免新旧 memo 同时 active 造成检索重复。"""
    from apps.agent_memory.models import AgentMemory
    from apps.services.agent_engine.utils.memory_constants import get_memo_queryset

    try:
        updated = get_memo_queryset().filter(
            id=memo_id,
            status=AgentMemory.Status.ACTIVE,
        ).update(status=AgentMemory.Status.ARCHIVED)
        if updated:
            logger.info("[Compaction] Rolled back merged memo=%s", memo_id)
        else:
            logger.warning("[Compaction] Rollback missed memo=%s (not active)", memo_id)
    except Exception as exc:
        logger.error(
            "[Compaction] Failed to rollback merged memo=%s: %s",
            memo_id, exc, exc_info=True,
        )


def _archive_old_memos(memo_ids: List[str]) -> List[str]:
    """将合并前的旧记忆 Memo 标记为归档，返回成功归档的 ID 列表。"""
    from apps.agent_memory.models import AgentMemory
    from apps.services.agent_engine.utils.memory_constants import get_memo_queryset

    if not memo_ids:
        return []
    try:
        memo_qs = get_memo_queryset()
        active_ids = list(
            memo_qs.filter(
                id__in=memo_ids,
                status=AgentMemory.Status.ACTIVE,
            ).values_list("id", flat=True)
        )
        if not active_ids:
            return []
        archived_ids = [str(mid) for mid in active_ids]
        memo_qs.filter(id__in=active_ids).update(status=AgentMemory.Status.ARCHIVED)
        logger.info("[Compaction] Archived %d old memos", len(archived_ids))
        return archived_ids
    except Exception as exc:
        logger.warning("[Compaction] Failed to archive memos: %s", exc)
        return []


_DISPATCH_CURSOR_KEY = "compaction:dispatch_cursor"
_DISPATCH_CURSOR_TTL = 7 * 3600


def _parse_pair_cursor(raw):
    """解析复合游标 b"{space_id}:{owner_id}" → (space_id, owner_id) 字符串对。

    空值或旧版单值游标（仅 space_id、无冒号）→ (None, None)，等价从头开始，
    安全兼容历史 Redis 残留（迁移前的单值游标会被忽略并重新全量遍历一轮）。
    """
    if not raw:
        return None, None
    text = raw.decode() if isinstance(raw, bytes) else str(raw)
    if ":" not in text:
        return None, None
    space_part, _, owner_part = text.partition(":")
    return (space_part or None), (owner_part or None)


@shared_task(ignore_result=True, time_limit=120, soft_time_limit=100)
def dispatch_compaction_for_all_spaces():
    """Beat 入口：从 agent memo 取 distinct (space_id, owner_id)，逐对 per-uw gate 后错峰分发。

    记忆是 per-(user, organization) 维度——一个共享 Space 可能有多个用户各自的 agent memo
    （owner_id 不同），故按 (space_id, owner_id) 对操作，而非遍历 Space 猜单一 owner
    （Space 无 owner 字段，旧实现 .only("owner_id") 求值即抛 FieldError）。
    使用 Redis 持久化复合游标 "{space}:{owner}"，超时后下次 Beat 从断点续跑。
    """
    from celery.exceptions import SoftTimeLimitExceeded
    from django.db.models import Q
    from django_redis import get_redis_connection
    from apps.services.agent_engine.services.memory_table_service import MemoryTableService
    from apps.services.agent_engine.utils.memory_constants import get_agent_memo_queryset
    from apps.services.billing.organization_resolver import (
        resolve_organization_id_from_space,
    )

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
                from apps.agent_memory.workspace_memory_execution import (
                    resolve_workspace_memory_dispatch,
                )

                organization_id = (
                    resolve_organization_id_from_space(space_id_str) or ""
                )
                try:
                    execution = resolve_workspace_memory_dispatch(
                        scene_key="memory_compaction",
                        organization_id=organization_id,
                        user_id=owner_id_str,
                    )
                except Exception as exc:
                    logger.warning(
                        "[Compaction] dispatch blocked by Workspace Memory policy: %s",
                        type(exc).__name__,
                    )
                    continue
                if not execution.enabled:
                    continue
                try:
                    compact_memories_task.apply_async(
                        kwargs={
                            "space_id": space_id_str,
                            "user_id": owner_id_str,
                            "selected_model_id": execution.selected_model_id,
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
            "[Compaction] dispatch timed out after %d tasks, cursor saved at %s:%s — will resume next beat",
            dispatched, last_space, last_owner,
        )
        return

    if dispatched:
        logger.info("[Compaction] Dispatched %d compaction tasks (paged, per-uw)", dispatched)


COMPACTION_BEAT_SCHEDULE = {
    "memory-compact-every-6h": {
        "task": "apps.services.agent_engine.tasks.memory.compaction.dispatch_compaction_for_all_spaces",
        "schedule": 6 * 3600,
        "options": {"queue": "default"},
    },
}
