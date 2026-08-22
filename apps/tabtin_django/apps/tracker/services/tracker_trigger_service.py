"""Tracker 触发器服务：webhook 入站、tracker_completed 级联、table_event 路由。

Wave 7.3 (charter v1.8 §6.3 + plan v2.1 §Phase 7) 触发风暴防护：
  - debounce：N 秒内多次事件合并为 1 次 trigger
  - rate_limit：每小时最多触发 N 次（默认 20）
  - circuit_breaker：1 分钟内触发 X 次（默认 10）→ 自动暂停 Tracker + 通知用户
  - first_trigger：event Tracker 首次触发后弹 Inbox 通知

字段全部存放在 ``Tracker.trigger_config`` JSON（charter §7.1 字段封闭，禁止
新加 model 列）：
  - trigger_config.debounce_seconds (int, 默认 0 = 关闭)
  - trigger_config.rate_limit_per_hour (int, 默认 20)
  - trigger_config.circuit_breaker_threshold (int, 默认 10, 1 分钟窗口)
  - intent_snapshot.first_triggered_at (ISO datetime, 首次触发标记)
  - intent_snapshot.last_pause_reason (str, 熔断暂停原因)

Module C 收尾（2026-05-26）：
- ``trigger_by_goal_completed`` → ``trigger_by_tracker_completed``（函数名 + 形参 + wire format）
- trigger_context wire fields ``source='goal_completed'`` / ``completed_goal_id`` → ``tracker_completed`` / ``completed_tracker_id``
- trigger_config storage key ``goal_id`` → ``tracker_id``（migration 0030 同步迁移存量数据）
- trigger_type literal ``'goal_completed'`` → ``'tracker_completed'``（migration 0030 同步）
- ``_storm_guard_keys`` 形参 ``goal_id`` → ``tracker_id``；cache key 字符串值保持 ``tracker:storm:*`` 不变
- ``cascade_dedup_key`` cache key 字符串前缀 ``cascade_tracker:`` 保持不变
- ``tbl_goal:`` dedup key 字符串前缀 → ``tbl_tracker:``（TTL 10s，影响窗口极小）
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
from dataclasses import dataclass
from typing import Optional

from django.core.cache import cache

from apps.tracker.models import Tracker
from apps.tracker.services.tracker_executor import start_tracker_run
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)

_CASCADE_DEDUP_TTL = 600  # 级联去重窗口（秒），覆盖单次 TrackerRun 最大执行时间
_WEBHOOK_REQUIRE_SECRET = os.environ.get("WEBHOOK_REQUIRE_SECRET", "").lower() in ("1", "true", "yes")

_TABLE_RECORD_ACTION_LABELS = {
    "record_created": "新增记录",
    "record_updated": "更新记录",
    "record_deleted": "删除记录",
    "created": "新增记录",
    "updated": "更新记录",
    "deleted": "删除记录",
}


# ─── Wave 7.3 触发风暴防护（charter v1.8 §6.3 + plan v2.1 §Phase 7）────

# 默认配置（charter §7.1 字段封闭——所有字段都进 trigger_config JSON）
STORM_GUARD_DEFAULTS = {
    "debounce_seconds": 0,           # 0 = 关闭 debounce
    "rate_limit_per_hour": 20,       # 默认 20 次/小时
    "circuit_breaker_threshold": 10, # 1 分钟内 ≥ 10 次触发 → 熔断
}
# 熔断窗口固定 60s（不暴露用户配置；charter §6.3 "防风暴是平台保障非用户可调"）
_CIRCUIT_BREAKER_WINDOW_SECONDS = 60
# rate_limit 窗口固定 1 小时
_RATE_LIMIT_WINDOW_SECONDS = 3600


@dataclass
class StormGuardDecision:
    """触发风暴防护决策结果。

    属性：
      allowed: 是否允许触发
      reason: 拒绝原因（仅当 allowed=False；用作 logger / inbox 反馈）
      should_trip_circuit: 是否需要触发熔断动作（上层据此调 _trip_circuit_breaker）
      circuit_broken: 是否已成功完成熔断（_trip_circuit_breaker 返回值）
      first_trigger: 是否本次为该 Tracker 首次触发（上层应推首次触发 Inbox 通知）
    """
    allowed: bool
    reason: str = ""
    should_trip_circuit: bool = False
    circuit_broken: bool = False
    first_trigger: bool = False


def _storm_guard_config(tracker: Tracker) -> dict:
    """从 ``tracker.trigger_config`` 解析风暴防护配置，缺省字段填默认值。"""
    cfg = tracker.trigger_config or {}
    return {
        "debounce_seconds": int(cfg.get("debounce_seconds",
                                        STORM_GUARD_DEFAULTS["debounce_seconds"]) or 0),
        "rate_limit_per_hour": int(cfg.get("rate_limit_per_hour",
                                           STORM_GUARD_DEFAULTS["rate_limit_per_hour"]) or 20),
        "circuit_breaker_threshold": int(cfg.get("circuit_breaker_threshold",
                                                 STORM_GUARD_DEFAULTS["circuit_breaker_threshold"]) or 10),
    }


def _storm_guard_keys(tracker_id: str) -> dict[str, str]:
    """所有 cache key 在此集中定义，避免在多处分散写出 prefix。

    cache key 字符串值保持 ``tracker:storm:*`` 不变（重命名 cache key namespace
    会让生产环境正在运行的 Tracker storm guard 计数失效）；本函数只把 Python 形参
    从 goal_id 改成 tracker_id。
    """
    return {
        "debounce":      f"tracker:storm:debounce:{tracker_id}",
        "rate":          f"tracker:storm:rate:{tracker_id}",
        "circuit":       f"tracker:storm:circuit:{tracker_id}",
        "first_trigger": f"tracker:storm:first_triggered:{tracker_id}",
    }


def decide_storm_guard(
    tracker_id: str,
    trigger_config: dict | None,
) -> StormGuardDecision:
    """**纯决策函数**——只读 cache + trigger_config，不读不写 DB Tracker 对象。

    本函数把 storm guard 的 4 机制核心决策逻辑分离出来，让单元测试可以
    在 SimpleTestCase 层面（不开 PG/MySQL test DB）真跑核心逻辑——避免
    Wave 5 反思 16 "项目客观无真 DB 基础设施"导致核心逻辑无测试保护的问题。

    返回的 ``StormGuardDecision``：
      - ``should_trip_circuit=True`` 时上层应当调用 ``_trip_circuit_breaker(tracker)``
        完成 DB 副作用（status 转 paused + intent_snapshot 写入）
      - ``first_trigger=True`` 的副作用（写 intent_snapshot.first_triggered_at）
        **由 ``apply_storm_guard`` 内部统一处理**——上层 caller 不要再额外调
        ``_mark_first_triggered(tracker)``，否则会重复打 PG 行锁（Module F 修复）

    设计取舍：
      - 每个机制独立检查，按"先粗后细"顺序：debounce → rate → circuit
        （先短时去重，再小时限流，最后熔断；rate / circuit 共享 INCR 计数器
        架构但不同窗口与阈值）
      - 不抛异常——任一机制 cache 故障应 fail-open 允许触发
        （平台稳定性优先；charter §6.3 防风暴不能反过来挡正常流量）
    """
    # 用临时 dict 模拟 _storm_guard_config 的输入接口
    cfg_raw = trigger_config or {}
    cfg = {
        "debounce_seconds": int(cfg_raw.get("debounce_seconds",
                                            STORM_GUARD_DEFAULTS["debounce_seconds"]) or 0),
        "rate_limit_per_hour": int(cfg_raw.get("rate_limit_per_hour",
                                               STORM_GUARD_DEFAULTS["rate_limit_per_hour"]) or 20),
        "circuit_breaker_threshold": int(cfg_raw.get("circuit_breaker_threshold",
                                                     STORM_GUARD_DEFAULTS["circuit_breaker_threshold"]) or 10),
    }
    keys = _storm_guard_keys(tracker_id)

    # ── 0) first_trigger 标记（**Wave 7 续作 P1-3 修复**：必须最先做）──
    # 语义：标记"我们检测到了第一次"——无论是否最终 allowed。
    # 修复前 bug：first_trigger 在 step 4 做（circuit / rate / debounce 之后）。
    # corner case：首次触发恰好是第 10 次连续（全部前 9 次因故被允许，第 10
    # 次被 circuit 抢先 return） → first_triggered_at 永远不会被记录，
    # 导致 UI"首次触发于…"永远空。
    # 修复后：cache.add 在最前，原子性"看见即标记"，不受后续决策影响。
    is_first = False
    try:
        is_first = bool(cache.add(keys["first_trigger"], "1", timeout=86400 * 30))
    except Exception:
        logger.debug("[storm_guard] first_trigger cache failed", exc_info=True)

    # ── 1) debounce ────────────────────────────────────────
    debounce_seconds = cfg["debounce_seconds"]
    if debounce_seconds > 0:
        try:
            ok = cache.add(keys["debounce"], "1", timeout=debounce_seconds)
            if not ok:
                return StormGuardDecision(
                    allowed=False,
                    reason=f"debounce_active({debounce_seconds}s)",
                    first_trigger=is_first,
                )
        except Exception:
            logger.debug("[storm_guard] debounce cache failed", exc_info=True)

    # ── 2) rate_limit（1 小时窗口）────────────────────────
    rate_limit = cfg["rate_limit_per_hour"]
    try:
        cache.add(keys["rate"], 0, timeout=_RATE_LIMIT_WINDOW_SECONDS)
        new_rate = cache.incr(keys["rate"])
        if new_rate > rate_limit:
            return StormGuardDecision(
                allowed=False,
                reason=f"rate_limit({rate_limit}/hour)",
                first_trigger=is_first,
            )
    except Exception:
        logger.debug("[storm_guard] rate_limit cache failed", exc_info=True)

    # ── 3) circuit_breaker（60 秒窗口）────────────────────
    threshold = cfg["circuit_breaker_threshold"]
    try:
        cache.add(keys["circuit"], 0, timeout=_CIRCUIT_BREAKER_WINDOW_SECONDS)
        new_circuit = cache.incr(keys["circuit"])
        if new_circuit >= threshold:
            return StormGuardDecision(
                allowed=False,
                reason=f"circuit_breaker({threshold}/{_CIRCUIT_BREAKER_WINDOW_SECONDS}s)",
                should_trip_circuit=True,
                first_trigger=is_first,
            )
    except Exception:
        logger.debug("[storm_guard] circuit_breaker cache failed", exc_info=True)

    return StormGuardDecision(allowed=True, first_trigger=is_first)


def apply_storm_guard(
    tracker: Tracker,
    *,
    event_label: str = "",
    space_id: Optional[str] = None,
) -> StormGuardDecision:
    """4 合 1 触发风暴防护（DB 副作用包装层）：纯决策走 ``decide_storm_guard``，
    熔断动作 / first_trigger 标记走 ``_trip_circuit_breaker`` + ``_mark_first_triggered``。

    调用时机：所有事件触发路径（table_event / webhook / tracker_completed / 未来 EventBus）
    在调用 ``start_tracker_run`` **之前**调用本函数。返回 ``allowed=True`` 才能继续触发。

    熔断后**当场把 Tracker.status 转 paused**（charter §6.3 plan §7.3 第 633 行：
    "1 分钟内触发 X 次 → 自动暂停 + 通知用户"）；intent_snapshot 写
    last_pause_reason 让用户能看到"为什么被暂停"。
    """
    decision = decide_storm_guard(str(tracker.id), tracker.trigger_config)

    # **Wave 7 续作 P1-3 修复**: first_trigger DB 副作用必须独立于 circuit 决策。
    # 修复前 bug：should_trip_circuit=True 时上层早 return，跳过 _mark_first_triggered，
    # 导致"首次触发恰好命中熔断"场景下 intent_snapshot.first_triggered_at 不被写入。
    # 修复：所有 first_trigger=True 的 case 都先 mark intent_snapshot，再走熔断分支。
    if decision.first_trigger:
        _mark_first_triggered(tracker)

    if decision.should_trip_circuit:
        threshold = _storm_guard_config(tracker)["circuit_breaker_threshold"]
        broken = _trip_circuit_breaker(
            tracker,
            threshold=threshold,
            window_seconds=_CIRCUIT_BREAKER_WINDOW_SECONDS,
            event_label=event_label,
            space_id=space_id,
        )
        decision.circuit_broken = broken
        return decision

    return decision


def _trip_circuit_breaker(
    tracker: Tracker,
    *,
    threshold: int,
    window_seconds: int,
    event_label: str,
    space_id: Optional[str],
) -> bool:
    """熔断动作：把 Tracker.status 转 ``paused`` + 写 intent_snapshot.last_pause_reason
    + 推送 Inbox 通知给 Tracker 创建者。

    返回 ``True`` 表示熔断动作完成（包括 Tracker 状态确实从 active 转到 paused）。
    若 Tracker 已经是 paused（被并发 worker 抢先转过），仍返回 True 让上层日志一致；
    DB 异常则返回 False。

    幂等性保证（**反思 14 防线**：看似 wire 上不等于真用）：
      - 用 ``filter(status='active').update(status='paused')`` 行级原子条件更新；
        多 worker 并发熔断时只有第一个真正改 DB
      - reason 字段写时机：仅在 DB 更新真生效时（rows_affected=1），
        避免被并发 worker 覆盖出现错乱时间戳
    """
    from django.utils import timezone
    from django.db import transaction
    try:
        # 用 filter().update() 替代 select_for_update + save，避免跨 DB 事务依赖；
        # 仅当 status 仍是 active 时才转 paused（幂等）
        rows = Tracker.objects.filter(id=tracker.id, status="active").update(status="paused")
        if rows == 0:
            # 已被其他 worker 暂停 / 已是 paused → 视为熔断已完成
            logger.info(
                "[storm_guard] circuit_breaker 已触发（tracker 已非 active）: tracker=%s",
                tracker.id,
            )
            return True

        # 写 intent_snapshot.last_pause_reason（charter §7.1 字段封闭，
        # 用 intent_snapshot JSON 存暂停原因不新加 column）
        try:
            now_iso = timezone.now().isoformat()
            with transaction.atomic(using=postgres_app_db_alias()):
                fresh = Tracker.objects.select_for_update().get(id=tracker.id)
                snapshot = fresh.intent_snapshot or {}
                if not isinstance(snapshot, dict):
                    snapshot = {}
                snapshot["last_pause_reason"] = (
                    f"触发风暴防护熔断（{window_seconds}s 内触发 ≥ {threshold} 次）"
                )
                snapshot["last_pause_at"] = now_iso
                snapshot["last_pause_event_label"] = event_label or ""
                fresh.intent_snapshot = snapshot
                fresh.save(update_fields=["intent_snapshot"])
        except Exception:
            logger.warning(
                "[storm_guard] 写 intent_snapshot 失败（不影响熔断主路径）",
                exc_info=True,
            )

        logger.warning(
            "[storm_guard] 熔断触发：tracker=%s 在 %ds 内触发 ≥ %d 次，自动暂停",
            tracker.id, window_seconds, threshold,
        )
        return True
    except Exception:
        logger.warning("[storm_guard] _trip_circuit_breaker 异常", exc_info=True)
        return False


def _mark_first_triggered(tracker: Tracker) -> None:
    """首次触发：写 intent_snapshot.first_triggered_at 让 UI 能展示。

    使用 select_for_update 保证 read-modify-write 原子性；并发场景下只有第一个
    worker 真写入（其它 worker 看到字段已存在自然跳过）。
    """
    from django.utils import timezone
    from django.db import transaction
    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            fresh = Tracker.objects.select_for_update().get(id=tracker.id)
            snapshot = fresh.intent_snapshot or {}
            if not isinstance(snapshot, dict):
                snapshot = {}
            if "first_triggered_at" in snapshot:
                return  # 已写过
            snapshot["first_triggered_at"] = timezone.now().isoformat()
            fresh.intent_snapshot = snapshot
            fresh.save(update_fields=["intent_snapshot"])
    except Exception:
        logger.debug("[storm_guard] _mark_first_triggered failed", exc_info=True)


def trigger_by_webhook(
    webhook_path: str,
    payload: dict,
    source_ip: Optional[str] = None,
    signature: str = "",
    raw_body: bytes = b"",
) -> str | None:
    """Webhook 入站触发：匹配 trigger_config.path 的所有 active Tracker。

    安全机制：若 trigger_config 包含 secret 字段，则验证 HMAC-SHA256 签名。
    签名通过 X-Webhook-Signature 请求头传递。

    TGE-013: 触发所有匹配的 Tracker（而非只取 first()），每个独立做签名校验。
    """
    trackers = list(
        Tracker.objects.filter(
            trigger_type="webhook",
            status="active",
            trigger_config__path=webhook_path,
        )
    )
    if not trackers:
        logger.info("[Tracker webhook] No matching Tracker for path: %s", webhook_path)
        return None

    if len(trackers) > 1:
        logger.warning(
            "[Tracker webhook] %d 个 Tracker 绑定同一 path: %s, tracker_ids=%s",
            len(trackers), webhook_path, [str(t.id) for t in trackers],
        )

    first_run_id = None
    for tracker in trackers:
        cfg_secret = (tracker.trigger_config or {}).get("secret")
        if cfg_secret:
            body_bytes = raw_body if raw_body else b""
            expected = hmac.new(cfg_secret.encode(), body_bytes, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, expected):
                logger.warning(
                    "[Tracker webhook] 签名验证失败: path=%s tracker=%s ip=%s",
                    webhook_path, tracker.id, source_ip,
                )
                continue
        else:
            logger.warning(
                "[Tracker webhook] Tracker 未配置 HMAC secret（历史数据），"
                "%s: path=%s tracker=%s ip=%s",
                "拒绝触发（strict 模式）" if _WEBHOOK_REQUIRE_SECRET else "允许触发但建议尽快配置",
                webhook_path, tracker.id, source_ip,
            )
            if _WEBHOOK_REQUIRE_SECRET:
                continue

        # Wave 7.3 触发风暴防护（charter v1.8 §6.3 + plan §Phase 7）
        # Module F 修复：first_trigger 副作用已在 apply_storm_guard 内部统一处理，
        # 此处不再二次调用 _mark_first_triggered（避免每次首次触发多打一次 PG 行锁）。
        decision = apply_storm_guard(
            tracker,
            event_label=f"Webhook {webhook_path}",
            space_id=str(tracker.workspace_id) if tracker.workspace_id else None,
        )
        if not decision.allowed:
            logger.info(
                "[storm_guard] webhook 拒绝触发: tracker=%s path=%s reason=%s",
                tracker.id, webhook_path, decision.reason,
            )
            continue

        trigger_context = {
            "source": "webhook",
            "path": webhook_path,
            "payload": payload,
            "source_ip": source_ip,
            "source_label": "Webhook",
            "event_label": f"Webhook 入站 ({webhook_path})",
        }
        try:
            run_id = start_tracker_run(
                tracker_id=str(tracker.id),
                trigger_type="webhook",
                trigger_context=trigger_context,
            )
            if run_id and first_run_id is None:
                first_run_id = run_id
        except Exception:
            logger.warning(
                "[Tracker webhook] 启动 Tracker 失败: tracker=%s path=%s",
                tracker.id, webhook_path, exc_info=True,
            )

    return first_run_id


MAX_CASCADE_DEPTH = 10


def trigger_by_tracker_completed(
    completed_tracker_id: str,
    completed_run_id: str,
    trigger_context: dict | None = None,
):
    """Tracker 完成后级联触发：查找 trigger_type=tracker_completed 且匹配的 Tracker。

    防递归机制：
    - 深度限制：通过 trigger_context._cascade_chain 追踪调用链深度
    - 环检测（本地）：如果待触发的 tracker_id 已在调用链中则跳过
    - 环检测（分布式，TGE-010）：Redis SET NX 防止跨进程并发级联重复触发
    """
    cascade_chain: list = (trigger_context or {}).get("_cascade_chain", [])

    trackers = Tracker.objects.filter(
        trigger_type="tracker_completed",
        status="active",
    )

    dispatched = 0
    for tracker in trackers:
        cfg = tracker.trigger_config or {}
        # Module C 收尾：trigger_config storage key 从 ``goal_id`` 改成 ``tracker_id``。
        # migration 0030 已把存量 trigger_config 中 ``goal_id`` 重命名为 ``tracker_id``，
        # 新创建路径也直接写 ``tracker_id``，这里只读新 key。
        target_tracker_id = cfg.get("tracker_id")
        if target_tracker_id and target_tracker_id != completed_tracker_id:
            continue

        tracker_id_str = str(tracker.id)

        if len(cascade_chain) >= MAX_CASCADE_DEPTH:
            logger.warning(
                "[Tracker] 级联深度 %d 超限，停止触发 %s (chain=%s)",
                len(cascade_chain), tracker_id_str, cascade_chain,
            )
            continue

        if tracker_id_str in cascade_chain:
            logger.warning(
                "[Tracker] 检测到级联环路，跳过 %s (chain=%s)",
                tracker_id_str, cascade_chain,
            )
            continue

        # 数据库幂等检查：若已有由同一 completed_run_id 触发的 TrackerRun，跳过
        from apps.tracker.models import TrackerRun
        existing = TrackerRun.objects.filter(
            tracker_id=tracker_id_str,
            trigger_type="tracker_completed",
            trigger_context__completed_run_id=completed_run_id,
        ).exists()
        if existing:
            logger.info(
                "[Tracker] 级联幂等检查命中，跳过 %s (completed_run=%s)",
                tracker_id_str, completed_run_id,
            )
            continue

        # TGE-010: Redis 分布式去重 — 防止不同 Worker 并发触发同一级联
        cascade_dedup_key = f"cascade_tracker:{completed_run_id}:{tracker_id_str}"
        if not cache.add(cascade_dedup_key, "1", timeout=_CASCADE_DEDUP_TTL):
            logger.info(
                "[Tracker] 级联去重命中（跨进程），跳过 %s (completed_run=%s)",
                tracker_id_str, completed_run_id,
            )
            continue

        # Wave 7.3 触发风暴防护（charter v1.8 §6.3 + plan §Phase 7）
        # 级联触发也走风暴防护——避免上游 Tracker 高频完成时下游被炸。
        # Module F 修复：first_trigger 副作用已在 apply_storm_guard 内部统一处理。
        decision = apply_storm_guard(
            tracker,
            event_label="Tracker 级联触发",
            space_id=str(tracker.workspace_id) if tracker.workspace_id else None,
        )
        if not decision.allowed:
            logger.info(
                "[storm_guard] tracker_completed 级联拒绝触发: tracker=%s reason=%s",
                tracker_id_str, decision.reason,
            )
            cache.delete(cascade_dedup_key)
            continue

        upstream_name = ""
        try:
            upstream_name = Tracker.objects.filter(id=completed_tracker_id).values_list("name", flat=True).first() or ""
        except Exception:
            pass
        child_context = {
            # Module C wire format：source / completed_tracker_id 都改成新名（migration 0030
            # 不回填存量 TrackerRun.trigger_context，但产品未上线无影响）。
            "source": "tracker_completed",
            "completed_tracker_id": completed_tracker_id,
            "completed_run_id": completed_run_id,
            "_cascade_chain": cascade_chain + [tracker_id_str],
            "source_label": "Tracker 级联",
            "event_label": f"上游 Tracker 完成: {upstream_name}" if upstream_name else "上游 Tracker 完成",
            "resource_title": upstream_name,
        }
        try:
            result = start_tracker_run(
                tracker_id=tracker_id_str,
                trigger_type="tracker_completed",
                trigger_context=child_context,
            )
            if result:
                dispatched += 1
        except Exception:
            cache.delete(cascade_dedup_key)
            logger.warning(
                "[Tracker] 级联触发失败，已释放去重锁: tracker=%s", tracker_id_str, exc_info=True,
            )

    if dispatched:
        logger.info(
            "[Tracker] tracker_completed 级联触发: completed_tracker=%s dispatched=%d",
            completed_tracker_id, dispatched,
        )
    return dispatched


def trigger_by_table_event(
    organization_id: str,
    space_id: str | None,
    table_id: str,
    event_type: str,
    record_data: dict | None = None,
    event_id: str | None = None,
):
    """表格事件触发：匹配 trigger_config 中的 table_id 和事件类型。

    使用 cache-based 去重防止同一事件重复触发。
    """
    from django.core.cache import cache

    qs = Tracker.objects.filter(
        trigger_type="table_event",
        status="active",
        organization_id=organization_id,
    )
    if space_id:
        # ：Tracker.space FK 已 Drop；按 workspace 过滤（id-reuse）
        qs = qs.filter(workspace_id=space_id)

    dispatched = 0
    for tracker in qs.only("id", "trigger_config"):
        cfg = tracker.trigger_config or {}
        cfg_table_id = cfg.get("table_id")
        if cfg_table_id and cfg_table_id != table_id:
            continue
        cfg_events = cfg.get("events", [])
        if cfg_events:
            short_type = event_type.rsplit(".", 1)[-1] if "." in event_type else event_type
            if short_type not in cfg_events:
                continue

        cfg_conditions = cfg.get("conditions")
        if cfg_conditions:
            from apps.tracker.services.condition_evaluator import evaluate_conditions
            if not evaluate_conditions(cfg_conditions, record_data or {}):
                from apps.tracker.services.tracker_notification import notify_trigger_filtered
                notify_trigger_filtered(
                    organization_id=organization_id,
                    tracker_id=str(tracker.id),
                    event_type=event_type,
                    event_label=_TABLE_RECORD_ACTION_LABELS.get(
                        event_type.rsplit(".", 1)[-1] if "." in event_type else event_type,
                        event_type,
                    ),
                    space_id=space_id,
                )
                continue

        # Module C 收尾：cache key 前缀 ``tbl_goal:`` → ``tbl_tracker:``。
        # TTL 10s 窗口极小，重命名后存量 dedup cache key 自然过期；最坏 10s 内
        # 同事件可能跨进程重复触发一次（无功能影响——Tracker 级 single active run
        # 兜底，cancel 路径处理重复）。
        dedup_key = f"tbl_tracker:{tracker.id}:{event_id or ''}"
        if event_id and not cache.add(dedup_key, "1", timeout=10):
            continue

        # Wave 7.3 触发风暴防护（charter v1.8 §6.3 + plan §Phase 7）
        # apply_storm_guard 是统一的"事件触发是否应允许"入口，所有 4 个机制
        # 在此一次性做完——跨触发源（table_event / webhook / tracker_completed /
        # 未来 EventBus）共享同一套判断。需要 tracker 完整字段（status / intent_snapshot），
        # 重新查一次（前面的 .only("id", "trigger_config") 字段不够）。
        full_tracker = Tracker.objects.filter(id=tracker.id).first()
        if full_tracker is None:
            continue
        short_type_label = _TABLE_RECORD_ACTION_LABELS.get(
            event_type.rsplit(".", 1)[-1] if "." in event_type else event_type,
            event_type,
        )
        # Module F 修复：first_trigger 副作用已在 apply_storm_guard 内部统一处理。
        decision = apply_storm_guard(
            full_tracker,
            event_label=f"表格{short_type_label}",
            space_id=space_id,
        )
        if not decision.allowed:
            logger.info(
                "[storm_guard] table_event 拒绝触发: tracker=%s reason=%s",
                tracker.id, decision.reason,
            )
            continue

        table_name = ""
        try:
            from apps.tabdata.models import Table
            table_name = Table.objects.filter(id=table_id).values_list("name", flat=True).first() or ""
        except Exception:
            pass
        short_type = event_type.rsplit(".", 1)[-1] if "." in event_type else event_type
        # TGE-014: 提取独立 record_id，与 event_bridge 旧链路保持一致
        extracted_record_id = (record_data or {}).get("record_id", "") if record_data else ""
        trigger_context = {
            "source": "table_event",
            "table_id": table_id,
            "event_type": event_type,
            "event_id": event_id,
            "record_id": extracted_record_id,
            "record_data": record_data,
            "source_label": "TabData",
            "event_label": f"表格{_TABLE_RECORD_ACTION_LABELS.get(short_type, short_type)}",
            "resource_title": table_name,
        }
        try:
            result = start_tracker_run(
                tracker_id=str(tracker.id),
                trigger_type="table_event",
                trigger_context=trigger_context,
            )
            if result:
                dispatched += 1
        except Exception:
            logger.warning(
                "[Tracker] table_event 启动 Tracker 失败: tracker=%s table=%s event=%s",
                tracker.id,
                table_id,
                event_type,
                exc_info=True,
            )

    if dispatched:
        logger.info(
            "[Tracker] table_event 触发: table=%s event=%s dispatched=%d",
            table_id, event_type, dispatched,
        )
    return dispatched
