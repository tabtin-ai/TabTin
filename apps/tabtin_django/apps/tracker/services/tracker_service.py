"""Tracker 核心服务：CRUD + 触发。

Wave 2 (charter v1.8 §6.4 / §6.2)：执行模型单一——Tracker 通过单 Skill 执行。
- 删除 _create_steps / _validate_dag / _step_inputs_match_existing：V2 已废弃多步骤 DAG。
- create_tracker 入参收敛为 charter §7.1 终局字段（skill_key + skill_params + intent_snapshot
  + agent_id），不再接受 ``steps[]``。
- Tracker 模块波次 4 Stage 2.2 一刀切后入口收敛为：UI 表单 / CLI（``tabtin tracker new``）
  两条，**直接构造 ``TrackerCreate``**（DTO 合并后不再有翻译 helper），统一走
  ``create_tracker``（charter §6.2 单一创建路径）。
"""

from __future__ import annotations

import logging
import secrets
from datetime import timedelta
from typing import Optional

from django.core.cache import cache
from django.db import transaction
from django.utils import timezone
from django.core.exceptions import ValidationError

from apps.tabtinspace.services.base import BaseService, ensure_space_in_organization

from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.constants import TRACKER_TRIGGER_TYPE_CHOICES
from apps.tracker.tracker_schemas import TrackerCreate, TrackerUpdate
from apps.tracker.utils import ensure_cron_timezone
from apps.services.common.db_router import postgres_app_db_alias
from apps.i18n import _

logger = logging.getLogger(__name__)

# TS-14：合法 trigger_type 白名单（与 constants.TRACKER_TRIGGER_TYPE_CHOICES 同源）。
_VALID_TRIGGER_TYPES = frozenset(TRACKER_TRIGGER_TYPE_CHOICES.values())

# table_event 允许的事件短名（与 CLI / consumers 短名匹配口径一致）。
_VALID_TABLE_EVENT_TYPES = frozenset({"record_created", "record_updated", "record_deleted"})


def _extract_tracker_instructions(skill_params) -> str:
    """从 skill_params 取出执行指令（纯 Agent 模式任务主体）。"""
    if not isinstance(skill_params, dict):
        return ""
    raw = skill_params.get("instructions")
    if not isinstance(raw, str):
        return ""
    return raw.strip()


def _require_tracker_instructions(skill_params, *, skill_key: str = "") -> None:
    """#4230 / ：纯 Agent 模式必须有执行指令，避免只写名称就激活后秒败。

    绑定了 skill_key 时允许指令为空（方法论来自 Skill）。
    """
    if (skill_key or "").strip():
        return
    if _extract_tracker_instructions(skill_params):
        return
    raise ValidationError("请填写执行指令（告诉 Agent 要做什么），不能只填任务名称")


def _resolve_space_default_agent(space_id):
    """解析 Space 绑定的默认执行 Agent（单根契约）。

    复用 tabtinspace 的权威解析（bot space→其 agent / 单成员 space→唯一 agent）。
    用于「极简表单未显式选 Agent」时的兜底——任一步出错/解析不到都返回 None，
    由调用方决定是否报「必须指定执行 Agent」。DB/导入异常一律吞掉、不抛给上层。
    """
    if not space_id:
        return None
    try:
        from apps.tabtinspace.services.execution_binding import resolve_execution_agent
        from apps.tabtinspace.services.host_resolver import resolve_host

        space = resolve_host(space_id)
        if space is None:
            return None
        return resolve_execution_agent(space=space)
    except Exception:
        logger.debug("[TrackerService] resolve space fallback agent failed", exc_info=True)
        return None


def _validate_trigger_type_and_config(trigger_type: str, trigger_config: dict | None) -> None:
    """TS-14：trigger_type 白名单 + 新开放入口的最小 per-type config 校验。

    目的：避免非法 trigger_type 或缺字段的脏配置静默入库（charter §6.2 单一创建
    路径的入口防线）。非法时抛 ``ValidationError``，API 层翻成 400。

    分工边界：
      - cron 的表达式合法性由 ``compute_next_run(fail_loud=True)`` 兜底，这里不重复。
      - webhook secret 由 ``_ensure_webhook_secret`` 兜底生成。
      - manual / extension_event / webhook / tracker_completed 不在此强制 config
        字段（各自链路另有校验：事件目录 / 上游 Tracker / secret）。
      - 仅对本期新开放的 interval / at / table_event 做必填字段校验。
    """
    tt = (trigger_type or "").strip()
    if tt not in _VALID_TRIGGER_TYPES:
        allowed = " / ".join(sorted(_VALID_TRIGGER_TYPES))
        raise ValidationError(f"非法 trigger_type：{trigger_type!r}；合法值：{allowed}")

    cfg = trigger_config or {}

    if tt == "interval":
        seconds = cfg.get("interval_seconds", cfg.get("seconds"))
        try:
            seconds_int = int(seconds)
        except (TypeError, ValueError):
            raise ValidationError("interval 触发需要 trigger_config.interval_seconds（正整数秒）")
        if seconds_int < 1:
            raise ValidationError("interval 触发的 interval_seconds 必须 ≥ 1 秒")

    elif tt == "at":
        at_str = cfg.get("at")
        if not at_str or not str(at_str).strip():
            raise ValidationError("at 触发需要 trigger_config.at（ISO 8601 日期时间）")
        from django.utils.dateparse import parse_datetime
        at_dt = parse_datetime(str(at_str))
        if at_dt is None:
            raise ValidationError(
                f"at 触发的 trigger_config.at 无法解析为日期时间：{at_str!r}"
                "（用 ISO 8601，如 2026-06-10T09:00:00）"
            )
        # ：「定时一次」必须设在未来。过期 at 激活会被本机当成来晚了的一拍。
        # 60s 缓冲容忍 CLI/网络抖动与时钟漂移，避免误伤「马上要执行」的合法场景。
        if timezone.is_naive(at_dt):
            at_dt = timezone.make_aware(at_dt)
        if at_dt < timezone.now() - timedelta(seconds=60):
            raise ValidationError(
                "at 触发的 trigger_config.at 必须是未来时间"
                "（过去时间不可设置；如要立即执行请改用 manual 触发）"
            )

    elif tt == "table_event":
        table_id = cfg.get("table_id")
        if not table_id or not str(table_id).strip():
            raise ValidationError("table_event 触发需要 trigger_config.table_id")
        events = cfg.get("events")
        if not isinstance(events, (list, tuple)) or len(events) == 0:
            raise ValidationError(
                "table_event 触发需要 trigger_config.events（非空列表，如 ['record_created']）"
            )
        invalid = [e for e in events if e not in _VALID_TABLE_EVENT_TYPES]
        if invalid:
            raise ValidationError(
                f"table_event 的 events 含非法值 {invalid}；"
                "合法值：record_created / record_updated / record_deleted"
            )

# Wave 8 治理:cache 失败专属 logger,便于 Sentry / ELK / OTel 采集器
# 按 logger name 维度 group + alert,与业务 logger 分流。
# logger name 固定 ``scheduler.cache_failure`` 与 ``scheduler.deprecation``
# 同模式（见 services/deprecation_logger.py）。
_cache_failure_logger = logging.getLogger("scheduler.cache_failure")


def _record_storm_guard_cache_delete_failure(
    *,
    organization_id: str,
    tracker_id: str,
    cache_key_type: str,
    error: Exception,
) -> None:
    """resume_tracker 清理 storm guard cache key 失败时上报到运维监控。

    Wave 8 治理（用户视角:运维有 cache 告警；技术视角:反思 20 链路透传必有验证）:

    上报通道（双管齐下，覆盖两种部署形态）:
      1) 命名 logger ``scheduler.cache_failure`` (WARNING) ——
         ELK / Sentry 已配置 WARNING+ 采集 + grouping
      2) sentry_sdk.capture_exception 直送 Sentry (若已配置) ——
         exception fingerprint 自动 group,便于 alert + 趋势图

    metric 名 ``tracker.storm_guard.cache_delete_failure``（structured tags:
    organization_id / tracker_id / cache_key_type) 让运维能查询:
      - 哪个 organization 频繁 cache 失败（基础设施问题定位）
      - 哪类 cache key 失败（debounce / rate / circuit / first_trigger）
      - 趋势:cache 失败率上升 → redis 容量 / 网络问题预警

    设计选择:
      - 不抛异常:caller 在 except 内调本函数,本函数自身故障必须吞掉
      - 不阻塞 resume:fail-safe (charter §6.3)
      - 即便 sentry_sdk 未安装也能正常工作（_cache_failure_logger 仍记录）
    """
    # 主上报:命名 logger（structured kwargs 通过 extra 字段透传）
    try:
        _cache_failure_logger.warning(
            "tracker.storm_guard.cache_delete_failure "
            "organization_id=%s tracker_id=%s cache_key_type=%s error=%s",
            organization_id, tracker_id, cache_key_type, type(error).__name__,
            extra={
                "metric": "tracker.storm_guard.cache_delete_failure",
                "tags": {
                    "organization_id": organization_id,
                    "tracker_id": tracker_id,
                    "cache_key_type": cache_key_type,
                    "error_type": type(error).__name__,
                },
            },
        )
    except Exception:
        # logger 自身失败兜底 — 静默吞,不能阻塞 resume
        pass

    # 副上报:Sentry 若已配置则 capture_exception(让 Sentry alert 走起来)
    try:
        import sentry_sdk  # noqa: F401
        sentry_sdk.capture_exception(
            error,
            extras={  # type: ignore[arg-type]
                "metric": "tracker.storm_guard.cache_delete_failure",
                "organization_id": organization_id,
                "tracker_id": tracker_id,
                "cache_key_type": cache_key_type,
            },
        )
    except Exception:
        # sentry_sdk 未安装 / 未初始化 / capture 失败 → 静默吞
        pass


def _push_tracker_lifecycle_ws(tracker: Tracker, action: str, user=None) -> None:
    """向前端推送 Tracker 生命周期事件——同时驱动两条 WS 通道：

    1. ``tracker.events.{space_id}`` —— TabTracker UI 列表 / 详情实时刷新
       的主通道。envelope type 为 ``tracker.event.{action}``，前端
       ``useTrackerEventStream`` 消费。Module F 决策 3：按 Space 边界分发，
       不再用 organization topic（避免跨 Space 数据泄漏）。
    2. ``context.sync.{space_id}`` —— 跨 App resource sync 总线，让其他 App
       （如 TabMemo、Chat 引用卡片）感知 Tracker 资源变更。envelope type 为
       ``resource_{action}``。

    波次 4 Stage 2.2 一刀切：HTTP 端 ``_push_tracker_ws`` 已下线，本函数为
    service 层唯一 Tracker 生命周期 WS 推送入口。caller 在 create / update /
    delete / activate / pause / resume 六处生命周期方法调用。
    """
    try:
        from apps.services.common.ws.bus import publish_ws_event

        space_id = str(tracker.workspace_id) if tracker.workspace_id else ""
        organization_id = str(tracker.organization_id) if tracker.organization_id else ""

        # Module F 决策 3：tracker.events.* topic 必须按 space_id 分发；缺
        # space_id（charter §7.1 当前必须绑 Space，理论不应该走到）→ 回退到
        # organization topic 兜底不丢消息，但日志告警。
        if space_id:
            tracker_events_topic = f"tracker.events.{space_id}"
        elif organization_id:
            logger.warning(
                "[Tracker] lifecycle WS: tracker %s has no space_id, "
                "falling back to organization topic",
                tracker.id,
            )
            tracker_events_topic = f"tracker.events.{organization_id}"
        else:
            tracker_events_topic = ""

        if tracker_events_topic:
            publish_ws_event(
                topic=tracker_events_topic,
                envelope={
                    "type": f"tracker.event.{action}",
                    "tracker_id": str(tracker.id),
                    "name": tracker.name,
                    "space_id": space_id,
                    "user_id": str(user.id) if user else None,
                },
            )
        publish_ws_event(
            topic=f"context.sync.{space_id}" if space_id else "context.sync.global",
            envelope={
                "type": f"resource_{action}",
                "resource_type": "tabtracker",
                "resource_id": str(tracker.id),
                "title": tracker.name,
                "space_id": space_id,
                "user_id": str(user.id) if user else None,
            },
        )
    except Exception as exc:
        logger.warning("[Tracker] lifecycle WS push failed: %s", exc)


def finalize_one_shot_tracker(tracker_id) -> bool:
    """将 ``trigger_type=at`` 的一次性任务收口为「已结束」：disabled + 清空 leftover next_run_at。

    本机持钟后云不再把 next_run_at 当闹钟；这里清空只是去掉陈旧预览字段。
    """
    with transaction.atomic(using=postgres_app_db_alias()):
        tracker = Tracker.objects.select_for_update().get(id=tracker_id)
        if tracker.trigger_type != "at":
            return False

        update_fields: list[str] = []
        if tracker.status != "disabled" and tracker.status in ("draft", "active", "paused"):
            tracker.transition_status("disabled")
            update_fields.append("status")
        if tracker.next_run_at is not None:
            tracker.next_run_at = None
            update_fields.append("next_run_at")
        if not update_fields:
            return False
        tracker.save(update_fields=update_fields)
        return True


def _validate_activation_schedule(tracker: Tracker) -> None:
    """激活 / 恢复时只校验规则，不把下次几点写入云。过期的一次性任务拒绝恢复。"""
    if tracker.trigger_type == "manual":
        return
    from apps.tracker.utils import compute_next_run_at

    next_at = compute_next_run_at(
        tracker.trigger_type,
        tracker.trigger_config,
        fail_loud=True,
    )
    if tracker.trigger_type == "at" and (
        next_at is None or next_at <= timezone.now()
    ):
        raise ValidationError(
            "一次性任务的执行时间已过，请先修改执行时间后再恢复"
        )


def _clear_persisted_next_run(tracker: Tracker, update_fields: list[str] | None = None) -> None:
    """云不再记下次几点；激活/编辑时清掉历史 leftover。"""
    if tracker.next_run_at is None:
        return
    tracker.next_run_at = None
    if update_fields is not None and "next_run_at" not in update_fields:
        update_fields.append("next_run_at")


def _ensure_webhook_secret(trigger_type: str, trigger_config: dict | None) -> tuple[dict, bool]:
    """P1-17: webhook 类型的 Tracker 必须有 HMAC secret。

    Returns:
        (trigger_config, secret_was_generated) — 如果生成了新 secret，第二个值为 True。
    """
    if trigger_type != "webhook":
        return (trigger_config or {}), False
    cfg = dict(trigger_config or {})
    if cfg.get("secret"):
        return cfg, False
    cfg["secret"] = secrets.token_hex(32)
    return cfg, True


class TrackerService(BaseService):

    # ─── Read ─────────────────────────────────────────────────

    _CANCELLABLE_RUN_STATUSES = frozenset({"pending", "running", "waiting_device"})

    def resolve_tracker_capabilities(self, tracker: Tracker) -> dict[str, bool]:
        """返回当前用户对一条 Tracker 的动作授权。

        复用 ``BaseService.check_space_permission`` 作为唯一权限事实源，并且只做
        一次 editor 判定；同一请求内该判定还会命中 BaseService 的权限缓存。
        ``can_trigger`` 只表达授权，不叠加 Tracker 生命周期或并发状态。
        """
        can_edit = bool(
            tracker.workspace_id
            and self.check_space_permission(str(tracker.workspace_id), "editor")
        )
        return {
            "can_edit": can_edit,
            "can_trigger": can_edit,
            "can_cancel": can_edit,
        }

    def resolve_run_capabilities(self, tracker_run: TrackerRun) -> dict[str, bool]:
        """返回 Run 级动作能力；取消能力同时受 editor 权限和 Run 状态约束。"""
        capabilities = self.resolve_tracker_capabilities(tracker_run.tracker)
        capabilities["can_cancel"] = (
            capabilities["can_cancel"]
            and tracker_run.status in self._CANCELLABLE_RUN_STATUSES
        )
        return capabilities

    def list_trackers(self, organization_id: str, space_id: Optional[str] = None):
        """列出当前用户可见的 Tracker。

        Module F 决策 3：遵守 Space 边界——按 ``AccessibleSpaceResolver`` 取并集
        过滤，**不再**只校验 organization viewer 就返回全 organization Tracker。

        - 传 ``space_id``：仍按单 Space 校验（保留原行为）。
        - 不传 ``space_id``：用 ``AccessibleSpaceResolver`` 计算用户可访问的
          Space ID 集合（合并 SpaceMembership / Agent SpaceMembership），
          仅返回这些 Space 下的 Tracker；空集 → 返
          回空 queryset（而不是全 organization）。

        修复前 bug：HR Space 创建的"扫描简历评分" Tracker 会被销售总监（同
        organization editor）在自己 Tracker 列表里看到，违反 Space 默认私有原则。
        """
        if not self.check_organization_permission(organization_id, "viewer"):
            raise PermissionError(f"No viewer permission on organization {organization_id}")
        # TS-6（软删）：archived（已归档/已软删）的 Tracker 从所有列表入口隐藏。
        # 软删只改 status、保留 TrackerRun 审计历史；列表不应带出归档项。
        qs = Tracker.objects.filter(organization_id=organization_id).exclude(status="archived")
        if space_id:
            if not self.check_space_permission(space_id, "viewer"):
                raise PermissionError(f"No viewer permission on Space {space_id}")
            # ：Tracker.space FK 已 Drop；列表按 workspace 过滤（id-reuse）
            qs = qs.filter(workspace_id=space_id)
            return qs

        # 不传 space_id：按用户可访问 Space/Workspace 集合过滤
        from apps.tabtinspace.services.accessible_space_resolver import (
            get_accessible_space_ids,
        )
        accessible = get_accessible_space_ids(
            str(self.user.id) if self.user else None,
            organization_id,
        )
        if not accessible:
            return Tracker.objects.none()
        return qs.filter(workspace_id__in=accessible)

    def get_tracker(self, tracker_id: str):
        tracker = Tracker.objects.get(id=tracker_id)
        self._ensure_permission(tracker, "viewer")
        return tracker

    def get_tracker_for_update(self, tracker_id: str):
        tracker = Tracker.objects.select_for_update().get(id=tracker_id)
        self._ensure_permission(tracker, "editor")
        return tracker

    # ─── Create ───────────────────────────────────────────────

    def create_tracker(
        self,
        organization_id: str,
        space_id: Optional[str],
        data: TrackerCreate,
        user,
    ) -> Tracker:
        """charter v1.8 §6.2 / §6.4：唯一创建入口。

        校验：
        - space_id 为空时：本期暂不支持个人级 Tracker，应用层 require space_id。
          （charter §7.1 model 已允许 nullable，预留未来个人级路径）
        - skill_key 可为空：空值走纯 Agent 模式，非空时预绑定单一 Skill。
        - agent_id 为空：拒绝（charter v1.8 §7.1 终局形态：Tracker 必须指定执行 Agent）。

        Wave 2 续作 (plan v2.1 §1.1)：agent_id 在创建时升级为应用层必填校验。
        Tracker model 层保留 nullable=True 兼容存量数据（agent 删除时 SET_NULL，
        历史 Tracker 行可能 null），但新创建必须带 agent_id。
        """
        if not space_id:
            raise ValidationError("Tracker 当前必须绑定 Space（charter v1.8 §7.1 nullable 留作未来扩展）")
        if not self.check_space_permission(space_id, "editor"):
            raise PermissionError(f"No editor permission on Space {space_id}")

        try:
            ensure_space_in_organization(organization_id, space_id)
        except ValueError as e:
            raise PermissionError(str(e)) from e

        # 纯 Agent 模式（2026-06）：skill_key 不再强制。空值时 Tracker 走「无 Skill
        # 执行路径」——指令(skill_params.instructions)作为任务派给 Agent，Agent runtime
        # 会自动注入可用 Skill 清单并提供 skills_search/skills_read，由 Agent 自助挑选
        # 合适 Skill（详见 skill_executor.run_skill_based）。skill_key 非空时仍按原
        # 「绑定单一 Skill」语义解析。

        resolved_agent_id = (data.agent_id or "").strip()
        if not resolved_agent_id:
            raise ValidationError("创建 Tracker 必须指定执行 Agent")
        resolved_workspace_id = (data.workspace_id or "").strip()
        if not resolved_workspace_id:
            raise ValidationError("创建 Tracker 必须指定执行 Workspace")

        from apps.tabtinspace.models import Agent, Workspace

        if not Agent.objects.filter(
            id=resolved_agent_id,
            organization_id=organization_id,
            owner_user_id=user.id,
            is_active=True,
        ).exists():
            raise ValidationError("执行 Agent 不存在或不属于当前用户")
        if not Workspace.objects.filter(
            id=resolved_workspace_id,
            organization_id=organization_id,
            created_by_id=user.id,
        ).exists():
            raise ValidationError("执行 Workspace 不存在或不属于当前用户")

        # TS-14：trigger_type 白名单 + interval/at/table_event 必填字段校验，
        # 在入库前拦下脏配置（非法时 ValidationError → 400）。
        _validate_trigger_type_and_config(data.trigger_type, data.trigger_config)
        _require_tracker_instructions(
            data.skill_params,
            skill_key=(data.skill_key or ""),
        )
        normalized_name = data.name.strip()

        effective_trigger_config, secret_generated = _ensure_webhook_secret(
            data.trigger_type, data.trigger_config,
        )
        # ：cron 缺 timezone 时按产品 TIME_ZONE 补齐，避免默认 UTC 偏 8h。
        effective_trigger_config = ensure_cron_timezone(
            data.trigger_type, effective_trigger_config,
        )

        with transaction.atomic(using=postgres_app_db_alias()):
            # Wave 2 收尾 (charter v1.8 §7.1)：移除 token_budget / project_mode
            # 兜底写入——migration 0023 已 drop 字段，schema 中已无此入参。
            #  / ：Tracker.space FK 已 Drop；宿主只写 workspace_id。
            # 路由 query 的 space_id 仅用于权限/组织校验，禁止再传入 ORM。
            create_kwargs = dict(
                organization_id=organization_id,
                name=normalized_name,
                description=data.description,
                trigger_type=data.trigger_type,
                trigger_config=effective_trigger_config,
                skill_key=(data.skill_key or "").strip(),
                skill_params=data.skill_params,
                intent_snapshot=data.intent_snapshot,
                created_by=user,
                agent_id=resolved_agent_id,
                workspace_id=resolved_workspace_id,
            )

            tracker = Tracker.objects.create(**create_kwargs)

            # 新版 UI / CLI 创建时要求直接进入 active。状态切换与 next_run_at 计算
            # 必须和创建处在同一事务：任一步失败都整体回滚，不留下用户无法理解的草稿。
            # 未传 activate_on_create 的旧客户端仍维持 draft 契约，保证向前兼容。
            if data.activate_on_create:
                tracker.transition_status("active")
                _validate_activation_schedule(tracker)
                _clear_persisted_next_run(tracker)
                tracker.save()

        tracker._webhook_secret_generated = secret_generated
        _push_tracker_lifecycle_ws(tracker, "created", user=user)
        return tracker

    # ─── Update ───────────────────────────────────────────────

    def update_tracker(self, tracker_id: str, data: TrackerUpdate, user) -> Tracker:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = self.get_tracker_for_update(tracker_id)

            if data.name is not None:
                normalized_name = data.name.strip()
                tracker.name = normalized_name
            if data.description is not None:
                tracker.description = data.description
            if data.trigger_type is not None:
                tracker.trigger_type = data.trigger_type
            if data.trigger_config is not None:
                tracker.trigger_config = data.trigger_config
            effective_tt = tracker.trigger_type
            # TS-14：trigger_type / trigger_config 被更新时，同样走白名单 + 必填校验，
            # 避免编辑路径绕过创建期校验写入脏配置。
            if data.trigger_type is not None or data.trigger_config is not None:
                _validate_trigger_type_and_config(effective_tt, tracker.trigger_config)
            effective_cfg, _ = _ensure_webhook_secret(effective_tt, tracker.trigger_config)
            tracker.trigger_config = ensure_cron_timezone(effective_tt, effective_cfg)
            if data.skill_key is not None:
                tracker.skill_key = data.skill_key
            if data.skill_params is not None:
                tracker.skill_params = data.skill_params
            if data.intent_snapshot is not None:
                tracker.intent_snapshot = data.intent_snapshot
            if data.agent_id is not None:
                from apps.tabtinspace.models import Agent

                if not Agent.objects.filter(
                    id=data.agent_id,
                    organization_id=tracker.organization_id,
                    owner_user_id=user.id,
                    is_active=True,
                ).exists():
                    raise ValidationError("执行 Agent 不存在或不属于当前用户")
                tracker.agent_id = data.agent_id
            if data.workspace_id is not None:
                from apps.tabtinspace.models import Workspace

                if not Workspace.objects.filter(
                    id=data.workspace_id,
                    organization_id=tracker.organization_id,
                    created_by_id=user.id,
                ).exists():
                    raise ValidationError("执行 Workspace 不存在或不属于当前用户")
                tracker.workspace_id = data.workspace_id
            # Wave 2 收尾 (charter v1.8 §7.1)：移除 token_budget / project_mode
            # 更新分支——migration 0023 已 drop 字段。

            tracker.save()

            if tracker.status == "active":
                _validate_activation_schedule(tracker)
                leftover_fields: list[str] = []
                _clear_persisted_next_run(tracker, leftover_fields)
                if leftover_fields:
                    tracker.save(update_fields=leftover_fields)

        _push_tracker_lifecycle_ws(tracker, "updated", user=user)
        return tracker

    # ─── Delete ───────────────────────────────────────────────

    def delete_tracker(self, tracker_id: str, user=None):
        """TS-6 + TS-15：软删（归档）Tracker，保留审计历史。

        历史行为是物理硬删（``tracker.delete()`` + ``TrackerRun.tracker`` 外键
        CASCADE），会连带删除所有 TrackerRun 运行历史——这与 models.py TrackerRun
        「运行历史是审计资产，独立保留不连带删」的注释自相矛盾（TS-15）。

        改为软删：
        - 设 ``status='archived'`` + ``archived_at=now``（停止触发、从列表隐藏）。
        - **不**物理删除 Tracker，所有 TrackerRun 与其 ``chat_session_id`` 全部保留。
        - 仍取消活跃 Run（pending/running → cancelled）、释放 runtime claim。
        - WS 生命周期事件仍发 ``deleted``（前端无感：归档 Tracker 从列表移除，与
          原删除的 UI 表现一致；事件 payload 不变）。

        归档是终态：本期不提供 UI 恢复入口。如需永久物理删除（连带 TrackerRun），
        见管理员级 ``purge_tracker``（不接 UI）。

        幂等：对已 archived 的 Tracker 再次调用是空操作（不重复推 WS / 改时间戳）。
        """
        tracker = Tracker.objects.get(id=tracker_id)
        self._ensure_permission(tracker, "editor")

        # 幂等：已归档则直接返回，避免重复 WS 推送 / 覆盖 archived_at。
        if tracker.status == "archived":
            return

        now = timezone.now()
        active_runs = list(TrackerRun.objects.filter(
            tracker=tracker,
            status__in=("pending", "running", "waiting_device"),
        ))
        for run in active_runs:
            TrackerRun.objects.filter(
                id=run.id,
                status__in=("pending", "running", "waiting_device"),
            ).update(
                status="cancelled",
                finished_at=now,
                error_summary="Tracker 被归档（删除），执行自动取消",
            )
            try:
                from apps.tracker.services.tracker_executor import _release_tracker_run_runtime_claim
                _release_tracker_run_runtime_claim(run, reason="delete_tracker")
            except Exception:
                logger.debug("[TrackerService] release runtime claim failed during delete_tracker", exc_info=True)

        # 软删：归档而非物理删除。清空 leftover next_run_at，避免预览还当它活着。
        tracker.status = "archived"
        tracker.archived_at = now
        tracker.next_run_at = None
        tracker.save(update_fields=["status", "archived_at", "next_run_at", "updated_at"])

        _push_tracker_lifecycle_ws(tracker, "deleted", user=user)

    def purge_tracker(self, tracker_id: str, user=None):
        """管理员级永久物理删除（连带 CASCADE 删除所有 TrackerRun 审计历史）。

        **不接 UI**：仅供运维 / 管理员在 ``manage.py shell`` 或后台脚本中显式调用，
        用于彻底清理数据（如合规删除请求 / 测试数据回收）。普通删除走软删
        ``delete_tracker``（保留审计历史）。

        注意：这会触发 TrackerRun 外键 CASCADE，物理删除该 Tracker 的全部运行
        历史，不可恢复。调用方须自行确认这是预期行为。
        """
        tracker = Tracker.objects.get(id=tracker_id)
        self._ensure_permission(tracker, "editor")

        now = timezone.now()
        active_runs = list(TrackerRun.objects.filter(
            tracker=tracker,
            status__in=("pending", "running", "waiting_device"),
        ))
        for run in active_runs:
            try:
                from apps.tracker.services.tracker_executor import _release_tracker_run_runtime_claim
                _release_tracker_run_runtime_claim(run, reason="purge_tracker")
            except Exception:
                logger.debug("[TrackerService] release runtime claim failed during purge_tracker", exc_info=True)

        _push_tracker_lifecycle_ws(tracker, "deleted", user=user)
        tracker.delete()

    # ─── Status operations ────────────────────────────────────

    def activate_tracker(self, tracker_id: str, user=None) -> Tracker:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = self.get_tracker_for_update(tracker_id)
            # 纯 Agent 模式（2026-06）：激活不再要求 skill_key。无 Skill 的 Tracker
            # 走「指令驱动 + Agent 自助找 Skill」执行路径（见 skill_executor）。
            # ：激活前仍要求有执行指令，避免「运行中」却只会秒败。
            _require_tracker_instructions(
                tracker.skill_params,
                skill_key=tracker.skill_key or "",
            )
            tracker.transition_status("active")
            _validate_activation_schedule(tracker)
            _clear_persisted_next_run(tracker)
            tracker.save()
        _push_tracker_lifecycle_ws(tracker, "updated", user=user)
        return tracker

    def pause_tracker(self, tracker_id: str, user=None) -> Tracker:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = self.get_tracker_for_update(tracker_id)
            tracker.transition_status("paused")
            tracker.save(update_fields=["status"])
        _push_tracker_lifecycle_ws(tracker, "updated", user=user)
        return tracker

    def resume_tracker(self, tracker_id: str, user=None) -> Tracker:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = self.get_tracker_for_update(tracker_id)
            _require_tracker_instructions(
                tracker.skill_params,
                skill_key=tracker.skill_key or "",
            )
            tracker.transition_status("active")
            _validate_activation_schedule(tracker)
            _clear_persisted_next_run(tracker)
            tracker.save()

        # **Wave 7 续作 P1-1 修复**：resume Tracker 时必须清掉所有 storm guard cache key，
        # 否则用户被熔断 → resume → 60s 内 circuit 计数器仍残留 → 立刻又熔断的恶性循环。
        # 清除范围：debounce / rate / circuit / first_trigger 全部 4 个 key
        # （cache key 命名约定见 ``tracker_trigger_service._storm_guard_keys``，集中定义）。
        # first_trigger 也清掉是有意为之——用户重启 Tracker 后再次"首次触发"提示是合理的，
        # 让用户知道 resume 后第一次确实又跑起来了。
        #
        # **Wave 8 治理**：cache.delete 失败时除 logger.warning 外,还要走 telemetry
        # 上报到运维监控（reflexion 20: 链路透传必有端到端验证）—— 修复前 Wave 7 mini
        # 二次验证抓出:cache.delete 失败仅 logger.warning,无监控告警。极端场景:
        # Tracker status=active 但 storm guard cache 残留 → 下次事件触发立即 circuit_trip
        # 重新 paused（用户感知:resume 后立刻又被熔断,无法定位根因）。
        #
        # 设计选择:
        #   - 不抛异常 / 不阻塞 resume：cache.delete 失败有 60s TTL 自然恢复,
        #     resume 主路径不应因可观测性失败被打断（charter §6.3 平台稳定性优先）
        #   - 不加 retry：失败有 TTL 兜底 + 加 retry 增加复杂度;现有 60s TTL 自愈足够
        #   - 每个 key 独立 try/except：单 key 失败不影响其它 key 清理
        #   - 复用 ``scheduler.cache_failure`` logger（与 ``scheduler.deprecation``
        #     同模式）—— Sentry / ELK / OTel 已配置 WARNING+ 级别采集
        # cache 已在模块顶部 import,便于 patch 路径稳定（Wave 8 测试需求）
        from apps.tracker.services.tracker_trigger_service import _storm_guard_keys

        cache_keys = _storm_guard_keys(str(tracker.id))
        for key_type, cache_key in cache_keys.items():
            try:
                cache.delete(cache_key)
            except Exception as exc:
                # 双管齐下:
                #   1) 标准 logger.warning（既有日志查询能继续工作）
                #   2) 命名 logger ``scheduler.cache_failure`` 上报 metric
                #      ``tracker.storm_guard.cache_delete_failure`` —— 让 Sentry /
                #      ELK / OTel 采集器能 group + alert
                logger.warning(
                    "[TrackerService.resume_tracker] storm guard cache 清理失败 "
                    "tracker=%s key_type=%s cache_key=%s",
                    tracker_id, key_type, cache_key, exc_info=True,
                )
                _record_storm_guard_cache_delete_failure(
                    organization_id=str(tracker.organization_id) if tracker.organization_id else "",
                    tracker_id=str(tracker.id),
                    cache_key_type=key_type,
                    error=exc,
                )

        _push_tracker_lifecycle_ws(tracker, "updated", user=user)
        return tracker

    # ─── Cancel Run ───────────────────────────────────────────

    def cancel_run(self, run_id: str, user=None) -> TrackerRun:
        """统一取消 TrackerRun：标记取消、发送通知、更新统计。"""
        tracker_run = TrackerRun.objects.select_related("tracker").get(id=run_id)
        self._ensure_permission(tracker_run.tracker, "editor")

        # waiting_device（离线韧性 M1）可取消：用户可手动放弃等待设备上线。
        if tracker_run.status not in self._CANCELLABLE_RUN_STATUSES:
            raise ValidationError(f"只能取消等待中或运行中的执行 (当前状态: {tracker_run.status})")

        from apps.tracker.services.tracker_notification import TrackerNotificationService
        notifier = TrackerNotificationService(tracker_run)

        with transaction.atomic(using=postgres_app_db_alias()):
            tracker_run.status = "cancelled"
            tracker_run.finished_at = timezone.now()
            tracker_run.duration = (
                tracker_run.finished_at - (tracker_run.started_at or tracker_run.finished_at)
            ).total_seconds()
            tracker_run.save(update_fields=["status", "finished_at", "duration"])

            from apps.tracker.services.tracker_executor import _update_tracker_stats
            _update_tracker_stats(tracker_run.tracker_id, success=False)

        # 请求关联 ChatSession 取消（charter v1.8 §6.7：Run = Agent 的 react 循环）
        try:
            self._request_run_cancellation(tracker_run)
        except Exception:
            logger.warning(
                "[TrackerService] cancel request failed for run %s",
                tracker_run.id, exc_info=True,
            )

        try:
            from apps.tracker.services.tracker_executor import _release_tracker_run_runtime_claim
            _release_tracker_run_runtime_claim(tracker_run, reason="cancel_run")
        except Exception:
            logger.debug("[TrackerService] release runtime claim failed for run %s", tracker_run.id, exc_info=True)

        notifier.notify_progress(tracker_run)
        # Module F 修复（2026-05-26）：用户主动取消走独立 event，避免与
        # RUN_FAILED 共用通道导致 wire 语义错乱（event="失败" + payload.status="cancelled"）。
        notifier.notify_run_cancelled(tracker_run)

        return tracker_run

    @staticmethod
    def _request_run_cancellation(tracker_run) -> None:
        """请求取消 Run 关联的 Agent 执行（charter v1.8 §6.7）。

        Tracker 取消必须通知设备端 abort 当前 prompt（``agent.prompt.cancel``）。
        设备 forward 路径不消费 ``RunService`` cancel marker，只写 ExecutionRun
        无法真正停掉本地 runtime。
        """
        try:
            from apps.tracker.services.tracker_executor import (
                _runtime_task_id,
                _tracker_run_task_id,
            )

            celery_task_id = _tracker_run_task_id(tracker_run)
            if celery_task_id:
                try:
                    from celery import current_app

                    current_app.control.revoke(celery_task_id, terminate=True)
                except Exception:
                    logger.debug(
                        "[TrackerService] celery revoke failed for run %s",
                        tracker_run.id,
                        exc_info=True,
                    )

            session_id = getattr(tracker_run, "chat_session_id", None)
            if not session_id:
                return

            from apps.chat.conversation.models import ChatSession

            session = ChatSession.objects.filter(id=session_id).select_related("workspace").first()
            if not session:
                return

            published: int | None = None
            runtime_task_id = _runtime_task_id(tracker_run)
            if runtime_task_id and session.workspace_id:
                from apps.services.agent_engine.services.prompt_forward_service import (
                    PromptForwardService,
                )

                agent_id = None
                tracker = getattr(tracker_run, "tracker", None)
                if tracker and getattr(tracker, "agent_id", None):
                    agent_id = str(tracker.agent_id)

                published = PromptForwardService().forward_cancel(
                    thread_id=session.effective_thread_id,
                    task_id=runtime_task_id,
                    space=session.workspace,
                    agent_id=agent_id,
                )
                logger.info(
                    "[TrackerService] forward_cancel tracker_run=%s task=%s published=%s",
                    tracker_run.id,
                    runtime_task_id,
                    published,
                )

            if session.effective_thread_id:
                from apps.services.agent_engine.services.run_service import RunService
                from apps.services.agent_engine.services.session_run_state_service import (
                    ACTIVE_STATUSES,
                    SessionRunStateService,
                )

                latest_run = RunService.get_latest_run(session.effective_thread_id)
                if latest_run and latest_run.status in ACTIVE_STATUSES:
                    run_id = str(latest_run.run_id)
                    RunService.request_cancel(
                        run_id,
                        reason="tracker_run_cancelled",
                    )
                    SessionRunStateService.transition(
                        run_id=run_id,
                        status="cancelling",
                        stop_reason="tracker_run_cancelled",
                    )
                    if published == 0:
                        projection = SessionRunStateService.transition(
                            run_id=run_id,
                            status="interrupted",
                            stop_reason="aborted",
                            error_class="ABORT",
                            allowed_from=ACTIVE_STATUSES,
                        )
                        if projection is not None:
                            RunService.clear_cancelled(run_id)
        except Exception:
            logger.warning("[TrackerService] _request_run_cancellation failed", exc_info=True)

    # ─── Trigger ──────────────────────────────────────────────

    def trigger_tracker(
        self,
        tracker_id: str,
        user,
        trigger_type: str = "manual",
        trigger_context: Optional[dict] = None,
    ) -> TrackerRun:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = Tracker.objects.select_for_update().get(id=tracker_id)
            self._ensure_permission(tracker, "editor")

            active_runs = TrackerRun.objects.filter(
                tracker=tracker,
                status__in=("pending", "running", "waiting_device"),
            ).count()
            # Wave 2 收尾 (charter v1.8 §7.1 §3.4)：max_concurrent_runs 字段已
            # 在 migration 0023 drop（charter 拒绝清单 — 与 Redis 信号量重叠）。
            # 单 Tracker 单 active run 是 charter §6.4 单 Skill 执行模型的自然约束;
            # 跨 Tracker 全局并发由 _RedisDistributedSemaphore (tracker_executor.py
            # MAX_CONCURRENT_TRACKER_STEPS=8) 统一控制。
            # waiting_device（离线韧性 M1）计入 active：挂起等设备期间不允许再触发。
            if active_runs >= 1:
                raise ValidationError("已达到最大并发运行数（单 Tracker 同时仅允许 1 个执行中 Run）")

            tracker_run = self._create_tracker_run(tracker, trigger_type, trigger_context)

        return tracker_run

    # ─── Internal helpers ─────────────────────────────────────

    def _create_tracker_run(
        self,
        tracker: Tracker,
        trigger_type: str,
        trigger_context: Optional[dict] = None,
    ) -> TrackerRun:
        """charter v1.8 §6.7 / §7.2：Run = Agent 在 agentruntime 跑一次 react 循环。

        ``session_mode = per_run``：每个 TrackerRun 对应一条 ChatSession（在
        skill_executor 首次 attempt 时创建并回填 chat_session_id；同 Run 重试 /
        重派复用，见 ）。
        """
        return TrackerRun.objects.create(
            tracker=tracker,
            trigger_type=trigger_type,
            trigger_context=trigger_context or {},
            status="pending",
            started_at=timezone.now(),
        )

    def compute_next_run(self, tracker: Tracker, *, fail_loud: bool = False):
        from apps.tracker.utils import compute_next_run_at
        return compute_next_run_at(
            tracker.trigger_type,
            tracker.trigger_config,
            fail_loud=fail_loud,
        )

    def _ensure_permission(self, tracker: Tracker, role: str):
        if not tracker.workspace_id:
            # 个人级 Tracker：本期未启用此路径（charter §7.1 留作未来）。
            raise PermissionError("Tracker 未绑定 Space，本期不支持个人级权限校验")
        if not self.check_space_permission(str(tracker.workspace_id), role):
            raise PermissionError(f"No {role} permission on Space {tracker.workspace_id}")

    def list_host_schedule(self, device) -> list[Tracker]:
        """本机 Workspace 上、应由 agent-host 持钟的 active 定时 Tracker。"""
        from django.db.models import Exists, OuterRef

        from apps.tracker.constants import HOST_OWNED_TRIGGER_TYPES
        from apps.tracker.models import TrackerRun

        active_run = TrackerRun.objects.filter(
            tracker_id=OuterRef("pk"),
            status__in=("pending", "running", "waiting_device"),
        )
        qs = (
            Tracker.objects.filter(
                status="active",
                trigger_type__in=HOST_OWNED_TRIGGER_TYPES,
                workspace__device_id=device.id,
            )
            .annotate(_has_active_run=Exists(active_run))
            .filter(_has_active_run=False)
            .select_related("workspace")
            .order_by("last_run_at", "id")
        )
        return [
            tracker
            for tracker in qs
            if self.resolve_tracker_capabilities(tracker)["can_trigger"]
        ]

    def list_host_work(self, device) -> list:
        """本机应接手的未开跑 Run：只记账，由 agent-host 排队执行。"""
        from django.utils import timezone as tz

        from apps.tracker.models import TrackerRun
        from apps.tracker.services.tracker_executor import (
            TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY,
        )

        now_ts = tz.now().timestamp()
        runs = (
            TrackerRun.objects.filter(
                status__in=("pending", "waiting_device"),
                tracker__workspace__device_id=device.id,
            )
            .select_related("tracker", "tracker__workspace")
            .order_by("created_at", "id")[:100]
        )
        ready = []
        for run in runs:
            if not self.resolve_tracker_capabilities(run.tracker)["can_trigger"]:
                continue
            grace_until = (run.context or {}).get(TRANSIENT_RETRY_GRACE_UNTIL_CONTEXT_KEY)
            try:
                if grace_until is not None and float(grace_until) > now_ts:
                    continue
            except (TypeError, ValueError):
                pass
            ready.append(run)
        return ready

    def prepare_host_run(self, run_id: str, device) -> dict:
        from apps.tracker.models import TrackerRun
        from apps.tracker.services.skill_executor import prepare_tracker_run_for_host

        run = TrackerRun.objects.select_related(
            "tracker", "tracker__workspace", "tracker__created_by", "tracker__agent",
        ).get(id=run_id)
        workspace = run.tracker.workspace
        if workspace is None or workspace.device_id != device.id:
            raise PermissionError("Tracker 未绑定到当前设备")
        self._ensure_permission(run.tracker, "editor")
        return prepare_tracker_run_for_host(run, device)

    def finalize_host_run(self, run_id: str, device, *, error: str = "") -> dict:
        from apps.tracker.models import TrackerRun
        from apps.tracker.services.tracker_executor import finalize_host_tracker_run

        run = TrackerRun.objects.select_related("tracker", "tracker__workspace").get(id=run_id)
        workspace = run.tracker.workspace
        if workspace is None or workspace.device_id != device.id:
            raise PermissionError("Tracker 未绑定到当前设备")
        self._ensure_permission(run.tracker, "editor")
        return finalize_host_tracker_run(run, error=error)

    def fire_host_scheduled_tracker(self, tracker_id: str, device) -> dict:
        """本机到点后只记账：校验绑定并创建 Run，不计算下次、不判断跳过。"""
        from apps.tracker.constants import HOST_OWNED_TRIGGER_TYPES

        tracker = Tracker.objects.select_related("workspace", "created_by").get(id=tracker_id)
        if tracker.status != "active":
            raise ValidationError("Tracker 未激活")
        if tracker.trigger_type not in HOST_OWNED_TRIGGER_TYPES:
            raise ValidationError("该触发类型不由本机计时")
        workspace = tracker.workspace
        if workspace is None or workspace.device_id != device.id:
            raise PermissionError("Tracker 未绑定到当前设备")
        self._ensure_permission(tracker, "editor")

        run = self.trigger_tracker(
            str(tracker.id),
            self.user or tracker.created_by,
            trigger_type="scheduled",
        )
        if tracker.trigger_type == "at":
            finalize_one_shot_tracker(tracker.id)
        return {"fired": True, "run_id": str(run.id)}

    def reconcile_host_lifecycle(self, device) -> dict:
        """本机上线后收拾本机定时 Tracker 的未完结 Run：续跑等待中的，回收卡死的。"""
        from apps.tracker.constants import HOST_OWNED_TRIGGER_TYPES
        from apps.tracker.models import TrackerRun
        from apps.tracker.services.tracker_executor import (
            recover_stuck_runs,
            redispatch_waiting_run,
        )

        waiting_runs = list(
            TrackerRun.objects.filter(
                status="waiting_device",
                tracker__trigger_type__in=HOST_OWNED_TRIGGER_TYPES,
                tracker__workspace__device_id=device.id,
            ).select_related("tracker")[:100]
        )
        resumed = 0
        for run in waiting_runs:
            if not self.resolve_tracker_capabilities(run.tracker)["can_trigger"]:
                continue
            if redispatch_waiting_run(run):
                resumed += 1

        recovered = recover_stuck_runs(
            workspace_device_id=device.id,
            host_owned_only=False,
        )
        return {"resumed": resumed, "recovered": recovered}
