"""Extension 框架 API 端点"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, Optional, Tuple

from django.contrib.auth import get_user_model
from django.db import models, transaction
from django.http import JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_http_methods

from apps.i18n import _

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.tools.error_envelope import is_standard_tool_error

logger = logging.getLogger(__name__)
User = get_user_model()

MAX_WEBHOOK_RETRIES = 10


# ---------------------------------------------------------------------------
# 认证 & 鉴权
# ---------------------------------------------------------------------------

def _authenticate(request) -> Tuple[Optional[User], Optional[str]]:
    """从 Bearer token 提取用户，从 header 提取 organization_id。"""
    from apps.users.auth.permissions import authenticate_django_bearer_request

    user = authenticate_django_bearer_request(request)
    if not user:
        return None, None

    organization_id = request.headers.get("X-Organization-Id", "").strip()
    return user, organization_id


def _require_auth(request, role: str = "viewer"):
    """认证 + organization 鉴权，失败时返回错误 JsonResponse，成功返回 (user, organization_id)。"""
    user, organization_id = _authenticate(request)
    if not user:
        auth_error = getattr(request, "django_bearer_auth_error", None)
        if auth_error is not None:
            return JsonResponse({"error": str(auth_error)}, status=getattr(auth_error, "status_code", 401)), None, None
        return JsonResponse({"error": "Unauthorized"}, status=401), None, None

    if not organization_id:
        return JsonResponse({"error": _("common.invalid_request")}, status=400), None, None

    from apps.tabtinspace.services import OrganizationService
    svc = OrganizationService(user=user)
    if not svc.check_organization_permission(organization_id, role):
        return JsonResponse({"error": _("auth.insufficient_permissions")}, status=403), None, None

    return None, user, organization_id


def _parse_body(request):
    """解析 JSON body，返回 (dict, None) 或 (None, JsonResponse)。"""
    if not request.body:
        return {}, None
    try:
        data = json.loads(request.body)
        if not isinstance(data, dict):
            return None, _json_error("Request body must be a JSON object")
        return data, None
    except json.JSONDecodeError:
        return None, _json_error("Invalid JSON in request body")


def _safe_int(value, default: int, min_val: int = 0, max_val: int | None = None) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        return default
    v = max(min_val, v)
    if max_val is not None:
        v = min(max_val, v)
    return v


def _validate_space_ownership(organization_id: str, space_id: Optional[str]):
    """校验 space 归属，委托到 tabtinspace base。"""
    from apps.tabtinspace.services.base import validate_space_ownership_response
    return validate_space_ownership_response(organization_id, space_id)


def _json_error(msg: str, status: int = 400) -> JsonResponse:
    return JsonResponse({"ok": False, "error": msg}, status=status)


# ---------------------------------------------------------------------------
# Extension 列表 & 详情
# ---------------------------------------------------------------------------

@csrf_exempt
@require_http_methods(["GET"])
def list_extensions(request):
    """列出所有已注册的 Extension。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    from apps.extensions.registry import ExtensionRegistry
    manifests = ExtensionRegistry.list_manifests()
    return JsonResponse({"ok": True, "extensions": manifests})


@csrf_exempt
@require_http_methods(["GET"])
def extension_detail(request, extension_id: str):
    """获取单个 Extension 的详情。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    from apps.extensions.registry import ExtensionRegistry
    manifest = ExtensionRegistry.get_manifest(extension_id)
    if not manifest:
        return _json_error("Extension not found", 404)

    return JsonResponse({"ok": True, "extension": manifest})


# ---------------------------------------------------------------------------
# Builtin Extension 自动 ensure_connection
# ---------------------------------------------------------------------------

def _ensure_builtin_connections(organization_id: str) -> int:
    """为 builtin extension 幂等创建 organization 级别的 ExtensionConnection。"""
    from apps.extensions.models import ExtensionConnection
    from apps.extensions.registry import ExtensionRegistry

    created_count = 0
    with transaction.atomic(using=postgres_app_db_alias()):
        for ext in ExtensionRegistry.list_all():
            if not ext.is_builtin:
                continue
            _, was_created = ExtensionConnection.objects.get_or_create(
                extension_id=ext.id,
                organization_id=organization_id,
                space_id=None,
                defaults={
                    "name": ext.name,
                    "auth_type": "none",
                    "config": {},
                    "status": "connected",
                    "enabled": True,
                },
            )
            if was_created:
                created_count += 1
    return created_count


@csrf_exempt
@require_http_methods(["POST"])
def ensure_builtin_connections(request):
    """为当前 organization 确保所有 builtin extension 的 connection 存在（幂等）。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    created = _ensure_builtin_connections(organization_id)
    return JsonResponse({"ok": True, "created": created})


# ---------------------------------------------------------------------------
# ExtensionConnection CRUD
# ---------------------------------------------------------------------------

def _get_sensitive_keys(extension_id: str) -> set:
    """获取 Extension 中 field_type 为 password 的配置字段 key 集合。"""
    from apps.extensions.registry import ExtensionRegistry
    ext = ExtensionRegistry.get(extension_id)
    if not ext:
        return set()
    return {f.key for f in ext.get_config_fields() if f.field_type == "password"}


def _mask_value(v: str) -> str:
    if len(v) <= 12:
        return "****"
    return v[:4] + "****" + v[-4:]


def _mask_config(config: dict, extension_id: str = "") -> dict:
    """对 config 做脱敏，仅对 password 类型字段隐藏真实值，非敏感字段原样返回。"""
    if not config:
        return {}
    sensitive_keys = _get_sensitive_keys(extension_id) if extension_id else set()
    masked = {}
    for k, v in config.items():
        if k in sensitive_keys:
            masked[k] = _mask_value(str(v)) if v else None
        else:
            masked[k] = v
    return masked


def _serialize_connection(c) -> dict:
    config_raw = c.config if isinstance(c.config, dict) else {}
    return {
        "id": str(c.id),
        "extension_id": c.extension_id,
        "organization_id": c.organization_id,
        "space_id": c.space_id,
        "name": c.name,
        "enabled": c.enabled,
        "status": c.status,
        "auth_type": c.auth_type,
        "config_masked": _mask_config(config_raw, c.extension_id),
        "last_error": c.last_error,
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }


def _auto_ensure_builtins(organization_id: str) -> None:
    """首次请求连接列表时静默 ensure builtin connections（每 organization 10 分钟最多一次）。"""
    from django.core.cache import cache

    cache_key = f"ext:builtins_ensured:{organization_id}"
    if cache.get(cache_key):
        return
    try:
        _ensure_builtin_connections(organization_id)
        cache.set(cache_key, True, 600)
    except Exception:
        logger.debug("[auto_ensure_builtins] 静默 ensure 失败: organization=%s", organization_id, exc_info=True)


@csrf_exempt
@require_http_methods(["GET"])
def list_connections(request):
    """列出当前 organization 的 Extension 连接。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    space_id = request.GET.get("space_id", "")
    if ownership_err := _validate_space_ownership(organization_id, space_id):
        return ownership_err

    _auto_ensure_builtins(organization_id)

    from apps.extensions.models import ExtensionConnection

    qs = ExtensionConnection.objects.filter(organization_id=organization_id)
    if space_id:
        qs = qs.filter(space_id=space_id)

    connections = [_serialize_connection(c) for c in qs]
    return JsonResponse({"ok": True, "connections": connections})


@csrf_exempt
@require_http_methods(["POST"])
def create_connection(request):
    """创建 Extension 连接。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err

    if ownership_err := _validate_space_ownership(organization_id, body.get("space_id")):
        return ownership_err

    extension_id = body.get("extension_id")
    if not extension_id:
        return _json_error(_("common.invalid_request"))

    from apps.extensions.registry import ExtensionRegistry
    ext = ExtensionRegistry.get(extension_id)
    if not ext:
        return _json_error(_("common.not_found"), 404)

    config = body.get("config", {})
    if not isinstance(config, dict):
        config = {}

    errors = ext.validate_config(config)
    if errors:
        return JsonResponse({"ok": False, "errors": errors}, status=400)

    from apps.extensions.models import ExtensionConnection

    auth_type = body.get("auth_type", "none")
    from apps.extensions.constants import AuthType
    if auth_type not in AuthType.values:
        return _json_error(_("common.invalid_request"))

    name = body.get("name", ext.name) or ""
    if len(name) > 200:
        return _json_error(_("common.invalid_request"))

    with transaction.atomic(using=postgres_app_db_alias()):
        conn, created = ExtensionConnection.objects.get_or_create(
            extension_id=extension_id,
            organization_id=organization_id,
            space_id=body.get("space_id") or None,
            defaults={
                "name": name,
                "auth_type": auth_type,
                "config": config,
                "status": "connected",
            },
        )
        if not created:
            existing_config = conn.config if isinstance(conn.config, dict) else {}
            merged = {**existing_config, **{k: v for k, v in config.items() if v is not None and v != ""}}
            errors = ext.validate_config(merged)
            if errors:
                return JsonResponse({"ok": False, "errors": errors}, status=400)
            conn.config = merged
            conn.name = body.get("name", conn.name)
            conn.auth_type = auth_type
            conn.status = "connected"
            conn.save(update_fields=["config", "name", "auth_type", "status", "updated_at"])

    return JsonResponse({"ok": True, "connection": _serialize_connection(conn), "created": created})


@csrf_exempt
@require_http_methods(["GET"])
def get_connection(request, connection_id: str):
    """获取单个 Extension 连接详情。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    from apps.extensions.models import ExtensionConnection
    conn = ExtensionConnection.objects.filter(id=connection_id, organization_id=organization_id).first()
    if not conn:
        return _json_error("Connection not found", 404)

    return JsonResponse({"ok": True, "connection": _serialize_connection(conn)})


@csrf_exempt
@require_http_methods(["PUT", "PATCH"])
def update_connection(request, connection_id: str):
    """更新 Extension 连接。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err

    from apps.extensions.models import ExtensionConnection

    with transaction.atomic(using=postgres_app_db_alias()):
        conn = (
            ExtensionConnection.objects
            .select_for_update()
            .filter(id=connection_id, organization_id=organization_id)
            .first()
        )
        if not conn:
            return _json_error("Connection not found", 404)

        update_fields = ["updated_at"]

        if "config" in body:
            incoming_config = body["config"] if isinstance(body["config"], dict) else {}
            existing_config = conn.config if isinstance(conn.config, dict) else {}
            merged_config = {**existing_config, **{k: v for k, v in incoming_config.items() if v is not None and v != ""}}
            from apps.extensions.registry import ExtensionRegistry
            ext = ExtensionRegistry.get(conn.extension_id)
            if ext:
                errors = ext.validate_config(merged_config)
                if errors:
                    return JsonResponse({"ok": False, "errors": errors}, status=400)
            conn.config = merged_config
            update_fields.append("config")

        if "name" in body:
            name = str(body["name"] or "")
            if len(name) > 200:
                return _json_error(_("common.invalid_request"))
            conn.name = name
            update_fields.append("name")
        if "enabled" in body:
            conn.enabled = bool(body["enabled"])
            update_fields.append("enabled")
        if "auth_type" in body:
            from apps.extensions.constants import AuthType
            if body["auth_type"] not in AuthType.values:
                return _json_error(_("common.invalid_request"))
            conn.auth_type = body["auth_type"]
            update_fields.append("auth_type")

        conn.save(update_fields=update_fields)
    return JsonResponse({"ok": True, "connection": _serialize_connection(conn)})


@csrf_exempt
@require_http_methods(["DELETE"])
def delete_connection(request, connection_id: str):
    """删除 Extension 连接。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    from apps.extensions.models import ExtensionConnection
    conn = ExtensionConnection.objects.filter(id=connection_id, organization_id=organization_id).first()
    if not conn:
        return _json_error("Connection not found", 404)

    conn.delete()
    return JsonResponse({"ok": True})


@csrf_exempt
@require_http_methods(["POST"])
async def probe_connection(request, connection_id: str):
    """对 Extension 连接执行连通性检查。"""
    def _run_sync():
        err, user, organization_id = _require_auth(request, "editor")
        if err:
            return err

        from apps.extensions.models import ExtensionConnection
        conn = ExtensionConnection.objects.filter(id=connection_id, organization_id=organization_id).first()
        if not conn:
            return _json_error("Connection not found", 404)

        from apps.extensions.registry import ExtensionRegistry
        ext = ExtensionRegistry.get(conn.extension_id)
        if not ext:
            return _json_error(_("common.not_found"), 404)

        try:
            import time
            from asgiref.sync import async_to_sync
            t0 = time.monotonic()
            result = async_to_sync(ext.probe)(conn)
            result.latency_ms = round((time.monotonic() - t0) * 1000, 1)
        except Exception as exc:
            result = None
            conn.status = "error"
            conn.last_error = str(exc)
            conn.save(update_fields=["status", "last_error", "updated_at"])
            return JsonResponse({
                "ok": False,
                "probe": {"ok": False, "error": str(exc), "latency_ms": None},
                "connection": _serialize_connection(conn),
            })

        from django.utils import timezone as tz
        conn.last_probe_at = tz.now()
        if result.ok:
            conn.status = "connected"
            conn.last_error = None
        else:
            conn.status = "error"
            conn.last_error = result.error
        conn.save(update_fields=["status", "last_error", "last_probe_at", "updated_at"])

        return JsonResponse({
            "ok": result.ok,
            "probe": {
                "ok": result.ok,
                "error": result.error,
                "latency_ms": result.latency_ms,
            },
            "connection": _serialize_connection(conn),
        })

    from apps.services.common.executor import run_in_agent_io_executor

    return await run_in_agent_io_executor(_run_sync)


# ---------------------------------------------------------------------------
# ExtensionWebhookSubscription CRUD
# ---------------------------------------------------------------------------

def _serialize_webhook(wh) -> dict:
    return {
        "id": str(wh.id),
        "organization_id": wh.organization_id,
        "space_id": wh.space_id,
        "url": wh.url,
        "event_types": wh.event_types,
        "is_active": wh.is_active,
        "max_retries": wh.max_retries,
        "total_deliveries": wh.total_deliveries,
        "failed_deliveries": wh.failed_deliveries,
        "consecutive_failures": wh.consecutive_failures,
        "last_triggered_at": wh.last_triggered_at.isoformat() if wh.last_triggered_at else None,
        "created_at": wh.created_at.isoformat(),
        "updated_at": wh.updated_at.isoformat(),
    }


@csrf_exempt
@require_http_methods(["GET"])
def list_webhooks(request):
    """列出当前 organization 的 Webhook 订阅。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    space_id = request.GET.get("space_id")
    if ownership_err := _validate_space_ownership(organization_id, space_id):
        return ownership_err

    from apps.extensions.models import ExtensionWebhookSubscription
    qs = ExtensionWebhookSubscription.objects.filter(organization_id=organization_id)
    if space_id:
        qs = qs.filter(space_id=space_id)

    webhooks = [_serialize_webhook(wh) for wh in qs.order_by("-created_at")]
    return JsonResponse({"ok": True, "webhooks": webhooks})


@csrf_exempt
@require_http_methods(["POST"])
def create_webhook(request):
    """创建 Webhook 订阅。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err

    if ownership_err := _validate_space_ownership(organization_id, body.get("space_id")):
        return ownership_err

    url = (body.get("url") or "").strip()
    if not url:
        return _json_error(_("common.invalid_request"))
    if not url.startswith(("https://", "http://")):
        return _json_error(_("common.invalid_request"))
    if len(url) > 2048:
        return _json_error(_("common.invalid_request"))

    from apps.extensions.delivery import validate_webhook_url
    ssrf_err = validate_webhook_url(url)
    if ssrf_err:
        return _json_error(_("common.invalid_request"))

    event_types = body.get("event_types", [])
    if not isinstance(event_types, list):
        return _json_error(_("common.invalid_request"))
    if event_types and not all(isinstance(et, str) and et.strip() for et in event_types):
        return _json_error(_("common.invalid_request"))

    max_retries = _safe_int(body.get("max_retries", 3), default=3, min_val=0, max_val=MAX_WEBHOOK_RETRIES)

    secret = body.get("secret", "")
    if not isinstance(secret, str):
        return _json_error(_("common.invalid_request"))

    from apps.extensions.models import ExtensionWebhookSubscription
    wh = ExtensionWebhookSubscription.objects.create(
        organization_id=organization_id,
        space_id=body.get("space_id") or None,
        url=url,
        secret=secret,
        event_types=event_types,
        is_active=bool(body.get("is_active", True)),
        max_retries=max_retries,
    )
    return JsonResponse({"ok": True, "webhook": _serialize_webhook(wh)}, status=201)


@csrf_exempt
@require_http_methods(["PUT", "PATCH"])
def update_webhook(request, webhook_id: str):
    """更新 Webhook 订阅。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    from apps.extensions.models import ExtensionWebhookSubscription
    wh = ExtensionWebhookSubscription.objects.filter(id=webhook_id, organization_id=organization_id).first()
    if not wh:
        return _json_error("Webhook not found", 404)

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err
    update_fields = ["updated_at"]

    if "url" in body:
        url = (body["url"] or "").strip()
        if not url:
            return _json_error(_("common.invalid_request"))
        if not url.startswith(("https://", "http://")):
            return _json_error(_("common.invalid_request"))
        if len(url) > 2048:
            return _json_error(_("common.invalid_request"))
        from apps.extensions.delivery import validate_webhook_url
        ssrf_err = validate_webhook_url(url)
        if ssrf_err:
            return _json_error(_("common.invalid_request"))
        wh.url = url
        update_fields.append("url")
    if "secret" in body:
        if not isinstance(body["secret"], str):
            return _json_error(_("common.invalid_request"))
        wh.secret = body["secret"]
        update_fields.append("secret")
    if "event_types" in body:
        et = body["event_types"]
        if not isinstance(et, list):
            return _json_error(_("common.invalid_request"))
        if et and not all(isinstance(e, str) and e.strip() for e in et):
            return _json_error(_("common.invalid_request"))
        wh.event_types = et
        update_fields.append("event_types")
    if "is_active" in body:
        wh.is_active = bool(body["is_active"])
        update_fields.append("is_active")
        if wh.is_active:
            wh.consecutive_failures = 0
            update_fields.append("consecutive_failures")
    if "max_retries" in body:
        wh.max_retries = _safe_int(body["max_retries"], default=wh.max_retries, min_val=0, max_val=MAX_WEBHOOK_RETRIES)
        update_fields.append("max_retries")

    wh.save(update_fields=update_fields)
    return JsonResponse({"ok": True, "webhook": _serialize_webhook(wh)})


@csrf_exempt
@require_http_methods(["DELETE"])
def delete_webhook(request, webhook_id: str):
    """删除 Webhook 订阅。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    from apps.extensions.models import ExtensionWebhookSubscription
    wh = ExtensionWebhookSubscription.objects.filter(id=webhook_id, organization_id=organization_id).first()
    if not wh:
        return _json_error("Webhook not found", 404)

    wh.delete()
    return JsonResponse({"ok": True})


# ---------------------------------------------------------------------------
# EventBus consumers 查询
# ---------------------------------------------------------------------------

@csrf_exempt
@require_http_methods(["GET"])
def list_event_consumers(request):
    """列出所有已注册的事件消费者。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    from apps.extensions.event_bus import EventBus
    consumers = EventBus.list_consumers()
    return JsonResponse({"ok": True, "consumers": consumers})


# ---------------------------------------------------------------------------
# EventLog 查询
# ---------------------------------------------------------------------------

@csrf_exempt
@require_http_methods(["GET"])
def list_event_logs(request):
    """查询事件日志（分页），支持 extension_id / event_type / status 过滤。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    from apps.extensions.models import ExtensionEventLog

    qs = ExtensionEventLog.objects.filter(organization_id=organization_id).order_by("-created_at")

    ext_id = request.GET.get("extension_id")
    if ext_id:
        qs = qs.filter(extension_id=ext_id)
    event_type = request.GET.get("event_type")
    if event_type:
        qs = qs.filter(event_type=event_type)
    status = request.GET.get("status")
    if status:
        qs = qs.filter(status=status)

    limit = _safe_int(request.GET.get("limit", "50"), default=50, min_val=1, max_val=200)
    offset = _safe_int(request.GET.get("offset", "0"), default=0, min_val=0)

    total = qs.count()
    logs = list(qs[offset: offset + limit])

    def _serialize_log(log):
        return {
            "id": str(log.id),
            "extension_id": log.extension_id,
            "connection_id": str(log.connection_id) if log.connection_id else None,
            "organization_id": log.organization_id,
            "space_id": log.space_id,
            "event_type": log.event_type,
            "status": log.status,
            "error_message": log.error_message,
            "created_at": log.created_at.isoformat(),
            "processed_at": log.processed_at.isoformat() if log.processed_at else None,
        }

    return JsonResponse({
        "ok": True,
        "total": total,
        "offset": offset,
        "limit": limit,
        "logs": [_serialize_log(l) for l in logs],
    })


# ---------------------------------------------------------------------------
# 通知规则 API
# ---------------------------------------------------------------------------

def _serialize_rule(rule):
    return {
        "id": str(rule.id),
        "organization_id": rule.organization_id,
        "space_id": rule.space_id,
        "event_pattern": rule.event_pattern,
        "source_extension_id": rule.source_extension_id,
        "channels": rule.channels,
        "priority": rule.priority,
        "category": rule.category,
        "title_template": rule.title_template,
        "body_template": rule.body_template,
        "enabled": rule.enabled,
        "is_system": rule.is_system,
        "sort_order": rule.sort_order,
        "created_at": rule.created_at.isoformat(),
        "updated_at": rule.updated_at.isoformat(),
    }


@csrf_exempt
@require_http_methods(["GET"])
def list_notification_rules(request):
    """列出通知规则。"""
    err, user, organization_id = _require_auth(request, "viewer")
    if err:
        return err

    space_id = request.GET.get("space_id")
    if ownership_err := _validate_space_ownership(organization_id, space_id):
        return ownership_err

    from apps.extensions.models import NotificationRule

    qs = NotificationRule.objects.filter(organization_id=organization_id)
    if space_id:
        qs = qs.filter(models.Q(space_id=space_id) | models.Q(space_id__isnull=True))

    rules = list(qs.order_by("sort_order", "-created_at"))
    return JsonResponse({"ok": True, "rules": [_serialize_rule(r) for r in rules]})


@csrf_exempt
@require_http_methods(["POST"])
def create_notification_rule(request):
    """创建通知规则。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err

    if ownership_err := _validate_space_ownership(organization_id, body.get("space_id")):
        return ownership_err

    from apps.extensions.models import NotificationRule

    event_pattern = body.get("event_pattern", "").strip()
    if not event_pattern:
        return _json_error("event_pattern is required")
    if len(event_pattern) > 200:
        return _json_error(_("common.invalid_request"))

    channels = body.get("channels", ["in_app"])
    if not isinstance(channels, list) or not all(isinstance(c, str) for c in channels):
        return _json_error(_("common.invalid_request"))

    priority = body.get("priority", "normal")
    valid_priorities = {c[0] for c in NotificationRule.PRIORITY_CHOICES}
    if priority not in valid_priorities:
        return _json_error(_("common.invalid_request"))

    title_template = str(body.get("title_template", ""))
    if len(title_template) > 500:
        return _json_error(_("common.invalid_request"))

    body_template = str(body.get("body_template", ""))
    if len(body_template) > 5000:
        return _json_error(_("common.invalid_request"))

    sort_order = _safe_int(body.get("sort_order", 0), default=0, min_val=0, max_val=9999)

    source_ext_id = str(body.get("source_extension_id", ""))
    if len(source_ext_id) > 64:
        return _json_error(_("common.invalid_request"))

    category = str(body.get("category", "general"))
    if len(category) > 64:
        return _json_error(_("common.invalid_request"))

    rule = NotificationRule.objects.create(
        organization_id=organization_id,
        space_id=body.get("space_id") or None,
        event_pattern=event_pattern,
        source_extension_id=source_ext_id,
        channels=channels,
        priority=priority,
        category=category,
        title_template=title_template,
        body_template=body_template,
        enabled=bool(body.get("enabled", True)),
        sort_order=sort_order,
    )
    return JsonResponse({"ok": True, "rule": _serialize_rule(rule)}, status=201)


@csrf_exempt
@require_http_methods(["PATCH"])
def update_notification_rule(request, rule_id: str):
    """更新通知规则。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    from apps.extensions.models import NotificationRule

    try:
        rule = NotificationRule.objects.get(pk=rule_id, organization_id=organization_id)
    except NotificationRule.DoesNotExist:
        return JsonResponse({"ok": False, "error": _("common.not_found")}, status=404)

    body, parse_err = _parse_body(request)
    if parse_err:
        return parse_err

    if rule.is_system and "event_pattern" in body and body["event_pattern"] != rule.event_pattern:
        return JsonResponse({"ok": False, "error": "Cannot change event_pattern of system rule"}, status=400)

    valid_priorities = {c[0] for c in NotificationRule.PRIORITY_CHOICES}
    changed = []

    if "event_pattern" in body:
        ep = str(body["event_pattern"]).strip()
        if not ep or len(ep) > 200:
            return _json_error(_("common.invalid_request"))
        rule.event_pattern = ep
        changed.append("event_pattern")
    if "source_extension_id" in body:
        sei = str(body["source_extension_id"])
        if len(sei) > 64:
            return _json_error(_("common.invalid_request"))
        rule.source_extension_id = sei
        changed.append("source_extension_id")
    if "channels" in body:
        ch = body["channels"]
        if not isinstance(ch, list) or not all(isinstance(c, str) for c in ch):
            return _json_error(_("common.invalid_request"))
        rule.channels = ch
        changed.append("channels")
    if "priority" in body:
        if body["priority"] not in valid_priorities:
            return _json_error(_("common.invalid_request"))
        rule.priority = body["priority"]
        changed.append("priority")
    if "category" in body:
        cat = str(body["category"])
        if len(cat) > 64:
            return _json_error(_("common.invalid_request"))
        rule.category = cat
        changed.append("category")
    if "title_template" in body:
        tt = str(body["title_template"])
        if len(tt) > 500:
            return _json_error(_("common.invalid_request"))
        rule.title_template = tt
        changed.append("title_template")
    if "body_template" in body:
        bt = str(body["body_template"])
        if len(bt) > 5000:
            return _json_error(_("common.invalid_request"))
        rule.body_template = bt
        changed.append("body_template")
    if "enabled" in body:
        rule.enabled = bool(body["enabled"])
        changed.append("enabled")
    if "sort_order" in body:
        rule.sort_order = _safe_int(body["sort_order"], default=rule.sort_order, min_val=0, max_val=9999)
        changed.append("sort_order")

    if changed:
        rule.save(update_fields=changed + ["updated_at"])

    return JsonResponse({"ok": True, "rule": _serialize_rule(rule)})


@csrf_exempt
@require_http_methods(["DELETE"])
def delete_notification_rule(request, rule_id: str):
    """删除通知规则（系统规则不可删）。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    from apps.extensions.models import NotificationRule

    try:
        rule = NotificationRule.objects.get(pk=rule_id, organization_id=organization_id)
    except NotificationRule.DoesNotExist:
        return JsonResponse({"ok": False, "error": _("common.not_found")}, status=404)

    if rule.is_system:
        return JsonResponse({"ok": False, "error": "Cannot delete system rule"}, status=403)

    rule.delete()
    return JsonResponse({"ok": True})


@csrf_exempt
@require_http_methods(["POST"])
def seed_notification_rules(request):
    """为当前 organization 创建系统内置通知规则（幂等）。"""
    err, user, organization_id = _require_auth(request, "editor")
    if err:
        return err

    created = _ensure_system_rules(organization_id)
    return JsonResponse({"ok": True, "created": created})


def _ensure_system_rules(organization_id: str) -> int:
    """幂等创建或更新系统内置规则。

    新规则会被创建；已存在规则的模板字段会被同步更新（保留用户对
    channels / enabled 等字段的自定义修改）。
    """
    from apps.extensions.models import NotificationRule

    SYSTEM_RULES = [
        {
            "event_pattern": "email.received",
            "channels": ["in_app", "desktop"],
            "priority": "normal",
            "category": "email",
            "title_template": "新邮件: {subject}",
            "body_template": "收到来自 {from_address} 的 {new_count} 封新邮件（{account_email}）",
            "sort_order": 10,
        },
        {
            "event_pattern": "email.sent",
            "channels": ["in_app"],
            "priority": "low",
            "category": "email",
            "title_template": "邮件已发送: {subject}",
            "body_template": "已通过 {account_email} 发送邮件",
            "sort_order": 12,
        },
        {
            "event_pattern": "email.draft_created",
            "channels": ["in_app", "desktop"],
            "priority": "normal",
            "category": "email",
            "title_template": "草稿待审批: {subject}",
            "body_template": "Agent 创建了邮件草稿，请审批后发送",
            "sort_order": 11,
        },
        {
            "event_pattern": "email.draft_approved",
            "channels": ["in_app"],
            "priority": "normal",
            "category": "email",
            "title_template": "草稿已审批: {subject}",
            "body_template": "邮件草稿已审批通过，正在发送",
            "sort_order": 13,
        },
        {
            "event_pattern": "email.draft_rejected",
            "channels": ["in_app"],
            "priority": "normal",
            "category": "email",
            "title_template": "草稿已拒绝: {subject}",
            "body_template": "邮件草稿已被拒绝",
            "sort_order": 14,
        },
        {
            "event_pattern": "email.bounced",
            "channels": ["in_app", "desktop"],
            "priority": "high",
            "category": "email",
            "title_template": "邮件退信: {subject}",
            "body_template": "发往 {to} 的邮件被退回: {error}",
            "sort_order": 8,
        },
        {
            "event_pattern": "email.failed",
            "channels": ["in_app", "desktop"],
            "priority": "high",
            "category": "email",
            "title_template": "邮件发送失败: {subject}",
            "body_template": "发送到 {to} 失败: {error}",
            "sort_order": 7,
        },
        {
            "event_pattern": "email.sync_failed",
            "channels": ["in_app"],
            "priority": "normal",
            "category": "email",
            "title_template": "邮箱同步失败",
            "body_template": "{account_email} 同步失败: {error}",
            "sort_order": 15,
        },
        {
            "event_pattern": "scheduler.job.finished",
            "channels": ["in_app"],
            "priority": "low",
            "category": "scheduler",
            "title_template": "任务完成",
            "body_template": "定时任务已执行完成",
            "sort_order": 20,
        },
        {
            "event_pattern": "*.failed",
            "channels": ["in_app", "desktop"],
            "priority": "high",
            "category": "alert",
            "title_template": "执行失败",
            "body_template": "{event_type} 执行失败",
            "sort_order": 5,
        },
        {
            "event_pattern": "*.error",
            "channels": ["in_app", "desktop"],
            "priority": "high",
            "category": "alert",
            "title_template": "发生错误",
            "body_template": "{event_type} 出现错误",
            "sort_order": 5,
        },
        {
            "event_pattern": "telegram.message_received",
            "channels": ["in_app"],
            "priority": "normal",
            "category": "channel",
            "title_template": "Telegram 新消息",
            "body_template": "收到 Telegram 消息",
            "sort_order": 15,
        },
        {
            "event_pattern": "billing.degradation_alert",
            "channels": ["in_app", "desktop"],
            "priority": "high",
            "category": "billing",
            "title_template": "计费降级告警",
            "body_template": "计费系统出现降级: {meter_key} 触发次数 {count}",
            "sort_order": 3,
        },
        {
            "event_pattern": "billing.*",
            "channels": ["in_app"],
            "priority": "normal",
            "category": "billing",
            "title_template": "计费通知",
            "body_template": "{event_type}",
            "sort_order": 18,
        },
    ]

    changed = 0
    _template_fields = ("title_template", "body_template")

    with transaction.atomic(using=postgres_app_db_alias()):
        for rule_data in SYSTEM_RULES:
            existing, was_created = NotificationRule.objects.get_or_create(
                organization_id=organization_id,
                event_pattern=rule_data["event_pattern"],
                is_system=True,
                defaults=rule_data,
            )
            if was_created:
                changed += 1
            else:
                update_fields = []
                for f in _template_fields:
                    if getattr(existing, f, None) != rule_data.get(f):
                        setattr(existing, f, rule_data[f])
                        update_fields.append(f)
                if update_fields:
                    existing.save(update_fields=update_fields)
                    changed += 1

    return changed


# ---------------------------------------------------------------------------
# CLI 命令查询端点（供 tabtin CLI 获取 Extension CLI 声明）
# ---------------------------------------------------------------------------

@csrf_exempt
@require_http_methods(["GET"])
def extension_cli_commands(request):
    """返回所有 Extension CLI 命令声明。

    tabtin CLI 启动时调用此端点，动态注册 Extension CLI 命令。
    无需用户认证（CLI 从本地 Unix Socket / HTTP 调用）。
    """
    from apps.extensions.registry import ExtensionRegistry

    commands = [
        cmd
        for cmd in ExtensionRegistry.get_all_cli_commands()
        if _find_extension_tool(str(cmd.get("extension_id") or ""), str(cmd.get("name") or ""))
    ]
    return JsonResponse({"success": True, "data": {"commands": commands}})


_CLI_HTTP_METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE"}


def _normalize_cli_payload_key(key: Any) -> str:
    text = str(key or "").strip()
    text = text.replace("-", "_")
    text = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", text)
    return text.lower()


_CLI_KEY_ALIASES: Dict[str, str] = {
    "agent_space_id": "space_id",
}


def _normalize_cli_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    normalized: Dict[str, Any] = {}
    for key, value in payload.items():
        normalized_key = _normalize_cli_payload_key(key)
        if normalized_key:
            normalized_key = _CLI_KEY_ALIASES.get(normalized_key, normalized_key)
            normalized[normalized_key] = value
    return normalized


def _find_cli_command(extension_id: str, command_name: str) -> Optional[Dict[str, Any]]:
    from apps.extensions.registry import ExtensionRegistry

    commands = ExtensionRegistry.get_all_cli_commands()
    for cmd in commands:
        if cmd.get("extension_id") == extension_id and cmd.get("name") == command_name:
            return cmd
    return None


def _find_extension_tool(extension_id: str, command_name: str):
    """Locate the Extension tool instance for a CLI command.

    W6 (2026-05-04): tools are pulled directly from ``extension.get_tools()``
    rather than via ``ToolHub`` — the hub no longer holds extension tools.
    """
    from apps.extensions.registry import ExtensionRegistry

    ext = ExtensionRegistry.get(extension_id)
    if not ext:
        return None

    domain = ext.get_tool_domain()
    try:
        tools = ext.get_tools()
    except Exception:
        logger.exception("[ExtensionCLI] %s.get_tools() 抛出异常", extension_id)
        return None
    if not tools:
        return None

    candidates = [
        f"{domain}.{command_name}",
        f"{extension_id}.{command_name}",
        command_name,
    ]
    by_name = {getattr(t, "name", ""): t for t in tools}
    for key in candidates:
        tool = by_name.get(key)
        if tool:
            return tool

    for tool in tools:
        name = getattr(tool, "name", "")
        if name.endswith(f".{command_name}"):
            return tool
    return None


@csrf_exempt
@require_http_methods(["GET", "POST", "PUT", "PATCH", "DELETE"])
def execute_extension_cli_command(request, extension_id: str, command_name: str):
    """执行 Extension CLI 子命令（默认桥接到 Extension Tool）。"""
    role = "viewer" if request.method == "GET" else "editor"
    err, user, organization_id = _require_auth(request, role)
    if err:
        return err

    cli_cmd = _find_cli_command(extension_id, command_name)
    if not cli_cmd:
        return _json_error(_("common.not_found"), 404)

    declared_method = str(cli_cmd.get("method") or "POST").upper()
    if declared_method not in _CLI_HTTP_METHODS:
        return _json_error(_("common.invalid_request"), 400)
    if declared_method != request.method:
        return _json_error(_("common.invalid_request"), 405)

    if request.method == "GET":
        payload: Dict[str, Any] = {k: v for k, v in request.GET.items()}
    else:
        payload, parse_err = _parse_body(request)
        if parse_err:
            return parse_err
    payload = _normalize_cli_payload(payload)
    if ownership_err := _validate_space_ownership(organization_id, payload.get("space_id")):
        return ownership_err

    tool = _find_extension_tool(extension_id, command_name)
    if not tool:
        return _json_error(_("common.not_found"), 404)

    run_kwargs = {
        **payload,
        "user_id": str(user.id),
        "organization_id": organization_id,
        "space_id": payload.get("space_id"),
    }
    try:
        result = tool.run(**run_kwargs)
    except Exception:
        logger.exception("[ExtensionCLI] 执行异常: %s.%s", extension_id, command_name)
        return JsonResponse(
            {
                "success": False,
                "error": {
                    "code": "EXTENSION_CLI_EXEC_FAILED",
                    "message": _("common.internal_error"),
                },
            },
            status=500,
        )

    payload = result
    if isinstance(result, str):
        try:
            parsed = json.loads(result)
        except (TypeError, ValueError, json.JSONDecodeError):
            parsed = None
        if isinstance(parsed, dict):
            payload = parsed

    if is_standard_tool_error(payload):
        return JsonResponse(
            {
                "success": False,
                "error": {
                    "code": "EXTENSION_CLI_TOOL_ERROR",
                    "message": payload.get("error") or _("common.invalid_request"),
                    "error_kind": payload.get("error_kind"),
                    "hint": payload.get("hint"),
                },
                "data": payload,
            },
            status=400,
        )

    if isinstance(payload, dict) and payload.get("status") == "error":
        return JsonResponse(
            {
                "success": False,
                "error": {
                    "code": "EXTENSION_CLI_TOOL_ERROR",
                    "message": payload.get("error") or _("common.invalid_request"),
                    "error_kind": payload.get("error_kind"),
                    "hint": payload.get("hint"),
                },
                "data": payload,
            },
            status=400,
        )

    return JsonResponse({"success": True, "data": result})
