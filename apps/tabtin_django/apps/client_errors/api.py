"""
客户端错误监控 API

- POST /report    — 客户端上报错误（已登录用户）
- POST /report-anonymous — 客户端上报错误（匿名，登录失败等场景）
"""

import hmac
import json
import logging
from datetime import datetime
from typing import List, Optional

from django.core.cache import cache
from django.db import IntegrityError, transaction
from django.db.models import F
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import _
from apps.users.auth.api import jwt_auth

from django.conf import settings as django_settings

from .models import ClientErrorEvent, ClientErrorGroup, Release, SourceMapFile
from .notifications import send_error_webhook

logger = logging.getLogger(__name__)
router = Router()


# ── Schemas ──


class BreadcrumbSchema(Schema):
    type: str = "default"  # click / navigation / http / console / error
    category: str = ""
    message: str = ""
    timestamp: Optional[str] = None
    data: Optional[dict] = None


class ErrorEventSchema(Schema):
    error_type: str
    message: str
    stack_trace: str = ""
    level: str = "error"
    source: str = "renderer"
    file: str = ""
    line: Optional[int] = None
    column: Optional[int] = None
    breadcrumbs: List[BreadcrumbSchema] = []
    app_version: str = ""
    electron_version: str = ""
    os_name: str = ""
    os_version: str = ""
    arch: str = ""
    locale: str = ""
    extra: dict = {}
    occurred_at: Optional[str] = None


class BatchReportSchema(Schema):
    events: List[ErrorEventSchema]


# ── Rate Limiting ──

_ANON_RATE_LIMIT_PREFIX = "client_errors:anon:"
_ANON_RATE_LIMIT_MAX = 10  # 每个 IP 每分钟最多 10 次
_ANON_RATE_LIMIT_WINDOW = 60  # 秒

_USER_RATE_LIMIT_PREFIX = "client_errors:user:"
_USER_RATE_LIMIT_MAX = 100  # 每个用户每分钟最多 100 条事件
_USER_RATE_LIMIT_WINDOW = 60  # 秒


def _get_client_ip(request) -> str:
    from apps.users.auth.utils import get_client_ip

    return get_client_ip(request) or "unknown"


def _check_anon_rate_limit(request) -> bool:
    """检查匿名上报的 IP 级频率限制，返回 True 表示被限流。原子操作。"""
    ip = _get_client_ip(request)
    key = f"{_ANON_RATE_LIMIT_PREFIX}{ip}"
    try:
        current = cache.incr(key)
    except ValueError:
        cache.set(key, 1, _ANON_RATE_LIMIT_WINDOW)
        current = 1
    return current > _ANON_RATE_LIMIT_MAX


def _check_user_rate_limit(user_id: str) -> bool:
    """检查已登录用户的上报频率限制，返回 True 表示被限流。"""
    if not user_id:
        return False
    key = f"{_USER_RATE_LIMIT_PREFIX}{user_id}"
    try:
        current = cache.incr(key)
    except ValueError:
        cache.set(key, 1, _USER_RATE_LIMIT_WINDOW)
        current = 1
    return current > _USER_RATE_LIMIT_MAX


# ── Helpers ──

_EXTRA_MAX_SIZE = 8192  # extra 字段序列化后最大 8KB
_FRONTEND_DEDUP_COUNT_MAX = 1000


def _extract_frontend_dedup_count(extra: dict) -> tuple[int, int | None]:
    """读取前端合并上报的重复错误计数。

    返回 ``(clamped_value, raw_or_none)``。只有发生上限截断时才返回 raw，
    便于调用方记录原始值，同时不修改传入的 ``extra``。
    """
    if not isinstance(extra, dict):
        return 0, None
    value = extra.get("frontend_dedup_count")
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return 0, None
    if value > _FRONTEND_DEDUP_COUNT_MAX:
        return _FRONTEND_DEDUP_COUNT_MAX, value
    return value, None


def _sanitize_extra(extra: dict) -> dict:
    """限制 extra 字段大小，防止滥用。"""
    if not extra:
        return {}
    try:
        serialized = json.dumps(extra, default=str)
        if len(serialized) > _EXTRA_MAX_SIZE:
            return {"_truncated": True, "size": len(serialized)}
    except (TypeError, ValueError):
        return {}
    return extra


_COMPONENT_STACK_MAX = 16384  # 与 stack_trace 同量级；React 组件树通常远小于此


def _extract_component_stack(extra: dict) -> str:
    """从 extra 中抽出 React `componentStack`（ErrorBoundary 上报时塞在 extra 里）。

    历史 SDK 把 componentStack 塞在 extra 里随便上报；现在我们独立成一个字段方便
    admindash 主显示 + 未来可以单独反混淆。这里做向后兼容：
    - 同时支持 `componentStack`（驼峰）和 `component_stack`（下划线）两种 key
    - 抽出来后**不**从 extra 删除，避免破坏老 admindash 客户端的"附加信息"展示
      （新版 admindash 会优先读独立字段，不会重复显示）
    """
    if not extra or not isinstance(extra, dict):
        return ""
    raw = extra.get("componentStack") or extra.get("component_stack") or ""
    if not isinstance(raw, str):
        return ""
    return raw[:_COMPONENT_STACK_MAX]


def _ingest_event(data: ErrorEventSchema, user_id: str = "") -> ClientErrorEvent:
    """将上报数据写入数据库，自动分组。使用事务 + F() 表达式保证并发安全。"""
    occurred_at = timezone.now()
    if data.occurred_at:
        try:
            raw = data.occurred_at.replace("Z", "+00:00")
            occurred_at = datetime.fromisoformat(raw)
        except (ValueError, TypeError):
            pass

    fingerprint = ClientErrorEvent(
        error_type=data.error_type[:128],
        stack_trace=data.stack_trace[:16384],
        message=data.message[:4096],
    ).compute_fingerprint()
    frontend_dedup_count, frontend_dedup_raw = _extract_frontend_dedup_count(data.extra)
    event_count_delta = 1 + frontend_dedup_count
    extra_for_storage = dict(data.extra) if isinstance(data.extra, dict) else {}
    if frontend_dedup_raw is not None:
        extra_for_storage["_frontend_dedup_count_raw"] = frontend_dedup_raw

    reopened = False

    with transaction.atomic(using="postgresql"):
        # savepoint 保护：并发 get_or_create 在 PostgreSQL 中可能因唯一约束
        # 触发 IntegrityError，需要 savepoint 回滚后重新 GET (INFRA-28)
        try:
            with transaction.atomic(using="postgresql"):
                group, created = ClientErrorGroup.objects.get_or_create(
                    fingerprint=fingerprint,
                    defaults={
                        "title": f"{data.error_type[:128]}: {data.message[:256]}",
                        "level": (
                            data.level[:16]
                            if data.level in ("error", "warning", "fatal", "info")
                            else "error"
                        ),
                        "first_seen": occurred_at,
                        "last_seen": occurred_at,
                        "event_count": event_count_delta,
                        "user_count": 1,
                        "sample_stack_trace": data.stack_trace[:4096],
                        "sample_app_version": data.app_version[:64],
                    },
                )
        except IntegrityError:
            group = ClientErrorGroup.objects.using("postgresql").get(
                fingerprint=fingerprint
            )
            created = False

        # 创建事件（直接关联 group）
        event = ClientErrorEvent.objects.create(
            group=group,
            error_type=data.error_type[:128],
            message=data.message[:4096],
            stack_trace=data.stack_trace[:16384],
            component_stack=_extract_component_stack(data.extra),
            level=(
                data.level[:16]
                if data.level in ("error", "warning", "fatal", "info")
                else "error"
            ),
            source=(
                data.source[:32]
                if data.source in ("main", "renderer", "preload")
                else "renderer"
            ),
            file=data.file[:512],
            line=data.line,
            column=data.column,
            breadcrumbs=[b.dict() for b in data.breadcrumbs[-30:]],
            user_id=user_id[:64],
            app_version=data.app_version[:64],
            electron_version=data.electron_version[:32],
            os_name=data.os_name[:32],
            os_version=data.os_version[:64],
            arch=data.arch[:16],
            locale=data.locale[:16],
            extra=_sanitize_extra(extra_for_storage),
            fingerprint=fingerprint,
            occurred_at=occurred_at,
        )

        # 原子更新分组统计（使用 F() 避免竞态）
        if not created:
            update_kwargs = {
                "last_seen": occurred_at,
                "event_count": F("event_count") + event_count_delta,
                "sample_stack_trace": data.stack_trace[:4096],
                "sample_app_version": data.app_version[:64],
            }

            # 已修复的错误再次出现 → 自动 reopen
            if group.status == "resolved":
                update_kwargs["status"] = "open"
                reopened = True
                logger.info(
                    "[ClientErrors] Reopened resolved group #%d: %s",
                    group.pk,
                    group.title[:80],
                )

            # 检查是否为新用户
            if (
                user_id
                and not ClientErrorEvent.objects.filter(
                    fingerprint=fingerprint,
                    user_id=user_id,
                )
                .exclude(pk=event.pk)
                .exists()
            ):
                update_kwargs["user_count"] = F("user_count") + 1

            ClientErrorGroup.objects.filter(pk=group.pk).update(**update_kwargs)

        # 更新 Release 统计（在同一事务内）
        version = data.app_version[:64]
        if version:
            try:
                with transaction.atomic(using="postgresql"):
                    release, rel_created = Release.objects.using(
                        "postgresql"
                    ).get_or_create(
                        app_version=version,
                        defaults={"first_seen": occurred_at, "last_seen": occurred_at},
                    )
            except IntegrityError:
                release = Release.objects.using("postgresql").get(app_version=version)
            rel_update = {
                "last_seen": occurred_at,
                "event_count": F("event_count") + event_count_delta,
            }
            if created:
                rel_update["new_group_count"] = F("new_group_count") + 1
            # 新用户计数（同一版本内去重）
            if (
                user_id
                and not ClientErrorEvent.objects.using("postgresql")
                .filter(
                    app_version=version,
                    user_id=user_id,
                )
                .exclude(pk=event.pk)
                .exists()
            ):
                rel_update["user_count"] = F("user_count") + 1
            Release.objects.using("postgresql").filter(pk=release.pk).update(
                **rel_update
            )

    # 事务提交后异步发送 Webhook 通知（不阻塞 ingest 流程）
    if created:
        send_error_webhook.delay(group.pk, "new_group")
    elif reopened:
        send_error_webhook.delay(group.pk, "reopened")

    return event


# ── Endpoints ──


@router.post("/report", auth=jwt_auth, tags=["Client Errors"])
def report_errors(request, payload: BatchReportSchema):
    """客户端批量上报错误事件（需登录）"""
    user_id = str(request.auth.id) if request.auth else ""
    if _check_user_rate_limit(user_id):
        raise HttpError(429, _("client_errors.rate_limited"))

    count = 0
    for event_data in payload.events[:50]:  # 单次最多 50 条
        try:
            _ingest_event(event_data, user_id=user_id)
            count += 1
        except Exception:
            logger.exception("[ClientErrors] Failed to ingest event")
    return {"success": True, "ingested": count}


@router.post("/report-anonymous", auth=None, tags=["Client Errors"])
def report_errors_anonymous(request, payload: BatchReportSchema):
    """客户端上报错误事件（匿名，登录前/Token 过期等场景）"""
    if _check_anon_rate_limit(request):
        raise HttpError(429, _("client_errors.rate_limited"))

    count = 0
    for event_data in payload.events[:20]:  # 匿名最多 20 条
        try:
            _ingest_event(event_data, user_id="")
            count += 1
        except Exception:
            logger.exception("[ClientErrors] Failed to ingest anonymous event")
    return {"success": True, "ingested": count}


# ── SourceMap 上传（API Key 鉴权，供 CI/CD 使用） ──


class SourceMapUploadSchema(Schema):
    app_version: str
    file_path: str
    map_data: str


def _check_sourcemap_key(request) -> bool:
    """验证 X-Sourcemap-Key 请求头（timing-safe 比较）。"""
    configured_key = getattr(django_settings, "SOURCEMAP_UPLOAD_KEY", "")
    if not configured_key:
        return False
    header = request.META.get("HTTP_X_SOURCEMAP_KEY", "")
    if not header:
        return False
    return hmac.compare_digest(header, configured_key)


@router.post("/upload-sourcemap", auth=None, tags=["Client Errors"])
def upload_sourcemap_ci(request, payload: SourceMapUploadSchema):
    """上传 SourceMap 文件（CI/CD 使用，通过 X-Sourcemap-Key 鉴权）"""
    if not _check_sourcemap_key(request):
        raise HttpError(403, "Invalid or missing X-Sourcemap-Key")

    if not payload.app_version or not payload.file_path:
        raise HttpError(400, "app_version and file_path are required")

    try:
        data = json.loads(payload.map_data)
        if "mappings" not in data:
            raise HttpError(400, "Invalid sourcemap: missing 'mappings' field")
    except (json.JSONDecodeError, TypeError):
        raise HttpError(400, "Invalid sourcemap: not valid JSON")

    obj, created = SourceMapFile.objects.using("postgresql").update_or_create(
        app_version=payload.app_version[:64],
        file_path=payload.file_path[:512],
        defaults={"map_data": payload.map_data},
    )

    return {
        "success": True,
        "created": created,
        "id": obj.id,
        "app_version": obj.app_version,
        "file_path": obj.file_path,
    }
