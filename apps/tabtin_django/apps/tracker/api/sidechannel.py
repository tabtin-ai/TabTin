"""Tracker 侧路接口（templates / webhook / SDK progress / filtered-events）。

挂在 ``/api/tracker/`` 前缀下（波次 4 Stage 2.1 一刀切）：

- ``/templates`` —— Tracker 模板查询（前端 / Cmd+K 复用，独立 schema 不依赖 step）
- ``/webhook/{path}`` —— 外部入站触发（trigger_by_webhook 服务）
- ``/runs/{run_id}/progress`` —— SDK 进度上报（与 Skill 执行链路对齐）
- ``/trackers/{tracker_id}/filtered-events`` —— 触发过滤事件查询（debug 用）

注：``/event-catalog`` 已删除（与 ``/api/scheduler/events`` 重复，由后者承接）。
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.http import HttpRequest, HttpResponse
from ninja import Router
from pydantic import BaseModel, Field

from apps.i18n import _
from apps.users.auth.permissions import JWTAuth
from apps.tabdata.api_helpers import (
    success_response,
    not_found_response,
    validation_error_response,
    permission_denied_response,
)
from apps.tracker.models import Tracker

_logger = logging.getLogger(__name__)

router = Router(tags=["Tracker (side-channels)"])
auth = JWTAuth()


def _tracker_service(user):
    from apps.tracker.services.tracker_service import TrackerService
    return TrackerService(user=user)


def _ensure_tracker_permission(user, tracker, role: str = "viewer"):
    """通过 tracker 的 space_id 校验权限，失败时抛 PermissionError。"""
    svc = _tracker_service(user)
    if not svc.check_space_permission(str(tracker.workspace_id), role):
        raise PermissionError(f"No {role} permission on Space {tracker.workspace_id}")


# ─── Templates ────────────────────────────────────────────────


@router.get("/templates", response={200: dict}, auth=None)
def list_templates(
    request: HttpRequest,
    category: str = None,
    format: str = None,
    locale: str = None,
):
    """获取预置 Tracker 模板列表。

    locale：可选；支持 en / en-US / en_US → en-US，zh / zh-CN / zh_CN → zh-CN；
    缺省或未知回落 zh-CN（保持旧调用兼容）。
    """
    from apps.tracker.tracker_templates import get_templates
    templates = get_templates(category, format=format, locale=locale)
    return success_response({"templates": templates})


@router.get("/templates/{template_id}", response={200: dict, 404: dict}, auth=None)
def get_template(request: HttpRequest, template_id: str, locale: str = None):
    """获取单个模板详情（locale 语义与列表接口一致）。"""
    from apps.tracker.tracker_templates import get_template_by_id
    t = get_template_by_id(template_id, locale=locale)
    if not t:
        return not_found_response(_("scheduler.tracker_template_not_found"))
    return success_response(t)


# ─── Webhook ──────────────────────────────────────────────────

_WEBHOOK_RATE_LIMIT_PER_IP = 30
_WEBHOOK_RATE_LIMIT_WINDOW = 60


@router.post(
    "/webhook/{path}",
    response={200: dict, 404: dict, 429: dict},
    auth=None,
)
def webhook_inbound(request: HttpRequest, path: str):
    """Webhook 入站触发：外部系统 POST 调用触发 Tracker。

    安全机制：
    - 基于 IP 的速率限制（每 IP 每分钟 30 次）
    - 支持可选的 HMAC 签名验证（trigger_config.secret）
    """
    import json

    source_ip = request.META.get("REMOTE_ADDR", "unknown")

    from django.core.cache import cache
    rate_key = f"webhook_rate:{source_ip}"
    try:
        cache.add(rate_key, 0, timeout=_WEBHOOK_RATE_LIMIT_WINDOW)
        hit_count = cache.incr(rate_key)
        if hit_count > _WEBHOOK_RATE_LIMIT_PER_IP:
            _logger.warning("[webhook] rate limit exceeded: ip=%s count=%d", source_ip, hit_count)
            return HttpResponse(
                json.dumps({"error": "Rate limit exceeded", "retry_after": _WEBHOOK_RATE_LIMIT_WINDOW}),
                status=429,
                content_type="application/json",
            )
    except Exception:
        _logger.warning("[webhook] rate limit check failed (fail-closed), rejecting", exc_info=True)
        return HttpResponse(
            json.dumps({"error": "Rate limit unavailable, please retry later"}),
            status=503,
            content_type="application/json",
        )

    try:
        payload = json.loads(request.body) if request.body else {}
    except (json.JSONDecodeError, ValueError):
        _logger.warning("[webhook] payload 解析失败: path=%s ip=%s", path, source_ip)
        payload = {}

    signature = request.headers.get("X-Webhook-Signature", "")

    from apps.tracker.services.tracker_trigger_service import trigger_by_webhook
    raw_body = request.body or b""
    run_id = trigger_by_webhook(path, payload, source_ip, signature, raw_body)
    if run_id:
        return success_response({"run_id": run_id, "triggered": True})
    return not_found_response(_("scheduler.webhook_no_matching_tracker"))


# ─── SDK Progress Reporting ───────────────────────────────────


class ProgressUpdateRequest(BaseModel):
    progress_pct: int = Field(..., ge=0, le=100)
    progress_message: str = ""


@router.put(
    "/runs/{run_id}/progress",
    response={200: dict, 400: dict, 403: dict, 404: dict},
    auth=auth,
)
def update_run_progress(request: HttpRequest, run_id: UUID, payload: ProgressUpdateRequest):
    """SDK 进度上报：Skill 脚本在执行过程中调用此接口报告进度。"""
    from apps.tracker.models import TrackerRun
    try:
        run = TrackerRun.objects.select_related("tracker").get(id=run_id)
    except TrackerRun.DoesNotExist:
        return not_found_response(_("scheduler.run_record_resource"))
    try:
        _ensure_tracker_permission(request.auth, run.tracker)
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    if run.status not in ("running", "pending"):
        return validation_error_response(f"Cannot update progress for run in status: {run.status}")

    run.progress_pct = payload.progress_pct
    run.progress_message = payload.progress_message
    run.save(update_fields=["progress_pct", "progress_message"])

    try:
        from apps.tracker.services.tracker_notification import TrackerNotificationService
        TrackerNotificationService(run).notify_progress(run)
    except Exception:
        _logger.debug("Progress WS notification failed for run=%s", run_id, exc_info=True)

    return success_response({
        "run_id": str(run.id),
        "progress_pct": run.progress_pct,
        "progress_message": run.progress_message,
    })


# ─── Filtered Events ──────────────────────────────────────────


@router.get("/trackers/{tracker_id}/filtered-events", response={200: dict}, auth=auth)
def filtered_events(request: HttpRequest, tracker_id: UUID):
    """返回最近被条件过滤掉的触发事件（来自 cache，最多 20 条）。"""
    try:
        tracker = Tracker.objects.only("id", "organization", "workspace").get(id=tracker_id)
    except Tracker.DoesNotExist:
        # NOTE: 历史选择 validation_error_response(400) 而非 not_found_response(404)，
        # 保持原 status code 契约不动，只把消息走 i18n key。
        return validation_error_response(_("scheduler.tracker_not_found"))

    try:
        _ensure_tracker_permission(request.auth, tracker, "viewer")
    except PermissionError as exc:
        return permission_denied_response(str(exc))

    from apps.tracker.services.tracker_notification import get_filtered_events

    entries = get_filtered_events(str(tracker_id))
    return success_response({"filtered_events": entries, "total": len(entries)})


# Module E 抽到 _helpers.py（消除 trackers.py 反向 import 错位）。
# 此处保留 re-export 兼容外部 caller（如果有），但 trackers.py 已直接从
# _helpers import。
from apps.tracker.api._helpers import _serialize_tracker_run  # noqa: F401
