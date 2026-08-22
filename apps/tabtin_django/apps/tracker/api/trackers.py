"""TabTracker 主 API：CRUD + 生命周期 + Run 查询。

挂在 ``/api/tracker/`` 前缀下（波次 4 Stage 2.1 一刀切；历史命名遗留路径
的兼容期 alias 全部删除）。

charter v1.8 §6.4 / §7.1：单 Skill 执行模型——无 ``steps`` 字段、无
attendees / agenda_meta / reminders（已在波次 1 砍掉）。
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.http import HttpRequest
from django.core.exceptions import ValidationError
from django.db import transaction
from ninja import Router, Query
from pydantic import BaseModel, Field

from apps.i18n import _
from apps.users.auth.permissions import JWTAuth
from apps.tabdata.api_helpers import (
    success_response,
    not_found_response,
    validation_error_response,
    permission_denied_response,
)
from apps.tracker.tracker_schemas import (
    TrackerCreate,
    TrackerUpdate,
    TrackerOut,
    TrackerListOut,
    TrackerRunListOut,
    SchedulePreviewOut,
)
from apps.tracker.models import Tracker
from apps.tabtinspace.services.base import ensure_space_in_organization
from apps.services.common.db_router import postgres_app_db_alias

_logger = logging.getLogger(__name__)

router = Router(tags=["TabTracker"])
auth = JWTAuth()


class HostRunFinalizeIn(BaseModel):
    error: str = ""


# ── Helpers ───────────────────────────────────────────────────

def _tracker_service(user):
    from apps.tracker.services.tracker_service import TrackerService
    return TrackerService(user=user)


def _ensure_permission(user, tracker, role: str = "viewer", *, service=None):
    svc = service or _tracker_service(user)
    if not svc.check_space_permission(str(tracker.workspace_id), role):
        raise PermissionError(f"No {role} permission on Space {tracker.workspace_id}")


def _tracker_space_name(tracker) -> str | None:
    """从已 select_related 的 workspace FK 取显示名；缺省 / 非字符串时返回 None。"""
    workspace = getattr(tracker, "workspace", None)
    if workspace is None:
        return None
    name = getattr(workspace, "name", None)
    return name if isinstance(name, str) and name else None


def _tracker_schedule_config(tracker) -> dict:
    """返回列表展示需要的安全调度字段，不泄露完整 ``trigger_config``。"""
    trigger_type = getattr(tracker, "trigger_type", "")
    config = getattr(tracker, "trigger_config", None)
    if not isinstance(config, dict):
        return {}

    if trigger_type == "cron":
        expression = config.get("cron_expression") or config.get("expression")
        result = {}
        if isinstance(expression, str) and expression.strip():
            result["cron_expression"] = expression.strip()
        timezone = config.get("timezone")
        if isinstance(timezone, str) and timezone.strip():
            result["timezone"] = timezone.strip()
        return result

    if trigger_type == "interval":
        seconds = config.get("interval_seconds", config.get("seconds"))
        try:
            normalized_seconds = int(seconds)
        except (TypeError, ValueError):
            return {}
        return {"interval_seconds": normalized_seconds} if normalized_seconds > 0 else {}

    if trigger_type == "at":
        at = config.get("at")
        return {"at": at.strip()} if isinstance(at, str) and at.strip() else {}

    return {}


def _serialize_tracker_list(tracker, *, capabilities: dict | None = None) -> dict:
    # 历史遗留：execution_type 字段曾区分 'skill_field'（TabData AI 字段定时执行）
    # 和默认的 Skill-based Agent 对话；前者已随 AI 字段下架移除（2026-05-01）。
    # 仍从 skill_params 读取此字段是为了兼容历史 Tracker 数据；新建 Tracker 不再写入。
    skill_params = getattr(tracker, "skill_params", None) or {}
    if not isinstance(skill_params, dict):
        skill_params = {}
    instructions = skill_params.get("instructions", "")
    if not isinstance(instructions, str):
        instructions = ""
    return TrackerListOut(
        id=tracker.id,
        name=tracker.name,
        description=tracker.description,
        status=tracker.status,
        space_id=getattr(tracker, "workspace_id", None),
        space_name=_tracker_space_name(tracker),
        agent_id=getattr(tracker, "agent_id", None),
        trigger_type=tracker.trigger_type,
        schedule_config=_tracker_schedule_config(tracker),
        skill_key=getattr(tracker, "skill_key", ""),
        execution_type=skill_params.get("execution_type", ""),
        instructions=instructions,
        total_runs=tracker.total_runs,
        success_runs=tracker.success_runs,
        fail_runs=tracker.fail_runs,
        last_run_at=tracker.last_run_at,
        next_run_at=tracker.next_run_at,
        capabilities=capabilities or {},
        created_at=tracker.created_at,
        updated_at=tracker.updated_at,
    ).model_dump(mode="json")


def _serialize_tracker(tracker, *, capabilities: dict | None = None) -> dict:
    skill_params = getattr(tracker, "skill_params", None) or {}
    execution_type = skill_params.get("execution_type", "") if isinstance(skill_params, dict) else ""
    return TrackerOut(
        id=tracker.id,
        name=tracker.name,
        description=tracker.description,
        status=tracker.status,
        space_id=getattr(tracker, "workspace_id", None),
        space_name=_tracker_space_name(tracker),
        agent_id=getattr(tracker, "agent_id", None),
        trigger_type=tracker.trigger_type,
        trigger_config=tracker.trigger_config,
        skill_key=getattr(tracker, "skill_key", ""),
        skill_params=skill_params or None,
        execution_type=execution_type,
        total_runs=tracker.total_runs,
        success_runs=tracker.success_runs,
        fail_runs=tracker.fail_runs,
        last_run_at=tracker.last_run_at,
        next_run_at=tracker.next_run_at,
        # 创建意图快照（charter §6.6）——前端详情页"创建意图回顾"区块用。
        intent_snapshot=getattr(tracker, "intent_snapshot", None),
        capabilities=capabilities or {},
        created_at=tracker.created_at,
        updated_at=tracker.updated_at,
    ).model_dump(mode="json")


# Tracker 生命周期 WS 推送由 service 层 ``_push_tracker_lifecycle_ws`` 统一负责
# （波次 4 Stage 2 一刀切）。HTTP 端不再需要二次推送 helper —— 避免 context.sync /
# tracker.events 双 topic 重复推送、且让 activate/pause/resume 等 service-only
# 路径与 CRUD 行为一致。详见 ``services/tracker_service.py``。


# ── Schedule preview（未来执行点，虚拟 occurrence）─────────────

def _caller_device(request: HttpRequest):
    from apps.tabtinspace.models import Device

    fingerprint = (request.META.get("HTTP_X_DEVICE_FINGERPRINT") or "").strip()
    if not fingerprint:
        raise ValidationError("缺少设备指纹")
    device = Device.objects.filter(fingerprint=fingerprint, user=request.auth).first()
    if device is None:
        raise PermissionError("当前账号在此设备上未注册")
    return device


@router.get("/host-schedule", response={200: dict, 400: dict, 403: dict}, auth=auth)
def list_host_schedule(request: HttpRequest):
    """本机 agent-host 持钟清单：只返回绑定当前设备的 active 定时 Tracker。"""
    try:
        device = _caller_device(request)
    except ValidationError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    svc = _tracker_service(request.auth)
    items = [
        {
            "id": str(tracker.id),
            "trigger_type": tracker.trigger_type,
            "trigger_config": tracker.trigger_config or {},
            "last_run_at": tracker.last_run_at.isoformat() if tracker.last_run_at else None,
            "created_at": tracker.created_at.isoformat() if tracker.created_at else None,
        }
        for tracker in svc.list_host_schedule(device)
    ]
    work = [
        {"run_id": str(run.id), "tracker_id": str(run.tracker_id)}
        for run in svc.list_host_work(device)
    ]
    return success_response({"items": items, "work": work})


@router.post(
    "/host-schedule/{tracker_id}/fire",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def fire_host_schedule(request: HttpRequest, tracker_id: UUID):
    try:
        device = _caller_device(request)
    except ValidationError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    svc = _tracker_service(request.auth)
    try:
        result = svc.fire_host_scheduled_tracker(str(tracker_id), device)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(result)


@router.post("/host-schedule/reconcile", response={200: dict, 400: dict, 403: dict}, auth=auth)
def reconcile_host_schedule(request: HttpRequest):
    """本机 agent-host 启动/重连后对账：续跑 waiting_device，回收本机卡死 Run。"""
    try:
        device = _caller_device(request)
    except ValidationError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    svc = _tracker_service(request.auth)
    return success_response(svc.reconcile_host_lifecycle(device))


@router.post(
    "/host-schedule/runs/{run_id}/prepare",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def prepare_host_run(request: HttpRequest, run_id: UUID):
    """本机认领待办 Run，返回在 agent-host 开跑所需字段。"""
    from apps.tracker.models import TrackerRun

    try:
        device = _caller_device(request)
    except ValidationError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    svc = _tracker_service(request.auth)
    try:
        result = svc.prepare_host_run(str(run_id), device)
    except TrackerRun.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(result)


@router.post(
    "/host-schedule/runs/{run_id}/finalize",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def finalize_host_run(request: HttpRequest, run_id: UUID, payload: HostRunFinalizeIn = None):
    """本机 Agent 跑完后写回 Run 终态。"""
    from apps.tracker.models import TrackerRun

    try:
        device = _caller_device(request)
    except ValidationError as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    svc = _tracker_service(request.auth)
    try:
        result = svc.finalize_host_run(
            str(run_id),
            device,
            error=(payload.error if payload else ""),
        )
    except TrackerRun.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(result)


@router.get("/schedule-preview", response={200: dict, 400: dict}, auth=auth)
def schedule_preview(
    request: HttpRequest,
    organization_id: str = Query(...),
    space_id: str = Query(None),
    from_: str = Query(..., alias="from"),
    to: str = Query(...),
):
    """预览组织/Space 下 active 自动化在 [from,to) 的未来执行点。

    复用 ``TrackerService.list_trackers`` / AccessibleSpace 权限；
    只展开 cron / interval / at；不落库、不创建 TrackerRun、不泄漏 trigger_config。
    """
    from django.utils.dateparse import parse_datetime
    from django.utils import timezone as dj_tz
    from apps.tracker.utils import build_schedule_preview, validate_schedule_preview_window

    try:
        from_dt = parse_datetime(from_) if from_ else None
        to_dt = parse_datetime(to) if to else None
    except (TypeError, ValueError):
        return validation_error_response("from/to 必须是合法 ISO datetime")
    if from_dt is None or to_dt is None:
        return validation_error_response("from/to 必须是合法 ISO datetime")
    if dj_tz.is_naive(from_dt) or dj_tz.is_naive(to_dt):
        return validation_error_response("from/to 必须是 timezone-aware ISO datetime")

    try:
        validate_schedule_preview_window(from_dt, to_dt)
    except ValueError as exc:
        return validation_error_response(str(exc))

    svc = _tracker_service(request.auth)
    try:
        qs = svc.list_trackers(organization_id, space_id)
    except PermissionError:
        if space_id:
            return permission_denied_response(_("scheduler.tracker_no_space_viewer"))
        return permission_denied_response(_("scheduler.tracker_no_organization_viewer"))

    # select_related 避免 space_name N+1；DB 侧先收窄 active + 时间触发
    qs = (
        qs.select_related("workspace")
        .filter(status="active", trigger_type__in=["cron", "interval", "at"])
        .order_by("next_run_at", "id")
    )
    preview = build_schedule_preview(
        qs,
        from_dt=from_dt,
        to_dt=to_dt,
    )
    data = SchedulePreviewOut.model_validate(preview).model_dump(mode="json")
    return success_response(data)


# ── Trackers CRUD ─────────────────────────────────────────────
# URL path 保留 ``/events`` —— 避免对前端 URL 二次改动；path param 改 ``tracker_id``。

@router.get("/events", response={200: dict}, auth=auth)
def list_trackers(
    request: HttpRequest,
    organization_id: str = Query(...),
    space_id: str = Query(None),
    event_type: str = Query(None),  # 兼容入参（前端 trackerApi 仍传 agent_task），已无意义
    page: int = Query(1),
    page_size: int = Query(200),
):
    """Module F 决策 3：复用 TrackerService.list_trackers 单一权限入口，
    避免 API 层和 service 层重复实现 Space 边界过滤逻辑。"""
    svc = _tracker_service(request.auth)
    try:
        qs = svc.list_trackers(organization_id, space_id)
    except PermissionError:
        if space_id:
            return permission_denied_response(_("scheduler.tracker_no_space_viewer"))
        return permission_denied_response(_("scheduler.tracker_no_organization_viewer"))

    # select_related("workspace")：序列化 space_name 时避免 N+1。
    qs = qs.select_related("workspace").order_by("-created_at")

    total_count = qs.count()
    clamped_page_size = max(1, min(page_size, 500))
    offset = max(0, (page - 1)) * clamped_page_size
    paginated_qs = qs[offset:offset + clamped_page_size]

    events = [
        _serialize_tracker_list(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
        for tracker in paginated_qs
    ]

    return success_response({
        "events": events,
        "total": total_count,
        "page": page,
        "page_size": clamped_page_size,
        "has_more": offset + clamped_page_size < total_count,
    })


@router.post("/events", response={200: dict, 400: dict}, auth=auth)
def create_tracker(
    request: HttpRequest,
    payload: TrackerCreate,
    organization_id: str = Query(...),
    space_id: str = Query(...),
):
    svc = _tracker_service(request.auth)
    if not svc.check_space_permission(space_id, "editor"):
        return permission_denied_response(_("scheduler.tracker_no_space_editor"))

    try:
        ensure_space_in_organization(organization_id, space_id)
    except ValueError as e:
        return not_found_response(str(e))

    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            tracker = svc.create_tracker(organization_id, space_id, payload, request.auth)
    except (ValidationError, ValueError) as exc:
        return validation_error_response(str(exc))
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


@router.get("/events/{tracker_id}", response={200: dict, 404: dict}, auth=auth)
def get_tracker(request: HttpRequest, tracker_id: UUID):
    try:
        tracker = Tracker.objects.select_related("workspace").get(id=tracker_id)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))

    svc = _tracker_service(request.auth)
    try:
        _ensure_permission(request.auth, tracker, "viewer", service=svc)
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


@router.put("/events/{tracker_id}", response={200: dict, 400: dict, 404: dict}, auth=auth)
def update_tracker(request: HttpRequest, tracker_id: UUID, payload: TrackerUpdate):
    try:
        tracker = Tracker.objects.get(id=tracker_id)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))

    svc = _tracker_service(request.auth)
    try:
        _ensure_permission(request.auth, tracker, "editor", service=svc)
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    try:
        with transaction.atomic(using=postgres_app_db_alias()):
            changed_fields = []
            if payload.name is not None:
                normalized_name = payload.name.strip()
                tracker.name = normalized_name
                changed_fields.append("name")
            if payload.description is not None:
                tracker.description = payload.description
                changed_fields.append("description")

            if payload.trigger_type is not None:
                tracker.trigger_type = payload.trigger_type
                changed_fields.append("trigger_type")
                if payload.trigger_config is None:
                    tracker.trigger_config = {}
                    changed_fields.append("trigger_config")
            if payload.trigger_config is not None:
                tracker.trigger_config = payload.trigger_config
                if "trigger_config" not in changed_fields:
                    changed_fields.append("trigger_config")
            # ：HTTP 更新路径不走 TrackerService，需就地补 cron timezone。
            if "trigger_type" in changed_fields or "trigger_config" in changed_fields:
                from apps.tracker.utils import ensure_cron_timezone
                ensured = ensure_cron_timezone(tracker.trigger_type, tracker.trigger_config)
                if ensured != (tracker.trigger_config or {}):
                    tracker.trigger_config = ensured
                    if "trigger_config" not in changed_fields:
                        changed_fields.append("trigger_config")
            if payload.skill_key is not None:
                tracker.skill_key = payload.skill_key
                changed_fields.append("skill_key")
            if payload.skill_params is not None:
                tracker.skill_params = payload.skill_params
                changed_fields.append("skill_params")
            if payload.intent_snapshot is not None:
                tracker.intent_snapshot = payload.intent_snapshot
                changed_fields.append("intent_snapshot")
            if payload.agent_id is not None:
                tracker.agent_id = payload.agent_id
                changed_fields.append("agent_id")

            if changed_fields:
                tracker.save(update_fields=changed_fields + ["updated_at"])

            trigger_changed = "trigger_type" in changed_fields or "trigger_config" in changed_fields
            if trigger_changed and tracker.status == "active":
                from apps.tracker.services.tracker_service import (
                    _clear_persisted_next_run,
                    _validate_activation_schedule,
                )
                _validate_activation_schedule(tracker)
                leftover_fields: list[str] = []
                _clear_persisted_next_run(tracker, leftover_fields)
                if leftover_fields:
                    tracker.save(update_fields=leftover_fields)

    except (ValidationError, ValueError) as exc:
        return validation_error_response(str(exc))

    # HTTP update 路径直接操作 model（不走 svc.update_tracker，以便用 changed_fields 精简
    # save），所以本处手动调 service 层 lifecycle helper 推 WS 双 topic。
    from apps.tracker.services.tracker_service import _push_tracker_lifecycle_ws
    _push_tracker_lifecycle_ws(tracker, "updated", user=request.auth)
    tracker = Tracker.objects.get(id=tracker_id)
    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


@router.delete("/events/{tracker_id}", response={200: dict, 404: dict}, auth=auth)
def delete_tracker(request: HttpRequest, tracker_id: UUID):
    try:
        tracker = Tracker.objects.get(id=tracker_id)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))

    try:
        _ensure_permission(request.auth, tracker, "editor")
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    tracker_name = tracker.name
    svc = _tracker_service(request.auth)
    try:
        svc.delete_tracker(str(tracker_id), user=request.auth)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    # svc.delete_tracker 内部已调 _push_tracker_lifecycle_ws("deleted")，HTTP 端无需再推。
    return success_response({"message": f"Tracker '{tracker_name}' deleted"})


# ── Tracker 生命周期 ──────────────────────────────────────────

@router.post(
    "/events/{tracker_id}/activate",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def activate_tracker(request: HttpRequest, tracker_id: UUID):
    svc = _tracker_service(request.auth)
    try:
        tracker = svc.activate_tracker(str(tracker_id), user=request.auth)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


@router.post(
    "/events/{tracker_id}/pause",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def pause_tracker(request: HttpRequest, tracker_id: UUID):
    svc = _tracker_service(request.auth)
    try:
        tracker = svc.pause_tracker(str(tracker_id), user=request.auth)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


class TriggerEventPayload(BaseModel):
    trigger_context: dict = Field(default_factory=dict)


@router.post(
    "/events/{tracker_id}/trigger",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def trigger_tracker(request: HttpRequest, tracker_id: UUID, payload: TriggerEventPayload = None):
    trigger_context = payload.trigger_context if payload else {}
    svc = _tracker_service(request.auth)
    try:
        run = svc.trigger_tracker(str(tracker_id), request.auth, trigger_context=trigger_context)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))

    from apps.tracker.api._helpers import _serialize_tracker_run
    return success_response(
        _serialize_tracker_run(
            run,
            capabilities=svc.resolve_run_capabilities(run),
        )
    )


@router.post(
    "/events/{tracker_id}/resume",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def resume_tracker(request: HttpRequest, tracker_id: UUID):
    svc = _tracker_service(request.auth)
    try:
        tracker = svc.resume_tracker(str(tracker_id), user=request.auth)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except ValidationError as exc:
        return validation_error_response(str(exc))
    return success_response(
        _serialize_tracker(
            tracker,
            capabilities=svc.resolve_tracker_capabilities(tracker),
        )
    )


@router.get("/events/{tracker_id}/runs", response={200: dict, 404: dict}, auth=auth)
def list_tracker_runs(request: HttpRequest, tracker_id: UUID):
    try:
        tracker = Tracker.objects.get(id=tracker_id)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_not_found"))

    svc = _tracker_service(request.auth)
    try:
        _ensure_permission(request.auth, tracker, "viewer", service=svc)
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    from apps.tracker.api._helpers import _run_result_summary

    runs = tracker.runs.select_related("tracker").order_by("-created_at")[:50]
    runs_out = [
        TrackerRunListOut(
            id=r.id, tracker_id=r.tracker_id,
            chat_session_id=r.chat_session_id,
            trigger_type=r.trigger_type,
            trigger_context=r.trigger_context, status=r.status,
            progress=r.progress, progress_pct=r.progress_pct,
            progress_message=r.progress_message, tokens_used=r.tokens_used,
            current_cycle=r.current_cycle, max_cycles=r.max_cycles,
            started_at=r.started_at, finished_at=r.finished_at,
            duration=r.duration, error_summary=r.error_summary,
            # TS-28 / ：completed 透回复；failed 透 agent_result.error_message
            result_summary=_run_result_summary(r.status, r.context or {}),
            capabilities=svc.resolve_run_capabilities(r),
            created_at=r.created_at,
        ).model_dump(mode="json")
        for r in runs
    ]
    return success_response({"runs": runs_out})


@router.get("/events/{tracker_id}/runs/{run_id}", response={200: dict, 404: dict}, auth=auth)
def get_tracker_run(request: HttpRequest, tracker_id: UUID, run_id: UUID):
    """charter v1.8 §6.7：Run = Agent 的 react 循环；transcript 在关联 ChatSession，
    本接口不再返回 step_runs（Wave 2 删除）。"""
    from apps.tracker.models import TrackerRun
    try:
        run = TrackerRun.objects.select_related("tracker").get(id=run_id, tracker_id=tracker_id)
    except TrackerRun.DoesNotExist:
        return not_found_response(_("scheduler.tracker_run_not_found"))

    svc = _tracker_service(request.auth)
    try:
        _ensure_permission(request.auth, run.tracker, "viewer", service=svc)
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    from apps.tracker.api._helpers import _serialize_tracker_run
    return success_response(
        _serialize_tracker_run(
            run,
            capabilities=svc.resolve_run_capabilities(run),
        )
    )


@router.post("/events/{tracker_id}/runs/{run_id}/cancel", response={200: dict, 400: dict, 404: dict}, auth=auth)
def cancel_tracker_run(request: HttpRequest, tracker_id: UUID, run_id: UUID):
    from apps.tracker.models import TrackerRun
    try:
        TrackerRun.objects.select_related("tracker").get(id=run_id, tracker_id=tracker_id)
    except TrackerRun.DoesNotExist:
        return not_found_response(_("scheduler.tracker_run_not_found"))

    svc = _tracker_service(request.auth)
    try:
        run = svc.cancel_run(str(run_id), user=request.auth)
    except PermissionError as exc:
        return permission_denied_response(str(exc))
    except (ValidationError, ValueError) as exc:
        return validation_error_response(str(exc))

    run_out = TrackerRunListOut(
        id=run.id, tracker_id=run.tracker_id, trigger_type=run.trigger_type,
        trigger_context=run.trigger_context, status=run.status,
        progress=run.progress, progress_pct=run.progress_pct,
        progress_message=run.progress_message, tokens_used=run.tokens_used,
        current_cycle=run.current_cycle, max_cycles=run.max_cycles,
        started_at=run.started_at, finished_at=run.finished_at,
        duration=run.duration, error_summary=run.error_summary,
        capabilities=svc.resolve_run_capabilities(run),
        created_at=run.created_at,
    ).model_dump(mode="json")
    return success_response(run_out)


# ==================== Tracker 试运行（charter v1.8 §6.3 plan §Phase 7.4）====
#
# TS-2（dry-run 路由收敛）：从 ``scheduler_api.py`` 搬迁到主前缀，完整对外路径
# ``/api/tracker/events/{tracker_id}/dry-run``，与本文件其余 ``/events/...`` 命名一致。
# i18n key（``scheduler.tracker_dry_run_*`` 等）保持不变，仅迁移代码归属。


@router.post(
    "/events/{tracker_id}/dry-run",
    response={200: dict, 401: dict, 403: dict, 404: dict},
    auth=auth,
)
def tracker_dry_run(
    request: HttpRequest,
    tracker_id: UUID,
    replay_last: int = Query(5, ge=1, le=50, description="回放最近 N 个事件"),
):
    """Tracker 试运行（plan v2.1 §Phase 7.4）。

    用 ``--replay-last N`` 拉近 N 个事件，模拟评估 Tracker 的 trigger filter，
    输出每个事件能否匹配（yes / no + 原因），但**不真触发** Skill。

    本期约束（plan §Phase 7.4 第 638-642 行）：
      - **不新建 EventLog 表**（存储压力 + 维护成本）
      - 改为各 app 自提供"近 N 个事件"read-only 接口
      - **本期大部分 app 尚未提供该接口** → 试运行能验证 filter
        本身的语义但无法真回放（用合成 mock 事件演示 condition_evaluator）

    输出格式::

        {
          "tracker_id": "...",
          "tracker_name": "...",
          "trigger_type": "table_event",
          "events_source": "synthetic|app_provided",
          "events_source_note": "tabmail 暂无 recent events 接口…",
          "results": [
            {
              "event_index": 0,
              "event": { ... },
              "matched": true,
              "reason": "filter conditions all satisfied"
            },
            ...
          ],
          "matched_count": N,
          "total_count": N
        }

    本期"events_source=synthetic"——展示 filter 评估行为，但不算真"回放"；
    待跨团队推动 EventBus + recent events 接口（v3+）后改为 app_provided。
    """
    from apps.tracker.models import Tracker
    from apps.tracker.services.tracker_service import TrackerService

    try:
        tracker = Tracker.objects.get(id=tracker_id)
    except Tracker.DoesNotExist:
        return not_found_response(_("scheduler.tracker_resource", tracker_id=tracker_id))

    # 权限：仅 Tracker 创建者 / Organization owner / Space editor 可 dry-run
    # 复用 TrackerService.check_space_permission / check_organization_permission（与 agenda_api 同口径）
    #
    # **Wave 7 续作 P0-1 修复（真实安全漏洞）**：
    #   原代码在 `tracker.workspace_id is None` 时整个 if 块跳过，**任何登录用户传任意
    #   tracker_id 都能 dry-run** —— 泄漏其它 organization 的 trigger_config（含
    #   webhook secret / table_id / filter expressions 等敏感配置）。
    #
    # 修复策略（charter §1 #5：本期不做 system_preset / organization-level Tracker，
    # 但保留 fallback 让未来 system_preset 不需重写权限层）：
    #   1) tracker.workspace_id 存在 → check_space_permission(viewer)（原口径不变）
    #   2) tracker.workspace_id 为空但 organization_id 存在 → check_organization_permission(viewer)
    #      （未来 system_preset organization-level Tracker 的权限边界）
    #   3) 两者皆无 → 直接拒绝（异常 Tracker，无可信租户边界）
    try:
        svc = TrackerService(user=request.auth)
        if tracker.workspace_id:
            if not svc.check_space_permission(str(tracker.workspace_id), "viewer"):
                return permission_denied_response(_("scheduler.tracker_dry_run_no_permission"))
        elif tracker.organization_id:
            if not svc.check_organization_permission(str(tracker.organization_id), "viewer"):
                return permission_denied_response(_("scheduler.tracker_dry_run_no_organization_access"))
        else:
            # organization_id 也为空 → 异常 Tracker（charter §7.4 模型边界要求 organization_id 非空），
            # 不允许 dry-run（fail-closed，避免泄漏意外残留数据）
            return permission_denied_response(_("scheduler.tracker_dry_run_no_tenant"))
    except Exception as exc:
        return permission_denied_response(str(exc))

    # 取近 N 个事件——本期无 app 接口 → 用合成 mock 演示
    events_source, events_source_note, events = _resolve_recent_events_for_dry_run(
        tracker, replay_last=replay_last,
    )

    results = []
    matched_count = 0
    cfg = tracker.trigger_config or {}
    conditions = cfg.get("conditions", []) or []
    cfg_table_id = cfg.get("table_id")

    from apps.tracker.services.condition_evaluator import evaluate_conditions

    for idx, evt in enumerate(events):
        # 1. table_id 过滤（仅 table_event）
        if tracker.trigger_type == "table_event" and cfg_table_id:
            if evt.get("table_id") != cfg_table_id:
                results.append({
                    "event_index": idx,
                    "event": evt,
                    "matched": False,
                    "reason": f"table_id 不匹配（期望 {cfg_table_id}，事件 {evt.get('table_id')}）",
                })
                continue

        # 2. conditions 过滤
        if conditions:
            payload = evt.get("payload") or evt.get("record_data") or evt
            if not evaluate_conditions(conditions, payload):
                results.append({
                    "event_index": idx,
                    "event": evt,
                    "matched": False,
                    "reason": "filter conditions 不满足",
                })
                continue

        # 3. 通过所有过滤 → 匹配
        matched_count += 1
        results.append({
            "event_index": idx,
            "event": evt,
            "matched": True,
            "reason": "通过所有过滤条件" if conditions else "无 filter 条件，默认全部匹配",
        })

    return success_response({
        "tracker_id": str(tracker.id),
        "tracker_name": tracker.name,
        "trigger_type": tracker.trigger_type,
        "trigger_config": tracker.trigger_config or {},
        "events_source": events_source,
        "events_source_note": events_source_note,
        "results": results,
        "matched_count": matched_count,
        "total_count": len(results),
        # 关键提示：本期"试运行"不是真回放真实事件——做真 replay 需要 app
        # 提供 recent events 接口（plan §Phase 7.4 决策升级）。前端 / Agent
        # 应当显示这条说明,避免误导用户以为"matched=true 就一定会触发"。
        #
        # Wave 8 治理（用户视角诚信）：根据 events_source 动态切换文案——
        # synthetic 时仍说"未回放真实"；app_provided 时如实告知"已回放最近 N
        # 条真实事件"。修复前 Wave 7 mini 二次验证发现：tabmail.email.received
        # 等已接入真实 model 的 Tracker dry-run 仍展示"未回放真实"文案——
        # 与代码实际行为不符,误导用户。
        "disclaimer": _build_disclaimer(
            events_source=events_source,
            trigger_type=tracker.trigger_type,
            event_key=(tracker.trigger_config or {}).get("event_key"),
            real_count=len(events) if events_source == "app_provided" else 0,
        ),
    })


def _build_disclaimer(
    *,
    events_source: str,
    trigger_type: str,
    event_key: str | None,
    real_count: int,
) -> str:
    """根据 events_source 动态生成 dry-run disclaimer 文案。

    Wave 8 治理（用户视角诚信）:
      - synthetic: "本期试运行使用合成事件演示 trigger filter 行为,未回放真实 app 事件"
      - app_provided: "本次试运行回放了最近 N 条真实 {app} 事件(organization 内 + 时间倒序)"

    Args:
        events_source: ``app_provided`` / ``synthetic`` (来自 _resolve_recent_events_for_dry_run)
        trigger_type: Tracker.trigger_type (extension_event / table_event / ...)
        event_key: trigger_config.event_key (如 ``tabmail.email.received``);非 extension_event 时为 None
        real_count: app_provided 时实际回放的事件数(synthetic 时传 0;不影响文案)
    """
    if events_source == "app_provided":
        # 从 event_key 抽 app 名(如 ``tabmail.email.received`` → ``tabmail``)
        app_name = ""
        if event_key:
            app_name = (event_key.split(".", 1)[0] or "").strip()
        app_label = app_name or "app"
        return (
            f"本次试运行回放了最近 {real_count} 条真实 {app_label} 事件"
            f"(organization 内 + 时间倒序)；matched=true 表示在该样本上"
            "通过了 trigger filter 评估,但实际触发仍取决于事件入站时的实时数据。"
        )
    # synthetic 默认文案(table_event / webhook / cron / 不支持的 event_key 等)
    return (
        "本期试运行使用合成事件演示 trigger filter 行为,未回放真实 app 事件；"
        "完整真回放依赖各 app 提供 recent events 接口(v3+)。"
    )


def _resolve_recent_events_for_dry_run(
    tracker,
    *,
    replay_last: int,
) -> tuple[str, str, list[dict]]:
    """根据 Tracker trigger_type 取近 N 个事件用于 dry-run。

    返回 ``(events_source, note, events)``：
      - ``events_source``: ``app_provided`` / ``synthetic``
      - ``note``: 给前端 / CLI 的人话说明
      - ``events``: list[dict] 事件列表

    实现状态（plan §Phase 7.4 验收"能回放最近事件"）：

      **Wave 7 续作 P1-2 修复**：为已有 model 的事件接入真实数据：
        - ``tabmail.email.received``  → 真 ``MailMessage.objects`` direction='inbound'
        - ``tabdoc.document.published`` → 真 ``Document.objects`` status='active'
                                          + 有 latest_version (代替"已发布"语义)

      其它 event_key 沿用合成事件 + disclaimer。
      table_event 沿用合成（TabData 尚未提供 recent-records read-only 接口）。

    多租户隔离（charter §6.3 / §7.4）：所有真数据查询必须**按 tracker.organization_id
    硬过滤** —— 用户只能 dry-run 自己 organization 的事件，绝不能跨租户回放。
    """
    cfg = tracker.trigger_config or {}

    # ── extension_event：基于 event_key 路由到对应 app 的真 model ──
    if tracker.trigger_type == "extension_event":
        event_key = (cfg.get("event_key") or "").strip()
        if event_key == "tabdoc.document.published":
            return _resolve_real_doc_published_events(tracker, replay_last=replay_last)

        # 其它 event_key 暂走合成（待对应 app 接入 recent events 接口）
        events = [
            {
                "source": tracker.trigger_type,
                "event_key": event_key or "(未设置)",
                "payload": {"index": i, "demo": True},
            }
            for i in range(replay_last)
        ]
        note = (
            f"event_key={event_key or '(空)'} 暂未对应 recent events 接口；"
            "当前用合成事件演示 trigger filter 评估行为。"
        )
        return ("synthetic", note, events)

    if tracker.trigger_type == "table_event":
        # 合成几条典型 record 事件演示 filter 评估
        table_id = cfg.get("table_id") or "synthetic-table"
        events: list[dict] = []
        for i in range(replay_last):
            events.append({
                "table_id": table_id,
                "event_type": "record_created",
                "payload": {
                    "record_id": f"synthetic-record-{i}",
                    "fields": {
                        "status": "completed" if i % 2 == 0 else "pending",
                        "amount": (i + 1) * 100,
                    },
                },
            })
        note = (
            "TabData 暂未提供"
            " GET /api/tabdata/tables/{id}/recent-records read-only 接口；"
            "当前用合成事件演示 trigger filter 评估行为。"
        )
        return ("synthetic", note, events)

    if tracker.trigger_type in ("webhook", "tracker_completed"):
        # webhook / cascade 暂时也走 synthetic
        events = [
            {
                "source": tracker.trigger_type,
                "payload": {"index": i, "demo": True},
            }
            for i in range(replay_last)
        ]
        note = (
            f"trigger_type={tracker.trigger_type} 暂未对应 recent events 接口；"
            "当前用合成事件演示 trigger filter 评估行为。"
        )
        return ("synthetic", note, events)

    # cron / manual / 其它：试运行不适用（无事件触发）
    return (
        "synthetic",
        f"trigger_type={tracker.trigger_type} 不依赖事件触发，dry-run 仅展示 trigger 配置摘要。",
        [],
    )


def _resolve_real_doc_published_events(
    tracker,
    *,
    replay_last: int,
) -> tuple[str, str, list[dict]]:
    """真 ``tabdoc.document.published`` 事件回放：按 tracker.organization_id 过滤最近
    的 active 文档（latest_version > 0 视为"曾被发布"代理语义）。

    本期 Document model 暂无显式 published_at 字段；用 ``latest_version > 0``
    + ``status='active'`` 作为"已被发布过"的近似 — 让 dry-run 能演示 filter 行为，
    待 tabdoc 后续加 published_at + 发布事件入站时升级为真触发时间过滤。
    """
    try:
        from apps.tabdoc.models import Document
    except Exception:
        return (
            "synthetic",
            "tabdoc 模块不可用（导入失败），回退到合成事件。",
            [],
        )

    qs = Document.objects.filter(
        organization_id=tracker.organization_id,
        status="active",
        latest_version__gt=0,
    ).order_by("-updated_at")[:replay_last]

    events: list[dict] = []
    for doc in qs:
        # 与 packages/apps/tabdoc/app.json 的 events[].payload_schema 对齐：
        # doc_id / title / author_id / tags
        events.append({
            "source": "extension_event",
            "event_key": "tabdoc.document.published",
            "payload": {
                "doc_id": str(doc.id),
                "title": doc.title,
                "author_id": str(doc.owner_id) if doc.owner_id else "",
                "tags": list(doc.tags or []),
                # 元数据
                "latest_version": doc.latest_version,
                "updated_at": doc.updated_at.isoformat() if doc.updated_at else None,
            },
        })

    note = (
        f"已加载 organization_id={tracker.organization_id} 最近 {len(events)} 篇 active 文档"
        f"（latest_version > 0；按 updated_at 倒序，取 ≤ {replay_last}）；"
        "本期 Document 无显式 published_at 字段，以 latest_version 作 published 代理。"
    )
    return ("app_provided", note, events)
