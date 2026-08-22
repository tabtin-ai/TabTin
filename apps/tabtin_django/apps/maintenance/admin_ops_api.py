from __future__ import annotations

import os
import re
import json
import time
import logging
from collections import Counter
from datetime import timedelta
from decimal import Decimal
from typing import Any

import requests
from celery import current_app
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.db import transaction
from django.db.models import Count, Max, Min, Q
from django.http import JsonResponse
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.fts.models import FtsOutbox, FtsOutboxPg
from apps.users.auth.permissions import StaffAuth
from apps.users.auth.utils import get_client_ip, get_user_agent

from .models import FailedTaskRecord, OpsRuntimeActionLog, OpsRuntimeResolution, OpsTroubleshootQueryLog

router = Router(auth=StaffAuth())
User = get_user_model()
logger = logging.getLogger(__name__)

P0_PERMISSION_CODES = {
    "stability": "ops_stability:view",
    "user_diagnose": "ops_user:diagnose",
    "task": "ops_task:view",
    "realtime": "ops_realtime:view",
    "collab": "ops_collab:view",
    "search_outbox": "ops_search_outbox:view",
    "finance_trace": "ops_finance_trace:view",
    "audit": "ops_audit:view",
    "beat": "ops_beat:view",
    "llm_trace": "ops_llm_trace:view",
    "oss_status": "ops_oss_status:view",
    "sms_status": "ops_sms_status:view",
    "dependency_health": "ops_dependency_health:view",
    "incident": "ops_incident:view",
    "cost_sla": "ops_cost_sla:view",
}

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 100
DEFAULT_RANGE_HOURS = 24
MAX_RANGE_DAYS = 30
FTS_OLD_PENDING_THRESHOLD_SECONDS = 600
FTS_ERROR_PREVIEW_MAX_CHARS = 500
FTS_DOC_SAMPLE_LIMIT = 5
COLLAB_METRICS_TIMEOUT_SECONDS = 0.8
CELERY_INSPECT_TIMEOUT_SECONDS = 1.2
CELERY_WORKER_SNAPSHOT_CACHE_SECONDS = 30
OVERVIEW_CACHE_SECONDS = 30
BEAT_FAILURE_LOOKBACK_HOURS = 24
BEAT_STALE_MULTIPLIER = 3
OPS_KNOWN_CELERY_QUEUES = (
    "critical",
    "default",
    "heavy",
    "pptx_import_oss",
    "tabdata_conversion",
    "tracker_agent",
    "celery",
)
OPS_CRITICAL_CELERY_QUEUES = {"critical", "default"}


class FtsOutboxStatus:
    PENDING = "pending"
    PROCESSED = "processed"
    RETRYING = "retrying"
    FAILED = "failed"
    OLD_PENDING = "old_pending"
    UNKNOWN = "unknown"

SENSITIVE_KEY_RE = re.compile(
    r"(token|api[_-]?key|secret|password|authorization|jwt|session|callback_data|"
    r"private[_-]?url|database[_-]?url|provider[_-]?key|centrifugo|live_secret)",
    re.IGNORECASE,
)
SENSITIVE_EXACT_KEYS = {
    "content",
    "sms_content",
    "sms_body",
    "message_content",
    "verification_code",
    "verify_code",
    "sms_code",
    "captcha",
    "otp",
}
EMAIL_RE = re.compile(r"(?P<name>[A-Za-z0-9._%+-])[^@\s]*@(?P<domain>[A-Za-z0-9.-]+\.[A-Za-z]{2,})")
PHONE_RE = re.compile(r"(?<!\d)(?P<prefix>\+?\d{3})\d{4,13}(?P<suffix>\d{4})(?!\d)")
SIGNED_URL_RE = re.compile(r"https?://[^\s\"']*(?:X-Amz-|Expires=|Signature=)[^\s\"']*", re.IGNORECASE)
URL_RE = re.compile(r"https?://[^\s\"']+", re.IGNORECASE)
JWT_RE = re.compile(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b")
BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)
SECRET_ASSIGN_RE = re.compile(
    r"\b(token|api[_-]?key|secret|session|jwt|authorization)\s*[:=]\s*[A-Za-z0-9._~+/=-]{6,}",
    re.IGNORECASE,
)
VERIFY_CODE_RE = re.compile(r"(?:(验证码|校验码|verification code|verify code|otp)[^\d]{0,12})(\d{4,8})", re.IGNORECASE)


def _is_production() -> bool:
    envs = {
        os.getenv("ENVIRONMENT", ""),
        os.getenv("DJANGO_ENV", ""),
        os.getenv("TABTIN_ENV", ""),
    }
    return "production" in {item.strip().lower() for item in envs}


def _ticket_required() -> bool:
    if _is_production():
        return True
    return str(getattr(settings, "TABTIN_ADMIN_OPS_REQUIRE_TICKET_ID", "0")) == "1"


def _parse_time_range(start: str | None, end: str | None) -> tuple[Any, Any]:
    now = timezone.now()
    range_end = _parse_dt(end) if end else now
    range_start = _parse_dt(start) if start else range_end - timedelta(hours=DEFAULT_RANGE_HOURS)
    if range_start >= range_end:
        raise HttpError(400, "time_range_start must be before time_range_end")
    if range_end - range_start > timedelta(days=MAX_RANGE_DAYS):
        raise HttpError(400, f"time range must be <= {MAX_RANGE_DAYS} days")
    return range_start, range_end


def _parse_limited_time_range(
    start: str | None,
    end: str | None,
    *,
    default_hours: int,
    max_days: int,
) -> tuple[Any, Any]:
    now = timezone.now()
    range_end = _parse_dt(end) if end else now
    range_start = _parse_dt(start) if start else range_end - timedelta(hours=default_hours)
    if range_start >= range_end:
        raise HttpError(400, "time_range_start must be before time_range_end")
    if range_end - range_start > timedelta(days=max_days):
        raise HttpError(400, f"time range must be <= {max_days} days")
    return range_start, range_end


def _parse_dt(raw: str | None):
    if not raw:
        return None
    try:
        parsed = timezone.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HttpError(400, "invalid ISO datetime") from exc
    if timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, timezone.get_current_timezone())
    return parsed


def _page_size(value: int) -> int:
    if value < 1:
        raise HttpError(400, "page_size must be >= 1")
    return min(value, MAX_PAGE_SIZE)


def _require_reason_ticket(reason: str | None, ticket_id: str | None) -> tuple[str, str]:
    normalized_reason = (reason or "").strip()
    normalized_ticket = (ticket_id or "").strip()
    if not normalized_reason:
        raise HttpError(400, "reason is required")
    if _ticket_required() and not normalized_ticket:
        raise HttpError(400, "ticket_id is required")
    return normalized_reason, normalized_ticket


def _require_perm(request, code: str) -> None:
    user = request.auth
    try:
        if getattr(user, "is_superuser", False):
            return
        if user and user.has_perm(f"maintenance.{code}"):
            return
    except Exception as exc:
        logger.warning(
            "Admin ops permission check failed closed: code=%s error=%s",
            code,
            exc.__class__.__name__,
        )
    raise HttpError(403, f"missing permission: {code}")


def _ops_runtime_actions_enabled() -> bool:
    return bool(getattr(settings, "OPS_RUNTIME_ACTIONS_ENABLED", False))


def _runtime_action_allowed(action_type: str) -> bool:
    return action_type in {"retry", "resolve"}


def _require_runtime_action_perm(request, action_type: str) -> str:
    if not _runtime_action_allowed(action_type):
        raise HttpError(400, f"unsupported runtime action: {action_type}")
    perm_code = _runtime_action_permission_code(action_type)
    user = getattr(request, "auth", None)
    try:
        if getattr(user, "is_superuser", False):
            return perm_code
        if user and user.has_perm(f"maintenance.{perm_code}"):
            return perm_code
    except Exception as exc:
        logger.warning(
            "Runtime action permission check failed closed: action=%s error=%s",
            action_type,
            exc.__class__.__name__,
        )
    raise HttpError(403, f"missing permission: {perm_code}")


def _request_id(request) -> str:
    return (
        request.META.get("HTTP_X_REQUEST_ID")
        or request.META.get("HTTP_X_CORRELATION_ID")
        or request.META.get("HTTP_TRACEPARENT")
        or ""
    )[: OpsTroubleshootQueryLog.REQUEST_ID_MAX_LEN]


def _audit_query(
    request,
    *,
    query_type: str,
    reason: str,
    ticket_id: str,
    time_range_start=None,
    time_range_end=None,
    target_user_id: str = "",
    target_organization_id: str = "",
    target_entity_type: str = "",
    target_entity_id: str = "",
) -> None:
    actor = request.auth
    OpsTroubleshootQueryLog.objects.create(
        actor_user_id=str(getattr(actor, "id", "")),
        actor_admin_account_id=None,
        query_type=query_type,
        target_user_id=str(target_user_id or ""),
        target_organization_id=str(target_organization_id or ""),
        target_entity_type=target_entity_type or "",
        target_entity_id=str(target_entity_id or ""),
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=time_range_start,
        time_range_end=time_range_end,
        ip=get_client_ip(request),
        user_agent=get_user_agent(request)[:2000],
        request_id=_request_id(request),
    )


def _mask_email(value: str) -> str:
    if "@" not in value:
        return "***"
    name, domain = value.split("@", 1)
    return f"{name[:1]}***@{domain}"


def _mask_phone(value: str) -> str:
    if len(value) < 7:
        return "***"
    return f"{value[:3]}****{value[-4:]}"


def _mask_text(value: str) -> str:
    if SIGNED_URL_RE.fullmatch(value):
        return "[masked-url]"
    if SENSITIVE_KEY_RE.search(value) and SECRET_ASSIGN_RE.search(value):
        return "[masked]"
    masked = SIGNED_URL_RE.sub("[masked-url]", value)
    masked = BEARER_RE.sub("Bearer [masked]", masked)
    masked = JWT_RE.sub("[masked-jwt]", masked)
    masked = SECRET_ASSIGN_RE.sub(lambda m: f"{m.group(1)}=[masked]", masked)
    masked = URL_RE.sub("[masked-url]", masked)
    masked = VERIFY_CODE_RE.sub(lambda m: f"{m.group(1)} [masked-code]", masked)
    masked = EMAIL_RE.sub(lambda m: f"{m.group('name')}***@{m.group('domain')}", masked)
    masked = PHONE_RE.sub(lambda m: f"{m.group('prefix')}****{m.group('suffix')}", masked)
    return masked


def _is_sensitive_key(key: Any) -> bool:
    normalized = str(key).strip().lower().replace("-", "_")
    return normalized in SENSITIVE_EXACT_KEYS or bool(SENSITIVE_KEY_RE.search(normalized))


def _mask(value: Any) -> Any:
    if isinstance(value, dict):
        masked = {}
        for key, item in value.items():
            if _is_sensitive_key(key):
                masked[key] = "[masked]"
            else:
                masked[key] = _mask(item)
        return masked
    if isinstance(value, list):
        return [_mask(item) for item in value]
    if isinstance(value, str):
        return _mask_text(value)
    if isinstance(value, Decimal):
        return str(value)
    return value


def _safe_part(name: str, fn):
    try:
        return {"status": "ok", "data": _mask(fn())}
    except Exception as exc:  # pragma: no cover - defensive partial result
        return {"status": "unknown", "error": f"{name} unavailable: {exc.__class__.__name__}"}


def _request_memo(request, key: str, builder):
    if request is None:
        return builder()
    memo = getattr(request, "_admin_ops_memo", None)
    if not isinstance(memo, dict):
        memo = {}
        setattr(request, "_admin_ops_memo", memo)
    if key not in memo:
        memo[key] = builder()
    return memo[key]


def _safe_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def _age_seconds(value) -> int | None:
    if not value:
        return None
    try:
        return max(0, int((timezone.now() - value).total_seconds()))
    except (TypeError, ValueError):
        return None


def _service_intervention(*, current: list[str] | None = None, future: list[str] | None = None) -> dict[str, Any]:
    return {
        "current_supported": current or ["刷新", "查看详情", "复制排障信息"],
        "p15_candidates": future or [],
        "forbidden": [
            "批量 retry",
            "批量 resolve",
            "批量 requeue",
            "清空队列",
            "批量断开连接",
            "全量重建",
            "强关房间",
            "自动补偿",
        ],
    }


RUNTIME_STATUS_RANK = {
    "healthy": 0,
    "unsupported": 0,
    "warning": 1,
    "partial": 2,
    "unavailable": 3,
    "critical": 4,
}

RUNTIME_ALLOWED_ACTIONS = [
    "refresh",
    "view_failed_samples",
    "view_related_worker",
    "view_outbox_samples",
    "copy_diagnostic_info",
    "export_diagnostic_json",
]

RUNTIME_FORBIDDEN_ACTIONS = [
    "bulk_retry",
    "purge_queue",
    "clear_queue",
    "kill_worker",
    "scale_worker",
    "edit_beat_schedule",
]


class OpsRuntimeActionRequest(Schema):
    target_type: str = ""
    target_id: str = ""
    source: str = ""
    queue: str = ""
    task_name: str = ""
    before_status: str = ""
    ticket_id: str = ""
    reason: str = ""
    payload: dict[str, Any] = {}


def _operator_name(user) -> str:
    for attr in ("username", "email", "nickname", "phone"):
        value = getattr(user, attr, "")
        if value:
            return str(value)
    display = getattr(user, "get_display_name", None)
    if callable(display):
        try:
            return str(display() or "")
        except Exception:
            return ""
    return ""


def _runtime_action_error(error: str, message: str, *, status: int = 400, warnings: list[str] | None = None):
    return JsonResponse(
        {
            "ok": False,
            "error": error,
            "message": message,
            "warnings": warnings or [],
        },
        status=status,
    )


def _runtime_action_success(log: OpsRuntimeActionLog, message: str, warnings: list[str] | None = None):
    return {
        "ok": True,
        "action_id": str(log.id),
        "action_type": log.action_type,
        "target_type": log.target_type,
        "target_id": log.target_id,
        "before_status": log.before_status,
        "after_status": log.after_status,
        "message": message,
        "warnings": warnings or [],
    }


def _runtime_action_failure(log: OpsRuntimeActionLog, error: str, message: str, warnings: list[str] | None = None):
    return JsonResponse(
        {
            "ok": False,
            "action_id": str(log.id),
            "action_type": log.action_type,
            "target_type": log.target_type,
            "target_id": log.target_id,
            "before_status": log.before_status,
            "after_status": log.after_status,
            "error": error,
            "message": message,
            "warnings": warnings or [],
        },
        status=409,
    )


def _record_runtime_action(
    request,
    *,
    action_type: str,
    payload: OpsRuntimeActionRequest,
    result: str,
    error_message: str = "",
    after_status: str = "",
) -> OpsRuntimeActionLog:
    operator = getattr(request, "auth", None)
    payload_dict = payload.dict()
    return OpsRuntimeActionLog.objects.create(
        action_type=action_type,
        target_type=(payload.target_type or "")[:80],
        target_id=(payload.target_id or "")[:160],
        source=(payload.source or "")[:80],
        queue=(payload.queue or "")[:100],
        task_name=(payload.task_name or "")[:500],
        before_status=(payload.before_status or "")[:80],
        after_status=(after_status or "")[:80],
        ticket_id=(payload.ticket_id or "")[:100],
        operator_id=str(getattr(operator, "id", "") or "")[:36],
        operator_name=_operator_name(operator)[:255],
        request_payload_sanitized=_mask(payload_dict),
        result=result[:40],
        error_message=(error_message or "")[:4000],
    )


def _runtime_action_permission_code(action_type: str) -> str:
    if action_type == "retry":
        return "runtime_action:retry"
    if action_type == "resolve":
        return "runtime_action:resolve"
    if action_type == "cleanup":
        return "runtime_action:cleanup"
    return f"runtime_action:{action_type}"


def _runtime_action_guard(request, action_type: str, payload: OpsRuntimeActionRequest):
    if not _runtime_action_allowed(action_type):
        log = _record_runtime_action(
            request,
            action_type=action_type,
            payload=payload,
            result="rejected",
            error_message="unsupported_runtime_action",
        )
        return _runtime_action_error(
            "unsupported_runtime_action",
            "不支持的 Runtime action",
            status=400,
            warnings=[f"action_id={log.id}"],
        )
    if not (payload.ticket_id or "").strip():
        log = _record_runtime_action(
            request,
            action_type=action_type,
            payload=payload,
            result="rejected",
            error_message="ticket_id_required",
        )
        return _runtime_action_error(
            "ticket_id_required",
            "写操作必须提供 Ticket ID",
            status=400,
            warnings=[f"action_id={log.id}"],
        )
    if not _ops_runtime_actions_enabled():
        log = _record_runtime_action(
            request,
            action_type=action_type,
            payload=payload,
            result="rejected",
            error_message="ops_runtime_actions_disabled",
        )
        return _runtime_action_error(
            "ops_runtime_actions_disabled",
            "Runtime 写操作未启用",
            status=403,
            warnings=[f"action_id={log.id}"],
        )
    try:
        _require_runtime_action_perm(request, action_type)
    except HttpError as exc:
        message = str(exc)
        log = _record_runtime_action(
            request,
            action_type=action_type,
            payload=payload,
            result="rejected",
            error_message=message,
        )
        return _runtime_action_error(
            "permission_denied",
            message,
            status=getattr(exc, "status_code", 403),
            warnings=[f"action_id={log.id}"],
        )
    return None


def _runtime_action_target(payload: OpsRuntimeActionRequest) -> tuple[str, str]:
    source = (payload.source or "").strip()
    target_id = (payload.target_id or "").strip()
    if not source or not target_id:
        raise ValueError("source and target_id are required")
    return source, target_id


def _channel_outbox_max_attempts() -> int:
    return int(getattr(settings, "CHANNEL_GATEWAY_OUTBOUND_MAX_ATTEMPTS", 5))


def _runtime_retry_channel(target_id: str) -> tuple[str, str, str]:
    from apps.channel_gateway.models import ChannelOutboundMessageRecord
    from apps.channel_gateway.tasks import deliver_one_outbox

    with transaction.atomic():
        record = ChannelOutboundMessageRecord.objects.select_for_update().filter(id=target_id).first()
        if not record:
            raise ValueError("Channel Outbox 不存在")
        before = record.status
        if record.status != "failed":
            raise ValueError("仅 failed 的 Channel Outbox 可 retry")
        if int(record.attempts or 0) >= _channel_outbox_max_attempts():
            raise ValueError("terminal_failed Channel Outbox 禁止 retry")
        record.status = "pending"
        record.next_retry_at = timezone.now()
        record.save(update_fields=["status", "next_retry_at", "updated_at"])
    deliver_one_outbox.apply_async(args=[target_id], queue="realtime_delivery")
    return before, "pending", "已重新投递到 realtime_delivery"


def _runtime_retry_rag(target_id: str) -> tuple[str, str, str]:
    from apps.rag.models import EmbeddingTask

    task = EmbeddingTask.objects.filter(id=target_id).first()
    if not task:
        raise ValueError("EmbeddingTask 不存在")
    # EmbeddingTask 当前没有 user_id 字段。没有可验证的用户或 system context 时
    # 严禁盲目 retry，否则会重复制造同类 terminal failed 噪音。
    raise ValueError("当前任务缺少 user_id / system organization context，禁止 retry")


def _runtime_retry_fts(payload: OpsRuntimeActionRequest, target_id: str) -> tuple[str, str, str]:
    if not getattr(settings, "SEARCH_ENGINE_ENABLED", False):
        raise ValueError("搜索索引未启用，禁止 retry")
    db = str((payload.payload or {}).get("db") or "").strip()
    if not db:
        raise ValueError("FTS retry 必须提供明确 db，禁止默认选择数据库")
    if db == "pg":
        db = "postgresql"
    if db not in {"default", "postgresql"}:
        raise ValueError("FTS retry db 必须为 default 或 postgresql")
    from apps.fts.services.outbox_service import requeue_terminal
    from apps.fts.tasks import flush_outbox_task

    affected = requeue_terminal(db, [int(target_id)])
    if not affected:
        raise ValueError("FTS outbox 不存在或不处于 terminal failed")
    flush_outbox_task.apply_async(kwargs={"db": db}, queue="search_indexing")
    return "terminal_failed", "pending", "已重新入队，等待 search_indexing 消费"


def _runtime_retry_tabdoc(target_id: str) -> tuple[str, str, str]:
    from apps.tabdoc.models import DocUpdate
    from apps.tabdoc.tasks import merge_doc_for_document

    row = DocUpdate.objects.select_related("document").filter(id=target_id).first()
    if not row:
        raise ValueError("DocUpdate 不存在")
    document_id = str(row.document_id)
    if not document_id:
        raise ValueError("DocUpdate 缺少 document_id")
    merge_doc_for_document.apply_async(args=[document_id], queue="doc_merge")
    return "pending", "pending", "已投递 merge_doc_for_document 到 doc_merge"


def _runtime_perform_retry(payload: OpsRuntimeActionRequest) -> tuple[str, str, str]:
    source, target_id = _runtime_action_target(payload)
    if source == "FailedTaskRecord":
        raise ValueError("FailedTaskRecord 不能盲目 retry；只能查看或 resolve")
    if source == "channel_outbox":
        return _runtime_retry_channel(target_id)
    if source == "rag_embedding_task":
        return _runtime_retry_rag(target_id)
    if source == "fts_outbox":
        return _runtime_retry_fts(payload, target_id)
    if source == "tabdoc_doc_update":
        return _runtime_retry_tabdoc(target_id)
    raise ValueError(f"不支持的 retry source: {source}")


def _runtime_perform_resolve(request, payload: OpsRuntimeActionRequest) -> tuple[str, str, str]:
    source, target_id = _runtime_action_target(payload)
    if source == "rag_embedding_task":
        raise ValueError("RAG terminal failed 历史清理必须使用 ops_rag_terminal_failed_resolve 管理命令")
    reason = (payload.reason or "").strip()
    if not reason:
        raise ValueError("resolve 必须提供 reason")
    before = payload.before_status or "failed"
    with transaction.atomic():
        resolution, _created = OpsRuntimeResolution.objects.update_or_create(
            source=source,
            target_id=target_id,
            defaults={
                "target_type": (payload.target_type or source)[:80],
                "status": "resolved",
                "reason": reason,
                "ticket_id": payload.ticket_id,
                "resolved_by": str(getattr(request.auth, "id", "") or "")[:36],
                "resolved_at": timezone.now(),
            },
        )
        if source == "FailedTaskRecord":
            FailedTaskRecord.objects.filter(task_id=target_id).update(
                resolved=True,
                resolved_at=resolution.resolved_at,
            )
    return before, "resolved", "已标记为 resolved；原始失败记录未删除"


def _runtime_registries() -> tuple[dict[str, Any], dict[str, Any], dict[str, Any], dict[str, Any]]:
    from tabtin.runtime.registry import BEAT_REGISTRY, QUEUE_REGISTRY, TASK_REGISTRY, WORKER_REGISTRY

    return QUEUE_REGISTRY, WORKER_REGISTRY, BEAT_REGISTRY, TASK_REGISTRY


def _runtime_envelope(
    *,
    status: str,
    items: list[dict[str, Any]],
    warnings: list[str] | None = None,
    unsupported: list[dict[str, Any]] | list[str] | None = None,
    errors: list[str] | None = None,
    **extra,
) -> dict[str, Any]:
    return {
        "status": status,
        "generated_at": _serialize_dt(timezone.now()),
        "items": items,
        "warnings": warnings or [],
        "unsupported": unsupported or [],
        "errors": errors or [],
        **extra,
    }


def _runtime_status_from_items(items: list[dict[str, Any]], *, default: str = "healthy") -> str:
    statuses = [str(item.get("status") or default) for item in items if item.get("status") != "unsupported"]
    if not statuses:
        return default
    return max(statuses, key=lambda status: RUNTIME_STATUS_RANK.get(status, 0))


def _runtime_safe(name: str, fn):
    try:
        return fn(), []
    except Exception as exc:  # pragma: no cover - defensive runtime console boundary
        return None, [f"{name} unavailable: {exc.__class__.__name__}"]


def _runtime_queue_lengths(queue_names: list[str]) -> tuple[dict[str, int | None], list[str]]:
    import redis

    try:
        r = redis.from_url(settings.CELERY_BROKER_URL, socket_timeout=1.0, socket_connect_timeout=1.0)
        return {name: int(r.llen(name)) for name in queue_names}, []
    except Exception as exc:
        return {name: None for name in queue_names}, [f"celery broker unavailable: {exc.__class__.__name__}"]


def _task_route_queue(task_name: str) -> tuple[str, str, str]:
    name = str(task_name or "").strip()
    if not name:
        return "unknown", "unavailable", "low"
    route = getattr(current_app.conf, "task_routes", None)
    if isinstance(route, dict):
        value = route.get(name)
        if isinstance(value, dict) and value.get("queue"):
            return str(value["queue"]), "Celery task_routes", "high"
        if isinstance(value, str):
            return value, "Celery task_routes", "high"
    registered_task = current_app.tasks.get(name)
    explicit_queue = str(getattr(registered_task, "queue", "") or "").strip() if registered_task else ""
    if explicit_queue:
        return explicit_queue, "registered task explicit queue", "high"
    try:
        _queues, _workers, _beats, task_registry = _runtime_registries()
        task_meta = task_registry.get(name) or {}
        if task_meta.get("queue"):
            return str(task_meta["queue"]), "registry inference", "medium"
    except Exception:
        pass
    return "unknown", "unavailable", "low"


def _task_worker_for_queue(queue_name: str) -> str:
    try:
        _queues, workers, _beats, _tasks = _runtime_registries()
        for worker_name, meta in workers.items():
            if queue_name in (meta.get("queues") or []):
                return worker_name
    except Exception:
        pass
    return "unknown"


def _runtime_error_signature(value: str) -> str:
    text = str(value or "").strip()
    if not text:
        return "unknown"
    first_line = text.splitlines()[0][:180]
    return _mask_text(first_line)


def _runtime_seconds_since(value) -> int | None:
    if not value:
        return None
    try:
        return max(0, int((timezone.now() - value).total_seconds()))
    except Exception:
        return None


def _runtime_base_actions() -> dict[str, list[str]]:
    return {
        "allowed_actions": list(RUNTIME_ALLOWED_ACTIONS),
        "forbidden_actions": list(RUNTIME_FORBIDDEN_ACTIONS),
    }


def _runtime_queue_diagnosis(
    *,
    backlog,
    consumer_count,
    active,
    failed_sample_count,
    dlq_count,
    terminal_failed_count,
    expected_worker: str,
    actual_workers: list[str] | None,
) -> tuple[str, str, str]:
    if backlog is None or actual_workers is None:
        return "partial", "unavailable", "队列或 worker 指标来源不可用。"
    if actual_workers and expected_worker and expected_worker not in actual_workers:
        return "critical", "worker_binding_mismatch", "实际消费队列与 Runtime Registry 不一致。"
    if dlq_count > 0 or terminal_failed_count > 0:
        return "critical", "manual_intervention_required", "存在终态失败或死信样本，需要人工排查。"
    if backlog > 0 and consumer_count <= 0:
        return "critical", "worker_not_consuming", "队列存在积压，但没有 worker 消费。"
    if backlog > 0 and consumer_count > 0 and active > 0:
        return "warning", "normal_backlog", "队列存在积压，但 worker 正在消费。"
    if backlog == 0 and failed_sample_count > 0:
        return "warning", "program_error", "当前不是队列积压，而是失败任务较多。"
    return "healthy", "none", "队列暂无明显异常。"


def _runtime_failed_samples(limit: int = MAX_PAGE_SIZE) -> tuple[list[dict[str, Any]], dict[str, int], list[str]]:
    errors: list[str] = []
    samples: list[dict[str, Any]] = []
    per_queue: dict[str, int] = {}
    start = timezone.now() - timedelta(hours=BEAT_FAILURE_LOOKBACK_HOURS)
    try:
        rows = list(
            FailedTaskRecord.objects.filter(failed_at__gte=start)
            .order_by("-failed_at")
            .values("task_id", "task_name", "exception", "traceback", "retries", "failed_at", "resolved")[:limit]
        )
    except Exception as exc:
        return [], {}, [f"FailedTaskRecord unavailable: {exc.__class__.__name__}"]

    grouped: dict[tuple[str, str, str], dict[str, Any]] = {}
    for row in rows:
        task_name = str(row.get("task_name") or "unknown")
        queue, queue_source, queue_confidence = _task_route_queue(task_name)
        error_signature = _runtime_error_signature(str(row.get("exception") or ""))
        key = ("FailedTaskRecord", task_name, error_signature)
        bucket = grouped.setdefault(
            key,
            {
                "source": "FailedTaskRecord",
                "task_name": task_name,
                "queue": queue,
                "queue_source": queue_source,
                "queue_confidence": queue_confidence,
                "worker": _task_worker_for_queue(queue),
                "exception_type": error_signature.split(":", 1)[0],
                "error_signature": error_signature,
                "failed_count": 0,
                "retries": 0,
                "max_retries": 0,
                "is_exhausted": False,
                "first_seen_at": None,
                "last_seen_at": None,
                "related_object_type": "celery_task",
                "related_object_id": str(row.get("task_id") or ""),
                "sanitized_summary": error_signature,
                "action_links": {"task": "/monitoring/messages?tab=failed_tasks"},
            },
        )
        bucket["failed_count"] += 1
        bucket["retries"] = max(_safe_int(bucket.get("retries")), _safe_int(row.get("retries")))
        bucket["max_retries"] = bucket["retries"]
        bucket["is_exhausted"] = True
        failed_at = row.get("failed_at")
        if failed_at and (not bucket["first_seen_at"] or failed_at < bucket["first_seen_at"]):
            bucket["first_seen_at"] = failed_at
        if failed_at and (not bucket["last_seen_at"] or failed_at > bucket["last_seen_at"]):
            bucket["last_seen_at"] = failed_at
        if queue != "unknown":
            per_queue[queue] = per_queue.get(queue, 0) + 1

    for item in grouped.values():
        item["first_seen_at"] = _serialize_dt(item.get("first_seen_at"))
        item["last_seen_at"] = _serialize_dt(item.get("last_seen_at"))
        samples.append(item)

    return samples, per_queue, errors


def _runtime_worker_snapshot(request=None) -> tuple[dict[str, Any] | None, list[str]]:
    return _runtime_safe("celery inspect", lambda: _celery_worker_snapshot(request))


def _runtime_worker_items(request=None) -> tuple[list[dict[str, Any]], list[str]]:
    queues, workers_registry, _beats, _tasks = _runtime_registries()
    snapshot, errors = _runtime_worker_snapshot(request)
    snapshot_workers = (snapshot or {}).get("workers") or []
    items: list[dict[str, Any]] = []

    for worker_name, meta in workers_registry.items():
        expected_queues = list(meta.get("queues") or [])
        matched = [
            row for row in snapshot_workers
            if worker_name.replace("worker-", "") in str(row.get("worker_name") or "")
        ]
        actual_queues = sorted({queue for row in matched for queue in (row.get("queues") or [])})
        if snapshot is None:
            status, abnormal_type, diagnosis = "unavailable", "inspect_unavailable", "Celery inspect 数据源不可用。"
            actual_queues_value = None
        elif not matched:
            status, abnormal_type, diagnosis = "critical", "worker_offline", "Worker 当前离线或未被 inspect 发现。"
            actual_queues_value = []
        elif not actual_queues:
            status, abnormal_type, diagnosis = "unavailable", "actual_queues_unavailable", "Worker 在线，但实际消费队列不可用。"
            actual_queues_value = None
        elif set(actual_queues) != set(expected_queues):
            status, abnormal_type, diagnosis = "critical", "worker_binding_mismatch", "实际消费队列与 Runtime Registry 不一致。"
            actual_queues_value = actual_queues
        else:
            status, abnormal_type, diagnosis = "healthy", "none", "Worker 消费队列符合 Runtime Registry。"
            actual_queues_value = actual_queues

        if worker_name == "worker-heavy" and actual_queues and any(q in actual_queues for q in ["rag_indexing", "doc_merge"]):
            status, abnormal_type, diagnosis = "critical", "worker_binding_mismatch", "worker-heavy 不应消费数据 AI 队列。"
        if worker_name == "worker-default" and actual_queues and "realtime_delivery" in actual_queues:
            status, abnormal_type, diagnosis = "critical", "worker_binding_mismatch", "worker-default 不应消费 realtime_delivery。"

        active = sum(_safe_int(row.get("active_tasks")) for row in matched)
        reserved = sum(_safe_int(row.get("reserved_tasks")) for row in matched)
        scheduled = sum(_safe_int(row.get("scheduled_tasks")) for row in matched)
        items.append(
            {
                "worker_name": worker_name,
                "display_name": meta.get("display_name") or worker_name,
                "pod_names": [row.get("worker_name") for row in matched],
                "expected_queues": expected_queues,
                "actual_queues": actual_queues_value,
                "online": bool(matched),
                "concurrency": max((_safe_int(row.get("concurrency")) for row in matched), default=0),
                "active": active,
                "reserved": reserved,
                "scheduled": scheduled,
                "last_heartbeat": None,
                "restart_count": None,
                "status": status,
                "abnormal_type": abnormal_type,
                "diagnosis": diagnosis,
                "evidence": {
                    "inspect_timeout_ms": (snapshot or {}).get("inspect_timeout_ms"),
                    "expected_queues": expected_queues,
                    "actual_queues": actual_queues_value,
                    "registry_notes": meta.get("notes") or "",
                },
            }
        )
    return items, errors


def _runtime_queue_items(request=None) -> tuple[list[dict[str, Any]], list[str]]:
    queue_registry, _workers_registry, _beats, _tasks = _runtime_registries()
    queue_names = list(queue_registry.keys())
    lengths, length_errors = _runtime_queue_lengths(queue_names)
    worker_items, worker_errors = _runtime_worker_items(request)
    failed_samples, per_queue_failures, failed_errors = _runtime_failed_samples()
    errors = length_errors + worker_errors + failed_errors
    worker_by_queue: dict[str, list[str]] = {}
    active_by_queue: dict[str, int] = {}
    reserved_by_queue: dict[str, int] = {}
    scheduled_by_queue: dict[str, int] = {}
    for worker in worker_items:
        for queue in worker.get("actual_queues") or []:
            worker_by_queue.setdefault(queue, []).append(str(worker["worker_name"]))
            active_by_queue[queue] = active_by_queue.get(queue, 0) + _safe_int(worker.get("active"))
            reserved_by_queue[queue] = reserved_by_queue.get(queue, 0) + _safe_int(worker.get("reserved"))
            scheduled_by_queue[queue] = scheduled_by_queue.get(queue, 0) + _safe_int(worker.get("scheduled"))

    items: list[dict[str, Any]] = []
    for queue_name, meta in queue_registry.items():
        expected_workers = list(meta.get("expected_workers") or [])
        expected_worker = expected_workers[0] if expected_workers else ""
        actual_workers = sorted(worker_by_queue.get(queue_name, []))
        backlog = lengths.get(queue_name)
        active = active_by_queue.get(queue_name, 0)
        reserved = reserved_by_queue.get(queue_name, 0)
        scheduled = scheduled_by_queue.get(queue_name, 0)
        failed_count = per_queue_failures.get(queue_name, 0)
        status, abnormal_type, diagnosis = _runtime_queue_diagnosis(
            backlog=backlog,
            consumer_count=len(actual_workers),
            active=active,
            failed_sample_count=failed_count,
            dlq_count=0,
            terminal_failed_count=0,
            expected_worker=expected_worker,
            actual_workers=None if worker_errors else actual_workers,
        )
        item = {
            "queue_name": queue_name,
            "display_name": meta.get("display_name") or queue_name,
            "description": meta.get("description") or "",
            "domain": meta.get("domain") or "",
            "expected_worker": expected_worker,
            "expected_workers": expected_workers,
            "actual_workers": actual_workers if not worker_errors else None,
            "consumer_count": len(actual_workers) if not worker_errors else None,
            "backlog": backlog,
            "active": active if not worker_errors else None,
            "reserved": reserved if not worker_errors else None,
            "scheduled": scheduled if not worker_errors else None,
            "failed_sample_count": failed_count,
            "dlq_count": 0,
            "terminal_failed_count": 0,
            "oldest_pending_age": None,
            "status": status,
            "abnormal_type": abnormal_type,
            "diagnosis": diagnosis,
            "evidence": {
                "latency_target_seconds": meta.get("latency_target_seconds"),
                "allow_backlog": meta.get("allow_backlog"),
                "registry_notes": meta.get("notes") or "",
                "metric_sources": ["redis_llen", "celery_inspect", "failed_task_route_inference"],
            },
            **_runtime_base_actions(),
            "related_links": {
                "worker": f"/monitoring/consumers?worker={expected_worker}",
                "failed_samples": f"/monitoring/messages?tab=failed_tasks&queue={queue_name}",
                "outbox": f"/monitoring/messages?tab=outbox&queue={queue_name}",
            },
        }
        items.append(item)
    return items, errors


def _runtime_beat_items() -> tuple[list[dict[str, Any]], list[str]]:
    _queues, _workers, beat_registry, _tasks = _runtime_registries()
    periodic_by_name: dict[str, Any] = {}
    errors: list[str] = []
    try:
        from django_celery_beat.models import PeriodicTask

        tasks = PeriodicTask.objects.filter(name__in=list(beat_registry.keys())).select_related(
            "interval", "crontab", "solar", "clocked"
        )
        periodic_by_name = {task.name: task for task in tasks}
    except Exception as exc:
        errors.append(f"django_celery_beat unavailable: {exc.__class__.__name__}")

    items: list[dict[str, Any]] = []
    for beat_key, meta in beat_registry.items():
        task = periodic_by_name.get(beat_key)
        enabled = bool(getattr(task, "enabled", False)) if task else False
        next_run = _next_run_estimate(task) if task else {"next_run_at": None, "reason": "periodic_task_missing"}
        status = "healthy"
        abnormal_type = "none"
        diagnosis = "Runtime Beat 已登记并可观察。"
        if errors:
            status, abnormal_type, diagnosis = "partial", "beat_runtime_unavailable", "无法读取 django-celery-beat 运行态，仅展示 registry。"
        elif not task:
            status, abnormal_type, diagnosis = "partial", "periodic_task_missing", "未查到 PeriodicTask，展示 registry 基础信息。"
        elif not enabled:
            status, abnormal_type, diagnosis = "warning", "beat_disabled", "Runtime Beat 已登记但当前 disabled。"
        items.append(
            {
                "beat_key": beat_key,
                "display_name": meta.get("display_name") or beat_key,
                "task": meta.get("task") or "",
                "queue": meta.get("queue") or "",
                "schedule": meta.get("schedule_seconds") or meta.get("crontab") or "",
                "role": meta.get("role") or "",
                "is_main_path": bool(meta.get("is_main_path")),
                "enabled": enabled,
                "last_run_at": _serialize_dt(getattr(task, "last_run_at", None)) if task else None,
                "next_run_at": next_run.get("next_run_at"),
                "expires_seconds": meta.get("expires_seconds"),
                "status": status,
                "abnormal_type": abnormal_type,
                "diagnosis": diagnosis,
                "evidence": {
                    "registry_notes": meta.get("notes") or "",
                    "next_run_reason": next_run.get("reason"),
                    "periodic_task_found": bool(task),
                },
            }
        )
    return items, errors


class _RuntimeOutboxAdapter:
    source = "unknown"
    display_name = "Unknown"
    related_queue = "unknown"

    def collect(self) -> dict[str, Any]:
        raise NotImplementedError

    def item(self) -> dict[str, Any]:
        try:
            data = self.collect()
            error = ""
        except Exception as exc:  # pragma: no cover - defensive adapter boundary
            data = {}
            error = f"{self.source} unavailable: {exc.__class__.__name__}"
        pending = _safe_int(data.get("pending_count"))
        processing = _safe_int(data.get("processing_count"))
        failed = _safe_int(data.get("failed_count"))
        terminal = _safe_int(data.get("terminal_failed_count"))
        dlq = _safe_int(data.get("dlq_count"))
        status = "healthy"
        diagnosis = "业务消息队列暂无明显异常。"
        if error:
            status, diagnosis = "partial", "数据源不可用，仅保留占位。"
        elif terminal or dlq:
            status, diagnosis = "critical", "存在终态失败或 DLQ，需要人工排查。"
        elif failed:
            status, diagnosis = "warning", "存在失败样本，需要查看错误签名。"
        elif pending or processing:
            status, diagnosis = "warning", "存在待处理或处理中业务消息。"
        diagnosis = data.get("diagnosis") or diagnosis
        return {
            "source": self.source,
            "display_name": self.display_name,
            "related_queue": self.related_queue,
            "related_worker": _task_worker_for_queue(self.related_queue),
            "pending_count": pending,
            "processing_count": processing,
            "succeeded_count": _safe_int(data.get("succeeded_count")),
            "failed_count": failed,
            "terminal_failed_count": terminal,
            "retryable_count": _safe_int(data.get("retryable_count")),
            "dlq_count": dlq,
            "oldest_pending_age": data.get("oldest_pending_age"),
            "oldest_failed_age": data.get("oldest_failed_age"),
            "status": status,
            "diagnosis": diagnosis,
            "top_samples": data.get("top_samples") or [],
            "errors": [error] if error else [],
        }


class ChannelOutboxAdapter(_RuntimeOutboxAdapter):
    source = "channel_outbox"
    display_name = "Channel Outbox"
    related_queue = "realtime_delivery"

    def collect(self) -> dict[str, Any]:
        from apps.channel_gateway.models import ChannelOutboundMessageRecord

        qs = ChannelOutboundMessageRecord.objects.all()
        oldest_pending = qs.filter(status__in=["pending", "dispatched"]).order_by("created_at").values("created_at").first()
        oldest_failed = qs.filter(status="failed").order_by("updated_at").values("updated_at").first()
        return {
            "pending_count": qs.filter(status="pending").count(),
            "processing_count": qs.filter(status="dispatched").count(),
            "succeeded_count": qs.filter(status="sent").count(),
            "failed_count": qs.filter(status="failed").count(),
            "terminal_failed_count": qs.filter(status="failed", attempts__gte=3).count(),
            "retryable_count": qs.filter(status="failed", attempts__lt=_channel_outbox_max_attempts()).count(),
            "oldest_pending_age": _runtime_seconds_since((oldest_pending or {}).get("created_at")),
            "oldest_failed_age": _runtime_seconds_since((oldest_failed or {}).get("updated_at")),
            "top_samples": list(qs.filter(status="failed").order_by("-updated_at").values("id", "channel", "attempts")[:5]),
        }


class RagEmbeddingTaskAdapter(_RuntimeOutboxAdapter):
    source = "rag_embedding_task"
    display_name = "RAG Embedding Task"
    related_queue = "rag_indexing"

    def collect(self) -> dict[str, Any]:
        from apps.rag.models import EmbeddingTask
        from apps.maintenance.runtime_rag_terminal import (
            error_signature_for_message,
            scene_key_for_embedding_task,
            task_name_for_embedding_task,
            unresolved_rag_terminal_queryset,
        )

        qs = EmbeddingTask.objects.all()
        terminal_qs = unresolved_rag_terminal_queryset()
        oldest_pending = qs.filter(status="pending").order_by("created_at").values("created_at").first()
        oldest_failed = terminal_qs.order_by("completed_at", "created_at").values("completed_at", "created_at").first()
        top_tasks = list(terminal_qs.order_by("-created_at")[:5])
        return {
            "pending_count": qs.filter(status="pending").count(),
            "processing_count": qs.filter(status="processing").count(),
            "succeeded_count": qs.filter(status="success").count(),
            "failed_count": terminal_qs.filter(status="failed").count(),
            "terminal_failed_count": terminal_qs.count(),
            "retryable_count": qs.filter(status="pending").count(),
            "oldest_pending_age": _runtime_seconds_since((oldest_pending or {}).get("created_at")),
            "oldest_failed_age": _runtime_seconds_since((oldest_failed or {}).get("completed_at") or (oldest_failed or {}).get("created_at")),
            "top_samples": [
                {
                    "id": str(task.id),
                    "task_type": task.task_type,
                    "target_id": str(task.target_id),
                    "retry_count": task.retry_count,
                    "task_name": task_name_for_embedding_task(task),
                    "scene_key": scene_key_for_embedding_task(task),
                    "error_signature": error_signature_for_message(task.error_message),
                }
                for task in top_tasks
            ],
            "diagnosis": "历史 RAG terminal failed 可通过 ops_rag_terminal_failed_report / resolve 管理命令清理；禁止在页面直接批量 retry。",
        }


class FtsOutboxAdapter(_RuntimeOutboxAdapter):
    source = "fts_outbox"
    display_name = "FTS Outbox"
    related_queue = "search_indexing"

    def collect(self) -> dict[str, Any]:
        models = [("default", FtsOutbox), ("postgresql", FtsOutboxPg)]
        pending = processing = succeeded = failed = retryable = 0
        oldest_pending_age = None
        oldest_failed_age = None
        samples: list[dict[str, Any]] = []
        for db, model in models:
            qs = model.objects.all()
            pending += qs.filter(processed_at__isnull=True, retry_count=0, last_error="").count()
            retrying_qs = qs.filter(processed_at__isnull=True).filter(Q(retry_count__gt=0) | Q(last_error__gt=""))
            failed_qs = qs.filter(processed_at__isnull=True, retry_count__gt=0, last_error__gt="")
            processing += retrying_qs.exclude(retry_count__gt=0, last_error__gt="").count()
            failed += failed_qs.count()
            retryable += retrying_qs.count()
            succeeded += qs.filter(processed_at__isnull=False).count()
            oldest_pending = qs.filter(processed_at__isnull=True).order_by("created_at").values("created_at").first()
            oldest_failed = failed_qs.order_by("created_at").values("created_at").first()
            pending_age = _runtime_seconds_since((oldest_pending or {}).get("created_at"))
            failed_age = _runtime_seconds_since((oldest_failed or {}).get("created_at"))
            oldest_pending_age = pending_age if oldest_pending_age is None else min(oldest_pending_age, pending_age or oldest_pending_age)
            oldest_failed_age = failed_age if oldest_failed_age is None else min(oldest_failed_age, failed_age or oldest_failed_age)
            samples.extend([
                {**row, "db": db}
                for row in failed_qs.order_by("-id").values("id", "index_name", "doc_id", "retry_count")[:3]
            ])
        return {
            "pending_count": pending,
            "processing_count": processing,
            "succeeded_count": succeeded,
            "failed_count": failed,
            "terminal_failed_count": failed,
            "retryable_count": retryable,
            "oldest_pending_age": oldest_pending_age,
            "oldest_failed_age": oldest_failed_age,
            "top_samples": samples[:5],
        }


class DocUpdateAdapter(_RuntimeOutboxAdapter):
    source = "tabdoc_doc_update"
    display_name = "TabDoc DocUpdate"
    related_queue = "doc_merge"

    def collect(self) -> dict[str, Any]:
        from apps.tabdoc.models import DocUpdate

        qs = DocUpdate.objects.all()
        oldest = qs.order_by("created_at").values("created_at").first()
        return {
            "pending_count": qs.count(),
            "processing_count": 0,
            "succeeded_count": 0,
            "failed_count": 0,
            "terminal_failed_count": 0,
            "retryable_count": qs.count(),
            "oldest_pending_age": _runtime_seconds_since((oldest or {}).get("created_at")),
            "top_samples": list(qs.order_by("-created_at").values("id", "document_id", "editor_type", "created_at")[:5]),
        }


def _runtime_outbox_items() -> list[dict[str, Any]]:
    return [
        ChannelOutboxAdapter().item(),
        RagEmbeddingTaskAdapter().item(),
        FtsOutboxAdapter().item(),
        DocUpdateAdapter().item(),
    ]


def _runtime_phase2_item(key: str, label: str) -> dict[str, Any]:
    return {
        "source": key,
        "label": "Phase 2",
        "display_name": label,
        "status": "unsupported",
        "diagnosis": "未接入 runtime snapshot/event sample",
        "core_runtime": False,
    }

def _metric_sum(series: dict[str, Any], *needles: str) -> float:
    total = 0.0
    lowered = [needle.lower() for needle in needles]
    for key, value in series.items():
        normalized_key = str(key).lower()
        if all(needle in normalized_key for needle in lowered):
            try:
                total += float(value or 0)
            except (TypeError, ValueError):
                continue
    return total


def _readonly_lookup_payload(kind: str, identifiers: dict[str, str], *, status_reason: str) -> dict[str, Any]:
    clean_identifiers = {
        key: _mask_text(value.strip()) for key, value in identifiers.items() if str(value or "").strip()
    }
    return {
        "kind": kind,
        "status": "unknown" if clean_identifiers else "not_requested",
        "status_reason": status_reason if clean_identifiers else "lookup_not_requested",
        "identifiers": clean_identifiers,
        "is_online": None,
        "connection_id": clean_identifiers.get("connection_id", ""),
        "instance": "",
        "connected_at": None,
        "last_seen_at": None,
        "reconnect_count_30m": None,
        "disconnect_count_30m": None,
        "last_disconnect_reason": "",
        "auth_status": "unknown",
        "client_version": "",
        "ip_masked": "",
        "latest_error": "",
    }


def _values_page(qs, *, page_size: int):
    rows = list(qs[: page_size + 1])
    return rows[:page_size], len(rows) > page_size


def _serialize_dt(value) -> str | None:
    return value.isoformat() if value else None


def _sensitive_filter_used(*values: str | None) -> bool:
    return any(str(value or "").strip() for value in values)


def _require_sensitive_query_context(
    request,
    *,
    query_type: str,
    reason: str,
    ticket_id: str,
    time_range_start,
    time_range_end,
    target_user_id: str = "",
    target_organization_id: str = "",
    target_entity_type: str = "",
    target_entity_id: str = "",
) -> tuple[str, str]:
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _audit_query(
        request,
        query_type=query_type,
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=time_range_start,
        time_range_end=time_range_end,
        target_user_id=target_user_id,
        target_organization_id=target_organization_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
    )
    return reason, ticket_id


def _sample_status(rows: list[dict[str, Any]], *, success_values: set[str]) -> dict[str, Any]:
    total = len(rows)
    if total == 0:
        return {"sample_size": 0, "success_rate": None, "error_rate": None}
    success = sum(1 for row in rows if str(row.get("status") or "").lower() in success_values)
    failed = total - success
    return {
        "sample_size": total,
        "success_rate": round(success / total * 100, 2),
        "error_rate": round(failed / total * 100, 2),
    }


def _p95(values: list[int | float | None]) -> int | float | None:
    cleaned = sorted(value for value in values if value is not None)
    if not cleaned:
        return None
    index = min(len(cleaned) - 1, int(len(cleaned) * 0.95))
    return cleaned[index]


def _health_from_sample(sample: dict[str, Any]) -> str:
    if sample.get("sample_size", 0) == 0:
        return "unknown"
    error_rate = sample.get("error_rate")
    if error_rate is None:
        return "unknown"
    if error_rate >= 50:
        return "critical"
    if error_rate >= 10:
        return "degraded"
    return "ok"


def _parse_json_summary(raw: str | None, fallback):
    if not raw:
        return fallback
    try:
        return _mask(json.loads(raw))
    except (TypeError, ValueError):
        return _mask_text(str(raw)[:500])


def _fts_normalize_db(db: str, *, allow_all: bool = False) -> str:
    normalized = str(db or "").strip().lower()
    if normalized == "pg":
        normalized = "postgresql"
    allowed = {"default", "postgresql"}
    if allow_all:
        allowed.add("all")
    if normalized not in allowed:
        expected = "default|postgresql|all" if allow_all else "default|postgresql"
        raise HttpError(400, f"db must be {expected}")
    return normalized


def _fts_db_models(db: str) -> list[tuple[str, type]]:
    normalized = _fts_normalize_db(db, allow_all=True)
    if normalized == "all":
        return [("default", FtsOutbox), ("postgresql", FtsOutboxPg)]
    return [(normalized, FtsOutbox if normalized == "default" else FtsOutboxPg)]


def _fts_row_status(row: dict[str, Any], *, now=None) -> dict[str, str]:
    processed_at = row.get("processed_at")
    retry_count = _safe_int(row.get("retry_count"))
    last_error = str(row.get("last_error") or "").strip()
    created_at = row.get("created_at")
    age = None
    if created_at:
        try:
            age = int(((now or timezone.now()) - created_at).total_seconds())
        except (TypeError, ValueError):
            age = None
    if processed_at:
        return {
            "status": FtsOutboxStatus.PROCESSED,
            "status_label": "已处理",
            "status_reason": "processed_at is not null",
            "diagnosis": "该 outbox 已处理完成。",
        }
    if retry_count > 0 and last_error:
        return {
            "status": FtsOutboxStatus.FAILED,
            "status_label": "失败",
            "status_reason": f"该 outbox 已重试 {retry_count} 次且仍未处理完成",
            "diagnosis": "疑似程序错误、mapping 错误或单文档数据问题。",
        }
    if retry_count > 0 or last_error:
        return {
            "status": FtsOutboxStatus.RETRYING,
            "status_label": "重试中",
            "status_reason": "该 outbox 有重试或错误摘要，但错误信息不完整",
            "diagnosis": "需要继续观察下一轮 flush 是否恢复。",
        }
    if age is not None and age > FTS_OLD_PENDING_THRESHOLD_SECONDS:
        return {
            "status": FtsOutboxStatus.OLD_PENDING,
            "status_label": "等待过久",
            "status_reason": f"pending 超过 {FTS_OLD_PENDING_THRESHOLD_SECONDS} 秒仍未处理",
            "diagnosis": "疑似同步停滞或 search_indexing worker 消费不及时。",
        }
    return {
        "status": FtsOutboxStatus.PENDING,
        "status_label": "等待中",
        "status_reason": "该 outbox 尚未处理，且未超过等待阈值",
        "diagnosis": "当前更像正常积压或刚入队任务。",
    }


def _fts_group_status(row: dict[str, Any]) -> dict[str, str]:
    pending_count = _safe_int(row.get("pending_count"))
    failed_count = _safe_int(row.get("failed_count"))
    oldest_age = row.get("oldest_pending_age_seconds")
    max_retry_count = _safe_int(row.get("max_retry_count") or row.get("retry_count_max"))
    latest_error = str(row.get("latest_error_masked") or "").strip()
    repeated_doc = bool(row.get("repeated_doc_problem"))
    if repeated_doc:
        return {
            "status": "data_problem",
            "status_label": "数据问题",
            "exception_classification": "数据问题",
            "status_reason": "同一 doc_id 出现多次 pending/failed 或 retry_count 较高",
        }
    if failed_count > 0 and (latest_error or max_retry_count >= 3):
        return {
            "status": "program_error",
            "status_label": "程序错误",
            "exception_classification": "程序错误",
            "status_reason": "同一 index/action 存在 failed outbox，且错误摘要或 max retry_count 指向程序异常",
        }
    if pending_count > 0 and oldest_age is not None and oldest_age > FTS_OLD_PENDING_THRESHOLD_SECONDS:
        return {
            "status": "needs_attention",
            "status_label": "需要关注",
            "exception_classification": "同步停滞",
            "status_reason": f"最老 pending 已超过 {FTS_OLD_PENDING_THRESHOLD_SECONDS} 秒",
        }
    if pending_count > 0 and failed_count == 0:
        return {
            "status": "normal_backlog",
            "status_label": "正常积压",
            "exception_classification": "正常积压",
            "status_reason": "存在 pending outbox，但最老等待未超过阈值且没有失败样本",
        }
    if pending_count == 0 and failed_count == 0:
        return {
            "status": "normal",
            "status_label": "正常",
            "exception_classification": "正常",
            "status_reason": "该 index/action 在当前时间范围内没有 pending 或 failed",
        }
    return {
        "status": FtsOutboxStatus.UNKNOWN,
        "status_label": "未知",
        "exception_classification": "指标不足",
        "status_reason": "数据不足，无法判断 FTS outbox 状态",
    }


def _fts_current_actions() -> list[str]:
    return ["刷新", "查看样本", "复制排障信息"]


def _fts_p15_actions() -> list[str]:
    return ["单行 dry-run requeue", "单行 requeue", "mark terminal / ignored"]


def _fts_forbidden_actions() -> list[str]:
    return ["全量 reindex", "批量 requeue", "批量 delete", "mark processed"]


def _fts_outbox_impact() -> str:
    return "可能影响搜索结果、知识库召回或 AI 回答引用。"


def _fts_mask_error(value: Any) -> str:
    return _mask_text(str(value or "")[:FTS_ERROR_PREVIEW_MAX_CHARS])


def _with_workteam_alias(row: dict[str, Any]) -> dict[str, Any]:
    """ORM 使用 organization_id；对 AdminDash 暂保留 workteam_id 响应兼容字段。"""
    if "workteam_id" not in row and "organization_id" in row:
        row["workteam_id"] = row.get("organization_id") or ""
    return row


def _with_workteam_aliases(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [_with_workteam_alias(row) for row in rows]


def _fts_base_queryset(model, *, start, end, index_name: str = "", action: str = "", workteam_id: str = ""):
    qs = model.objects.filter(created_at__gte=start, created_at__lt=end)
    if index_name:
        qs = qs.filter(index_name=index_name.strip()[: FtsOutbox.INDEX_NAME_MAX_LEN])
    if action:
        qs = qs.filter(action=action.strip()[: FtsOutbox.ACTION_MAX_LEN])
    if workteam_id:
        qs = qs.filter(organization_id=workteam_id.strip()[: FtsOutbox.ORGANIZATION_ID_MAX_LEN])
    return qs


def _fts_apply_row_status_filter(qs, status: str, *, now=None):
    normalized = str(status or "pending").strip().lower()
    if normalized == "all":
        return qs
    if normalized == FtsOutboxStatus.PENDING:
        threshold = (now or timezone.now()) - timedelta(seconds=FTS_OLD_PENDING_THRESHOLD_SECONDS)
        return qs.filter(
            processed_at__isnull=True,
            retry_count=0,
            last_error="",
            created_at__gte=threshold,
        )
    if normalized == FtsOutboxStatus.OLD_PENDING:
        threshold = (now or timezone.now()) - timedelta(seconds=FTS_OLD_PENDING_THRESHOLD_SECONDS)
        return qs.filter(
            processed_at__isnull=True,
            retry_count=0,
            last_error="",
            created_at__lt=threshold,
        )
    if normalized == FtsOutboxStatus.PROCESSED:
        return qs.filter(processed_at__isnull=False)
    if normalized == FtsOutboxStatus.FAILED:
        return qs.filter(processed_at__isnull=True, retry_count__gt=0, last_error__gt="")
    if normalized == FtsOutboxStatus.RETRYING:
        return qs.filter(processed_at__isnull=True).filter(Q(retry_count__gt=0) | Q(last_error__gt="")).exclude(
            retry_count__gt=0,
            last_error__gt="",
        )
    raise HttpError(400, "status must be pending|failed|processed|old_pending|all")


def _fts_values_row(row: dict[str, Any], *, db: str, now=None) -> dict[str, Any]:
    status = _fts_row_status(row, now=now)
    item = {
        "id": row.get("id"),
        "db": db,
        "index_name": row.get("index_name") or "",
        "doc_id": _mask_text(str(row.get("doc_id") or "")),
        "action": row.get("action") or "",
        "workteam_id": str(row.get("organization_id") or row.get("workteam_id") or ""),
        "created_at": row.get("created_at"),
        "processed_at": row.get("processed_at"),
        "retry_count": _safe_int(row.get("retry_count")),
        "last_error_masked": _fts_mask_error(row.get("last_error")),
        "impact": _fts_outbox_impact(),
        "current_actions": _fts_current_actions(),
        "p15_actions": _fts_p15_actions(),
        "forbidden_actions": _fts_forbidden_actions(),
    }
    item.update(status)
    return item


def _fts_audit_if_sensitive(
    request,
    *,
    reason: str,
    ticket_id: str,
    start,
    end,
    workteam_id: str = "",
    doc_id: str = "",
    row: dict[str, Any] | None = None,
) -> None:
    row = row or {}
    target_workteam_id = workteam_id or str(row.get("organization_id") or row.get("workteam_id") or "")
    target_doc_id = doc_id or str(row.get("doc_id") or "")
    if not target_workteam_id and not target_doc_id:
        return
    target_entity_type = "doc" if target_doc_id else "workteam"
    target_entity_id = target_doc_id or target_workteam_id
    _require_sensitive_query_context(
        request,
        query_type="fts_outbox_diagnose",
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=start,
        time_range_end=end,
        target_organization_id=target_workteam_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
    )


def _schedule_kind(task) -> str:
    if getattr(task, "interval_id", None) or getattr(task, "interval", None):
        return "interval"
    if getattr(task, "crontab_id", None) or getattr(task, "crontab", None):
        return "crontab"
    if getattr(task, "solar_id", None) or getattr(task, "solar", None):
        return "solar"
    if getattr(task, "clocked_id", None) or getattr(task, "clocked", None):
        return "clocked"
    return "unknown"


def _interval_delta(interval) -> timedelta | None:
    if not interval:
        return None
    every = int(getattr(interval, "every", 0) or 0)
    period = str(getattr(interval, "period", "") or "")
    if every <= 0:
        return None
    if period == "days":
        return timedelta(days=every)
    if period == "hours":
        return timedelta(hours=every)
    if period == "minutes":
        return timedelta(minutes=every)
    if period == "seconds":
        return timedelta(seconds=every)
    if period == "microseconds":
        return timedelta(microseconds=every)
    return None


def _schedule_display(task) -> str:
    kind = _schedule_kind(task)
    if kind == "interval":
        interval = getattr(task, "interval", None)
        return f"every {getattr(interval, 'every', '?')} {getattr(interval, 'period', '')}".strip()
    if kind == "crontab":
        cron = getattr(task, "crontab", None)
        return " ".join([
            str(getattr(cron, "minute", "*")),
            str(getattr(cron, "hour", "*")),
            str(getattr(cron, "day_of_month", "*")),
            str(getattr(cron, "month_of_year", "*")),
            str(getattr(cron, "day_of_week", "*")),
        ])
    if kind == "solar":
        solar = getattr(task, "solar", None)
        return f"{getattr(solar, 'event', 'solar')} @ {getattr(solar, 'latitude', '?')},{getattr(solar, 'longitude', '?')}"
    if kind == "clocked":
        clocked = getattr(task, "clocked", None)
        return f"clocked {getattr(clocked, 'clocked_time', '')}".strip()
    return "unknown"


def _object_display(value) -> str | None:
    return str(value) if value is not None else None


def _next_run_estimate(task) -> dict[str, str | None]:
    if not getattr(task, "enabled", False):
        return {"next_run_at": None, "reason": "disabled"}
    kind = _schedule_kind(task)
    last_run_at = getattr(task, "last_run_at", None)
    if kind == "interval":
        delta = _interval_delta(getattr(task, "interval", None))
        if not delta:
            return {"next_run_at": None, "reason": "unknown_interval"}
        base = last_run_at or getattr(task, "start_time", None) or timezone.now()
        next_run_at = base + delta
        if next_run_at < timezone.now():
            next_run_at = timezone.now()
        return {"next_run_at": _serialize_dt(next_run_at), "reason": None}
    if kind == "crontab":
        cron = getattr(task, "crontab", None)
        try:
            from celery.schedules import crontab

            schedule = crontab(
                minute=getattr(cron, "minute", "*"),
                hour=getattr(cron, "hour", "*"),
                day_of_week=getattr(cron, "day_of_week", "*"),
                day_of_month=getattr(cron, "day_of_month", "*"),
                month_of_year=getattr(cron, "month_of_year", "*"),
                nowfun=timezone.now,
            )
            remaining = schedule.remaining_estimate(last_run_at or timezone.now())
            next_run_at = timezone.now() + max(remaining, timedelta())
            return {"next_run_at": _serialize_dt(next_run_at), "reason": None}
        except Exception:
            return {"next_run_at": None, "reason": "unknown_crontab"}
    return {"next_run_at": None, "reason": "unsupported_schedule"}


def _resolve_task_queue(task) -> str:
    explicit_queue = str(getattr(task, "queue", "") or "").strip()
    if explicit_queue:
        return explicit_queue
    route = getattr(current_app.conf, "task_routes", None)
    task_name = str(getattr(task, "task", "") or "")
    if isinstance(route, dict):
        value = route.get(task_name)
        if isinstance(value, dict) and value.get("queue"):
            return str(value["queue"])
        if isinstance(value, str):
            return value
    return str(getattr(current_app.conf, "task_default_queue", "") or "default")


def _resolve_task_name_queue(task_name: str) -> tuple[str | None, str, str]:
    name = str(task_name or "").strip()
    if not name:
        return None, "global_only", "unknown"
    route = getattr(current_app.conf, "task_routes", None)
    if isinstance(route, dict):
        value = route.get(name)
        if isinstance(value, dict) and value.get("queue"):
            return str(value["queue"]), "queue_mapped", "Celery task_routes"
        if isinstance(value, str):
            return value, "queue_mapped", "Celery task_routes"
    registered_task = current_app.tasks.get(name)
    if registered_task is not None:
        explicit_queue = str(getattr(registered_task, "queue", "") or "").strip()
        if explicit_queue:
            return explicit_queue, "queue_mapped", "registered task queue"
        return str(getattr(current_app.conf, "task_default_queue", "") or "default"), "queue_mapped", "default queue"
    return None, "global_only", "unknown / global only"


def _queue_lengths_for(queues: list[str]) -> dict[str, Any]:
    import redis

    result: dict[str, Any] = {"status": "ok", "data": {}}
    selected = [queue for queue in dict.fromkeys(queues) if queue in OPS_KNOWN_CELERY_QUEUES]
    if not selected:
        return result
    try:
        r = redis.from_url(settings.CELERY_BROKER_URL, socket_timeout=0.5, socket_connect_timeout=0.5)
        result["data"] = {queue: int(r.llen(queue)) for queue in selected}
    except Exception as exc:
        result = {"status": "unknown", "error": f"redis unavailable: {exc.__class__.__name__}", "data": {}}
    return result


def _recent_failures_for(task_names: list[str], *, limit_per_task: int = 1) -> dict[str, list[dict[str, Any]]]:
    if not task_names:
        return {}
    start = timezone.now() - timedelta(hours=BEAT_FAILURE_LOOKBACK_HOURS)
    rows = list(
        FailedTaskRecord.objects.filter(task_name__in=task_names, failed_at__gte=start)
        .order_by("task_name", "-failed_at")
        .values("id", "task_id", "task_name", "exception", "retries", "failed_at", "resolved")[: MAX_PAGE_SIZE * 3]
    )
    grouped: dict[str, list[dict[str, Any]]] = {}
    for row in rows:
        bucket = grouped.setdefault(str(row.get("task_name") or ""), [])
        if len(bucket) >= limit_per_task:
            continue
        row["exception"] = _mask_text((row.get("exception") or "")[:500])
        bucket.append(row)
    return grouped


def _beat_status(task, queue_length: int | None, failures: list[dict[str, Any]]) -> dict[str, Any]:
    if not getattr(task, "enabled", False):
        return {"is_stale": False, "is_suspected_stuck": False, "status": "disabled", "reason": "disabled"}
    now = timezone.now()
    last_run_at = getattr(task, "last_run_at", None)
    kind = _schedule_kind(task)
    is_stale = False
    stale_reason = ""
    if kind == "interval":
        delta = _interval_delta(getattr(task, "interval", None))
        if delta and last_run_at:
            is_stale = now - last_run_at > delta * BEAT_STALE_MULTIPLIER
            stale_reason = "interval_threshold" if is_stale else ""
        elif not last_run_at:
            created_at = getattr(task, "date_changed", None) or getattr(task, "start_time", None)
            is_stale = bool(created_at and now - created_at > timedelta(hours=24))
            stale_reason = "never_ran" if is_stale else ""
    elif not last_run_at:
        created_at = getattr(task, "date_changed", None) or getattr(task, "start_time", None)
        is_stale = bool(created_at and now - created_at > timedelta(hours=24))
        stale_reason = "never_ran" if is_stale else "unsupported_stale_schedule"
    else:
        stale_reason = "unsupported_stale_schedule"

    has_backlog = bool(queue_length and queue_length > 0)
    is_suspected_stuck = bool(is_stale and has_backlog)
    status = "stuck" if is_suspected_stuck else "stale" if is_stale else "ok"
    return {
        "is_stale": is_stale,
        "is_suspected_stuck": is_suspected_stuck,
        "status": status,
        "reason": stale_reason,
    }


def _beat_task_row(task, queue_lengths: dict[str, int], failures_by_task: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    task_name = str(getattr(task, "task", "") or "")
    queue = _resolve_task_queue(task)
    failures = failures_by_task.get(task_name, [])
    queue_length = queue_lengths.get(queue)
    status = _beat_status(task, queue_length, failures)
    next_run = _next_run_estimate(task)
    last_failure = failures[0] if failures else {}
    now = timezone.now()
    next_run_at = _parse_dt(next_run["next_run_at"]) if next_run["next_run_at"] else None
    interval = _interval_delta(getattr(task, "interval", None))
    allowed_grace_seconds = int(interval.total_seconds() * max(BEAT_STALE_MULTIPLIER - 1, 1)) if interval else None
    overdue_seconds = int(max((now - next_run_at).total_seconds(), 0)) if next_run_at else None
    display_status = status["status"]
    display_reason = status["reason"]
    if failures:
        display_status = "warning"
        display_reason = "recent_failure"
    elif next_run["reason"]:
        display_status = "unknown"
        display_reason = next_run["reason"]
    return {
        "id": str(getattr(task, "id", "")),
        "name": getattr(task, "name", ""),
        "task": task_name,
        "enabled": bool(getattr(task, "enabled", False)),
        "schedule_type": _schedule_kind(task),
        "schedule_display": _schedule_display(task),
        "last_run_at": _serialize_dt(getattr(task, "last_run_at", None)),
        "next_run_at": next_run["next_run_at"],
        "next_run_reason": next_run["reason"],
        "generated_at": _serialize_dt(now),
        "overdue_seconds": overdue_seconds,
        "allowed_grace_seconds": allowed_grace_seconds,
        "total_run_count": int(getattr(task, "total_run_count", 0) or 0),
        "queue": queue,
        "queue_length": queue_length,
        "last_failure_at": _serialize_dt(last_failure.get("failed_at")),
        "last_error_masked": last_failure.get("exception", ""),
        "is_stale": status["is_stale"],
        "is_suspected_stuck": status["is_suspected_stuck"],
        "status": display_status,
        "status_reason": display_reason,
    }


def _beat_summary(rows: list[dict[str, Any]], queue_state: dict[str, Any]) -> dict[str, Any]:
    return {
        "enabled_tasks": sum(1 for row in rows if row["enabled"]),
        "disabled_tasks": sum(1 for row in rows if not row["enabled"]),
        "stale_tasks": sum(1 for row in rows if row["is_stale"]),
        "suspected_stuck_tasks": sum(1 for row in rows if row["is_suspected_stuck"]),
        "recent_failures": sum(1 for row in rows if row.get("last_failure_at")),
        "queue_backlog": queue_state,
        "scope": "current_page",
    }


@router.get("/ops/users/{user_id}/summary")
def user_summary(request, user_id: str, reason: str = "", ticket_id: str = ""):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["user_diagnose"])
    start, end = _parse_time_range(None, None)
    _audit_query(
        request,
        query_type="ops_user_summary",
        target_user_id=user_id,
        target_entity_type="user",
        target_entity_id=user_id,
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=start,
        time_range_end=end,
    )

    user = User.objects.filter(id=user_id).only(
        "id", "username", "email", "phone", "nickname", "is_active",
        "is_staff", "date_joined", "last_login",
    ).first()
    if not user:
        raise HttpError(404, "user not found")

    def organizations():
        from apps.tabtinspace.models import Organization, OrganizationMember

        return {
            "owned_count": Organization.objects.filter(owner_id=user_id).count(),
            "member_count": OrganizationMember.objects.filter(user_id=user_id).count(),
        }

    def sessions():
        from apps.users.auth.models import UserSession

        return {
            "active_count": UserSession.objects.filter(user_id=user_id, is_active=True).count(),
            "recent": list(
                UserSession.objects.filter(user_id=user_id)
                .order_by("-last_activity")
                .values("session_type", "ip_address", "last_activity", "expires_at", "is_active")[:5]
            ),
        }

    return _mask({
        "status": "ok",
        "user": {
            "id": str(user.id),
            "username": user.username,
            "display_name": user.get_display_name(),
            "email": user.email,
            "phone": user.phone,
            "is_active": user.is_active,
            "is_staff": user.is_staff,
            "date_joined": user.date_joined,
            "last_login": user.last_login,
        },
        "organizations": _safe_part("organizations", organizations),
        "sessions": _safe_part("sessions", sessions),
    })


@router.get("/ops/users/{user_id}/timeline")
def user_timeline(
    request,
    user_id: str,
    module: str = "auth",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["user_diagnose"])
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    cursor_dt = _parse_dt(cursor) if cursor else None
    _audit_query(
        request,
        query_type=f"ops_user_timeline:{module}",
        target_user_id=user_id,
        target_entity_type="user",
        target_entity_id=user_id,
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=start,
        time_range_end=end,
    )

    if module == "auth":
        from apps.users.auth.models import UserActionLog

        qs = UserActionLog.objects.filter(user_id=user_id, created_at__gte=start, created_at__lt=end)
        if cursor_dt:
            qs = qs.filter(created_at__lt=cursor_dt)
        qs = qs.order_by("-created_at").values(
            "id", "action_type", "description", "success", "error_message", "created_at"
        )
    elif module == "billing":
        from apps.services.billing.models import BillingUsageEvent

        qs = BillingUsageEvent.objects.filter(user_id=user_id, occurred_at__gte=start, occurred_at__lt=end)
        if cursor_dt:
            qs = qs.filter(occurred_at__lt=cursor_dt)
        qs = qs.order_by("-occurred_at").values(
            "id", "meter_key", "amount", "currency", "charge_status", "biz_type", "biz_id", "occurred_at"
        )
    elif module == "payment":
        from apps.services.payment.models import PaymentOrder

        qs = PaymentOrder.objects.filter(user_id=user_id, created_at__gte=start, created_at__lt=end)
        if cursor_dt:
            qs = qs.filter(created_at__lt=cursor_dt)
        qs = qs.order_by("-created_at").values(
            "id", "order_no", "order_type", "amount", "paid_amount", "status", "payment_method", "created_at", "paid_at"
        )
    elif module == "wallet":
        from apps.users.wallet.models import WalletTransaction

        qs = WalletTransaction.objects.filter(operator_user_id=user_id, created_at__gte=start, created_at__lt=end)
        if cursor_dt:
            qs = qs.filter(created_at__lt=cursor_dt)
        qs = qs.order_by("-created_at").values(
            "id", "transaction_type", "amount", "amount_precise", "organization_id", "related_order_id", "created_at"
        )
    else:
        raise HttpError(400, "unsupported module")

    rows, has_more = _values_page(qs, page_size=page_size)
    next_cursor = None
    if has_more and rows:
        ts = rows[-1].get("created_at") or rows[-1].get("occurred_at")
        next_cursor = _serialize_dt(ts)
    return _mask({"items": rows, "has_more": has_more, "next_cursor": next_cursor})


@router.get("/ops/finance/orders/{order_no}/trace")
def finance_order_trace(request, order_no: str, reason: str = "", ticket_id: str = ""):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["finance_trace"])
    start, end = _parse_time_range(None, None)
    _audit_query(
        request,
        query_type="ops_finance_order_trace",
        target_entity_type="payment_order",
        target_entity_id=order_no,
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=start,
        time_range_end=end,
    )

    from apps.services.billing.models import BillingUsageEvent
    from apps.services.payment.models import PaymentCallback, PaymentOrder, RefundRecord
    from apps.users.wallet.models import WalletTransaction

    order = PaymentOrder.objects.filter(order_no=order_no).values(
        "id", "order_no", "user_id", "organization_id", "order_type", "amount", "paid_amount",
        "payment_method", "status", "third_party_order_no", "third_party_trade_no",
        "business_data", "created_at", "paid_at", "updated_at",
    ).first()
    if not order:
        raise HttpError(404, "order not found")
    order_id = str(order["id"])

    return _mask({
        "order": order,
        "wallet_transactions": list(
            WalletTransaction.objects.filter(related_order_id__in=[order_id, order_no])
            .order_by("-created_at")
            .values("id", "transaction_type", "amount", "amount_precise", "balance_before", "balance_after",
                    "organization_id", "usage_event_id", "created_at")[:MAX_PAGE_SIZE]
        ),
        "usage_events": list(
            BillingUsageEvent.objects.filter(Q(biz_id=order_id) | Q(biz_id=order_no))
            .order_by("-occurred_at")
            .values("id", "organization_id", "user_id", "meter_key", "amount", "currency",
                    "charge_status", "biz_type", "biz_id", "occurred_at")[:MAX_PAGE_SIZE]
        ),
        "refunds": list(
            RefundRecord.objects.filter(payment_order_id=order_id)
            .order_by("-created_at")
            .values("id", "refund_no", "refund_amount", "refund_status", "failure_reason", "created_at", "refunded_at")[:50]
        ),
        "callbacks": list(
            PaymentCallback.objects.filter(order_id=order_id)
            .order_by("-created_at")
            .values("id", "payment_method", "is_verified", "is_processed", "error_message", "created_at")[:50]
        ),
        "provider_called": False,
    })


@router.get("/ops/tasks")
def ops_tasks(
    request,
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    resolved: str = "all",
    task_name: str = "",
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["task"])
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    cursor_dt = _parse_dt(cursor) if cursor else None

    qs = FailedTaskRecord.objects.filter(failed_at__gte=start, failed_at__lt=end)
    if resolved == "true":
        qs = qs.filter(resolved=True)
    elif resolved == "false":
        qs = qs.filter(resolved=False)
    elif resolved != "all":
        raise HttpError(400, "resolved must be all|true|false")
    if task_name:
        qs = qs.filter(task_name__icontains=task_name[:120])
    if cursor_dt:
        qs = qs.filter(failed_at__lt=cursor_dt)
    rows, has_more = _values_page(
        qs.order_by("-failed_at").values("id", "task_id", "task_name", "exception", "retries", "resolved", "failed_at", "resolved_at"),
        page_size=page_size,
    )
    for row in rows:
        row["exception"] = _mask_text((row.get("exception") or "")[:500])
        mapped_queue, attribution, attribution_source = _resolve_task_name_queue(str(row.get("task_name") or ""))
        row["mapped_queue"] = mapped_queue
        row["failure_attribution"] = attribution
        row["failure_attribution_source"] = attribution_source
    return {
        "items": rows,
        "has_more": has_more,
        "next_cursor": _serialize_dt(rows[-1]["failed_at"]) if has_more and rows else None,
        "queues": _safe_part("celery_queues", lambda: _celery_queue_health(request)),
        "workers": _safe_part("celery_workers", lambda: _celery_worker_snapshot(request)),
    }


@router.get("/ops/beat/tasks")
def ops_beat_tasks(
    request,
    enabled: str = "all",
    stale: str = "all",
    task_name: str = "",
    queue: str = "",
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: int | None = None,
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["beat"])
    page_size = _page_size(page_size)
    if enabled not in {"all", "true", "false"}:
        raise HttpError(400, "enabled must be all|true|false")
    if stale not in {"all", "true", "false"}:
        raise HttpError(400, "stale must be all|true|false")
    if queue and queue not in OPS_KNOWN_CELERY_QUEUES:
        raise HttpError(400, "queue is not in the known queue allowlist")

    from django_celery_beat.models import PeriodicTask

    qs = PeriodicTask.objects.select_related("interval", "crontab", "solar", "clocked").order_by("id")
    if cursor:
        qs = qs.filter(id__gt=cursor)
    if enabled == "true":
        qs = qs.filter(enabled=True)
    elif enabled == "false":
        qs = qs.filter(enabled=False)
    if task_name:
        qs = qs.filter(task__icontains=task_name[:160])
    if queue:
        qs = qs.filter(queue=queue)

    raw_limit = page_size + 1 if stale == "all" else min(page_size * 3 + 1, MAX_PAGE_SIZE * 3 + 1)
    tasks = list(qs[:raw_limit])
    queues = [_resolve_task_queue(task) for task in tasks]
    queue_state = _queue_lengths_for(queues or list(OPS_KNOWN_CELERY_QUEUES))
    queue_lengths = queue_state.get("data", {}) if isinstance(queue_state.get("data"), dict) else {}
    task_names = [str(getattr(task, "task", "") or "") for task in tasks]
    failures_by_task = _recent_failures_for(task_names)
    rows = [_beat_task_row(task, queue_lengths, failures_by_task) for task in tasks]
    if stale != "all":
        expected = stale == "true"
        rows = [row for row in rows if row["is_stale"] is expected]

    items = rows[:page_size]
    raw_has_more = len(tasks) == raw_limit
    next_cursor = str(getattr(tasks[-1], "id", "")) if raw_has_more and tasks else None
    return {
        "items": items,
        "has_more": raw_has_more,
        "next_cursor": next_cursor,
        "summary": _beat_summary(items, queue_state),
        "ticket_id": ticket_id,
    }


@router.get("/ops/beat/tasks/{task_id}")
def ops_beat_task_detail(request, task_id: int, ticket_id: str = ""):
    _require_perm(request, P0_PERMISSION_CODES["beat"])
    from django_celery_beat.models import PeriodicTask

    task = (
        PeriodicTask.objects.select_related("interval", "crontab", "solar", "clocked")
        .filter(id=task_id)
        .first()
    )
    if not task:
        raise HttpError(404, "beat task not found")

    queue_name = _resolve_task_queue(task)
    queue_state = _queue_lengths_for([queue_name])
    queue_lengths = queue_state.get("data", {}) if isinstance(queue_state.get("data"), dict) else {}
    failures_by_task = _recent_failures_for([task.task], limit_per_task=5)
    row = _beat_task_row(task, queue_lengths, failures_by_task)
    recent_failures = failures_by_task.get(task.task, [])
    schedule_kind = _schedule_kind(task)
    schedule_summary = {
        "type": schedule_kind,
        "display": row["schedule_display"],
        "next_run_at": row["next_run_at"],
        "next_run_reason": row["next_run_reason"],
    }
    return _mask({
        "task": row,
        "schedule": schedule_summary,
        "raw_schedule": {
            "interval": _object_display(getattr(task, "interval", None)),
            "crontab": _object_display(getattr(task, "crontab", None)),
            "solar": _object_display(getattr(task, "solar", None)),
            "clocked": _object_display(getattr(task, "clocked", None)),
        },
        "args_masked": _parse_json_summary(getattr(task, "args", ""), []),
        "kwargs_masked": _parse_json_summary(getattr(task, "kwargs", ""), {}),
        "recent_failures": recent_failures,
        "queue": {
            "name": queue_name,
            "length": queue_lengths.get(queue_name),
            "state": queue_state.get("status", "unknown"),
            "error": queue_state.get("error", ""),
        },
        "links": {
            "tasks": f"/ops/tasks?task_name={task.task}",
        },
        "readonly_recommendations": [
            "检查任务是否 enabled，并确认 last_run_at 是否按预期推进。",
            "如 queue_length 持续增长，请跳转任务中心查看 worker 与失败样本。",
            "P1 v1 不提供 pause/resume/run now/update/delete。",
        ],
        "ticket_id": ticket_id,
    })


@router.get("/ops/llm/traces")
def ops_llm_traces(
    request,
    request_id: str = "",
    user_id: str = "",
    workteam_id: str = "",
    conversation_id: str = "",
    message_id: str = "",
    scene: str = "",
    provider: str = "",
    model: str = "",
    status: str = "all",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["llm_trace"])
    start, end = _parse_limited_time_range(time_range_start, time_range_end, default_hours=24, max_days=7)
    page_size = _page_size(page_size)
    if status not in {"all", "success", "failed", "timeout", "fallback"}:
        raise HttpError(400, "status must be all|success|failed|timeout|fallback")
    if _sensitive_filter_used(user_id, workteam_id, conversation_id, message_id):
        _require_sensitive_query_context(
            request,
            query_type="ops_llm_traces",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_organization_id=workteam_id,
            target_entity_type="llm_trace",
            target_entity_id=conversation_id or message_id or request_id,
        )

    from apps.services.llm.models import LLMUsageFact

    qs = LLMUsageFact.objects.filter(occurred_at__gte=start, occurred_at__lt=end)
    if request_id:
        qs = qs.filter(request_id=request_id.strip())
    if user_id:
        qs = qs.filter(user_id=user_id.strip())
    if workteam_id:
        qs = qs.filter(organization_id=workteam_id.strip())
    if scene:
        qs = qs.filter(scene_key=scene[:100])
    if provider:
        qs = qs.filter(provider_key=provider[:100])
    if model:
        qs = qs.filter(model_name=model[:100])
    if status == "success":
        qs = qs.filter(status="completed")
    elif status == "failed":
        qs = qs.filter(status="failed")
    elif status == "timeout":
        qs = qs.filter(Q(error_code__icontains="timeout") | Q(error_category__icontains="timeout"))
    elif status == "fallback":
        qs = qs.filter(attempt_count__gt=1)
    cursor_dt = _parse_dt(cursor) if cursor else None
    if cursor_dt:
        qs = qs.filter(occurred_at__lt=cursor_dt)

    rows, has_more = _values_page(
        qs.order_by("-occurred_at").values(
            "id", "request_id", "scene_key", "capability_domain", "provider_key", "model_name",
            "organization_id", "user_id", "status", "error_code", "error_category", "attempt_count",
            "latency_ms", "total_tokens", "cost_status", "occurred_at",
        ),
        page_size=page_size,
    )
    rows = _with_workteam_aliases(rows)
    for row in rows:
        row["id"] = str(row["id"])
        row["error_code"] = _mask_text(row.get("error_code") or "")
        row["error_category"] = _mask_text(row.get("error_category") or "")
        row["fallback_chain"] = "attempts>1" if int(row.get("attempt_count") or 0) > 1 else ""
        row["missing_links"] = ["conversation", "message"] if conversation_id or message_id else []
        row["weak_correlation"] = bool(conversation_id or message_id)
    return {
        "items": rows,
        "has_more": has_more,
        "next_cursor": _serialize_dt(rows[-1]["occurred_at"]) if has_more and rows else None,
        "summary": _sample_status(rows, success_values={"completed"}),
        "missing_links": ["conversation", "message"] if conversation_id or message_id else [],
    }


@router.get("/ops/llm/traces/{request_id}")
def ops_llm_trace_detail(request, request_id: str, reason: str = "", ticket_id: str = ""):
    _require_perm(request, P0_PERMISSION_CODES["llm_trace"])
    from apps.services.billing.models import BillingUsageEvent
    from apps.services.llm.models import LLMUsageFact
    from apps.users.wallet.models import WalletTransaction

    fact = LLMUsageFact.objects.filter(request_id=request_id).values(
        "id", "request_id", "scene_key", "capability_domain", "provider_key", "model_name",
        "organization_id", "user_id", "status", "error_code", "error_category", "attempt_count",
        "latency_ms", "input_tokens", "output_tokens", "total_tokens", "cost_status",
        "total_cost", "occurred_at",
    ).first()
    if not fact:
        raise HttpError(404, "llm trace not found")

    _require_sensitive_query_context(
        request,
        query_type="ops_llm_trace_detail",
        reason=reason,
        ticket_id=ticket_id,
        time_range_start=fact["occurred_at"] - timedelta(minutes=5),
        time_range_end=fact["occurred_at"] + timedelta(minutes=5),
        target_user_id=fact.get("user_id") or "",
        target_organization_id=fact.get("organization_id") or "",
        target_entity_type="llm_trace",
        target_entity_id=request_id,
    )
    fact = _with_workteam_alias(fact)
    fact["id"] = str(fact["id"])
    usage_events = list(
        BillingUsageEvent.objects.filter(
            Q(biz_id=request_id) | Q(idempotency_key__icontains=request_id) | Q(metadata__request_id=request_id)
        )
        .order_by("-occurred_at")
        .values("id", "meter_key", "organization_id", "user_id", "amount", "currency", "charge_status", "biz_type", "biz_id", "occurred_at")[:20]
    )
    usage_events = _with_workteam_aliases(usage_events)
    usage_ids = [str(row["id"]) for row in usage_events]
    wallet_transactions = list(
        WalletTransaction.objects.filter(usage_event_id__in=usage_ids)
        .order_by("-created_at")
        .values("id", "transaction_type", "amount", "amount_precise", "organization_id", "usage_event_id", "created_at")[:20]
    )
    wallet_transactions = _with_workteam_aliases(wallet_transactions)
    return _mask({
        "trace": fact,
        "billing_usage_events": usage_events,
        "wallet_transactions": wallet_transactions,
        "fallback_chain": "attempts>1" if int(fact.get("attempt_count") or 0) > 1 else "",
        "masked_summary": {
            "error_code": _mask_text(fact.get("error_code") or ""),
            "error_category": _mask_text(fact.get("error_category") or ""),
        },
        "missing_links": ["conversation", "message"] if not usage_events else [],
        "weak_correlation": not bool(usage_events),
        "readonly_recommendations": [
            "如 billing_usage_events 为空，说明当前 request_id 与计费事实关联较弱。",
            "P1 v1 不提供 replay、退款、补偿、手动扣费或 provider key 查看。",
        ],
    })


@router.get("/ops/oss/status")
def ops_oss_status(
    request,
    status: str = "all",
    event_type: str = "upload",
    user_id: str = "",
    workteam_id: str = "",
    object_id: str = "",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["oss_status"])
    start, end = _parse_limited_time_range(time_range_start, time_range_end, default_hours=24, max_days=30)
    page_size = _page_size(page_size)
    if status not in {"all", "failed", "pending", "processed"}:
        raise HttpError(400, "status must be all|failed|pending|processed")
    if event_type not in {"upload", "sign", "callback", "process"}:
        raise HttpError(400, "event_type must be upload|sign|callback|process")
    if _sensitive_filter_used(user_id, workteam_id, object_id):
        _require_sensitive_query_context(
            request,
            query_type="ops_oss_status",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_organization_id=workteam_id,
            target_entity_type="oss_object",
            target_entity_id=object_id,
        )

    from apps.services.oss.models import FileRecord

    qs = FileRecord.objects.filter(created_at__gte=start, created_at__lt=end)
    if cursor:
        qs = qs.filter(created_at__lt=_parse_dt(cursor))
    if user_id:
        qs = qs.filter(upload_user=user_id.strip())
    if workteam_id:
        qs = qs.filter(organization_id=workteam_id.strip())
    if object_id:
        qs = qs.filter(Q(id=object_id.strip()) | Q(file_key=object_id.strip()) | Q(file_key_hash=object_id.strip()))
    if status == "failed":
        qs = qs.filter(status="failed")
    elif status == "pending":
        qs = qs.filter(status="uploading")
    elif status == "processed":
        qs = qs.filter(status="completed")
    rows, has_more = _values_page(
        qs.order_by("-created_at").values(
            "id", "file_name", "file_key", "bucket_name", "status", "upload_user",
            "organization_id", "metadata", "created_at", "updated_at",
        ),
        page_size=page_size,
    )
    rows = _with_workteam_aliases(rows)
    items = []
    for row in rows:
        metadata = row.get("metadata") or {}
        items.append({
            "id": str(row["id"]),
            "time": row["created_at"],
            "module": "oss",
            "event_type": event_type,
            "status": row["status"],
            "user_id": row.get("upload_user") or "",
            "workteam_id": row.get("workteam_id") or "",
            "object_id": str(row["id"]),
            "bucket": row.get("bucket_name") or "",
            "object_key_masked": _mask_text(row.get("file_key") or ""),
            "error_code": metadata.get("error_code", ""),
            "masked_error_summary": _mask_text(str(metadata.get("error_message") or "")[:500]),
            "missing_links": [] if event_type == "upload" else ["dedicated_oss_event_fact"],
            "weak_correlation": event_type != "upload",
        })
    return {
        "items": _mask(items),
        "has_more": has_more,
        "next_cursor": _serialize_dt(rows[-1]["created_at"]) if has_more and rows else None,
        "summary": _sample_status(items, success_values={"completed", "processed"}),
    }


@router.get("/ops/sms/status")
def ops_sms_status(
    request,
    status: str = "all",
    phone: str = "",
    user_id: str = "",
    template_code: str = "",
    provider: str = "",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["sms_status"])
    start, end = _parse_limited_time_range(time_range_start, time_range_end, default_hours=24, max_days=30)
    page_size = _page_size(page_size)
    if status not in {"all", "failed", "blocked", "rate_limited", "template_error", "provider_error"}:
        raise HttpError(400, "status must be all|failed|blocked|rate_limited|template_error|provider_error")
    if _sensitive_filter_used(user_id, phone):
        _require_sensitive_query_context(
            request,
            query_type="ops_sms_status",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_entity_type="sms_phone",
            target_entity_id=_mask_phone(phone) if phone else "",
        )

    from apps.services.sms.models import SmsRecord

    qs = SmsRecord.objects.filter(created_at__gte=start, created_at__lt=end)
    if cursor:
        qs = qs.filter(created_at__lt=_parse_dt(cursor))
    if phone:
        qs = qs.filter(phone_number=phone.strip())
    if user_id:
        qs = qs.filter(user_id=user_id.strip())
    if template_code:
        qs = qs.filter(template_code=template_code[:100])
    if provider:
        qs = qs.filter(provider=provider[:50])
    if status == "failed":
        qs = qs.filter(status__in=["failed", "undelivered"])
    elif status == "blocked":
        qs = qs.filter(Q(error_code__icontains="black") | Q(error_message__icontains="black"))
    elif status == "rate_limited":
        qs = qs.filter(Q(error_code__icontains="limit") | Q(error_message__icontains="频") | Q(error_message__icontains="limit"))
    elif status == "template_error":
        qs = qs.filter(Q(error_code__icontains="template") | Q(error_message__icontains="模板"))
    elif status == "provider_error":
        qs = qs.filter(status="failed").exclude(error_code="")
    rows, has_more = _values_page(
        qs.order_by("-created_at").values(
            "id", "user_id", "phone_number", "template_code", "status", "provider",
            "request_id", "message_id", "error_code", "error_message", "created_at", "sent_at",
        ),
        page_size=page_size,
    )
    items = []
    for row in rows:
        items.append({
            "id": str(row["id"]),
            "time": row["created_at"],
            "module": "sms",
            "event_type": "verification" if "verify" in (row.get("template_code") or "").lower() else "send",
            "status": row["status"],
            "user_id": str(row.get("user_id") or ""),
            "masked_phone": _mask_phone(row.get("phone_number") or ""),
            "template_code": row.get("template_code") or "",
            "provider": row.get("provider") or "",
            "error_code": _mask_text(row.get("error_code") or ""),
            "masked_error_summary": _mask_text((row.get("error_message") or "")[:500]),
            "request_id": row.get("request_id") or "",
        })
    return {
        "items": items,
        "has_more": has_more,
        "next_cursor": _serialize_dt(rows[-1]["created_at"]) if has_more and rows else None,
        "summary": _sample_status(items, success_values={"success", "delivered"}),
    }


@router.get("/ops/dependencies/health")
def ops_dependencies_health(
    request,
    window_minutes: int = 15,
    dependency: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["dependency_health"])
    allowed_windows = {15, 30, 60, 1440}
    if window_minutes not in allowed_windows:
        raise HttpError(400, "window_minutes must be 15|30|60|1440")
    allowed_dependencies = {
        "llm", "embedding", "oss", "sms", "payment_callback", "centrifugo_publish", "collab_save",
    }
    if dependency and dependency not in allowed_dependencies:
        raise HttpError(400, "unsupported dependency")

    def builder():
        return _dependency_health_payload(window_minutes, dependency)

    return _cached_overview(f"ops:overview:dependencies:v1:{window_minutes}:{dependency or 'all'}", builder)


@router.get("/ops/search/outbox")
def ops_search_outbox(
    request,
    db: str,
    status: str,
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: int | None = None,
    dry_run: bool = True,
    reason: str = "",
    ticket_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["search_outbox"])
    if dry_run is not True:
        raise HttpError(403, "P0 only allows dry_run=true; real requeue is not exposed")
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    model = {"default": FtsOutbox, "pg": FtsOutboxPg}.get(db)
    if model is None:
        raise HttpError(400, "db must be default|pg")

    qs = model.objects.filter(created_at__gte=start, created_at__lt=end)
    qs = _fts_apply_row_status_filter(qs, status)
    if cursor:
        qs = qs.filter(id__lt=cursor)
    rows, has_more = _values_page(
        qs.order_by("-id").values("id", "index_name", "doc_id", "action", "organization_id", "created_at", "processed_at", "retry_count", "last_error"),
        page_size=page_size,
    )
    for row in rows:
        row.update(_fts_values_row(row, db=_fts_normalize_db(db)))
        row["last_error"] = row["last_error_masked"]
    group_result = _fts_outbox_groups(model, db=db, start=start, end=end)
    groups = group_result[0] if isinstance(group_result, tuple) else group_result
    return {
        "items": rows,
        "has_more": has_more,
        "next_cursor": rows[-1]["id"] if has_more and rows else None,
        "dry_run": True,
        "groups": groups,
        "summary": {
            "status": max(
                (group["status"] for group in groups),
                key=lambda status: {
                    "program_error": 5,
                    "data_problem": 4,
                    "needs_attention": 3,
                    "normal_backlog": 2,
                    "unknown": 1,
                    "normal": 0,
                }.get(status, 0),
                default="normal",
            ),
            "status_reason": "fts_grouped_by_db_index_action",
            "intervention": _service_intervention(
                current=["查看样本", "复制排障信息"],
                future=["单条 dry-run requeue", "单条 requeue"],
            ),
        },
    }


@router.get("/ops/search/outbox/groups")
def ops_search_outbox_groups(
    request,
    db: str = "all",
    index_name: str = "",
    action: str = "",
    workteam_id: str = "",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["search_outbox"])
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    normalized_db = _fts_normalize_db(db, allow_all=True)
    if workteam_id:
        _fts_audit_if_sensitive(
            request,
            reason=reason,
            ticket_id=ticket_id,
            start=start,
            end=end,
            workteam_id=workteam_id,
        )
    groups, has_more = _fts_outbox_groups(
        db=normalized_db,
        start=start,
        end=end,
        index_name=index_name,
        action=action,
        workteam_id=workteam_id,
        page_size=page_size,
        cursor=cursor,
    )
    return {
        "items": groups,
        "has_more": has_more,
        "next_cursor": _fts_group_cursor_value(groups[-1]) if has_more and groups else None,
    }


@router.get("/ops/search/outbox/rows")
def ops_search_outbox_rows(
    request,
    db: str,
    index_name: str = "",
    action: str = "",
    status: str = FtsOutboxStatus.PENDING,
    workteam_id: str = "",
    doc_id: str = "",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: int | None = None,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["search_outbox"])
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    normalized_db = _fts_normalize_db(db)
    model = FtsOutbox if normalized_db == "default" else FtsOutboxPg
    if workteam_id or doc_id:
        _fts_audit_if_sensitive(
            request,
            reason=reason,
            ticket_id=ticket_id,
            start=start,
            end=end,
            workteam_id=workteam_id,
            doc_id=doc_id,
        )
    qs = _fts_base_queryset(
        model,
        start=start,
        end=end,
        index_name=index_name,
        action=action,
        workteam_id=workteam_id,
    )
    if doc_id:
        qs = qs.filter(doc_id=doc_id.strip()[: FtsOutbox.DOC_ID_MAX_LEN])
    qs = _fts_apply_row_status_filter(qs, status)
    if cursor:
        qs = qs.filter(id__lt=cursor)
    rows, has_more = _values_page(
        qs.order_by("-id").values(
            "id",
            "index_name",
            "doc_id",
            "action",
            "organization_id",
            "created_at",
            "processed_at",
            "retry_count",
            "last_error",
        ),
        page_size=page_size,
    )
    items = [_fts_values_row(row, db=normalized_db) for row in rows]
    return {
        "items": items,
        "has_more": has_more,
        "next_cursor": rows[-1]["id"] if has_more and rows else None,
    }


@router.get("/ops/search/outbox/rows/{db}/{row_id}")
def ops_search_outbox_row_detail(
    request,
    db: str,
    row_id: int,
    reason: str = "",
    ticket_id: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["search_outbox"])
    normalized_db = _fts_normalize_db(db)
    model = FtsOutbox if normalized_db == "default" else FtsOutboxPg
    row = (
        model.objects.filter(id=row_id)
        .values("id", "index_name", "doc_id", "action", "organization_id", "created_at", "processed_at", "retry_count", "last_error")
        .first()
    )
    if not row:
        raise HttpError(404, "outbox row not found")
    start = row.get("created_at") or timezone.now()
    end = timezone.now()
    _fts_audit_if_sensitive(
        request,
        reason=reason,
        ticket_id=ticket_id,
        start=start,
        end=end,
        row=row,
    )
    item = _fts_values_row(row, db=normalized_db)
    category = "程序错误" if item["status"] == FtsOutboxStatus.FAILED else "数据问题" if item.get("retry_count") else "同步状态"
    return {
        "row": item,
        "diagnosis": {
            "category": category,
            "summary": "该文档同步到搜索索引失败或等待过久，可能影响搜索和 AI 引用。",
            "confidence": "medium",
        },
        "related": {
            "task_names": ["apps.fts.tasks.flush_outbox_task"],
            "links": [
                {
                    "label": "查看任务中心",
                    "href": "/ops/tasks?task_name=apps.fts.tasks.flush_outbox_task",
                }
            ],
        },
        "actions": {
            "current": _fts_current_actions(),
            "p15": _fts_p15_actions(),
            "forbidden": _fts_forbidden_actions(),
        },
        "technical_details": {
            "raw": _mask(item),
        },
    }


@router.get("/ops/realtime/ws-gateway/overview")
def ws_gateway_overview(
    request,
    reason: str = "",
    ticket_id: str = "",
    user_id: str = "",
    device_id: str = "",
    daemon_id: str = "",
    connection_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    if _sensitive_filter_used(user_id, device_id, daemon_id, connection_id):
        start, end = _parse_time_range(None, None)
        _require_sensitive_query_context(
            request,
            query_type="ops_ws_gateway_lookup",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_entity_type="ws_connection",
            target_entity_id=connection_id or device_id or daemon_id,
        )
        return _ws_gateway_metrics(
            lookup={
                "user_id": user_id,
                "device_id": device_id,
                "daemon_id": daemon_id,
                "connection_id": connection_id,
            }
        )
    return _cached_overview("ops:overview:ws_gateway:v1", _ws_gateway_metrics)


@router.get("/ops/realtime/centrifugo/overview")
def centrifugo_overview(request, reason: str = "", ticket_id: str = "", channel: str = "", user_id: str = ""):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    if _sensitive_filter_used(channel, user_id):
        start, end = _parse_time_range(None, None)
        target_entity_type = "centrifugo_channel" if channel else "centrifugo_user"
        target_entity_id = channel[:200] if channel else user_id
        _require_sensitive_query_context(
            request,
            query_type="ops_centrifugo_lookup",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_entity_type=target_entity_type,
            target_entity_id=target_entity_id,
        )
        return _centrifugo_metrics(channel=channel, user_id=user_id)
    return _cached_overview("ops:overview:centrifugo:v1", _centrifugo_metrics)


@router.get("/ops/collab/overview")
def collab_overview(
    request,
    reason: str = "",
    ticket_id: str = "",
    document_id: str = "",
    table_id: str = "",
    slide_id: str = "",
    user_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["collab"])
    if _sensitive_filter_used(document_id, table_id, slide_id, user_id):
        start, end = _parse_time_range(None, None)
        target_entity_id = document_id or table_id or slide_id
        target_entity_type = (
            "collab_document"
            if document_id
            else "collab_table"
            if table_id
            else "collab_slide"
            if slide_id
            else "collab_user"
        )
        _require_sensitive_query_context(
            request,
            query_type="ops_collab_lookup",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=user_id,
            target_entity_type=target_entity_type,
            target_entity_id=target_entity_id,
        )
        return _collab_metrics(document_id=document_id, table_id=table_id, slide_id=slide_id, user_id=user_id)
    return _cached_overview("ops:overview:collab:v1", _collab_metrics)


@router.get("/ops/audit/events")
def audit_events(
    request,
    source: str = "ops",
    time_range_start: str | None = None,
    time_range_end: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    cursor: str | None = None,
    actor_user_id: str = "",
    actor_admin_account_id: str = "",
    target_user_id: str = "",
    target_organization_id: str = "",
    target_entity_type: str = "",
    target_entity_id: str = "",
    audit_ticket_id: str = "",
    reason: str = "",
    ticket_id: str = "",
):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["audit"])
    start, end = _parse_time_range(time_range_start, time_range_end)
    page_size = _page_size(page_size)
    cursor_dt = _parse_dt(cursor) if cursor else None
    sensitive_filters = _audit_event_sensitive_filters(
        actor_user_id=actor_user_id,
        actor_admin_account_id=actor_admin_account_id,
        target_user_id=target_user_id,
        target_organization_id=target_organization_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
        audit_ticket_id=audit_ticket_id,
    )
    if sensitive_filters:
        _audit_query(
            request,
            query_type=f"ops_audit_events:{source}",
            reason=reason,
            ticket_id=ticket_id,
            time_range_start=start,
            time_range_end=end,
            target_user_id=target_user_id or actor_user_id,
            target_organization_id=target_organization_id,
            target_entity_type=target_entity_type or "audit_event",
            target_entity_id=target_entity_id or audit_ticket_id or actor_admin_account_id,
        )

    qs, values = _audit_source_queryset(source, start, end)
    qs = _apply_audit_event_filters(
        qs,
        source=source,
        actor_user_id=actor_user_id,
        actor_admin_account_id=actor_admin_account_id,
        target_user_id=target_user_id,
        target_organization_id=target_organization_id,
        target_entity_type=target_entity_type,
        target_entity_id=target_entity_id,
        audit_ticket_id=audit_ticket_id,
    )
    if cursor_dt:
        qs = qs.filter(created_at__lt=cursor_dt)
    rows, has_more = _values_page(qs.order_by("-created_at").values(*values), page_size=page_size)
    return _mask({"items": rows, "has_more": has_more, "next_cursor": _serialize_dt(rows[-1]["created_at"]) if has_more and rows else None})


@router.get("/ops/stability/overview")
def stability_overview(request, reason: str = "", ticket_id: str = ""):
    reason, ticket_id = _require_reason_ticket(reason, ticket_id)
    _require_perm(request, P0_PERMISSION_CODES["stability"])
    return _cached_overview("ops:overview:stability:v1", lambda: _stability_overview(request))


@router.get("/ops/runtime/queues")
def ops_runtime_queues(request):
    _require_perm(request, P0_PERMISSION_CODES["task"])
    items, errors = _runtime_queue_items(request)
    status = "partial" if errors else _runtime_status_from_items(items)
    return _runtime_envelope(status=status, items=_mask(items), errors=errors)


@router.get("/ops/runtime/workers")
def ops_runtime_workers(request):
    _require_perm(request, P0_PERMISSION_CODES["task"])
    items, errors = _runtime_worker_items(request)
    status = "partial" if errors else _runtime_status_from_items(items)
    return _runtime_envelope(status=status, items=_mask(items), errors=errors)


@router.get("/ops/runtime/beat")
def ops_runtime_beat(request):
    _require_perm(request, P0_PERMISSION_CODES["beat"])
    items, errors = _runtime_beat_items()
    status = "partial" if errors else _runtime_status_from_items(items)
    return _runtime_envelope(
        status=status,
        items=_mask(items),
        errors=errors,
        warnings=["P1 只展示 Runtime Refactor BEAT_REGISTRY；全局 PeriodicTask 留到 P1.5。"],
    )


@router.get("/ops/runtime/failed-samples")
def ops_runtime_failed_samples(
    request,
    queue: str = "",
    task_name: str = "",
    error_signature: str = "",
    source: str = "",
    exception_type: str = "",
):
    _require_perm(request, P0_PERMISSION_CODES["task"])
    items, _per_queue, errors = _runtime_failed_samples()
    filtered = []
    for item in items:
        if queue and item.get("queue") != queue:
            continue
        if task_name and task_name not in str(item.get("task_name") or ""):
            continue
        if error_signature and error_signature not in str(item.get("error_signature") or ""):
            continue
        if source and item.get("source") != source:
            continue
        if exception_type and exception_type not in str(item.get("exception_type") or ""):
            continue
        filtered.append(item)
    status = "partial" if errors else "warning" if filtered else "healthy"
    return _runtime_envelope(status=status, items=_mask(filtered), errors=errors)


@router.get("/ops/runtime/outbox")
def ops_runtime_outbox(request, source: str = ""):
    _require_perm(request, P0_PERMISSION_CODES["search_outbox"])
    items = _runtime_outbox_items()
    if source:
        items = [item for item in items if item.get("source") == source]
    errors = [error for item in items for error in item.get("errors", [])]
    status = "partial" if errors else _runtime_status_from_items(items)
    return _runtime_envelope(status=status, items=_mask(items), errors=errors)


def _ws_runtime_unsupported() -> dict[str, Any]:
    return _runtime_envelope(
        status="unsupported",
        items=[],
        unsupported=[{
            "source": "ws_gateway",
            "reason": "WS_RUNTIME_SNAPSHOT_ENABLED=false",
        }],
        warnings=["当前为 Phase 2 占位页，观测数据尚未接入，不计入系统异常。"],
    )


@router.get("/ops/runtime/websocket/summary")
def ops_runtime_websocket_summary(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.services.common.ws.runtime_snapshot import (
        event_sample_enabled,
        read_connection_snapshots,
        read_event_samples,
        snapshot_enabled,
        summarize_connections,
    )

    if not snapshot_enabled():
        return _ws_runtime_unsupported()
    rows = read_connection_snapshots(limit=limit)
    events = read_event_samples(limit=limit) if event_sample_enabled() else []
    summary = summarize_connections(rows, events)
    return _runtime_envelope(status="healthy", items=[summary])


@router.get("/ops/runtime/websocket/connections")
def ops_runtime_websocket_connections(
    request,
    connection_id: str = "",
    user_id: str = "",
    device_id: str = "",
    limit: int = 100,
):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.services.common.ws.runtime_snapshot import read_connection_snapshots, snapshot_enabled

    if not snapshot_enabled():
        return _ws_runtime_unsupported()
    rows = read_connection_snapshots(
        connection_id=connection_id,
        user_id=user_id,
        device_id=device_id,
        limit=limit,
    )
    abnormal = any(row.get("abnormal_reason") for row in rows)
    return _runtime_envelope(status="warning" if abnormal else "healthy", items=_mask(rows))


@router.get("/ops/runtime/websocket/events")
def ops_runtime_websocket_events(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.services.common.ws.runtime_snapshot import event_sample_enabled, read_event_samples, snapshot_enabled

    if not snapshot_enabled():
        return _ws_runtime_unsupported()
    if not event_sample_enabled():
        return _runtime_envelope(
            status="unsupported",
            items=[],
            unsupported=[{
                "source": "ws_events",
                "reason": "WS_EVENT_SAMPLE_ENABLED=false",
            }],
            warnings=["事件样本未接入；连接快照可用。"],
        )
    rows = read_event_samples(limit=limit)
    return _runtime_envelope(status="healthy", items=_mask(rows))


def _im_runtime_unsupported() -> dict[str, Any]:
    return _runtime_envelope(
        status="unsupported",
        items=[],
        unsupported=[{
            "source": "centrifugo_publish_events",
            "reason": "CENTRIFUGO_PUBLISH_EVENT_SAMPLE_ENABLED=false",
        }],
        warnings=["当前为 Phase 2 占位页，观测数据尚未接入，不计入系统异常。"],
    )


@router.get("/ops/runtime/im/summary")
def ops_runtime_im_summary(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.tabchat.services.centrifugo_runtime_sample import (
        read_publish_events,
        sample_enabled,
        summarize_publish_events,
    )

    if not sample_enabled():
        return _im_runtime_unsupported()
    rows = read_publish_events(limit=limit)
    summary = summarize_publish_events(rows)
    status = "warning" if summary.get("publish_failed") or summary.get("backpressure") or summary.get("circuit_open") else "healthy"
    return _runtime_envelope(status=status, items=[summary])


@router.get("/ops/runtime/im/publish-events")
def ops_runtime_im_publish_events(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.tabchat.services.centrifugo_runtime_sample import read_publish_events, sample_enabled

    if not sample_enabled():
        return _im_runtime_unsupported()
    rows = read_publish_events(limit=limit)
    status = "warning" if any(row.get("publish_failed") == "true" for row in rows) else "healthy"
    return _runtime_envelope(status=status, items=_mask(rows))


@router.get("/ops/runtime/im/channels")
def ops_runtime_im_channels(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["realtime"])
    from apps.tabchat.services.centrifugo_runtime_sample import (
        read_publish_events,
        sample_enabled,
        summarize_channels,
    )

    if not sample_enabled():
        return _im_runtime_unsupported()
    rows = summarize_channels(read_publish_events(limit=limit))
    status = "warning" if any(row.get("failed") for row in rows) else "healthy"
    return _runtime_envelope(status=status, items=_mask(rows))


COLLAB_TTL_SECONDS = 180
COLLAB_CONN_PREFIX = "ops:collab:conn:"
COLLAB_ROOM_PREFIX = "ops:collab:room:"
COLLAB_CONN_INDEX = "ops:collab:index:connections"
COLLAB_ROOM_INDEX = "ops:collab:index:rooms"
COLLAB_EVENT_STREAM = "ops:collab:events"


def _collab_runtime_enabled() -> bool:
    return bool(getattr(settings, "COLLAB_RUNTIME_SNAPSHOT_ENABLED", False))


def _collab_event_enabled() -> bool:
    return _collab_runtime_enabled() and bool(getattr(settings, "COLLAB_EVENT_SAMPLE_ENABLED", False))


def _collab_redis():
    import redis

    return redis.Redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"))


def _json_from_redis(raw) -> dict[str, Any]:
    if raw is None:
        return {}
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    try:
        parsed = json.loads(str(raw))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _collab_read_by_index(index_key: str, key_prefix: str, *, limit: int = 100) -> list[dict[str, Any]]:
    redis = _collab_redis()
    limit = max(1, min(int(limit or 100), 500))
    ids = redis.zrevrange(index_key, 0, limit - 1)
    rows: list[dict[str, Any]] = []
    for raw_id in ids:
        item_id = raw_id.decode("utf-8", errors="replace") if isinstance(raw_id, bytes) else str(raw_id)
        row = _json_from_redis(redis.get(f"{key_prefix}{item_id}"))
        if row:
            rows.append(row)
    return rows


def _collab_read_events(*, limit: int = 100) -> list[dict[str, Any]]:
    if not _collab_event_enabled():
        return []
    redis = _collab_redis()
    rows = redis.xrevrange(COLLAB_EVENT_STREAM, count=max(1, min(int(limit or 100), 500)))
    result: list[dict[str, Any]] = []
    for stream_id, values in rows:
        item = {
            key.decode("utf-8", errors="replace") if isinstance(key, bytes) else str(key):
            value.decode("utf-8", errors="replace") if isinstance(value, bytes) else str(value)
            for key, value in values.items()
        }
        item["stream_id"] = stream_id.decode("utf-8", errors="replace") if isinstance(stream_id, bytes) else str(stream_id)
        result.append(item)
    return result


def _collab_runtime_unsupported() -> dict[str, Any]:
    return _runtime_envelope(
        status="unsupported",
        items=[],
        unsupported=[{
            "source": "collab_live",
            "reason": "COLLAB_RUNTIME_SNAPSHOT_ENABLED=false",
        }],
        warnings=["当前为 Phase 2 占位页，观测数据尚未接入，不计入系统异常。"],
    )


@router.get("/ops/runtime/collab/summary")
def ops_runtime_collab_summary(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["collab"])
    if not _collab_runtime_enabled():
        return _collab_runtime_unsupported()
    rooms = _collab_read_by_index(COLLAB_ROOM_INDEX, COLLAB_ROOM_PREFIX, limit=limit)
    connections = _collab_read_by_index(COLLAB_CONN_INDEX, COLLAB_CONN_PREFIX, limit=limit)
    events = _collab_read_events(limit=limit)
    summary = {
        "current_rooms": len([row for row in rooms if row.get("status") in {"active", "warning"}]),
        "current_connections": len([row for row in connections if row.get("status") == "connected"]),
        "active_users": sum(_safe_int(row.get("active_users")) for row in rooms),
        "store_failed": sum(_safe_int(row.get("store_failed_count")) for row in rooms),
        "store_slow": sum(_safe_int(row.get("store_slow_count")) for row in rooms),
        "pubsub_error": sum(1 for event in events if event.get("event_type") == "pubsub_error"),
    }
    status = "warning" if summary["store_failed"] or summary["store_slow"] or summary["pubsub_error"] else "healthy"
    return _runtime_envelope(status=status, items=[summary])


@router.get("/ops/runtime/collab/rooms")
def ops_runtime_collab_rooms(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["collab"])
    if not _collab_runtime_enabled():
        return _collab_runtime_unsupported()
    rows = _collab_read_by_index(COLLAB_ROOM_INDEX, COLLAB_ROOM_PREFIX, limit=limit)
    status = "warning" if any(row.get("status") == "warning" for row in rows) else "healthy"
    return _runtime_envelope(status=status, items=_mask(rows))


@router.get("/ops/runtime/collab/connections")
def ops_runtime_collab_connections(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["collab"])
    if not _collab_runtime_enabled():
        return _collab_runtime_unsupported()
    rows = _collab_read_by_index(COLLAB_CONN_INDEX, COLLAB_CONN_PREFIX, limit=limit)
    return _runtime_envelope(status="healthy", items=_mask(rows))


@router.get("/ops/runtime/collab/events")
def ops_runtime_collab_events(request, limit: int = 100):
    _require_perm(request, P0_PERMISSION_CODES["collab"])
    if not _collab_runtime_enabled():
        return _collab_runtime_unsupported()
    if not _collab_event_enabled():
        return _runtime_envelope(
            status="unsupported",
            items=[],
            unsupported=[{
                "source": "collab_events",
                "reason": "COLLAB_EVENT_SAMPLE_ENABLED=false",
            }],
            warnings=["事件样本未接入；房间和连接快照可用。"],
        )
    rows = _collab_read_events(limit=limit)
    status = "warning" if any(row.get("event_type") in {"store_failed", "store_slow", "pubsub_error", "stale_connection"} for row in rows) else "healthy"
    return _runtime_envelope(status=status, items=_mask(rows))


@router.get("/ops/runtime/overview")
def ops_runtime_overview(request):
    _require_perm(request, P0_PERMISSION_CODES["stability"])
    queue_items, queue_errors = _runtime_queue_items(request)
    worker_items, worker_errors = _runtime_worker_items(request)
    beat_items, beat_errors = _runtime_beat_items()
    failed_items, _per_queue, failed_errors = _runtime_failed_samples()
    outbox_items = _runtime_outbox_items()
    outbox_errors = [error for item in outbox_items for error in item.get("errors", [])]
    phase2 = [
        _runtime_phase2_item("ws_gateway", "WS Gateway"),
        _runtime_phase2_item("centrifugo", "Centrifugo"),
        _runtime_phase2_item("collab_live", "Collab Live"),
    ]
    modules = [
        {
            "source": "runtime_queues",
            "display_name": "Celery 队列",
            "status": "partial" if queue_errors else _runtime_status_from_items(queue_items),
            "count": len(queue_items),
            "diagnosis": "展示 Runtime Registry 13 个队列及消费状态。",
        },
        {
            "source": "runtime_workers",
            "display_name": "Worker / Consumer",
            "status": "partial" if worker_errors else _runtime_status_from_items(worker_items),
            "count": len(worker_items),
            "diagnosis": "展示 Runtime Registry 7 个 worker 及实际消费队列。",
        },
        {
            "source": "runtime_beat",
            "display_name": "Runtime Beat",
            "status": "partial" if beat_errors else _runtime_status_from_items(beat_items),
            "count": len(beat_items),
            "diagnosis": "仅展示 Runtime Refactor 相关 8 条 Beat。",
        },
        {
            "source": "failed_samples",
            "display_name": "Failed Samples / 死信",
            "status": "partial" if failed_errors else "warning" if failed_items else "healthy",
            "count": len(failed_items),
            "diagnosis": "展示 FailedTaskRecord 聚合，queue 无可靠来源时显示 unknown。",
        },
        {
            "source": "runtime_outbox",
            "display_name": "Outbox 业务消息",
            "status": _runtime_status_from_items(outbox_items),
            "count": len(outbox_items),
            "diagnosis": "通过各业务域 adapter 聚合，不做跨域大 SQL union。",
        },
    ]
    core_status = _runtime_status_from_items(modules)
    errors = queue_errors + worker_errors + beat_errors + failed_errors + outbox_errors
    return _runtime_envelope(
        status="partial" if errors else core_status,
        items=_mask(modules + phase2),
        errors=errors,
        unsupported=phase2,
        core_status=core_status,
    )


@router.post("/ops/runtime/actions/retry")
def ops_runtime_action_retry(request, payload: OpsRuntimeActionRequest):
    guard_response = _runtime_action_guard(request, "retry", payload)
    if guard_response is not None:
        return guard_response
    try:
        before, after, message = _runtime_perform_retry(payload)
        log = _record_runtime_action(
            request,
            action_type="retry",
            payload=payload,
            result="ok",
            after_status=after,
        )
        if not log.before_status and before:
            log.before_status = before[:80]
            log.save(update_fields=["before_status"])
        return _runtime_action_success(log, message)
    except Exception as exc:
        log = _record_runtime_action(
            request,
            action_type="retry",
            payload=payload,
            result="rejected",
            error_message=str(exc),
        )
        return _runtime_action_failure(log, "retry_not_allowed", str(exc))


@router.post("/ops/runtime/actions/resolve")
def ops_runtime_action_resolve(request, payload: OpsRuntimeActionRequest):
    guard_response = _runtime_action_guard(request, "resolve", payload)
    if guard_response is not None:
        return guard_response
    try:
        before, after, message = _runtime_perform_resolve(request, payload)
        log = _record_runtime_action(
            request,
            action_type="resolve",
            payload=payload,
            result="ok",
            after_status=after,
        )
        if not log.before_status and before:
            log.before_status = before[:80]
            log.save(update_fields=["before_status"])
        return _runtime_action_success(log, message)
    except Exception as exc:
        log = _record_runtime_action(
            request,
            action_type="resolve",
            payload=payload,
            result="rejected",
            error_message=str(exc),
        )
        return _runtime_action_failure(log, "resolve_not_allowed", str(exc))


def _audit_source_queryset(source: str, start, end):
    if source == "ops":
        return (
            OpsTroubleshootQueryLog.objects.filter(created_at__gte=start, created_at__lt=end),
            ("id", "actor_user_id", "actor_admin_account_id", "query_type", "target_user_id", "target_organization_id", "target_entity_type", "target_entity_id", "ticket_id", "created_at"),
        )
    if source == "billing":
        from apps.services.billing.models import BillingAdminAuditLog

        return (
            BillingAdminAuditLog.objects.filter(created_at__gte=start, created_at__lt=end),
            ("id", "admin_user_id", "action", "target_type", "target_id", "organization_id", "created_at"),
        )
    if source == "llm":
        from apps.services.llm.models import LLMAdminAuditLog

        return (
            LLMAdminAuditLog.objects.filter(created_at__gte=start, created_at__lt=end),
            ("id", "operator_id", "action", "target_type", "target_id", "organization_id", "created_at"),
        )
    if source == "space":
        from apps.tabtinspace.models import SpaceAdminActionLog

        return (
            SpaceAdminActionLog.objects.filter(created_at__gte=start, created_at__lt=end),
            ("id", "operator_id", "action_type", "target_type", "target_id", "organization_id", "success", "dry_run", "created_at"),
        )
    if source == "oss":
        from apps.services.oss.models import OSSAdminActionLog

        return (
            OSSAdminActionLog.objects.filter(created_at__gte=start, created_at__lt=end),
            ("id", "operator_id", "action_type", "organization_id", "success", "dry_run", "created_at"),
        )
    raise HttpError(400, "source must be ops|billing|llm|space|oss")


def _audit_event_sensitive_filters(**filters) -> bool:
    return any(str(value or "").strip() for value in filters.values())


def _apply_audit_event_filters(
    qs,
    *,
    source: str,
    actor_user_id: str = "",
    actor_admin_account_id: str = "",
    target_user_id: str = "",
    target_organization_id: str = "",
    target_entity_type: str = "",
    target_entity_id: str = "",
    audit_ticket_id: str = "",
):
    actor_id = (actor_admin_account_id or actor_user_id).strip()
    if source == "ops":
        if actor_user_id:
            qs = qs.filter(actor_user_id=actor_user_id.strip())
        if actor_admin_account_id:
            qs = qs.filter(actor_admin_account_id=actor_admin_account_id.strip())
        if target_user_id:
            qs = qs.filter(target_user_id=target_user_id.strip())
        if target_organization_id:
            qs = qs.filter(target_organization_id=target_organization_id.strip())
        if target_entity_type:
            qs = qs.filter(target_entity_type=target_entity_type.strip())
        if target_entity_id:
            qs = qs.filter(target_entity_id=target_entity_id.strip())
        if audit_ticket_id:
            qs = qs.filter(ticket_id=audit_ticket_id.strip())
        return qs

    if actor_id:
        if source == "billing":
            qs = qs.filter(admin_user_id=actor_id)
        else:
            qs = qs.filter(operator_id=actor_id)
    if target_organization_id and source in {"billing", "llm", "space", "oss"}:
        qs = qs.filter(organization_id=target_organization_id.strip())
    if target_entity_type and source in {"billing", "llm", "space"}:
        field = "target_type" if source in {"billing", "llm"} else "target_type"
        qs = qs.filter(**{field: target_entity_type.strip()})
    if target_entity_id and source in {"billing", "llm", "space"}:
        field = "target_id"
        qs = qs.filter(**{field: target_entity_id.strip()})
    return qs


def _cached_overview(key: str, builder):
    cached = cache.get(key)
    if cached is not None:
        return cached
    payload = builder()
    cache.set(key, payload, OVERVIEW_CACHE_SECONDS)
    return payload


def _celery_queue_lengths() -> dict[str, int]:
    import redis

    r = redis.from_url(settings.CELERY_BROKER_URL, socket_timeout=1.0, socket_connect_timeout=1.0)
    return {name: int(r.llen(name)) for name in OPS_KNOWN_CELERY_QUEUES}


def _celery_worker_snapshot_uncached() -> dict[str, Any]:
    inspect = current_app.control.inspect(timeout=CELERY_INSPECT_TIMEOUT_SECONDS)
    active = inspect.active() or {}
    reserved = inspect.reserved() or {}
    scheduled = inspect.scheduled() or {}
    stats = inspect.stats() or {}
    active_queues = inspect.active_queues() or {}
    now_ts = timezone.now().timestamp()
    worker_names = sorted(set(active) | set(reserved) | set(scheduled) | set(stats) | set(active_queues))
    workers = []
    queue_worker_counts: dict[str, int] = {queue: 0 for queue in OPS_KNOWN_CELERY_QUEUES}
    queue_active_task_counts: dict[str, int] = {queue: 0 for queue in OPS_KNOWN_CELERY_QUEUES}
    for worker_name in worker_names:
        active_tasks = active.get(worker_name, []) or []
        reserved_tasks = reserved.get(worker_name, []) or []
        scheduled_tasks = scheduled.get(worker_name, []) or []
        queues = [
            str(item.get("name") or item.get("routing_key") or "")
            for item in (active_queues.get(worker_name, []) or [])
            if item.get("name") or item.get("routing_key")
        ]
        for queue in queues:
            if queue in queue_worker_counts:
                queue_worker_counts[queue] += 1
        longest_running_seconds = None
        longest_running_task = ""
        for task in active_tasks:
            delivery = task.get("delivery_info") or {}
            queue_name = str(delivery.get("routing_key") or delivery.get("queue") or "")
            if queue_name in queue_active_task_counts:
                queue_active_task_counts[queue_name] += 1
            started = task.get("time_start")
            if started:
                running_seconds = max(0, int(now_ts - float(started)))
                if longest_running_seconds is None or running_seconds > longest_running_seconds:
                    longest_running_seconds = running_seconds
                    longest_running_task = str(task.get("name") or task.get("id") or "")
        concurrency = _safe_int((stats.get(worker_name) or {}).get("pool", {}).get("max-concurrency"))
        status = "idle"
        status_reason = "worker_online_no_active_tasks"
        if active_tasks:
            status = "ok"
            status_reason = "worker_online_consuming"
        if longest_running_seconds and longest_running_seconds > 3600:
            status = "stale"
            status_reason = "active_task_running_over_1h"
        workers.append(
            {
                "worker_name": worker_name,
                "online": True,
                "last_heartbeat": None,
                "active_tasks": len(active_tasks),
                "reserved_tasks": len(reserved_tasks),
                "scheduled_tasks": len(scheduled_tasks),
                "longest_running_task": longest_running_task,
                "longest_running_seconds": longest_running_seconds,
                "concurrency": concurrency,
                "queues": queues,
                "status": status,
                "status_reason": status_reason,
            }
        )
    worker_count = len(worker_names)
    status = "ok" if worker_count else "unknown"
    status_reason = "workers_online" if worker_count else "inspect_returned_no_workers"
    return {
        "status": status,
        "status_reason": status_reason,
        "worker_count": worker_count,
        "active_task_count": sum(len(tasks) for tasks in active.values()),
        "reserved_task_count": sum(len(tasks) for tasks in reserved.values()),
        "scheduled_task_count": sum(len(tasks) for tasks in scheduled.values()),
        "workers": workers,
        "queue_worker_counts": queue_worker_counts,
        "queue_active_task_counts": queue_active_task_counts,
        "inspect_timeout_ms": int(CELERY_INSPECT_TIMEOUT_SECONDS * 1000),
    }


def _celery_worker_snapshot(request=None) -> dict[str, Any]:
    def build():
        cache_key = "ops:celery:worker_snapshot:v1"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached
        payload = _celery_worker_snapshot_uncached()
        cache.set(cache_key, payload, CELERY_WORKER_SNAPSHOT_CACHE_SECONDS)
        return payload

    return _request_memo(request, "celery_worker_snapshot", build)


def _celery_failure_summary() -> dict[str, Any]:
    start = timezone.now() - timedelta(hours=BEAT_FAILURE_LOOKBACK_HOURS)
    rows = list(
        FailedTaskRecord.objects.filter(failed_at__gte=start)
        .order_by("-failed_at")
        .values("task_name", "exception", "failed_at", "resolved", "retries")[:MAX_PAGE_SIZE]
    )
    task_counts = Counter(str(row.get("task_name") or "unknown") for row in rows)
    error_counts = Counter(_mask_text((row.get("exception") or "")[:160]) for row in rows if row.get("exception"))
    queue_counts: dict[str, Counter[str]] = {}
    queue_errors: dict[str, Counter[str]] = {}
    queue_max_retries: dict[str, int] = {}
    queue_attribution_sources: dict[str, Counter[str]] = {}
    global_rows = []
    for row in rows:
        task_name = str(row.get("task_name") or "unknown")
        mapped_queue, attribution, attribution_source = _resolve_task_name_queue(task_name)
        row["mapped_queue"] = mapped_queue
        row["failure_attribution"] = attribution
        row["failure_attribution_source"] = attribution_source
        if attribution == "queue_mapped" and mapped_queue:
            queue_counts.setdefault(mapped_queue, Counter())[task_name] += 1
            queue_attribution_sources.setdefault(mapped_queue, Counter())[attribution_source] += 1
            queue_max_retries[mapped_queue] = max(
                queue_max_retries.get(mapped_queue, 0),
                _safe_int(row.get("retries")),
            )
            if row.get("exception"):
                queue_errors.setdefault(mapped_queue, Counter())[_mask_text((row.get("exception") or "")[:160])] += 1
        else:
            global_rows.append(row)
    top_task_count = task_counts.most_common(1)[0][1] if task_counts else 0
    concentrated = bool(len(rows) >= 3 and top_task_count / max(len(rows), 1) >= 0.6)
    return {
        "failed_sample_count": len(rows),
        "global_failed_sample_count": len(global_rows),
        "failure_attribution": "global_only" if global_rows and not queue_counts else "queue_mapped",
        "top_failed_task_names": [
            {"task_name": task_name, "count": count} for task_name, count in task_counts.most_common(5)
        ],
        "top_error_summaries": [
            {"error": error, "count": count} for error, count in error_counts.most_common(5)
        ],
        "queue_failures": {
            queue: {
                "failed_sample_count": sum(counter.values()),
                "top_failed_task_names": [
                    {"task_name": task_name, "count": count} for task_name, count in counter.most_common(5)
                ],
                "top_error_summaries": [
                    {"error": error, "count": count}
                    for error, count in queue_errors.get(queue, Counter()).most_common(5)
                ],
                "failure_attribution": "queue_mapped",
                "failure_attribution_source": ", ".join(
                    source for source, _count in queue_attribution_sources.get(queue, Counter()).most_common()
                )
                or "unknown",
                "max_retry_count": queue_max_retries.get(queue, 0),
            }
            for queue, counter in queue_counts.items()
        },
        "failed_concentrated": concentrated,
    }


def _classify_celery_queue(
    *,
    queue_name: str,
    backlog_count: int,
    worker_count: int,
    active_task_count: int,
    failed_count: int,
    max_retry_count: int,
) -> dict[str, str]:
    if backlog_count > 0 and worker_count <= 0:
        return {
            "status": "critical" if queue_name in OPS_CRITICAL_CELERY_QUEUES else "unhealthy",
            "exception_classification": "worker 不消费",
            "status_reason": "backlog_without_worker",
        }
    if backlog_count > 0 and worker_count > 0:
        return {"status": "normal_backlog", "exception_classification": "正常高峰", "status_reason": "backlog_worker_consuming"}
    if failed_count > 0:
        if max_retry_count >= 3:
            return {"status": "program_error", "exception_classification": "程序错误", "status_reason": "high_retry_mapped_failures"}
        return {"status": "task_failed", "exception_classification": "任务失败", "status_reason": "mapped_failures"}
    if backlog_count <= 0 and worker_count > 0:
        return {"status": "ok", "exception_classification": "正常", "status_reason": "empty_queue_with_worker"}
    return {"status": "unknown", "exception_classification": "无消费者", "status_reason": "empty_queue_without_worker"}


def _celery_queue_health(request=None) -> dict[str, Any]:
    lengths = _celery_queue_lengths()
    workers = _celery_worker_snapshot(request)
    failed_summary = _celery_failure_summary()
    details = []
    queue_worker_counts = workers.get("queue_worker_counts") or {}
    queue_active_task_counts = workers.get("queue_active_task_counts") or {}
    queue_failures = failed_summary.get("queue_failures") if isinstance(failed_summary.get("queue_failures"), dict) else {}
    for queue_name in OPS_KNOWN_CELERY_QUEUES:
        backlog_count = _safe_int(lengths.get(queue_name))
        worker_count = _safe_int(queue_worker_counts.get(queue_name))
        active_task_count = _safe_int(queue_active_task_counts.get(queue_name))
        queue_failure = queue_failures.get(queue_name) if isinstance(queue_failures.get(queue_name), dict) else {}
        mapped_failed_count = _safe_int(queue_failure.get("failed_sample_count"))
        classification = _classify_celery_queue(
            queue_name=queue_name,
            backlog_count=backlog_count,
            worker_count=worker_count,
            active_task_count=active_task_count,
            failed_count=mapped_failed_count,
            max_retry_count=_safe_int(queue_failure.get("max_retry_count")),
        )
        details.append(
            {
                "queue_name": queue_name,
                "backlog_count": backlog_count,
                "oldest_pending_age_seconds": None,
                "enqueue_rate": None,
                "consume_rate": None,
                "worker_count": worker_count,
                "active_task_count": active_task_count,
                "failed_sample_count": mapped_failed_count,
                "top_failed_task_names": queue_failure.get("top_failed_task_names", []),
                "top_error_summaries": queue_failure.get("top_error_summaries", []),
                "failure_attribution": queue_failure.get("failure_attribution", "none"),
                "failure_attribution_source": queue_failure.get("failure_attribution_source", "none"),
                "mapped_failed_max_retry_count": _safe_int(queue_failure.get("max_retry_count")),
                **classification,
                "impact": "可能影响后台任务执行、搜索同步、通知投递或统计报表。",
                "suggestion": "先查看失败样本和 worker 消费情况；如关键队列积压且无 worker，需排查 worker 进程。",
            }
        )
    rank = {"critical": 4, "error": 3, "normal_backlog": 2, "unknown": 1, "ok": 0}
    overall = max((row["status"] for row in details), key=lambda status: rank.get(status, 0), default="unknown")
    return {
        "status": overall,
        "status_reason": "queue_health_classified",
        "key_metrics": {
            "total_backlog": sum(row["backlog_count"] for row in details),
            "worker_count": workers.get("worker_count", 0),
            "active_task_count": workers.get("active_task_count", 0),
            "failed_sample_count": failed_summary["failed_sample_count"],
            "global_failed_sample_count": failed_summary.get("global_failed_sample_count", 0),
        },
        "queues": details,
        "failed_summary": failed_summary,
        "global_failed_sample_count": failed_summary.get("global_failed_sample_count", 0),
        "failure_attribution": failed_summary.get("failure_attribution", "global_only"),
        "intervention": _service_intervention(
            current=["刷新", "查看失败样本", "复制排障信息"],
            future=["单条任务 retry", "单条任务 resolve"],
        ),
    }


def _classify_fts_group(row: dict[str, Any]) -> dict[str, str]:
    return _fts_group_status(row)


def _fts_group_cursor_value(row: dict[str, Any]) -> str:
    return f"{row.get('db') or ''}|{row.get('index_name') or ''}|{row.get('action') or ''}"


def _fts_apply_group_cursor(rows: list[dict[str, Any]], cursor: str | None) -> list[dict[str, Any]]:
    if not cursor:
        return rows
    return [row for row in rows if _fts_group_cursor_value(row) > cursor]


def _fts_parse_group_cursor(cursor: str | None) -> tuple[str, str, str] | None:
    if not cursor:
        return None
    parts = cursor.split("|", 2)
    if len(parts) != 3:
        raise HttpError(400, "invalid cursor")
    return (_fts_normalize_db(parts[0]), parts[1], parts[2])


def _fts_outbox_groups(
    model=None,
    *,
    db: str,
    start,
    end,
    index_name: str = "",
    action: str = "",
    workteam_id: str = "",
    page_size: int = MAX_PAGE_SIZE,
    cursor: str | None = None,
) -> tuple[list[dict[str, Any]], bool]:
    rows: list[dict[str, Any]] = []
    model_pairs = [(db, model)] if model is not None else _fts_db_models(db)
    parsed_cursor = _fts_parse_group_cursor(cursor)
    for db_name, current_model in model_pairs:
        normalized_db = _fts_normalize_db(db_name)
        if parsed_cursor and normalized_db < parsed_cursor[0]:
            continue
        qs = _fts_base_queryset(
            current_model,
            start=start,
            end=end,
            index_name=index_name,
            action=action,
            workteam_id=workteam_id,
        )
        if parsed_cursor and normalized_db == parsed_cursor[0]:
            _cursor_db, cursor_index, cursor_action = parsed_cursor
            qs = qs.filter(Q(index_name__gt=cursor_index) | Q(index_name=cursor_index, action__gt=cursor_action))
        anomalous_qs = qs.filter(processed_at__isnull=True)
        grouped = list(
            anomalous_qs.values("index_name", "action")
            .annotate(
                pending_count=Count("id", filter=Q(processed_at__isnull=True)),
                failed_count=Count("id", filter=Q(processed_at__isnull=True, retry_count__gt=0, last_error__gt="")),
                oldest_pending_at=Min("created_at", filter=Q(processed_at__isnull=True)),
                max_retry_count=Max("retry_count"),
            )
            .order_by("index_name", "action")[: page_size + 1]
        )
        latest_errors = list(
            anomalous_qs.filter(retry_count__gt=0, last_error__gt="")
            .order_by("-id")
            .values("index_name", "action", "doc_id", "organization_id", "last_error", "retry_count")[: page_size * 3]
        )
        latest_error_by_key: dict[tuple[str, str], dict[str, Any]] = {}
        docs_by_key: dict[tuple[str, str], list[str]] = {}
        workteams_by_key: dict[tuple[str, str], set[str]] = {}
        doc_retry_by_key: dict[tuple[str, str], Counter[str]] = {}
        for sample in latest_errors:
            key = (str(sample.get("index_name") or ""), str(sample.get("action") or ""))
            latest_error_by_key.setdefault(key, sample)
            doc_id = str(sample.get("doc_id") or "")
            if doc_id and len(docs_by_key.setdefault(key, [])) < FTS_DOC_SAMPLE_LIMIT:
                docs_by_key[key].append(_mask_text(doc_id))
            workteam = str(sample.get("organization_id") or sample.get("workteam_id") or "")
            if workteam:
                workteams_by_key.setdefault(key, set()).add(workteam)
            if doc_id:
                doc_retry_by_key.setdefault(key, Counter())[doc_id] += max(1, _safe_int(sample.get("retry_count")))
        for row in grouped:
            key = (str(row.get("index_name") or ""), str(row.get("action") or ""))
            latest_error = latest_error_by_key.get(key, {})
            repeated_doc_problem = any(count >= 3 for count in doc_retry_by_key.get(key, {}).values())
            item = {
                "db": normalized_db,
                "index_name": key[0],
                "action": key[1],
                "pending_count": _safe_int(row.get("pending_count")),
                "failed_count": _safe_int(row.get("failed_count")),
                "processed_count_sample": 0,
                "oldest_pending_at": _serialize_dt(row.get("oldest_pending_at")),
                "oldest_pending_age_seconds": _age_seconds(row.get("oldest_pending_at")),
                "max_retry_count": _safe_int(row.get("max_retry_count")),
                "latest_error_masked": _fts_mask_error(latest_error.get("last_error")),
                "affected_workteam_count_capped": min(len(workteams_by_key.get(key, set())), FTS_DOC_SAMPLE_LIMIT),
                "affected_doc_sample": docs_by_key.get(key, [])[:FTS_DOC_SAMPLE_LIMIT],
                "repeated_doc_problem": repeated_doc_problem,
                "impact": _fts_outbox_impact(),
                "current_actions": _fts_current_actions(),
                "p15_actions": _fts_p15_actions(),
                "forbidden_actions": _fts_forbidden_actions(),
            }
            item.update(_classify_fts_group(item))
            rows.append(item)
    rows = sorted(rows, key=lambda row: (str(row["db"]), str(row["index_name"]), str(row["action"])))
    has_more = len(rows) > page_size
    return rows[:page_size], has_more


def _ws_gateway_metrics(lookup: dict[str, str] | None = None) -> dict[str, Any]:
    from apps.services.common.ws.metrics import _collect_metrics_payload

    payload = _parse_prometheus(_collect_metrics_payload().decode("utf-8", errors="replace"), prefix="tabtin_ws_")
    series = payload.get("series", {}) if isinstance(payload.get("series"), dict) else {}
    auth_failed = _metric_sum(series, "auth", "fail")
    reconnect = _metric_sum(series, "reconnect")
    send_failed = _metric_sum(series, "send", "fail")
    status = "ok"
    classification = "正常高峰"
    status_reason = "ws_metrics_available"
    if auth_failed > 0:
        status = "warning"
        classification = "鉴权失败"
        status_reason = "auth_failed_seen"
    if reconnect > 10:
        status = "warning"
        classification = "连接抖动"
        status_reason = "reconnect_high"
    if send_failed > 0:
        status = "error"
        classification = "程序错误"
        status_reason = "send_failed_seen"
    payload.update(
        {
            "status": status,
            "status_reason": status_reason,
            "exception_classification": classification,
            "key_metrics": {
                "active_connections": _metric_sum(series, "connection", "active"),
                "connect_count": _metric_sum(series, "connect"),
                "disconnect_count": _metric_sum(series, "disconnect"),
                "reconnect_count": reconnect,
                "auth_failed_count": auth_failed,
                "message_in": _metric_sum(series, "message", "in"),
                "message_out": _metric_sum(series, "message", "out"),
                "send_failed": send_failed,
                "stream_lag": _metric_sum(series, "lag"),
                "gateway_instances": _metric_sum(series, "instance"),
            },
            "samples": {
                "recent_disconnect_samples": [],
                "latest_error": "",
            },
            "lookup": _readonly_lookup_payload(
                "ws_gateway_connection",
                lookup or {},
                status_reason="connection_registry_not_available_metrics_only",
            ),
            "intervention": _service_intervention(
                current=["查看连接状态", "查看最近断连样本", "复制排障信息"],
                future=["单连接 disconnect", "revoke single session"],
            ),
        }
    )
    return payload


def _centrifugo_metrics(channel: str = "", user_id: str = "") -> dict[str, Any]:
    from apps.tabchat.services import centrifugo_service

    data = {
        "circuit_breaker": {
            "state": getattr(centrifugo_service._breaker, "state", "unknown"),
            "failure_count": getattr(centrifugo_service._breaker, "failure_count", None),
        },
        "pool_size": getattr(settings, "CENTRIFUGO_POOL_SIZE", None),
        "channel_enumerated": False,
    }
    try:
        metrics = _parse_prometheus(_ws_gateway_metrics_text(), prefix="tabchat_centrifugo_")
        data["metrics"] = metrics
    except Exception:
        metrics = {"status": "unknown", "series": {}}
        data["metrics"] = metrics
    series = metrics.get("series", {}) if isinstance(metrics.get("series"), dict) else {}
    publish_failed = _metric_sum(series, "publish", "failed") + _metric_sum(series, "publish", "api_error")
    backpressure = _metric_sum(series, "backpressure")
    status = "ok"
    classification = "正常高峰"
    status_reason = "centrifugo_metrics_available"
    if publish_failed > 0:
        status = "error"
        classification = "程序错误"
        status_reason = "publish_failed_seen"
    if backpressure > 0:
        status = "normal_backlog"
        classification = "正常高峰"
        status_reason = "backpressure_seen"
    channels = [item.strip() for item in (channel or "").split(",") if item.strip()][:20]
    presence = []
    service = centrifugo_service.get_centrifugo_service()
    for channel_name in channels:
        try:
            stats = service.presence_stats(channel_name)
            presence.append({
                "channel": _mask_text(channel_name),
                "status": "ok",
                "presence_stats": _mask(stats),
                "user_id": _mask_text(user_id) if user_id else "",
            })
        except Exception as exc:
            presence.append({
                "channel": _mask_text(channel_name),
                "status": "unknown",
                "error": exc.__class__.__name__,
                "user_id": _mask_text(user_id) if user_id else "",
            })
    data.update(
        {
            "status": status,
            "status_reason": status_reason,
            "exception_classification": classification,
            "key_metrics": {
                "publish_success_count": _metric_sum(series, "publish", "success"),
                "publish_failed_count": publish_failed,
                "subscribe_failed_count": _metric_sum(series, "subscribe", "fail"),
                "backpressure": backpressure,
                "pool_active_threads": _metric_sum(series, "pool", "active"),
                "latest_publish_error": "",
            },
            "lookup": {
                "channel_enumerated": False,
                "channel_limit": 20,
                "requested_channels": [_mask_text(item) for item in channels],
                "presence": presence,
                "user_id": _mask_text(user_id) if user_id else "",
                "status_reason": "point_lookup_only_no_full_channel_scan",
            },
            "intervention": _service_intervention(
                current=["查看 publish 状态", "点查 channel presence", "复制排障信息"],
                future=["单条 reliable publish retry"],
            ),
        }
    )
    return data


def _ws_gateway_metrics_text() -> str:
    from apps.services.common.ws.metrics import _collect_metrics_payload

    return _collect_metrics_payload().decode("utf-8", errors="replace")


def _collab_metrics(document_id: str = "", table_id: str = "", slide_id: str = "", user_id: str = "") -> dict[str, Any]:
    url = str(getattr(settings, "COLLAB_LIVE_URL", "http://localhost:4100")).rstrip("/") + "/metrics"
    try:
        response = requests.get(url, timeout=COLLAB_METRICS_TIMEOUT_SECONDS)
        response.raise_for_status()
        try:
            payload = response.json()
        except ValueError:
            payload = _parse_prometheus(response.text, prefix="")
        status = "ok"
        error = ""
    except Exception as exc:
        payload = {}
        status = "unknown"
        error = exc.__class__.__name__
    lookup = _collab_lookup(document_id=document_id, table_id=table_id, slide_id=slide_id, user_id=user_id, metrics_status=status)
    return {
        "status": status,
        "status_reason": "metrics_available" if status == "ok" else "metrics_http_error",
        "exception_classification": "指标不可用" if status == "unknown" else lookup.get("exception_classification", "正常高峰"),
        "metrics": _mask(payload),
        "timeout_ms": 800,
        "error": error,
        "key_metrics": {
            "active_documents": None,
            "active_connections": None,
            "auth_success": None,
            "auth_failed": None,
            "save_success": None,
            "save_failed": None,
            "store_latency": None,
            "redis_pubsub_status": "unknown",
        },
        "lookup": lookup,
        "intervention": _service_intervention(
            current=["查看文档/房间状态", "查看断连/重连样本", "查看保存状态", "复制排障信息"],
            future=["single doc save check", "resync dry-run"],
        ),
    }


def _collab_lookup(*, document_id: str = "", table_id: str = "", slide_id: str = "", user_id: str = "", metrics_status: str) -> dict[str, Any]:
    resource_type = ""
    resource_id = ""
    if document_id:
        resource_type, resource_id = "docs", document_id.strip()
    elif table_id:
        resource_type, resource_id = "table", table_id.strip()
    elif slide_id:
        resource_type, resource_id = "slide", slide_id.strip()
    if not resource_id and not user_id:
        return {"status": "not_requested", "status_reason": "lookup_not_requested"}
    last_save_at = None
    recent_versions = 0
    if resource_id:
        try:
            from apps.collab.models import VersionHistory

            qs = VersionHistory.objects.filter(resource_type=resource_type, resource_id=resource_id)
            latest = qs.order_by("-created_at").values("created_at").first()
            last_save_at = _serialize_dt(latest["created_at"]) if latest else None
            recent_versions = qs.filter(created_at__gte=timezone.now() - timedelta(minutes=30)).count()
        except Exception:
            last_save_at = None
    has_metrics_error = metrics_status == "unknown"
    status = "unknown" if has_metrics_error else "ok"
    classification = "指标不可用" if has_metrics_error else "正常高峰"
    judgment = "指标不可用" if has_metrics_error else "客户端重连成功" if recent_versions else "服务端保存未知"
    return {
        "status": status,
        "status_reason": "collab_lookup_best_effort",
        "exception_classification": classification,
        "document_room_status": judgment,
        "resource_type": resource_type,
        "resource_id_masked": _mask_text(resource_id) if resource_id else "",
        "user_id": _mask_text(user_id) if user_id else "",
        "disconnect_count_30m": None,
        "reconnect_count_30m": None,
        "recent_disconnect_samples": [],
        "recent_reconnect_samples": [],
        "recent_save_failed_samples": [],
        "last_save_at": last_save_at,
        "last_error_masked": "",
        "save_recent_version_count_30m": recent_versions,
        "auth_failed": None,
        "store_timeout": None,
        "metrics_http_error": has_metrics_error,
        "judgment": judgment,
    }


def _parse_prometheus(text: str, *, prefix: str) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "ok", "series": {}}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or not line.startswith(prefix):
            continue
        try:
            metric, value = line.rsplit(" ", 1)
            result["series"][metric] = float(value)
        except ValueError:
            continue
    return result


def _stability_overview(request=None) -> dict[str, Any]:
    now = timezone.now()
    start_24h = now - timedelta(hours=24)
    return {
        "generated_at": now,
        "failed_tasks": _safe_part(
            "failed_tasks",
            lambda: {
                "open_sample_count": _limited_sample_count(
                    FailedTaskRecord.objects.filter(resolved=False).order_by("-failed_at")
                ),
                "failed_24h_sample_count": _limited_sample_count(
                    FailedTaskRecord.objects.filter(failed_at__gte=start_24h).order_by("-failed_at")
                ),
            },
        ),
        "fts_outbox": _safe_part(
            "fts_outbox",
            lambda: {
                "default_pending_sample_count": _limited_sample_count(
                    FtsOutbox.objects.filter(processed_at__isnull=True).order_by("-id")
                ),
                "pg_pending_sample_count": _limited_sample_count(
                    FtsOutboxPg.objects.filter(processed_at__isnull=True).order_by("-id")
                ),
            },
        ),
        "celery_queues": _safe_part("celery_queues", lambda: _celery_queue_health(request)),
        "celery_workers": _safe_part("celery_workers", lambda: _celery_worker_snapshot(request)),
        "ws_gateway": _safe_part("ws_gateway", _ws_gateway_metrics),
        "centrifugo": _safe_part("centrifugo", _centrifugo_metrics),
        "collab": _safe_part("collab", _collab_metrics),
    }


def _dependency_health_payload(window_minutes: int, dependency: str = "") -> dict[str, Any]:
    now = timezone.now()
    start = now - timedelta(minutes=window_minutes)
    builders = {
        "llm": lambda: _dependency_from_llm(start),
        "embedding": lambda: _dependency_from_failed_tasks("embedding", start, "/ops/tasks"),
        "oss": lambda: _dependency_from_oss(start),
        "sms": lambda: _dependency_from_sms(start),
        "payment_callback": lambda: _dependency_from_payment_callbacks(start),
        "centrifugo_publish": lambda: _dependency_from_metrics("centrifugo_publish", _centrifugo_metrics, "/ops/realtime"),
        "collab_save": lambda: _dependency_from_metrics("collab_save", _collab_metrics, "/ops/collab"),
    }
    selected = [dependency] if dependency else list(builders.keys())
    items = []
    for name in selected:
        try:
            items.append(builders[name]())
        except Exception as exc:  # pragma: no cover - defensive partial result
            items.append({
                "dependency": name,
                "status": "unknown",
                "success_rate": None,
                "error_rate": None,
                "timeout_rate": None,
                "p95_latency_ms": None,
                "affected_users_capped": [],
                "affected_workteams_capped": [],
                "latest_error_masked": f"unavailable: {exc.__class__.__name__}",
                "source_freshness": "unknown",
                "links": {},
            })
    rank = {"critical": 3, "degraded": 2, "unknown": 1, "ok": 0}
    overall = max((item["status"] for item in items), key=lambda value: rank.get(value, 0), default="unknown")
    return {
        "generated_at": now,
        "window_minutes": window_minutes,
        "overall_status": overall,
        "items": items,
        "ticket_id": "",
    }


def _dependency_item(
    *,
    dependency: str,
    sample: dict[str, Any],
    p95_latency_ms=None,
    affected_users=None,
    affected_workteams=None,
    latest_error: str = "",
    source_freshness: str = "current_window",
    links=None,
) -> dict[str, Any]:
    return {
        "dependency": dependency,
        "status": _health_from_sample(sample),
        "success_rate": sample.get("success_rate"),
        "error_rate": sample.get("error_rate"),
        "timeout_rate": None,
        "p95_latency_ms": p95_latency_ms,
        "affected_users_capped": list(dict.fromkeys(affected_users or []))[:20],
        "affected_workteams_capped": list(dict.fromkeys(affected_workteams or []))[:20],
        "latest_error_masked": _mask_text((latest_error or "")[:500]),
        "source_freshness": source_freshness,
        "links": links or {},
    }


def _dependency_from_llm(start) -> dict[str, Any]:
    from apps.services.llm.models import LLMUsageFact

    rows = list(
        LLMUsageFact.objects.filter(occurred_at__gte=start)
        .order_by("-occurred_at")
        .values("status", "latency_ms", "user_id", "organization_id", "error_code", "error_category")[:MAX_PAGE_SIZE]
    )
    rows = _with_workteam_aliases(rows)
    sample = _sample_status(rows, success_values={"completed"})
    latest_error = next((row.get("error_code") or row.get("error_category") or "" for row in rows if row.get("status") != "completed"), "")
    return _dependency_item(
        dependency="llm",
        sample=sample,
        p95_latency_ms=_p95([row.get("latency_ms") for row in rows]),
        affected_users=[row.get("user_id") for row in rows if row.get("user_id")],
        affected_workteams=[row.get("workteam_id") for row in rows if row.get("workteam_id")],
        latest_error=latest_error,
        links={"llm_trace": "/ops/llm-trace"},
    )


def _dependency_from_oss(start) -> dict[str, Any]:
    from apps.services.oss.models import FileRecord

    rows = list(
        FileRecord.objects.filter(created_at__gte=start)
        .order_by("-created_at")
        .values("status", "upload_user", "organization_id", "metadata")[:MAX_PAGE_SIZE]
    )
    rows = _with_workteam_aliases(rows)
    sample = _sample_status(rows, success_values={"completed"})
    latest_error = next((str((row.get("metadata") or {}).get("error_message") or "") for row in rows if row.get("status") == "failed"), "")
    return _dependency_item(
        dependency="oss",
        sample=sample,
        affected_users=[row.get("upload_user") for row in rows if row.get("upload_user")],
        affected_workteams=[row.get("workteam_id") for row in rows if row.get("workteam_id")],
        latest_error=latest_error,
        links={"oss_sms": "/ops/oss-sms"},
    )


def _dependency_from_sms(start) -> dict[str, Any]:
    from apps.services.sms.models import SmsRecord

    rows = list(
        SmsRecord.objects.filter(created_at__gte=start)
        .order_by("-created_at")
        .values("status", "user_id", "error_message")[:MAX_PAGE_SIZE]
    )
    sample = _sample_status(rows, success_values={"success", "delivered"})
    latest_error = next((row.get("error_message") or "" for row in rows if row.get("status") in {"failed", "undelivered"}), "")
    return _dependency_item(
        dependency="sms",
        sample=sample,
        affected_users=[str(row.get("user_id")) for row in rows if row.get("user_id")],
        latest_error=latest_error,
        links={"oss_sms": "/ops/oss-sms"},
    )


def _dependency_from_payment_callbacks(start) -> dict[str, Any]:
    from apps.services.payment.models import PaymentCallback

    rows = list(
        PaymentCallback.objects.filter(created_at__gte=start)
        .order_by("-created_at")
        .values("is_processed", "is_verified", "error_message")[:MAX_PAGE_SIZE]
    )
    normalized = [{"status": "success" if row.get("is_processed") and row.get("is_verified") else "failed"} for row in rows]
    sample = _sample_status(normalized, success_values={"success"})
    latest_error = next((row.get("error_message") or "" for row in rows if row.get("error_message")), "")
    return _dependency_item(
        dependency="payment_callback",
        sample=sample,
        latest_error=latest_error,
        links={"finance_trace": "/ops/finance-trace"},
    )


def _dependency_from_failed_tasks(keyword: str, start, link: str) -> dict[str, Any]:
    rows = list(
        FailedTaskRecord.objects.filter(failed_at__gte=start, task_name__icontains=keyword)
        .order_by("-failed_at")
        .values("task_name", "exception")[:MAX_PAGE_SIZE]
    )
    sample = {"sample_size": len(rows), "success_rate": 0 if rows else None, "error_rate": 100 if rows else None}
    return _dependency_item(
        dependency=keyword,
        sample=sample,
        latest_error=rows[0].get("exception", "") if rows else "",
        links={"tasks": link},
    )


def _dependency_from_metrics(name: str, collector, link: str) -> dict[str, Any]:
    payload = collector()
    status = "unknown" if payload.get("status") == "unknown" else "ok"
    return {
        "dependency": name,
        "status": status,
        "success_rate": None,
        "error_rate": None,
        "timeout_rate": None,
        "p95_latency_ms": None,
        "affected_users_capped": [],
        "affected_workteams_capped": [],
        "latest_error_masked": _mask_text(str(payload.get("error") or "")),
        "source_freshness": "metrics",
        "links": {"overview": link},
    }


def _limited_sample_count(qs) -> int:
    return len(list(qs.values_list("id", flat=True)[:MAX_PAGE_SIZE]))
