"""
客户端错误监控 - AdminDash 管理 API

提供错误分组列表、事件详情、统计数据、状态更新等接口。
"""

import json
import logging
from datetime import timedelta
from typing import Optional

from django.core.cache import cache
from django.db.models import Count, Q
from django.db.models.functions import TruncHour, TruncDay
from django.utils import timezone
from ninja import Router, Schema
from ninja.errors import HttpError

from apps.i18n import _
from apps.users.auth.permissions import StaffAuth, SuperuserAuth
from tabtin.pagination import paginate_queryset

from .models import ClientErrorEvent, ClientErrorGroup, Release, SourceMapFile
from .sourcemap_service import resolve_stack_trace

logger = logging.getLogger(__name__)
router = Router(auth=StaffAuth())

# ── 错误分组列表 ──

@router.get("/client-errors/groups", auth=StaffAuth(), tags=["Admin Client Errors"])
def list_error_groups(
    request,
    status: str = "all",
    level: str = "all",
    keyword: str = "",
    page: int = 1,
    page_size: int = 20,
):
    """错误分组列表（支持按状态/级别/关键词筛选）"""

    qs = ClientErrorGroup.objects.using("postgresql").all()

    if status != "all":
        qs = qs.filter(status=status)
    if level != "all":
        qs = qs.filter(level=level)
    if keyword.strip():
        qs = qs.filter(
            Q(title__icontains=keyword.strip())
            | Q(sample_stack_trace__icontains=keyword.strip())
            | Q(fingerprint__icontains=keyword.strip())
        )

    qs = qs.order_by("-last_seen")
    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)

    return {
        "items": [
            {
                "id": g.id,
                "fingerprint": g.fingerprint,
                "title": g.title,
                "level": g.level,
                "status": g.status,
                "first_seen": g.first_seen.isoformat() if g.first_seen else None,
                "last_seen": g.last_seen.isoformat() if g.last_seen else None,
                "event_count": g.event_count,
                "user_count": g.user_count,
                "sample_app_version": g.sample_app_version,
            }
            for g in items
        ],
        "pagination": pagination,
    }

# ── 错误分组详情 ──

# ⚠️ 路由顺序：``GET /client-errors/groups/{group_id}`` 通配符必须在
# ``/groups/batch-status`` 字面量之后注册——否则 PUT batch-status 405。
# 装饰器在文件末尾延后注册（搜 RR-LATE）。
def get_error_group_detail(request, group_id: int):
    """错误分组详情（含示例堆栈）"""

    group = ClientErrorGroup.objects.using("postgresql").filter(id=group_id).first()
    if not group:
        raise HttpError(404, _("client_errors.error_group_not_found"))

    result = {
        "id": group.id,
        "fingerprint": group.fingerprint,
        "title": group.title,
        "level": group.level,
        "status": group.status,
        "first_seen": group.first_seen.isoformat() if group.first_seen else None,
        "last_seen": group.last_seen.isoformat() if group.last_seen else None,
        "event_count": group.event_count,
        "user_count": group.user_count,
        "sample_stack_trace": group.sample_stack_trace,
        "sample_app_version": group.sample_app_version,
    }

    # 尝试还原示例堆栈
    if group.sample_stack_trace and group.sample_app_version:
        try:
            resolved = resolve_stack_trace(group.sample_stack_trace, group.sample_app_version)
            if resolved:
                result["resolved_stack_trace"] = resolved
        except Exception:
            logger.debug("Failed to resolve stack for group %d", group.id)

    # 取该 group 最近一条事件的 component_stack 作为示例（group 表本身不存）
    # 用 .only(...) 限制查询字段，避免拉整条事件回来
    sample_event = (
        ClientErrorEvent.objects.using("postgresql")
        .filter(group=group)
        .exclude(component_stack="")
        .only("component_stack", "app_version")
        .order_by("-occurred_at")
        .first()
    )
    if sample_event:
        result["sample_component_stack"] = sample_event.component_stack
        if sample_event.app_version:
            try:
                resolved_cs = resolve_stack_trace(sample_event.component_stack, sample_event.app_version)
                if resolved_cs:
                    result["resolved_component_stack"] = resolved_cs
            except Exception:
                logger.debug("Failed to resolve component stack for group %d", group.id)

    return result

# ── 错误事件列表 ──

@router.get("/client-errors/groups/{group_id}/events", auth=StaffAuth(), tags=["Admin Client Errors"])
def list_group_events(
    request,
    group_id: int,
    page: int = 1,
    page_size: int = 20,
):
    """某个错误分组下的事件列表"""

    group = ClientErrorGroup.objects.using("postgresql").filter(id=group_id).first()
    if not group:
        raise HttpError(404, _("client_errors.error_group_not_found"))

    qs = ClientErrorEvent.objects.using("postgresql").filter(group=group).order_by("-occurred_at")
    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)

    return {
        "items": [_serialize_event(e) for e in items],
        "pagination": pagination,
    }

# ── 单个事件详情 ──

@router.get("/client-errors/events/{event_id}", auth=StaffAuth(), tags=["Admin Client Errors"])
def get_event_detail(request, event_id: int):
    """单条错误事件详情（含面包屑和设备信息）"""

    event = ClientErrorEvent.objects.using("postgresql").filter(id=event_id).first()
    if not event:
        raise HttpError(404, _("client_errors.error_event_not_found"))

    return _serialize_event(event, include_breadcrumbs=True)

# ── 更新分组状态 ──

class UpdateGroupStatusSchema(Schema):
    status: str  # open / confirmed / resolved / ignored

@router.put("/client-errors/groups/{group_id}/status", auth=SuperuserAuth(), tags=["Admin Client Errors"])
def update_group_status(request, group_id: int, payload: UpdateGroupStatusSchema):
    """更新错误分组处理状态"""

    valid_statuses = {"open", "confirmed", "resolved", "ignored"}
    if payload.status not in valid_statuses:
        raise HttpError(400, f"status 必须为 {', '.join(valid_statuses)} 之一")

    group = ClientErrorGroup.objects.using("postgresql").filter(id=group_id).first()
    if not group:
        raise HttpError(404, _("client_errors.error_group_not_found"))

    group.status = payload.status
    group.save(update_fields=["status", "updated_at"])

    return {"success": True, "message": _("client_errors.status_updated"), "status": group.status}

# ── 批量更新分组状态 ──

class BatchUpdateStatusSchema(Schema):
    group_ids: list[int]
    status: str  # open / confirmed / resolved / ignored

@router.put("/client-errors/groups/batch-status", auth=SuperuserAuth(), tags=["Admin Client Errors"])
def batch_update_group_status(request, payload: BatchUpdateStatusSchema):
    """批量更新错误分组处理状态"""

    valid_statuses = {"open", "confirmed", "resolved", "ignored"}
    if payload.status not in valid_statuses:
        raise HttpError(400, f"status 必须为 {', '.join(valid_statuses)} 之一")

    if not payload.group_ids or len(payload.group_ids) > 100:
        raise HttpError(400, "group_ids 必须为 1-100 个 ID")

    updated = ClientErrorGroup.objects.using("postgresql").filter(
        id__in=payload.group_ids
    ).update(status=payload.status)

    return {"success": True, "updated": updated}

# ── 统计概览 ──

_STATS_CACHE_TTL = 60  # 统计接口缓存 60 秒

@router.get("/client-errors/stats", auth=StaffAuth(), tags=["Admin Client Errors"])
def get_error_stats(request, hours: int = 24):
    """错误统计概览（按时间范围）"""

    hours = max(1, min(hours, 168))  # 最多 7 天

    cache_key = f"client_errors:stats:{hours}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    since = timezone.now() - timedelta(hours=hours)

    events_qs = ClientErrorEvent.objects.using("postgresql").filter(occurred_at__gte=since)
    groups_qs = ClientErrorGroup.objects.using("postgresql").all()

    total_events = events_qs.count()
    affected_users = events_qs.exclude(user_id="").values("user_id").distinct().count()

    by_level = dict(
        events_qs.values("level").annotate(count=Count("id")).values_list("level", "count")
    )

    by_source = dict(
        events_qs.values("source").annotate(count=Count("id")).values_list("source", "count")
    )

    # 按版本分布
    by_version = list(
        events_qs.exclude(app_version="")
        .values("app_version")
        .annotate(count=Count("id"))
        .order_by("-count")[:10]
    )

    # 待处理分组数
    open_groups = groups_qs.filter(status__in=["open", "confirmed"]).count()
    total_groups = groups_qs.count()

    # 时间趋势（按小时或按天，取决于时间跨度）
    if hours <= 48:
        trend = list(
            events_qs.annotate(bucket=TruncHour("occurred_at"))
            .values("bucket")
            .annotate(count=Count("id"))
            .order_by("bucket")
        )
    else:
        trend = list(
            events_qs.annotate(bucket=TruncDay("occurred_at"))
            .values("bucket")
            .annotate(count=Count("id"))
            .order_by("bucket")
        )

    result = {
        "period_hours": hours,
        "total_events": total_events,
        "affected_users": affected_users,
        "by_level": by_level,
        "by_source": by_source,
        "by_version": by_version,
        "open_groups": open_groups,
        "total_groups": total_groups,
        "trend": [
            {"time": item["bucket"].isoformat(), "count": item["count"]}
            for item in trend
        ],
    }

    cache.set(cache_key, result, _STATS_CACHE_TTL)
    return result

# ── Release 版本追踪 ──

@router.get("/client-errors/releases", auth=StaffAuth(), tags=["Admin Client Errors"])
def list_releases(request, page: int = 1, page_size: int = 20):
    """版本列表（按首次出现时间倒序）"""

    qs = Release.objects.using("postgresql").all().order_by("-first_seen")
    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)

    releases = []
    prev_release = None
    # 构建列表并计算与上一版本的对比
    release_list = list(items)
    for i, r in enumerate(release_list):
        entry = {
            "app_version": r.app_version,
            "first_seen": r.first_seen.isoformat() if r.first_seen else None,
            "last_seen": r.last_seen.isoformat() if r.last_seen else None,
            "event_count": r.event_count,
            "new_group_count": r.new_group_count,
            "user_count": r.user_count,
        }
        # 与下一条（即上一个版本）对比
        if i + 1 < len(release_list):
            prev = release_list[i + 1]
            prev_events = prev.event_count or 1
            entry["vs_prev"] = {
                "prev_version": prev.app_version,
                "event_change": r.event_count - prev.event_count,
                "event_change_pct": round((r.event_count - prev.event_count) / prev_events * 100, 1),
                "new_groups_introduced": r.new_group_count,
            }
        releases.append(entry)

    return {"items": releases, "pagination": pagination}

@router.get("/client-errors/releases/{app_version}", auth=StaffAuth(), tags=["Admin Client Errors"])
def get_release_detail(request, app_version: str):
    """单个版本详情（含该版本引入的新错误分组）"""

    release = Release.objects.using("postgresql").filter(app_version=app_version).first()
    if not release:
        raise HttpError(404, "Release not found")

    # 该版本引入的新错误分组（首次出现在这个版本的 group）
    new_groups = list(
        ClientErrorGroup.objects.using("postgresql")
        .filter(sample_app_version=app_version)
        .order_by("-event_count")[:20]
        .values("id", "title", "level", "status", "event_count", "user_count", "first_seen")
    )
    for g in new_groups:
        if g.get("first_seen"):
            g["first_seen"] = g["first_seen"].isoformat()

    # 该版本的错误按级别分布
    by_level = dict(
        ClientErrorEvent.objects.using("postgresql")
        .filter(app_version=app_version)
        .values("level")
        .annotate(count=Count("id"))
        .values_list("level", "count")
    )

    return {
        "app_version": release.app_version,
        "first_seen": release.first_seen.isoformat() if release.first_seen else None,
        "last_seen": release.last_seen.isoformat() if release.last_seen else None,
        "event_count": release.event_count,
        "new_group_count": release.new_group_count,
        "user_count": release.user_count,
        "by_level": by_level,
        "new_groups": new_groups,
    }

# ── SourceMap 管理 ──

class SourceMapUploadSchema(Schema):
    app_version: str
    file_path: str
    map_data: str  # SourceMap JSON 字符串

@router.post("/client-errors/sourcemaps/upload", auth=SuperuserAuth(), tags=["Admin Client Errors"])
def upload_sourcemap(request, payload: SourceMapUploadSchema):
    """上传 SourceMap 文件（CI/CD 构建后调用）"""

    if not payload.app_version or not payload.file_path:
        raise HttpError(400, "app_version and file_path are required")

    # 验证 map_data 是合法 JSON
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

@router.get("/client-errors/sourcemaps", auth=StaffAuth(), tags=["Admin Client Errors"])
def list_sourcemaps(request, app_version: str = "", page: int = 1, page_size: int = 20):
    """查看已上传的 SourceMap 列表"""

    qs = SourceMapFile.objects.using("postgresql").all().order_by("-uploaded_at")
    if app_version:
        qs = qs.filter(app_version=app_version)

    items, pagination = paginate_queryset(qs, page, page_size, max_size=100)

    return {
        "items": [
            {
                "id": s.id,
                "app_version": s.app_version,
                "file_path": s.file_path,
                "uploaded_at": s.uploaded_at.isoformat() if s.uploaded_at else None,
            }
            for s in items
        ],
        "pagination": pagination,
    }

@router.delete("/client-errors/sourcemaps/{sourcemap_id}", auth=SuperuserAuth(), tags=["Admin Client Errors"])
def delete_sourcemap(request, sourcemap_id: int):
    """删除 SourceMap 文件"""

    deleted, _ = SourceMapFile.objects.using("postgresql").filter(id=sourcemap_id).delete()
    if not deleted:
        raise HttpError(404, "SourceMap not found")
    return {"success": True}

# ── Helpers ──

def _serialize_event(event: ClientErrorEvent, include_breadcrumbs: bool = False) -> dict:
    result = {
        "id": event.id,
        "group_id": event.group_id,
        "error_type": event.error_type,
        "message": event.message,
        "stack_trace": event.stack_trace,
        # React 组件栈：定位 React 渲染类错误（ 等）的关键字段，
        # admindash 详情页应放在主区域显著展示。
        "component_stack": event.component_stack,
        "level": event.level,
        "source": event.source,
        "file": event.file,
        "line": event.line,
        "column": event.column,
        "user_id": event.user_id,
        "app_version": event.app_version,
        "electron_version": event.electron_version,
        "os_name": event.os_name,
        "os_version": event.os_version,
        "arch": event.arch,
        "locale": event.locale,
        "occurred_at": event.occurred_at.isoformat() if event.occurred_at else None,
    }
    if include_breadcrumbs:
        result["breadcrumbs"] = event.breadcrumbs
        result["extra"] = event.extra
        # 尝试还原堆栈
        if event.stack_trace and event.app_version:
            try:
                resolved = resolve_stack_trace(event.stack_trace, event.app_version)
                if resolved:
                    result["resolved_stack_trace"] = resolved
            except Exception:
                logger.debug("Failed to resolve stack trace for event %d", event.id)
        # 同步还原 component_stack 里的行号信息
        # （componentStack 通常已经是组件名，但行号是 minified，可还原源码行）
        if event.component_stack and event.app_version:
            try:
                resolved_cs = resolve_stack_trace(event.component_stack, event.app_version)
                if resolved_cs:
                    result["resolved_component_stack"] = resolved_cs
            except Exception:
                logger.debug("Failed to resolve component stack for event %d", event.id)
    return result


# ── RR-LATE: get_error_group_detail ───────────────────────────────
router.get(
    "/client-errors/groups/{group_id}",
    auth=StaffAuth(),
    tags=["Admin Client Errors"],
)(get_error_group_detail)
