"""Tracker 执行引擎（charter v1.8 §6.4 单 Skill 执行）。

Wave 2：
- 移除 V2 之前的多步骤 DAG 执行路径（已删除相关 services / models）。
- 唯一执行路径 = ``apps.tracker.services.skill_executor.run_skill_based``。
- 保留信号量、超时回收、Tracker 统计更新等通用基础设施。
"""

from __future__ import annotations

import functools
import logging
import threading
from datetime import timedelta
from uuid import UUID

from django.core.exceptions import ValidationError
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.constants import (
    CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY,
    ERROR_MSG_MAX_LEN,
    TRACKER_STEP_SEMAPHORE_REDIS_KEY,
    TRANSIENT_ERROR_CATEGORIES,
    TRANSIENT_RETRY_CONTEXT_KEY,
    TRANSIENT_RETRY_DELAY_SECONDS,
    TRANSIENT_RETRY_MAX_ATTEMPTS,
)
from apps.tracker.services.tracker_notification import TrackerNotificationService

logger = logging.getLogger(__name__)

TRACKER_RUN_TIMEOUT_SECONDS = 30 * 60
STUCK_TIMEOUT_SECONDS = 30 * 60
PENDING_DISPATCH_ORPHAN_TIMEOUT_SECONDS = 2 * 60
TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY = "_transient_retry_grace_until"
CANCELLED_RELEASE_GRACE_SECONDS = 2 * 60
COMPLETED_TRANSCRIPT_RECONCILE_GRACE_SECONDS = 30
MAX_CONCURRENT_TRACKER_STEPS = 8
_SEMAPHORE_KEY = TRACKER_STEP_SEMAPHORE_REDIS_KEY
_SEMAPHORE_SLOT_TTL = 24 * 60 * 60
SEMAPHORE_RETRY_BACKOFF_SECONDS = 0.2
SEMAPHORE_RETRY_BACKOFF_MAX = 5.0
SEMAPHORE_RETRY_MAX_ROUNDS = 150


class _SemaphoreToken:
    """acquire 返回的令牌，记录本次获取使用了哪种后端。"""
    __slots__ = ("acquired", "used_fallback")

    def __init__(self, acquired: bool, used_fallback: bool = False):
        self.acquired = acquired
        self.used_fallback = used_fallback

    def __bool__(self):
        return self.acquired


class _RedisDistributedSemaphore:
    """基于 Django cache (Redis) 原子计数器的分布式信号量。

    使用 cache.incr 先占位再判断的模式保证原子性：
    - acquire: incr → 如果超限则 decr 回退 → 返回 False
    - release: decr（最低归零）
    计数器带 TTL 自动回收，防止进程崩溃后永久占用。

    Redis 不可用时回退到进程内 threading.Semaphore，避免无限放行。
    acquire 返回 _SemaphoreToken，release 接收 token 以确保后端匹配。

    支持 per-organization 隔离：通过 organization_id 区分不同 counter key。
    """

    _COUNTER_TTL = _SEMAPHORE_SLOT_TTL

    def __init__(self, max_concurrent: int = MAX_CONCURRENT_TRACKER_STEPS, organization_id: str = ""):
        self.max_concurrent = max_concurrent
        self._organization_id = organization_id
        suffix = f":{organization_id}" if organization_id else ""
        self._counter_key = f"{_SEMAPHORE_KEY}:counter{suffix}"
        self._local_fallback = threading.Semaphore(max_concurrent)

    def _ensure_counter(self, cache) -> None:
        existing = cache.get(self._counter_key)
        if existing is not None:
            return
        cache.add(self._counter_key, 0, timeout=self._COUNTER_TTL)

    def acquire_simple(self) -> _SemaphoreToken:
        """原子获取：incr → 判断 → 超限则 decr 回退。Redis 异常时使用本地信号量。"""
        from django.core.cache import cache
        try:
            self._ensure_counter(cache)
            new_val = cache.incr(self._counter_key)
            if new_val <= self.max_concurrent:
                cache.touch(self._counter_key, self._COUNTER_TTL)
                return _SemaphoreToken(acquired=True, used_fallback=False)
            cache.decr(self._counter_key)
            return _SemaphoreToken(acquired=False)
        except Exception:
            logger.warning("[Tracker] Redis semaphore unavailable, using local fallback", exc_info=True)
            ok = self._local_fallback.acquire(blocking=False)
            return _SemaphoreToken(acquired=ok, used_fallback=True)

    def release_simple(self, token: _SemaphoreToken | None = None) -> None:
        """原子释放：decr，最低归零。根据 token 决定释放哪个后端。"""
        from django.core.cache import cache
        if token and token.used_fallback:
            try:
                self._local_fallback.release()
            except ValueError:
                pass
            return
        try:
            self._ensure_counter(cache)
            val = cache.decr(self._counter_key)
            if val < 0:
                cache.set(self._counter_key, 0, timeout=self._COUNTER_TTL)
        except Exception:
            logger.debug("[Tracker] semaphore release error", exc_info=True)


_distributed_semaphore = _RedisDistributedSemaphore(MAX_CONCURRENT_TRACKER_STEPS)


@functools.lru_cache(maxsize=256)
def _create_organization_semaphore(organization_id: str) -> _RedisDistributedSemaphore:
    return _RedisDistributedSemaphore(MAX_CONCURRENT_TRACKER_STEPS, organization_id=organization_id)


def _get_organization_semaphore(organization_id: str) -> _RedisDistributedSemaphore:
    """获取 per-organization 的信号量实例，带 LRU 缓存。"""
    if not organization_id:
        return _distributed_semaphore
    return _create_organization_semaphore(organization_id)


def _tracker_run_task_id(tracker_run: TrackerRun) -> str:
    context = tracker_run.context or {}
    return str(
        context.get("_celery_task_id")
        or context.get("dispatch_task_id")
        or context.get("task_id")
        or ""
    )


def _runtime_task_id(tracker_run: TrackerRun) -> str:
    context = tracker_run.context or {}
    return str(
        context.get("_runtime_task_id")
        or context.get("runtime_task_id")
        or ""
    )


def _record_runtime_task_id(tracker_run_id: str, runtime_task_id: str) -> None:
    """记录设备端 prompt task_id，供 Tracker 取消时 forward_cancel。"""
    if not tracker_run_id or not runtime_task_id:
        return

    tracker_run = TrackerRun.objects.filter(id=tracker_run_id).first()
    if not tracker_run:
        return

    context = tracker_run.context or {}
    context["_runtime_task_id"] = runtime_task_id
    context["runtime_task_id"] = runtime_task_id
    TrackerRun.objects.filter(id=tracker_run_id).update(context=context)


def _is_tracker_run_cancelled(tracker_run_id: str | None) -> bool:
    if not tracker_run_id:
        return False
    try:
        status = (
            TrackerRun.objects.filter(id=tracker_run_id)
            .values_list("status", flat=True)
            .first()
        )
        return status == "cancelled"
    except Exception:
        logger.debug(
            "[Tracker] cancelled status lookup failed for run %s",
            tracker_run_id,
            exc_info=True,
        )
        return False


def start_tracker_run(
    tracker_id: str,
    trigger_type: str = "extension_event",
    trigger_context: dict | None = None,
) -> str | None:
    """为 Extension 事件等无用户上下文的场景创建 TrackerRun 并异步执行。

    与 TrackerService.trigger_tracker 的区别：不需要 user / 权限检查。
    返回 tracker_run_id，若 Tracker 不存在或已达并发上限则返回 None。
    """
    with transaction.atomic(using=postgres_app_db_alias()):
        try:
            tracker = Tracker.objects.select_for_update().get(id=tracker_id, status="active")
        except Tracker.DoesNotExist:
            logger.warning("[start_tracker_run] Tracker 不存在或非 active: %s", tracker_id)
            return None

        # 纯 Agent 模式（2026-06）：无 skill_key 不再拒绝执行。空 skill_key 时
        # run_skill_based 走「无 Skill 路径」——指令直接派给 Agent，Agent 自助找 Skill。

        active_runs = TrackerRun.objects.filter(
            tracker=tracker,
            status__in=("pending", "running", "waiting_device"),
        ).count()
        # Wave 2 收尾 (charter v1.8 §7.1)：max_concurrent_runs 字段已在
        # migration 0023 drop（charter 拒绝清单 — 与 Redis 信号量重叠）。
        # 单 Tracker 单 active run 是 charter §6.4 自然约束；跨 Tracker 全局并发
        # 由 _RedisDistributedSemaphore (MAX_CONCURRENT_TRACKER_STEPS=8) 统一控制。
        # waiting_device（离线韧性 M1）计入 active：挂起等设备期间不再叠加触发。
        if active_runs >= 1:
            logger.info("[start_tracker_run] Tracker %s 已达并发上限 (%d)", tracker_id, active_runs)
            return None

        tracker_run = TrackerRun.objects.create(
            tracker=tracker,
            trigger_type=trigger_type,
            trigger_context=trigger_context or {},
            status="pending",
            started_at=timezone.now(),
        )

    logger.info(
        "[start_tracker_run] Tracker %s 已记账运行 %s (trigger=%s)，等待本机执行",
        tracker_id, tracker_run.id, trigger_type,
    )
    return str(tracker_run.id)


def run_tracker_run(tracker_run_id: str):
    """执行 TrackerRun：唯一路径 = Skill-based（charter v1.8 §6.4）。"""
    try:
        tracker_run = TrackerRun.objects.select_related("tracker").get(id=tracker_run_id)
    except TrackerRun.DoesNotExist:
        logger.error("[Tracker] TrackerRun not found: %s", tracker_run_id)
        return

    if tracker_run.status not in ("pending", "running"):
        logger.warning(
            "[Tracker] TrackerRun %s 状态为 %s，跳过执行",
            tracker_run_id, tracker_run.status,
        )
        return

    # 防双跑：只有成功完成 pending→running 原子认领的调用者才能继续执行。
    # Celery 重复投递 / broker 重试 / worker 重启重投时，第二个消费者会看到
    # running 或认领失败，直接返回——否则会双建 ChatSession、双发 forward、
    # 双计统计。已认领但真正卡死的 running run 由 recover_stuck_runs 兜底回收，
    # 不靠重复执行自愈。
    if tracker_run.status == "running":
        logger.warning(
            "[Tracker] TrackerRun %s 已在执行中，跳过重复执行（疑似重复投递）",
            tracker_run_id,
        )
        return

    updated = TrackerRun.objects.filter(
        id=tracker_run_id, status="pending",
    ).update(status="running")
    if not updated:
        tracker_run.refresh_from_db()
        logger.warning(
            "[Tracker] TrackerRun %s pending→running 认领失败（当前状态 %s），跳过",
            tracker_run_id, tracker_run.status,
        )
        return
    tracker_run.status = "running"
    # ：在认领成功后立刻打 attempt 时间戳（早于 session 创建 / 设备闸门），
    # 避免 worker 在 skill_executor 中途崩溃时 recovery 缺少边界、误用上一轮 transcript。
    _stamp_current_attempt_started_at(tracker_run)

    # 纯 Agent 模式（2026-06）：无 skill_key 不再视为非法。run_skill_based 内部
    # 按 skill_key 是否为空分流——有则解析单一 Skill，无则走「指令驱动」纯 Agent 路径。
    from apps.tracker.services.skill_executor import run_skill_based
    run_skill_based(tracker_run)


def _update_tracker_stats(tracker_id, *, success: bool):
    """统一更新 Tracker 统计计数（total_runs / success_runs / fail_runs / last_run_at）。

    定时类型的下次几点由本机计算，这里不写 next_run_at。

    所有 TrackerRun 终态（completed / failed / cancelled / partial_failed）
    均应调用此方法，保证统计口径一致。
    """
    with transaction.atomic(using=postgres_app_db_alias()):
        tracker = Tracker.objects.select_for_update().get(id=tracker_id)
        tracker.total_runs += 1
        if success:
            tracker.success_runs += 1
        else:
            tracker.fail_runs += 1
        tracker.last_run_at = timezone.now()

        update_fields = ["total_runs", "success_runs", "fail_runs", "last_run_at"]
        if tracker.trigger_type == "at":
            # ：Run 终态兜底收口；scan 侧若禁用失败，仍阻止再次入扫。
            if tracker.status != "disabled" and tracker.status in ("draft", "active", "paused"):
                tracker.transition_status("disabled")
                update_fields.append("status")
            if tracker.next_run_at is not None:
                tracker.next_run_at = None
                update_fields.append("next_run_at")
        tracker.save(update_fields=update_fields)


def _fail_tracker_run(tracker_run: TrackerRun, error: str, notifier=None, *, error_category: str | None = None):
    """标记 TrackerRun 失败、更新 Tracker 统计，可选发送终态通知。

    Wave 6 (charter v1.8 §4.4 / 6.1):error_summary 写入前必经 ``humanize_failure_message``
    翻译为"人话 + 恢复建议",不允许直接 ``str(exc)``/堆栈写入。``error_category``
    参数可让 Agent 协议级分类(如 ``rate_limit`` / ``budget_exceeded``)优先指导翻译。

    若 ``error_category`` 属瞬态白名单且未耗尽自动重试次数，则延迟重投同一 Run，
    不落终态（见 ``maybe_schedule_transient_retry``）。
    """
    if maybe_schedule_transient_retry(
        tracker_run,
        error=error or "",
        error_category=error_category,
        notifier=notifier,
    ):
        return

    from apps.tracker.utils import (
        humanize_failure_message,
        translate_skill_error,
        assert_failure_message_is_human_readable,
    )
    skill_key = getattr(getattr(tracker_run, "tracker", None), "skill_key", None)
    now = timezone.now()
    raw_error = (error or "").strip()
    # 人话化会丢掉技术细节；先落可检索日志，并把 raw 写入 context 供 API/诊断包对照
    logger.warning(
        "[_fail_tracker_run] run=%s category=%s raw=%r",
        tracker_run.id,
        error_category,
        raw_error[:500],
    )
    humanized = humanize_failure_message(
        raw_error,
        skill_key=skill_key,
        error_category=error_category,
    )
    # Wave 6 续作 P0-4 (charter §4.4 / plan §Phase 6 验收 #1):
    # 同步取出结构化 RecoveryAction(用于 envelope payload 给前端渲染按钮)。
    payload_recovery = translate_skill_error(
        raw_error,
        skill_key=skill_key,
        error_category=error_category,
    )
    # Wave 6 防线:写入前自检,违规即记 warning。这是反思 9 / 反思 14 的延伸——
    # 既不让用户吃到堆栈,也不掩盖"翻译规则漏掉了某类错误"的事实。
    if not assert_failure_message_is_human_readable(humanized):
        logger.warning(
            "[_fail_tracker_run] error_summary still looks like traceback after humanize: %r",
            humanized[:200],
        )

    # 终态文案注明已自动重试次数（若有）
    ctx_preview = tracker_run.context or {}
    retry_attempt = int(ctx_preview.get(TRANSIENT_RETRY_CONTEXT_KEY) or 0)
    if retry_attempt > 0:
        humanized = f"{humanized}（已自动重试 {retry_attempt} 次）"

    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status__in=("pending", "running"),
    ).update(
        status="failed",
        error_summary=humanized[:ERROR_MSG_MAX_LEN],
        finished_at=now,
    )
    if not updated:
        return

    # Wave 6 续作 P0-4:把 recovery_actions(结构化 list[dict])写入 TrackerRun.context
    # ——charter §7.1 字段封闭原则,不在 TrackerRun model 加新字段。前端通过
    # envelope.payload.recovery_actions 拿到,batch resolver 也从 context 取。
    #  / ：原始错误写入 agent_result + raw_error，避免人话化后只剩「执行没能跑完」。
    try:
        tracker_run.refresh_from_db()
        ctx = dict(tracker_run.context or {})
        ctx["recovery_actions"] = payload_recovery.get("recovery_action_items", [])
        if error_category or raw_error:
            agent_result = dict(ctx.get("agent_result") or {})
            if error_category:
                agent_result["error_category"] = str(error_category)
            if raw_error:
                agent_result["error_message"] = raw_error[:500]
            ctx["agent_result"] = agent_result
        if raw_error:
            ctx["raw_error"] = raw_error[:500]
        if error_category:
            ctx["error_category"] = str(error_category)
        TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
    except Exception:
        logger.debug(
            "[_fail_tracker_run] save recovery_actions to context failed for %s",
            tracker_run.id, exc_info=True,
        )

    tracker_run.refresh_from_db()
    if tracker_run.started_at:
        TrackerRun.objects.filter(id=tracker_run.id).update(
            duration=(now - tracker_run.started_at).total_seconds()
        )

    _release_tracker_run_runtime_claim(tracker_run, reason="fail_tracker_run")

    _update_tracker_stats(tracker_run.tracker_id, success=False)

    if notifier:
        tracker_run.refresh_from_db()
        notifier.notify_progress(tracker_run)
        notifier.notify_run_failed(tracker_run)


def _is_transient_failure(error_category: str | None, error: str = "") -> bool:
    """判定是否属于可自动重试的瞬态失败。"""
    cat = (error_category or "").strip().lower()
    if cat in TRANSIENT_ERROR_CATEGORIES:
        return True
    # runtime_failed 但 raw 明确是 429 / 过载时也视为瞬态
    lower = (error or "").lower()
    if cat == "runtime_failed" and any(
        needle in lower
        for needle in (
            "(429)",
            "status=429",
            "http 429",
            "rate limit",
            "rate_limit",
            "engine overloaded",
            "engine_overloaded",
            "模型上游返回错误",
            "模型服务现在太忙",
        )
    ):
        return True
    if any(
        needle in lower
        for needle in ("dropped to offline", "device_dropped")
    ):
        return True
    return False


def maybe_schedule_transient_retry(
    tracker_run: TrackerRun,
    *,
    error: str = "",
    error_category: str | None = None,
    notifier=None,
) -> bool:
    """瞬态失败时延迟重投同一 TrackerRun；成功调度返回 True（调用方勿再标 failed）。"""
    if not _is_transient_failure(error_category, error):
        return False

    ctx = dict(tracker_run.context or {})
    attempt = int(ctx.get(TRANSIENT_RETRY_CONTEXT_KEY) or 0)
    if attempt >= TRANSIENT_RETRY_MAX_ATTEMPTS:
        logger.info(
            "[Tracker] transient retry exhausted for run %s category=%s attempts=%s",
            tracker_run.id, error_category, attempt,
        )
        return False

    next_attempt = attempt + 1
    ctx[TRANSIENT_RETRY_CONTEXT_KEY] = next_attempt
    if error_category or error:
        agent_result = dict(ctx.get("agent_result") or {})
        if error_category:
            agent_result["error_category"] = str(error_category)
        if error:
            agent_result["error_message"] = str(error)[:500]
        agent_result["last_transient_error"] = str(error or error_category or "")[:500]
        ctx["agent_result"] = agent_result

    progress_message = (
        f"遇到临时故障（{error_category or 'transient'}），"
        f"将在 {TRANSIENT_RETRY_DELAY_SECONDS // 60} 分钟后自动重试"
        f"（第 {next_attempt}/{TRANSIENT_RETRY_MAX_ATTEMPTS} 次）…"
    )
    now = timezone.now()
    # 上一轮 task_id 已经终态，不能让 pending 看门狗拿它判断新一轮倒计时任务。
    # 即使新 task_id 入队后暂时回写失败，也用显式宽限窗覆盖 countdown + orphan
    # 短窗，避免正常重试在即将启动时被误回收。
    for key in ("dispatch_task_id", "_celery_task_id", "task_id"):
        ctx.pop(key, None)
    ctx[TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY] = int(
        (
            now
            + timedelta(
                seconds=(
                    TRANSIENT_RETRY_DELAY_SECONDS
                    + PENDING_DISPATCH_ORPHAN_TIMEOUT_SECONDS
                )
            )
        ).timestamp()
    )
    # ：不再清空 chat_session_id。同 Run 重试复用首次 attempt 的对话，
    # 避免外键被顶掉后旧 session 漏进主对话列表。
    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status__in=("pending", "running"),
    ).update(
        status="pending",
        context=ctx,
        progress_message=progress_message,
        progress_pct=0,
        error_summary="",
        finished_at=None,
        started_at=now,
    )
    if not updated:
        return False

    _release_tracker_run_runtime_claim(tracker_run, reason="transient_retry_reschedule")

    logger.info(
        "[Tracker] host queue will retry run %s category=%s attempt=%s after %ss",
        tracker_run.id, error_category, next_attempt, TRANSIENT_RETRY_DELAY_SECONDS,
    )

    try:
        tracker_run.refresh_from_db()
        if notifier is None:
            notifier = TrackerNotificationService(tracker_run)
        notifier.notify_progress(tracker_run)
    except Exception:
        logger.debug("[Tracker] transient retry notify failed", exc_info=True)
    return True


# ─── 离线韧性 M1：waiting_device 挂起 / 重投 / 超窗回收 ─────────────────────
#
# 核心思路（docs/overview/tracker-offline-resilience-design.md）：触发时发现
# 绑定设备离线，把「秒败」改成「挂起等待 + 设备上线重投 + 超窗兜底失败」。
# 挂起点在 ChatSession 创建之前（skill_executor 的前置闸门），因此挂起的 Run
# 没有 session / runtime 上下文，重投 = 干净重跑，与 pending 原子认领天然兼容。


def _is_device_dispatchable(device) -> bool:
    """设备当前是否可接收 Tracker forward：DB 在线 + WS 实际可达。"""
    if device is None:
        return False
    if getattr(device, "status", None) not in ("online", "busy"):
        return False
    fingerprint = getattr(device, "fingerprint", None)
    if not fingerprint:
        return False
    try:
        from apps.services.common.ws.bus import is_device_ws_connected

        return is_device_ws_connected(str(fingerprint))
    except Exception:
        # WS 可达性探测自身故障时不拦：交给 forward 路径按现状判定。
        logger.debug("[Tracker] device ws probe failed", exc_info=True)
        return True


def _resolve_tracker_binding_device(tracker):
    """按与 dispatcher 一致的口径解析 Tracker 的执行设备（可能为 None）。"""
    try:
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        binding = resolve_execution_binding(
            space=getattr(tracker, "workspace", None),
            agent_id=str(tracker.agent_id) if getattr(tracker, "agent_id", None) else None,
        )
        return binding.device
    except Exception:
        logger.warning(
            "[Tracker] resolve binding device failed for tracker %s",
            getattr(tracker, "id", None),
            exc_info=True,
        )
        return None


def suspend_tracker_run_waiting_device(tracker_run: TrackerRun, device, notifier=None) -> bool:
    """把设备不可达的 Run 挂起为 ``waiting_device``，等设备上线重投。

    返回 True 表示挂起成功（调用方应直接 return，不再继续执行链路）。
    """
    from apps.services.remote_agent.device_resolver import format_device_name

    device_name = format_device_name(device) if device is not None else "未知设备"
    now = timezone.now()

    trigger_context = dict(tracker_run.trigger_context or {})
    trigger_context["waiting_since"] = now.isoformat()
    if device is not None:
        trigger_context["waiting_device_id"] = str(getattr(device, "id", "") or "")
        trigger_context["waiting_device_name"] = device_name

    progress_message = f"执行设备「{device_name}」当前离线，等待设备上线后自动执行…"
    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status__in=("pending", "running"),
    ).update(
        status="waiting_device",
        trigger_context=trigger_context,
        progress_message=progress_message,
        progress_pct=0,
    )
    if not updated:
        return False

    tracker_run.refresh_from_db()
    logger.info(
        "[Tracker] run %s suspended waiting_device (tracker=%s device=%s)",
        tracker_run.id, tracker_run.tracker_id, device_name,
    )

    try:
        if notifier is None:
            notifier = TrackerNotificationService(tracker_run)
        notifier.notify_progress(tracker_run)
    except Exception:
        logger.debug("[Tracker] waiting_device ws notify failed", exc_info=True)

    try:
        from apps.tracker.services.offline_notification import notify_run_waiting_device

        notify_run_waiting_device(tracker_run, device_name)
    except Exception:
        logger.debug("[Tracker] waiting_device system notify failed", exc_info=True)
    return True


def redispatch_waiting_run(tracker_run: TrackerRun) -> bool:
    """把 waiting_device 的 Run 原子置回 pending，交给本机队列接手。

    ``started_at`` 必须重置为 now：看门狗把 started_at 早于 2 分钟的 pending
    Run 视为投递孤儿回收，等待数小时后重投的 Run 若保留旧值会被立即误杀。
    """
    now = timezone.now()
    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status="waiting_device",
    ).update(
        status="pending",
        started_at=now,
        progress_message="设备已上线，重新排队执行…",
    )
    if not updated:
        return False

    logger.info(
        "[Tracker] waiting_device run %s redispatched (tracker=%s)",
        tracker_run.id, tracker_run.tracker_id,
    )
    try:
        tracker_run.refresh_from_db()
        TrackerNotificationService(tracker_run).notify_progress(tracker_run)
    except Exception:
        logger.debug("[Tracker] redispatch ws notify failed", exc_info=True)
    return True


def _waiting_since(tracker_run: TrackerRun):
    """解析 Run 进入等待的时间；trigger_context 缺失时回退 started_at/created_at。"""
    raw = (tracker_run.trigger_context or {}).get("waiting_since")
    if raw:
        try:
            from django.utils.dateparse import parse_datetime

            parsed = parse_datetime(str(raw))
            if parsed is not None:
                return parsed
        except Exception:
            pass
    return tracker_run.started_at or tracker_run.created_at


def _fail_waiting_run_timeout(tracker_run: TrackerRun) -> bool:
    """等待超窗：标 failed + 统计 + WS/系统通知。"""
    from apps.tracker.constants import WAITING_DEVICE_TIMEOUT_SECONDS

    device_name = (tracker_run.trigger_context or {}).get("waiting_device_name") or "执行设备"
    hours = WAITING_DEVICE_TIMEOUT_SECONDS // 3600
    # 手写人话文案（同 recover_stuck_runs 惯例）：现象 + 恢复建议双段式，
    # 不走 humanize_failure_message 以免被关键词规则二次干预。
    error_msg = (
        f"等待设备「{device_name}」上线超过 {hours} 小时，本次执行已放弃。"
        "请检查该设备是否长期关机，或为执行 Agent 换绑一台常开设备。"
    )
    now = timezone.now()
    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status="waiting_device",
    ).update(
        status="failed",
        error_summary=error_msg,
        progress_message=error_msg,
        finished_at=now,
    )
    if not updated:
        return False

    tracker_run.refresh_from_db()
    try:
        ctx = tracker_run.context or {}
        ctx["recovery_actions"] = [
            {"kind": "switch_agent", "label": "换绑常开设备的 Agent"},
            {"kind": "rerun", "label": "设备上线后重新运行"},
        ]
        TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
    except Exception:
        logger.debug("[Tracker] waiting timeout save recovery_actions failed", exc_info=True)

    if tracker_run.started_at:
        TrackerRun.objects.filter(id=tracker_run.id).update(
            duration=(now - tracker_run.started_at).total_seconds()
        )

    # 超窗失败计入 fail_runs：用户需要在统计里看到它。
    _update_tracker_stats(tracker_run.tracker_id, success=False)

    try:
        notifier = TrackerNotificationService(tracker_run)
        notifier.notify_progress(tracker_run)
        notifier.notify_run_failed(tracker_run)
    except Exception:
        logger.debug("[Tracker] waiting timeout ws notify failed", exc_info=True)

    try:
        from apps.tracker.services.offline_notification import notify_run_waiting_timeout

        notify_run_waiting_timeout(tracker_run, device_name)
    except Exception:
        logger.debug("[Tracker] waiting timeout system notify failed", exc_info=True)

    logger.warning(
        "[Tracker] waiting_device run %s timed out after %sh (tracker=%s)",
        tracker_run.id, hours, tracker_run.tracker_id,
    )
    return True


# Tracker 模块收敛波次 1（2026-05-20）：删除 _sync_agenda_meta_next_run ——
# GoalAgendaMeta 已随 tabagenda 模块下线，无需再同步日历元数据。


def _stamp_current_attempt_started_at(tracker_run: TrackerRun) -> None:
    """记录本次 attempt 开始时刻，供卡住恢复只认本轮 transcript。"""
    ctx = dict(tracker_run.context or {})
    ctx[CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY] = timezone.now().isoformat()
    TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
    tracker_run.context = ctx


def _parse_attempt_started_at(tracker_run: TrackerRun):
    """读取本次 attempt 开始时刻（ISO）；缺失或非法则返回 None。"""
    raw = (getattr(tracker_run, "context", None) or {}).get(
        CURRENT_ATTEMPT_STARTED_AT_CONTEXT_KEY
    )
    if not raw:
        return None
    try:
        from django.utils.dateparse import parse_datetime

        parsed = parse_datetime(str(raw))
        if parsed is None:
            return None
        if timezone.is_naive(parsed):
            return timezone.make_aware(parsed, timezone.utc)
        return parsed
    except Exception:
        return None


def _release_tracker_run_runtime_claim(tracker_run: TrackerRun, *, reason: str) -> bool:
    """释放 TrackerRun per-run ChatSession 关联的 runtime action 设备绑定。

    Tracker 每个 Run 对应一条 ChatSession（跨 attempt 复用同一条，）；
    Run 终态后这个 thread 不应继续占住 action_device 绑定，否则后续恢复 /
    HITL / 工具动作可能被旧设备归属误导。
    """
    session_id = getattr(tracker_run, "chat_session_id", None)
    if not session_id or not isinstance(session_id, (str, UUID)):
        return False

    try:
        from apps.chat.conversation.models import ChatSession
        from apps.services.agent_engine.services.action_transport_service import (
            ActionTransportService,
        )

        session = ChatSession.objects.filter(id=session_id).only("thread_id").first()
        thread_id = getattr(session, "thread_id", "") if session else ""
        if not thread_id:
            return False

        released = ActionTransportService().force_release_action_device(thread_id)
        if released:
            logger.info(
                "[Tracker] released runtime device claim for run=%s thread=%s reason=%s",
                tracker_run.id,
                thread_id,
                reason,
            )
        return bool(released)
    except Exception:
        logger.debug(
            "[Tracker] release runtime device claim failed for run %s",
            getattr(tracker_run, "id", None),
            exc_info=True,
        )
        return False


def _extract_completed_reply_from_message(message) -> str:
    """从最终 assistant ChatMessage 中提取给 TrackerRun 摘要使用的正文。"""
    blocks = getattr(message, "content_blocks_json", None)
    if isinstance(blocks, list):
        parts: list[str] = []
        for block in blocks:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text = str(block.get("text") or "").strip()
                if text:
                    parts.append(text)
        full_text = "\n\n".join(parts).strip()
        if full_text:
            return full_text

    return (getattr(message, "text_summary", "") or "").strip()


def _find_completed_chat_reply(tracker_run: TrackerRun) -> str:
    """查找已完成本地 runtime transcript 的最终回复。

    Celery worker 在 ``RemoteAgentDispatcher`` 返回后、保存 TrackerRun 终态前
    被重启时，会出现 Chat/Trace 已完成但 Run 仍 running 的孤儿状态。per-run
    ChatSession 是审计事实源：若已有一条足够稳定的 assistant ``end_turn`` 消息，
    recovery 可以据此补写 Run 终态。

    ：同 Run 复用 session 后，必须只认本次 attempt 开始之后的消息，
    否则上一轮失败前的阶段性汇报会被误判为本次完成。
    """
    session_id = getattr(tracker_run, "chat_session_id", None)
    if not session_id:
        return ""

    try:
        from apps.chat.conversation.models import ChatMessage

        qs = ChatMessage.objects.filter(
            session_id=session_id,
            role="assistant",
            stop_reason="end_turn",
            error_info_json__isnull=True,
        )
        # 同 session 多 attempt 时必须有下界；缺 stamp 时用 started_at，
        # 再缺则拒绝对 transcript 做完成补偿，避免误判旧消息。
        attempt_started = _parse_attempt_started_at(tracker_run) or getattr(
            tracker_run, "started_at", None
        )
        if attempt_started is None:
            return ""
        qs = qs.filter(created_at__gte=attempt_started)
        message = qs.order_by("-updated_at", "-created_at").first()
        if not message:
            return ""

        # 给正常执行器一点收尾时间，避免 recovery 与活 worker 同时写统计。
        updated_at = getattr(message, "updated_at", None)
        if updated_at and updated_at > (
            timezone.now() - timedelta(seconds=COMPLETED_TRANSCRIPT_RECONCILE_GRACE_SECONDS)
        ):
            return ""

        return _extract_completed_reply_from_message(message)
    except Exception:
        logger.debug(
            "[Tracker] completed transcript lookup failed for run %s",
            getattr(tracker_run, "id", None),
            exc_info=True,
        )
        return ""


def _find_completed_trace_reply(tracker_run: TrackerRun) -> str:
    """从已完成的本地 runtime trace 补偿 TrackerRun 结果。

    当 relay 漏掉 ``message_stop`` / ``done`` 时，最终 ChatMessage 可能无法落库；
    但 ``ExecutionTrace.status=completed`` 仍是 runtime 已正常结束的事实源。若
    DONE payload 存在则使用其 content，否则写一条可诊断的完成摘要，避免 Run
    永久停在 running。
    """
    session_id = getattr(tracker_run, "chat_session_id", None)
    if not session_id:
        return ""

    try:
        from apps.services.agent_engine.models import ExecutionTrace, TraceEvent

        qs = ExecutionTrace.objects.filter(
            session_id=str(session_id),
            status="completed",
            ended_at__isnull=False,
        )
        attempt_started = _parse_attempt_started_at(tracker_run) or getattr(
            tracker_run, "started_at", None
        )
        if attempt_started is None:
            return ""
        qs = qs.filter(ended_at__gte=attempt_started)
        trace = qs.order_by("-ended_at").first()
        if not trace:
            return ""

        ended_at = getattr(trace, "ended_at", None)
        if ended_at and ended_at > (
            timezone.now() - timedelta(seconds=COMPLETED_TRANSCRIPT_RECONCILE_GRACE_SECONDS)
        ):
            return ""

        done_event = (
            TraceEvent.objects
            .filter(trace=trace, event_type="done")
            .order_by("-seq")
            .first()
        )
        if done_event:
            payload = getattr(done_event, "output", None) or getattr(done_event, "input", None) or {}
            if isinstance(payload, dict):
                content = str(payload.get("content") or "").strip()
                if content:
                    return content

        return "任务已完成，但最终汇报消息未成功持久化；请以已完成的产物和执行记录为准。"
    except Exception:
        logger.debug(
            "[Tracker] completed trace lookup failed for run %s",
            getattr(tracker_run, "id", None),
            exc_info=True,
        )
        return ""


def _mark_tracker_run_completed(
    tracker_run: TrackerRun,
    *,
    reply: str,
    recovery_source: str,
    release_reason: str,
) -> bool:
    """将 running TrackerRun 标记为 completed，并执行统一终态副作用。"""
    if tracker_run.status != "running":
        return False

    if not reply:
        return False

    now = timezone.now()
    context = tracker_run.context or {}
    context["agent_result"] = {"response": reply[:5000]}
    context["recovery_source"] = recovery_source

    duration = None
    if tracker_run.started_at:
        duration = (now - tracker_run.started_at).total_seconds()

    updated = TrackerRun.objects.filter(
        id=tracker_run.id,
        status="running",
    ).update(
        status="completed",
        context=context,
        progress_pct=100,
        progress_message=reply[:200],
        error_summary="",
        finished_at=now,
        duration=duration,
    )
    if not updated:
        return False

    tracker_run.refresh_from_db()
    _release_tracker_run_runtime_claim(
        tracker_run,
        reason=release_reason,
    )
    _update_tracker_stats(tracker_run.tracker_id, success=True)

    try:
        notifier = TrackerNotificationService(tracker_run)
        notifier.notify_progress(tracker_run)
        notifier.notify_run_completed(tracker_run)
    except Exception:
        logger.debug(
            "[Tracker] completed transcript recovery notify failed for %s",
            tracker_run.id,
            exc_info=True,
        )

    try:
        from apps.tracker.services.tracker_trigger_service import trigger_by_tracker_completed

        trigger_by_tracker_completed(
            str(tracker_run.tracker_id),
            str(tracker_run.id),
            trigger_context=tracker_run.trigger_context,
        )
    except Exception:
        logger.debug("[Tracker] completed transcript cascade failed", exc_info=True)

    logger.warning(
        "[Tracker] recovered completed TrackerRun from %s: %s (tracker=%s)",
        recovery_source,
        tracker_run.id,
        tracker_run.tracker_id,
    )
    return True


def _complete_tracker_run_from_transcript(tracker_run: TrackerRun) -> bool:
    """将已完成 transcript 的 running TrackerRun 补偿为 completed。"""
    if tracker_run.status != "running":
        return False

    reply = _find_completed_chat_reply(tracker_run)
    recovery_source = "completed_chat_transcript"
    if not reply:
        reply = _find_completed_trace_reply(tracker_run)
        recovery_source = "completed_runtime_trace"

    return _mark_tracker_run_completed(
        tracker_run,
        reply=reply,
        recovery_source=recovery_source,
        release_reason="completed_transcript_recovery",
    )


def complete_tracker_run_from_runtime_done(task_id: str, event_payload: dict) -> bool:
    """relay 收到 runtime done 后，按 task_id 立即收尾对应的 TrackerRun。

    forward_runner 正常会通过 ``runtime:result:{task_id}`` 唤醒 Celery worker，再由
    skill_executor 写终态。但真实设备链路里可能出现结果 key 读不到、worker 中断或
    Redis 竞态；此时 relay done / Chat transcript 已经证明 Agent turn 结束，不能让
    TrackerRun 继续卡在 running 等下一轮 stuck recovery。
    """
    if not isinstance(task_id, str) or not task_id:
        return False

    tracker_run = (
        TrackerRun.objects
        .select_related("tracker")
        .filter(status="running")
        .filter(Q(context___runtime_task_id=task_id) | Q(context__runtime_task_id=task_id))
        .order_by("-started_at")
        .first()
    )
    if not tracker_run:
        return False

    if bool(event_payload.get("error", False)):
        notifier = TrackerNotificationService(tracker_run)
        error_message = (
            str(event_payload.get("error_message") or "").strip()
            or str(event_payload.get("content") or "").strip()
            or "runtime done returned error"
        )
        # 快路径失败也把原始错误写入 context，避免只留在会过期的 Redis。
        try:
            ctx = dict(tracker_run.context or {})
            ctx["agent_result"] = {
                "error_category": "runtime_failed",
                "error_message": error_message[:500],
            }
            TrackerRun.objects.filter(id=tracker_run.id).update(context=ctx)
            tracker_run.context = ctx
        except Exception:
            logger.debug(
                "[Tracker] persist agent_result on runtime_done failed for %s",
                tracker_run.id,
                exc_info=True,
            )
        _fail_tracker_run(
            tracker_run,
            error_message,
            notifier,
            error_category="runtime_failed",
        )
        return True

    reply = str(event_payload.get("content") or "").strip()
    if not reply:
        reply = _find_completed_chat_reply(tracker_run)
    if not reply:
        reply = "任务已完成，但最终汇报消息未成功持久化；请以已完成的产物和执行记录为准。"

    return _mark_tracker_run_completed(
        tracker_run,
        reply=reply,
        recovery_source="runtime_done_event",
        release_reason="runtime_done_event",
    )


def finalize_host_tracker_run(tracker_run: TrackerRun, *, error: str = "") -> dict:
    """本机跑完后写回 Run 终态。"""
    if error.strip():
        _fail_tracker_run(
            tracker_run,
            error.strip(),
            error_category="host_execution",
        )
        return {"finalized": True, "status": "failed"}
    if _complete_tracker_run_from_transcript(tracker_run):
        return {"finalized": True, "status": "completed"}
    if _mark_tracker_run_completed(
        tracker_run,
        reply="任务已完成，但最终汇报消息未成功持久化；请以已完成的产物和执行记录为准。",
        recovery_source="host_finalize",
        release_reason="host_finalize",
    ):
        return {"finalized": True, "status": "completed"}
    tracker_run.refresh_from_db(fields=["status"])
    return {"finalized": False, "status": tracker_run.status}


def recover_stuck_runs(
    *,
    timeout_seconds: int = STUCK_TIMEOUT_SECONDS,
    pending_orphan_timeout_seconds: int = PENDING_DISPATCH_ORPHAN_TIMEOUT_SECONDS,
    limit: int = 100,
    workspace_device_id=None,
    host_owned_only: bool = False,
) -> int:
    """回收长时间处于 running/pending 的 TrackerRun。

    定时 Tracker 的回收由本机 agent-host 调用，并限定 ``workspace_device_id``。
    """
    from apps.tracker.constants import HOST_OWNED_TRIGGER_TYPES

    now_for_cutoff = timezone.now()
    cutoff = now_for_cutoff - timedelta(seconds=max(timeout_seconds, 60))
    pending_cutoff = now_for_cutoff - timedelta(seconds=max(pending_orphan_timeout_seconds, 60))
    completed_reconcile_cutoff = now_for_cutoff - timedelta(
        seconds=COMPLETED_TRANSCRIPT_RECONCILE_GRACE_SECONDS,
    )
    qs = TrackerRun.objects.filter(
        Q(status="pending", started_at__lt=pending_cutoff)
        | Q(status__in=("running", "waiting_checkpoint"), started_at__lt=cutoff)
        | Q(
            status="running",
            chat_session_id__isnull=False,
            started_at__lt=completed_reconcile_cutoff,
        )
    )
    if workspace_device_id is not None:
        qs = qs.filter(tracker__workspace__device_id=workspace_device_id)
    if host_owned_only:
        qs = qs.filter(tracker__trigger_type__in=HOST_OWNED_TRIGGER_TYPES)
    stuck_runs = list(qs.select_related("tracker")[:limit])

    recovered = 0
    for tr in stuck_runs:
        try:
            if _complete_tracker_run_from_transcript(tr):
                recovered += 1
                continue

            original_status = tr.status
            is_full_timeout = bool(tr.started_at and tr.started_at < cutoff)
            is_pending_orphan_timeout = bool(tr.started_at and tr.started_at < pending_cutoff)
            celery_task_id = _tracker_run_task_id(tr)
            if original_status != "pending" and not is_full_timeout:
                continue
            if original_status == "pending" and not is_pending_orphan_timeout:
                continue
            # 执行队列在本机：没有 Celery task_id 的 pending 不是投递孤儿，
            # 电脑没开时应一直等本机接手，不能按 2 分钟云队列口径杀掉。
            if original_status == "pending" and not celery_task_id:
                continue
            retry_grace_until = (tr.context or {}).get(
                TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY
            )
            if (
                original_status == "pending"
                and not is_full_timeout
                and retry_grace_until
            ):
                try:
                    if float(retry_grace_until) > now_for_cutoff.timestamp():
                        logger.debug(
                            "[Tracker] TrackerRun %s 仍在瞬态重试宽限窗内，跳过回收",
                            tr.id,
                        )
                        continue
                except (TypeError, ValueError):
                    logger.debug(
                        "[Tracker] TrackerRun %s 的瞬态重试宽限时间无效: %r",
                        tr.id,
                        retry_grace_until,
                    )
            if celery_task_id:
                try:
                    from celery.result import AsyncResult
                    task_state = AsyncResult(celery_task_id).state
                    # Celery 的 PENDING 同时表示“已在 broker/worker 排队”和“结果后端
                    # 不知道这个 task”。只要生产端已记录 task_id，就不能在 2 分钟
                    # 短窗把 PENDING 当作孤儿——macOS 本地 Tracker worker 为单槽时，
                    # 一个长任务足以让后续正常任务排队数分钟。STARTED / RETRY 同理。
                    #
                    # 真正遗失但留有 task_id 的任务仍由 full timeout 兜底；没有 task_id
                    # 的 pending 才走短窗回收。明确终态（FAILURE / REVOKED / SUCCESS）
                    # 则继续回收，避免终态任务留下 pending 业务记录。
                    if task_state in ("PENDING", "STARTED", "RETRY") and not is_full_timeout:
                        logger.debug(
                            "[Tracker] TrackerRun %s 的 Celery task %s 仍在排队或活跃 "
                            "(state=%s)，跳过短窗回收",
                            tr.id, celery_task_id, task_state,
                        )
                        continue
                except Exception:
                    logger.debug("[Tracker] Celery task state check failed for %s", tr.id, exc_info=True)

            now = timezone.now()
            # Wave 6 (charter §4.4 / 6.1):超时回收的固定文案手工写人话——
            # 不走 humanize_failure_message 是因为这两条文案已是人话且场景
            # 极特殊(系统级回收,非 Skill 抛错),不要被关键词翻译规则二次干预。
            # 但仍按"现象 + 恢复"双段式书写。
            if original_status == "pending":
                if (tr.trigger_context or {}).get("late_by_seconds"):
                    error_msg = (
                        "这次是错过原定时间后的补跑,已经成功创建执行记录,但后台执行队列没有及时接手,"
                        "所以系统先把这条补跑记录结束了。可以稍后重新触发一次,或确认 Celery worker 正常后再试。"
                    )
                else:
                    error_msg = (
                        "这次执行已经创建记录,但后台执行队列没有及时接手,所以系统先把它结束了。"
                        "可以重新触发一次,或者稍后再试。"
                    )
            elif original_status == "waiting_checkpoint":
                error_msg = (
                    "这次执行停在旧版检查点等待状态太久,我先把它结束了。"
                    " 可以重新触发一次,我会按当前单 Skill 执行链路重新跑。"
                )
            else:
                error_msg = (
                    f"这次执行跑得有点久(超过 {int(timeout_seconds // 60)} 分钟还没结束),"
                    "我先把它中止了。可以让我把任务拆细一些再重试。"
                )

            with transaction.atomic(using=postgres_app_db_alias()):
                updated = TrackerRun.objects.filter(
                    id=tr.id,
                    status__in=("running", "pending", "waiting_checkpoint"),
                ).update(
                    status="failed",
                    error_summary=error_msg,
                    finished_at=now,
                )
                if not updated:
                    continue

            tr.refresh_from_db()
            if tr.started_at:
                TrackerRun.objects.filter(id=tr.id).update(
                    duration=(now - tr.started_at).total_seconds()
                )

            _update_tracker_stats(tr.tracker_id, success=False)

            try:
                wt_id = str(tr.tracker.organization_id) if tr.tracker else ""
                _get_organization_semaphore(wt_id).release_simple()
            except Exception:
                logger.debug("[Tracker] semaphore release failed for stuck run %s", tr.id, exc_info=True)

            try:
                from apps.tracker.services.tracker_service import TrackerService
                TrackerService._request_run_cancellation(tr)
            except Exception:
                logger.debug("[Tracker] run cancellation request failed for stuck run %s", tr.id, exc_info=True)

            _release_tracker_run_runtime_claim(tr, reason="recover_stuck_runs")

            try:
                notifier = TrackerNotificationService(tr)
                notifier.notify_progress(tr)
                notifier.notify_run_failed(tr)
            except Exception:
                logger.debug("[Tracker] recover notify failed for %s", tr.id, exc_info=True)

            recovered += 1
            logger.warning("[Tracker] 回收卡死 TrackerRun: %s (tracker=%s)", tr.id, tr.tracker_id)
        except Exception:
            logger.exception("[Tracker] recover_stuck_runs error for %s", tr.id)

    return recovered


# ─── Re-exports for backward compatibility ─────────────────────
# 维持 ``from apps.tracker.services.tracker_executor import run_skill_based`` 可用。
from apps.tracker.services.skill_executor import run_skill_based  # noqa: F401, E402
from apps.services.common.db_router import postgres_app_db_alias
