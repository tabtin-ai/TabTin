"""
UserPortrait Celery 任务（v0.2 per-Organization）

任务清单：
  - distill_portrait_task   单 (user, organization) 蒸馏；由 API hint/distill 端点 + 定时扫描调度
  - scan_portraits_for_distill  每晚扫描"有新 memo 的 (user, organization) 二元组"批量调度

Beat schedule（自动发现）：
  - USER_PORTRAIT_BEAT_SCHEDULE 由 tabtin/celery.py 的 _discover_beat_schedules_auto 自动合并

并发控制：
  - 同一 (user, organization) 的蒸馏通过 UserPortraitService.mark_distill_pending 的
    select_for_update 防并发
  - 不同 (user, organization) 的蒸馏天然并行

成本控制（决策 N5：不做 Organization 级开关，按毛毛雨理解）：
  - 增量驱动：只有"上次蒸馏后有新 memo"或"有 pending hint"才触发
  - 没有变化的 (user, organization) 直接跳过，不烧钱
"""

from __future__ import annotations

import logging
from typing import Optional

from celery import shared_task
from celery.exceptions import MaxRetriesExceededError, Retry, SoftTimeLimitExceeded
from celery.schedules import crontab

logger = logging.getLogger(__name__)


# ── 单 (user, organization) 蒸馏 ──────────────────────────


@shared_task(
    name="user_portrait.distill_portrait",
    bind=True,
    ignore_result=True,
    max_retries=1,
    default_retry_delay=60,
    time_limit=180,        # 3 分钟硬上限
    soft_time_limit=150,
    queue="heavy",         # 跟 tabmemo.auto_tag 复用 heavy 队列
)
def distill_portrait_task(
    self,
    user_id: str,
    organization_id: str,
    agent_id: str = "",
    reason: str = "scheduled",
    selected_model_id: str = "",
) -> dict:
    """对单个 (user, organization, agent) 三元组运行一次画像蒸馏。

    /#4118：画像按 Agent 完全隔离——``agent_id`` 必传。缺失时跳过（不蒸馏、
    不落空画像），与 ``PortraitDistillService.run`` 的 fail-closed 一致。

    Args:
        user_id: 用户 ID
        organization_id: Organization ID（必传——per-Organization 隔离）
        agent_id: Agent ID（必传——per-Agent 隔离；缺失则 skip）
        reason: 触发原因（scheduled / hint / manual）

    Returns:
        dict: {"success": bool, "user_id": str, "organization_id": str, "agent_id": str, ...}
    """
    if not user_id:
        return {"success": False, "error": "missing user_id"}
    if not organization_id:
        return {"success": False, "error": "missing organization_id"}
    if not agent_id:
        # fail-closed：缺 agent_id 不落无主画像。
        return {"success": False, "skipped": True, "reason": "missing_agent_id"}

    from apps.agent_memory.workspace_memory_execution import (
        resolve_workspace_memory_worker,
    )

    execution = resolve_workspace_memory_worker(
        scene_key="user_portrait_distill",
        organization_id=organization_id,
        user_id=user_id,
        selected_model_id=selected_model_id,
    )
    if not execution.enabled:
        return {
            "success": False,
            "skipped": True,
            "reason": "auto_memory_disabled",
        }

    try:
        from django.contrib.auth import get_user_model
        from apps.user_portrait.error_codes import ErrorCode, ServiceError
        from apps.user_portrait.models import UserPortrait
        from apps.user_portrait.services.distill_service import PortraitDistillService
        from apps.tabmemo.services.record_style_service import resolve_record_preference

        User = get_user_model()
        try:
            user = User.objects.get(id=user_id)
        except User.DoesNotExist:
            logger.warning("[PortraitDistill] user %s not found, skip", user_id)
            return {"success": False, "skipped": True, "reason": "user_not_found"}

        # Agent 不存在 / 已停用（软删 is_active=False）时跳过——避免为一份 GET
        # 读不到（_resolve_agent_scope 过滤 is_active=True → 404）的画像白烧 LLM。
        # apps.agent 不可用（部分单测 settings）时跳过此校验（graceful）。
        try:
            from django.apps import apps as django_apps

            Agent = django_apps.get_model("agent", "Agent")
        except LookupError:
            Agent = None
        if Agent is not None and not Agent.objects.filter(
            id=agent_id, organization_id=organization_id, is_active=True
        ).exists():
            return {"success": False, "skipped": True, "reason": "agent_inactive_or_missing"}

        enabled, _ = resolve_record_preference(user_id, organization_id)
        if not enabled:
            return {"success": False, "skipped": True, "reason": "memory_disabled"}

        svc = PortraitDistillService(
            user=user,
            organization_id=organization_id,
            agent_id=agent_id,
        )
        retry_index = int(getattr(self.request, "retries", 0) or 0)
        is_final_attempt = retry_index >= int(self.max_retries or 0)
        current_portrait = svc.portrait_svc.get_portrait(
            organization_id, agent_id,
        )
        target_revision = int(getattr(current_portrait, "version", 0) or 0) + 1
        from apps.services.llm.services._runtime.background_invocation import (
            build_background_scene_invocation,
        )

        celery_task_id = str(getattr(self.request, "id", "") or "")
        business_identity = (
            f"{user_id}:{organization_id}:{agent_id}:revision-{target_revision}"
        )
        invocation_context = build_background_scene_invocation(
            scene_key="user_portrait_distill",
            business_identity=business_identity,
            organization_id=organization_id,
            user_id=user_id,
            selected_model_id=execution.selected_model_id,
            business_object_type="user_portrait_revision",
            business_object_id=business_identity,
            task_id=celery_task_id,
            retry_source="celery" if celery_task_id else "",
        )
        portrait = svc.run(
            trigger_reason=reason,
            resume_pending=retry_index > 0,
            mark_failed_on_error=is_final_attempt,
            invocation_context=invocation_context,
            selected_model_id=execution.selected_model_id,
        )
        if portrait is None:
            # run() 内 fail-closed skip（agent 缺失等）——不视为成功蒸馏。
            return {
                "success": False,
                "skipped": True,
                "reason": "distill_skipped",
                "user_id": user_id,
                "organization_id": organization_id,
                "agent_id": agent_id,
            }

        succeeded = (
            portrait.last_distill_status
            == UserPortrait.DistillStatus.IDLE
        )
        return {
            "success": succeeded,
            "user_id": user_id,
            "organization_id": organization_id,
            "agent_id": agent_id,
            "reason": reason,
            "version": portrait.version,
            "status": portrait.last_distill_status,
        }

    except Retry:
        raise
    except SoftTimeLimitExceeded:
        logger.warning(
            "[PortraitDistill] user %s organization %s soft timeout",
            user_id, organization_id,
        )
        try:
            raise self.retry(exc=SoftTimeLimitExceeded(), countdown=60)
        except MaxRetriesExceededError:
            return {"success": False, "skipped": True, "reason": "max_retries_exceeded"}
    except MaxRetriesExceededError:
        return {"success": False, "skipped": True, "reason": "max_retries_exceeded"}
    except ServiceError as exc:
        # DISTILL_IN_PROGRESS：另一个 worker 已抢到锁，60 秒后再 retry 也是无意义抢锁
        # （业务已被另一路径覆盖），直接 short-circuit；不进 retry，节省 worker。
        if exc.code == ErrorCode.DISTILL_IN_PROGRESS:
            logger.info(
                "[PortraitDistill] user %s organization %s skipped: distill in progress",
                user_id, organization_id,
            )
            return {
                "success": False,
                "skipped": True,
                "reason": "in_progress",
                "user_id": user_id,
                "organization_id": organization_id,
            }
        logger.exception(
            "[PortraitDistill] user %s organization %s ServiceError: %s",
            user_id, organization_id, exc.message or exc.code,
        )
        if not bool((exc.data or {}).get("background_retryable")):
            try:
                svc.portrait_svc.mark_distill_failed(
                    organization_id,
                    agent_id,
                    exc.message or exc.code,
                )
            except Exception as mark_exc:
                logger.warning(
                    "[PortraitDistill] failed to mark terminal error: %s",
                    mark_exc,
                )
            return {
                "success": False,
                "user_id": user_id,
                "organization_id": organization_id,
                "error": exc.message or exc.code,
                "reason": "non_retryable_service_error",
            }
        try:
            raise self.retry(exc=exc, countdown=60)
        except MaxRetriesExceededError:
            return {
                "success": False,
                "user_id": user_id,
                "organization_id": organization_id,
                "error": exc.message or exc.code,
                "reason": "max_retries_exceeded",
            }
    except Exception as exc:
        logger.exception(
            "[PortraitDistill] user %s organization %s failed: %s",
            user_id, organization_id, exc,
        )
        # 首次失败由 PortraitDistillService 保持 pending，给自动重试留出恢复窗口；
        # 最后一次失败才会落 failed。这里继续沿用通用 retry 路径。
        from apps.services.llm.scenes.exceptions import BYOKSceneError
        from apps.services.llm.services._runtime.background_invocation import (
            is_retryable_background_error,
        )

        if isinstance(exc, BYOKSceneError) and not is_retryable_background_error(exc):
            return {
                "success": False,
                "user_id": user_id,
                "organization_id": organization_id,
                "error": getattr(exc, "error_code", type(exc).__name__),
                "reason": "non_retryable_scene_error",
            }
        try:
            raise self.retry(exc=exc, countdown=60)
        except MaxRetriesExceededError:
            return {
                "success": False,
                "user_id": user_id,
                "organization_id": organization_id,
                "error": str(exc),
                "reason": "max_retries_exceeded",
            }


# ── 每晚定时扫描 ──────────────────────────────────────


@shared_task(
    name="user_portrait.scan_portraits_for_distill",
    bind=True,
    ignore_result=True,
    time_limit=600,       # 10 分钟硬上限（仅扫描和分发，不实际蒸馏）
    soft_time_limit=540,
    queue="default",
)
def scan_portraits_for_distill_task(self, dry_run: bool = False) -> dict:
    """扫描所有 UserPortrait，对"有新 memo 或有 pending hint"的三元组触发蒸馏。

    增量驱动（D5）：避免对没有任何变化的 (user, organization, agent) 重复蒸馏，节省成本。

    /#4118：扫描的是 (user, organization, agent) 三元组——DB 侧排除历史
    per-organization 画像行（agent_id=NULL）。它们画像 per-Agent 化前生成，
    不再被蒸馏刷新（也不召回），留待兼容清偿时物理清除。

    Args:
        dry_run: 只统计不实际触发，便于运维巡检

    Returns:
        dict: 统计信息
    """
    try:
        from apps.user_portrait.constants import USER_PORTRAIT_DB
        from apps.user_portrait.models import UserPortrait
        from apps.user_portrait.services.distill_service import has_new_memos_since
        from apps.tabmemo.services.record_style_service import resolve_record_preference
    except ImportError:
        logger.warning("[PortraitScan] user_portrait not available, skip")
        return {"success": False, "skipped": True, "reason": "import_error"}

    scanned = 0
    triggered = 0
    skipped_no_change = 0
    skipped_pending = 0
    skipped_disabled = 0

    # DB 侧排除历史 per-organization 画像行（agent_id=NULL），用 up_org_agent_idx
    # 下推，不在 Python 层逐行判空。
    qs = UserPortrait.objects.using(USER_PORTRAIT_DB).exclude(agent_id__isnull=True)

    for portrait in qs.iterator(chunk_size=200):
        scanned += 1

        # 跳过正在蒸馏中的三元组
        if portrait.last_distill_status == UserPortrait.DistillStatus.PENDING:
            skipped_pending += 1
            continue

        enabled, _ = resolve_record_preference(
            str(portrait.user_id),
            str(portrait.organization_id),
        )
        if not enabled:
            skipped_disabled += 1
            continue

        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        try:
            execution = resolve_workspace_memory_dispatch(
                scene_key="user_portrait_distill",
                organization_id=str(portrait.organization_id),
                user_id=str(portrait.user_id),
            )
        except Exception as exc:
            logger.warning(
                "[PortraitScan] dispatch blocked by Workspace Memory policy: %s",
                type(exc).__name__,
            )
            skipped_disabled += 1
            continue
        if not execution.enabled:
            skipped_disabled += 1
            continue

        has_pending_hints = bool(portrait.pending_hints)
        has_new_memos = has_new_memos_since(
            user_id=str(portrait.user_id),
            organization_id=str(portrait.organization_id),
            since=portrait.last_distilled_at,
            agent_id=str(portrait.agent_id),
        )

        if not has_pending_hints and not has_new_memos:
            skipped_no_change += 1
            continue

        if dry_run:
            triggered += 1
            continue

        try:
            distill_portrait_task.delay(
                user_id=str(portrait.user_id),
                organization_id=str(portrait.organization_id),
                agent_id=str(portrait.agent_id),
                reason="scheduled",
                selected_model_id=execution.selected_model_id,
            )
            triggered += 1
        except Exception as exc:
            logger.exception(
                "[PortraitScan] failed to dispatch for user %s organization %s agent %s: %s",
                portrait.user_id, portrait.organization_id, portrait.agent_id, exc,
            )

    summary = {
        "success": True,
        "dry_run": dry_run,
        "scanned": scanned,
        "triggered": triggered,
        "skipped_no_change": skipped_no_change,
        "skipped_pending": skipped_pending,
        "skipped_disabled": skipped_disabled,
    }
    logger.info("[PortraitScan] %s", summary)
    return summary


# ── Beat Schedule（自动发现） ────────────────────────


USER_PORTRAIT_BEAT_SCHEDULE = {
    "user-portrait-nightly-distill-scan": {
        "task": "user_portrait.scan_portraits_for_distill",
        # 每晚 03:00 跑一次（避开业务高峰）
        "schedule": crontab(hour=3, minute=0),
        "options": {
            "expires": 7200,  # 2 小时未执行就丢弃（避免堆积）
            "queue": "default",
        },
        "kwargs": {"dry_run": False},
    },
}
