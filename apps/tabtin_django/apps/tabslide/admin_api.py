"""
TabSlide Admin 管理 API

说明：
- 读接口：仅 staff 可访问
- 写接口：仅 superuser 可执行
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db.models import Case, Count, IntegerField, Q, Sum, Value, When
from django.utils import timezone
from ninja import Router
from ninja.errors import HttpError
from pydantic import BaseModel

from apps.services.oss.services.reactivate_utils import StorageQuotaExceededError
from apps.tabslide.models import (
    SlideAdminActionLog,
    SlideChange,
    SlideHistory,
    SlidePage,
    SlideProject,
)
from apps.tabtinspace.models import Organization, Project, Workspace
from apps.tabtinspace.services.host_resolver import host_name_map
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth
from apps.services.common.db_router import postgres_app_db_alias

logger = logging.getLogger(__name__)
User = get_user_model()
router = Router(auth=StaffAuth())

VALID_SLIDE_STATUS = {"all", "active", "archived", "trashed"}
VALID_SLIDE_ATTENTION = {"all", "dirty"}
VALID_OPERATION_ACTION_TYPES = {"all", *[item[0] for item in SlideAdminActionLog.ACTION_TYPE_CHOICES]}

class AdminSlideBatchActionSchema(BaseModel):
    slide_ids: list[str]
    reason: str = ""
    ticket_id: str = ""


class AdminSlideSensitiveActionSchema(BaseModel):
    reason: str = ""
    ticket_id: str = ""


def _ensure_sensitive_reason(reason: str) -> str:
    normalized = (reason or "").strip()
    if not normalized:
        raise HttpError(400, "reason 不能为空")
    return normalized


def _slide_sensitive_snapshot(project: SlideProject) -> dict:
    return {
        "slide_id": str(project.id),
        "name": project.name or "",
        "status": project.status or "",
        "organization_id": str(project.organization_id) if project.organization_id else "",
        "space_id": str(project.space_id) if project.space_id else "",
        "page_count": int(project.page_count or 0),
    }


def _record_slide_sensitive_action(
    *,
    request,
    permission_code: str,
    action: str,
    target_ids: list[str],
    reason: str,
    ticket_id: str,
    affected_count: int,
    before_preview: list[dict],
    after_preview: list[dict],
) -> None:
    if not target_ids:
        return
    before_json: dict = {
        "total_target_count": len(target_ids),
        "target_ids_preview": target_ids[:20],
        "affected_count": affected_count,
        "slides_preview": before_preview[:20],
    }
    if not before_preview:
        before_json = {"unavailable": True, "reason": "未能采集演示文稿变更前快照"}
    after_json = {
        "total_target_count": len(target_ids),
        "target_ids_preview": target_ids[:20],
        "affected_count": affected_count,
        "slides_preview": after_preview[:20],
    }
    record_admin_sensitive_action(
        request,
        permission_code=permission_code,
        action=action,
        target_type="slide",
        target_id=target_ids[0] if len(target_ids) == 1 else "batch",
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_json,
        after_json=after_json,
    )

def _parse_uuid_or_none(raw: str | None, *, field_name: str) -> UUID | None:
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError as exc:
        raise HttpError(400, f"{field_name} 非法，必须是 UUID") from exc

def _try_parse_uuid(raw: str | None) -> UUID | None:
    if not raw:
        return None
    try:
        return UUID(str(raw).strip())
    except (TypeError, ValueError):
        return None

def _extract_user_display_name(user_obj) -> str:
    display_fn = getattr(user_obj, "get_display_name", None)
    if callable(display_fn):
        return display_fn()
    return user_obj.username or user_obj.email or user_obj.phone or str(user_obj.id)

def _normalize_batch_ids(raw_ids: list[str] | None, *, field_name: str) -> list[str]:
    values: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids or []:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        values.append(value)

    if not values:
        raise HttpError(400, f"{field_name} 不能为空")
    if len(values) > 100:
        raise HttpError(400, f"{field_name} 单次最多处理 100 个")
    return values

def _build_batch_result(
    *,
    noun: str,
    action: str,
    requested_ids: list[str],
    updated_ids: list[str],
    skipped_ids: list[str],
    failed_items: list[dict[str, str]],
) -> dict:
    return {
        "message": (
            f"{noun}{action}完成：成功 {len(updated_ids)}，"
            f"跳过 {len(skipped_ids)}，失败 {len(failed_items)}"
        ),
        "requested_count": len(requested_ids),
        "updated_count": len(updated_ids),
        "skipped_count": len(skipped_ids),
        "failed_count": len(failed_items),
        "updated_ids": updated_ids,
        "skipped_ids": skipped_ids,
        "failed": failed_items,
        "updated_at": timezone.now(),
    }

def _extract_request_meta(request) -> tuple[str | None, str]:
    from apps.users.auth.utils import get_client_ip
    client_ip = get_client_ip(request)
    meta = getattr(request, "META", {}) or {}
    user_agent = str(meta.get("HTTP_USER_AGENT", "")).strip()
    return (client_ip or None), user_agent

def _extract_trace_id(request) -> str:
    headers = getattr(request, "headers", None)
    trace_id = ""
    if headers is not None:
        trace_id = (
            str(headers.get("X-Trace-Id") or "")
            or str(headers.get("X-Request-Id") or "")
        ).strip()
    if trace_id:
        return trace_id[:128]

    meta = getattr(request, "META", {}) or {}
    trace_id = (
        str(meta.get("HTTP_X_TRACE_ID") or "")
        or str(meta.get("HTTP_X_REQUEST_ID") or "")
    ).strip()
    return trace_id[:128]

def _summarize_failed_items(failed_items: list[dict[str, str]]) -> str:
    if not failed_items:
        return ""
    return "；".join(
        f"{str(item.get('id') or '').strip()}：{str(item.get('message') or '').strip()}"
        for item in failed_items[:3]
    )

def _serialize_operation_item(item: SlideAdminActionLog) -> dict:
    target_slide_ids = item.target_slide_ids if isinstance(item.target_slide_ids, list) else []
    normalized_target_ids = [
        str(slide_id).strip() for slide_id in target_slide_ids if str(slide_id).strip()
    ]
    result_payload = item.result_payload if isinstance(item.result_payload, dict) else {}
    failed_items = result_payload.get("failed") if isinstance(result_payload.get("failed"), list) else []
    normalized_failed = [
        {
            "id": str(entry.get("id") or "").strip(),
            "message": str(entry.get("message") or "").strip(),
        }
        for entry in failed_items
        if str(entry.get("id") or "").strip() or str(entry.get("message") or "").strip()
    ]
    skipped_ids = [
        str(value).strip()
        for value in (result_payload.get("skipped_ids") or [])
        if str(value).strip()
    ]
    updated_ids = [
        str(value).strip()
        for value in (result_payload.get("updated_ids") or [])
        if str(value).strip()
    ]
    derived_failed_count = max(0, int(item.requested_count or 0) - int(item.updated_count or 0) - int(item.skipped_count or 0))
    raw_failed_count = result_payload.get("failed_count")
    failed_count = raw_failed_count if isinstance(raw_failed_count, int) else 0
    failed_count = max(failed_count, len(normalized_failed), derived_failed_count)

    return {
        "id": str(item.id),
        "action_type": item.action_type,
        "operator_id": str(item.operator_id) if item.operator_id else None,
        "operator_name": item.operator_name or "",
        "target_slide_ids": normalized_target_ids,
        "requested_count": int(item.requested_count or 0),
        "updated_count": int(item.updated_count or 0),
        "skipped_count": int(item.skipped_count or 0),
        "failed_count": failed_count,
        "dry_run": bool(item.dry_run),
        "success": bool(item.success),
        "result_message": item.result_message or "",
        "error_message": item.error_message or "",
        "trace_id": item.trace_id or "",
        "updated_ids": updated_ids,
        "skipped_ids": skipped_ids,
        "failed": normalized_failed,
        "created_at": item.created_at,
    }

def _serialize_operation_detail(item: SlideAdminActionLog) -> dict:
    request_payload = item.request_payload if isinstance(item.request_payload, dict) else {}
    result_payload = item.result_payload if isinstance(item.result_payload, dict) else {}
    return {
        **_serialize_operation_item(item),
        "request_payload": request_payload,
        "result_payload": result_payload,
        "ip_address": str(item.ip_address) if item.ip_address else "",
        "user_agent": item.user_agent or "",
    }

def _record_slide_admin_action(
    *,
    request,
    action_type: str,
    target_slide_ids: list[str],
    requested_count: int,
    updated_count: int,
    skipped_count: int,
    dry_run: bool,
    success: bool,
    result_message: str = "",
    error_message: str = "",
    request_payload: dict | None = None,
    result_payload: dict | None = None,
) -> SlideAdminActionLog | None:
    user = request.auth
    operator_id = None
    if user and getattr(user, "id", None):
        try:
            operator_id = UUID(str(user.id))
        except (TypeError, ValueError):
            operator_id = None

    operator_name = _extract_user_display_name(user) if user else ""
    normalized_slide_ids: list[str] = []
    seen: set[str] = set()
    for raw in target_slide_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized_slide_ids.append(value)

    target_slide_ids_text = f"|{'|'.join(normalized_slide_ids)}|" if normalized_slide_ids else ""
    ip_address, user_agent = _extract_request_meta(request)

    try:
        return SlideAdminActionLog.objects.create(
            action_type=action_type,
            operator_id=operator_id,
            operator_name=operator_name,
            target_slide_ids=normalized_slide_ids,
            target_slide_ids_text=target_slide_ids_text,
            requested_count=max(0, requested_count),
            updated_count=max(0, updated_count),
            skipped_count=max(0, skipped_count),
            dry_run=dry_run,
            success=success,
            result_message=result_message or "",
            error_message=error_message or "",
            request_payload=request_payload or {},
            result_payload=result_payload or {},
            trace_id=_extract_trace_id(request),
            ip_address=ip_address,
            user_agent=user_agent or "",
        )
    except Exception:
        logger.exception("写入演示文稿治理日志失败")
        return None

def _build_user_name_map(user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    return {
        str(item.id): _extract_user_display_name(item)
        for item in User.objects.filter(id__in=user_ids)
    }

def _build_name_maps(
    projects: list[SlideProject],
) -> tuple[dict[str, str], dict[str, str], dict[str, str]]:
    organization_ids = {str(item.organization_id) for item in projects if item.organization_id}
    space_ids = {str(item.space_id) for item in projects if item.space_id}
    user_ids = {
        str(item.created_by_id)
        for item in projects
        if item.created_by_id
    } | {
        str(item.updated_by_id)
        for item in projects
        if item.updated_by_id
    }

    organization_name_map = {
        str(item.id): item.name
        for item in Organization.objects.filter(id__in=organization_ids)
    }
    space_name_map = host_name_map(space_ids)
    user_name_map = _build_user_name_map(user_ids)
    return organization_name_map, space_name_map, user_name_map

def _serialize_slide_item(
    project: SlideProject,
    *,
    organization_name_map: dict[str, str],
    space_name_map: dict[str, str],
    user_name_map: dict[str, str],
) -> dict:
    organization_id = str(project.organization_id)
    space_id_str = str(project.space_id)
    created_by_id = str(project.created_by_id) if project.created_by_id else None
    updated_by_id = str(project.updated_by_id) if project.updated_by_id else None

    return {
        "id": str(project.id),
        "name": project.name,
        "status": project.status,
        "preset": project.preset,
        "page_count": int(project.page_count or 0),
        "latest_version": int(project.latest_version or 0),
        "organization_id": organization_id,
        "organization_name": organization_name_map.get(organization_id),
        "space_id": space_id_str,
        "space_name": space_name_map.get(space_id_str),
        "created_by_id": created_by_id,
        "created_by_name": user_name_map.get(created_by_id) if created_by_id else None,
        "updated_by_id": updated_by_id,
        "updated_by_name": user_name_map.get(updated_by_id) if updated_by_id else None,
        "last_editor_type": project.last_editor_type or "",
        "last_editor_id": project.last_editor_id or "",
        "thumbnail": project.thumbnail or "",
        "pptx_dirty": bool(project.pptx_dirty),
        "dirty_page_count": len(project.dirty_page_ids or []),
        "history_count": int(getattr(project, "history_count", 0) or 0),
        "change_count": int(getattr(project, "change_count", 0) or 0),
        "is_trashed": bool(project.trashed_at),
        "created_at": project.created_at,
        "updated_at": project.updated_at,
    }

def _serialize_slide_history(history: SlideHistory) -> dict:
    return {
        "id": str(history.id),
        "version": int(history.version or 0),
        "page_count": int(history.page_count or 0),
        "editor_type": history.editor_type or "",
        "editor_id": history.editor_id or "",
        "is_snapshot": bool(history.is_snapshot),
        "is_named": bool(history.is_named),
        "name": history.name or "",
        "pinned": bool(history.pinned),
        "created_at": history.created_at,
    }

def _serialize_slide_change(change: SlideChange) -> dict:
    return {
        "id": str(change.id),
        "version": int(change.version or 0),
        "change_type": change.change_type,
        "summary": change.summary or "",
        "pages_affected": change.pages_affected or [],
        "editor_type": change.editor_type or "",
        "editor_id": change.editor_id or "",
        "created_at": change.created_at,
    }

def _serialize_slide_page(page: SlidePage) -> dict:
    return {
        "id": str(page.id),
        "page_id": page.page_id,
        "order": page.order,
        "version": int(page.version or 0),
        "content_format": page.content_format,
        "element_count": len(page.elements_data or []),
        "updated_at": page.updated_at,
    }

def _deactivate_slide_file_usages(project: SlideProject) -> None:
    try:
        from apps.services.oss.services.deactivate_utils import (
            deactivate_file_usages_and_release_storage,
        )

        deactivate_file_usages_and_release_storage(
            module="tabslide",
            context_filter={"context_id": str(project.id)},
            organization_id=str(project.organization_id),
            user_id=str(project.created_by_id or ""),
            biz_type="tabslide_admin_archive_release",
            biz_id=str(project.id),
            log_prefix="TabSlide Admin 归档",
        )
    except Exception:
        logger.exception("TabSlide Admin 归档清理 FileUsage 失败: project=%s", project.id)

def _reactivate_slide_file_usages(project: SlideProject) -> None:
    try:
        from apps.services.oss.services.reactivate_utils import (
            reactivate_file_usages_and_restore_storage,
        )

        result = reactivate_file_usages_and_restore_storage(
            module="tabslide",
            context_filter={"context_id": str(project.id)},
            organization_id=str(project.organization_id),
            user_id=str(project.created_by_id or ""),
            biz_type="tabslide_admin_restore_storage",
            biz_id=str(project.id),
            log_prefix="TabSlide Admin 恢复",
        )
        if result.has_failures:
            logger.warning(
                "TabSlide Admin 恢复 FileUsage 部分失败: project=%s failed=%s",
                project.id,
                len(result.failed_files),
            )
    except StorageQuotaExceededError:
        raise
    except Exception:
        logger.exception("TabSlide Admin 恢复 FileUsage 失败: project=%s", project.id)

def _get_slide_or_404(slide_id: str) -> SlideProject:
    project = SlideProject.objects.filter(id=slide_id).first()
    if not project:
        raise HttpError(404, "演示文稿不存在")
    return project

def _archive_slide_project(project: SlideProject, operator) -> bool:
    if project.trashed_at:
        raise HttpError(400, "回收站中的演示文稿请先恢复后再归档")
    if project.status == "archived":
        return False

    project.status = "archived"
    project.updated_by = operator
    project.save(update_fields=["status", "updated_by", "updated_at"])
    ResourceBridge.on_archive(project, user=operator)
    _deactivate_slide_file_usages(project)
    return True

def _restore_slide_project(project: SlideProject, operator) -> bool:
    if project.trashed_at:
        ResourceBridge.check_restore_quota(project)
        project.restore_from_trash()
        project.updated_by = operator
        project.save(
            update_fields=[
                "status",
                "trashed_at",
                "trashed_by",
                "previous_status",
                "updated_by",
                "updated_at",
            ]
        )
        ResourceBridge.on_restore(project, user=operator)
        _reactivate_slide_file_usages(project)
        return True

    if project.status == "archived":
        project.status = "active"
        project.updated_by = operator
        project.save(update_fields=["status", "updated_by", "updated_at"])
        ResourceBridge.on_restore(project, user=operator)
        _reactivate_slide_file_usages(project)
        return True

    return False

def _build_filtered_slide_queryset(
    *,
    keyword: str = "",
    status: str = "all",
    attention: str = "all",
    organization_id: str = "",
    organization_query: str = "",
    space_id: str = "",
    space_query: str = "",
    updated_by_id: str = "",
):
    queryset = SlideProject.objects.all()

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        maybe_uuid = _try_parse_uuid(normalized_keyword)
        query = Q(name__icontains=normalized_keyword)
        if maybe_uuid:
            query |= Q(id=maybe_uuid)
        queryset = queryset.filter(query)

    normalized_status = status.strip() or "all"
    if normalized_status not in VALID_SLIDE_STATUS:
        raise HttpError(400, f"不支持的状态筛选：{status}")
    if normalized_status == "trashed":
        queryset = queryset.filter(trashed_at__isnull=False)
    elif normalized_status != "all":
        queryset = queryset.filter(status=normalized_status, trashed_at__isnull=True)

    normalized_attention = attention.strip() or "all"
    if normalized_attention not in VALID_SLIDE_ATTENTION:
        raise HttpError(400, f"不支持的风险筛选：{attention}")
    if normalized_attention == "dirty":
        queryset = queryset.filter(pptx_dirty=True)

    if organization_id:
        parsed_organization_id = _parse_uuid_or_none(organization_id, field_name="organization_id")
        if parsed_organization_id:
            queryset = queryset.filter(organization_id=parsed_organization_id)

    if organization_query.strip():
        organization_ids = list(
            Organization.objects.filter(name__icontains=organization_query.strip()).values_list("id", flat=True)
        )
        queryset = queryset.filter(organization_id__in=organization_ids or [UUID(int=0)])

    if space_id:
        parsed_space_id = _parse_uuid_or_none(space_id, field_name="space_id")
        if parsed_space_id:
            queryset = queryset.filter(space_id=parsed_space_id)

    if space_query.strip():
        matching_space_ids = list(
            list(Workspace.objects.filter(name__icontains=space_query.strip()).values_list("id", flat=True))
            + list(Project.objects.filter(name__icontains=space_query.strip()).values_list("id", flat=True))
        )
        queryset = queryset.filter(space_id__in=matching_space_ids or [UUID(int=0)])

    if updated_by_id:
        parsed_updated_by_id = _parse_uuid_or_none(updated_by_id, field_name="updated_by_id")
        if parsed_updated_by_id:
            queryset = queryset.filter(updated_by_id=parsed_updated_by_id)

    return queryset

@router.get("/slides", auth=StaffAuth(), summary="管理员查看全局演示文稿列表")
def admin_list_slides(
    request,
    keyword: str = "",
    status: str = "all",
    attention: str = "all",
    organization_id: str = "",
    organization_query: str = "",
    space_id: str = "",
    space_query: str = "",
    updated_by_id: str = "",
    page: int = 1,
    page_size: int = 20,
):

    page = max(1, page)
    page_size = max(1, min(page_size, 100))

    queryset = _build_filtered_slide_queryset(
        keyword=keyword,
        status=status,
        attention=attention,
        organization_id=organization_id,
        organization_query=organization_query,
        space_id=space_id,
        space_query=space_query,
        updated_by_id=updated_by_id,
    )
    total = queryset.count()

    summary_agg = queryset.aggregate(
        active_projects=Count(Case(
            When(status="active", trashed_at__isnull=True, then=Value(1)),
            output_field=IntegerField(),
        )),
        archived_projects=Count(Case(
            When(status="archived", trashed_at__isnull=True, then=Value(1)),
            output_field=IntegerField(),
        )),
        trashed_projects=Count(Case(
            When(trashed_at__isnull=False, then=Value(1)),
            output_field=IntegerField(),
        )),
        dirty_projects=Count(Case(
            When(pptx_dirty=True, then=Value(1)),
            output_field=IntegerField(),
        )),
        total_pages=Sum("page_count"),
    )
    summary = {
        "total_projects": total,
        "active_projects": summary_agg["active_projects"],
        "archived_projects": summary_agg["archived_projects"],
        "trashed_projects": summary_agg["trashed_projects"],
        "dirty_projects": summary_agg["dirty_projects"],
        "total_pages": int(summary_agg["total_pages"] or 0),
    }

    offset = (page - 1) * page_size
    projects = list(
        queryset.annotate(
            history_count=Count("histories", distinct=True),
            change_count=Count("changes", distinct=True),
        )
        .order_by("-updated_at")[offset : offset + page_size]
    )
    organization_name_map, space_name_map, user_name_map = _build_name_maps(projects)

    total_pages = max(1, (total + page_size - 1) // page_size)
    return {
        "summary": summary,
        "items": [
            _serialize_slide_item(
                item,
                organization_name_map=organization_name_map,
                space_name_map=space_name_map,
                user_name_map=user_name_map,
            )
            for item in projects
        ],
        "pagination": {
            "page": page,
            "page_size": page_size,
            "total": total,
            "total_pages": total_pages,
        },
    }

@router.get("/slides/operations", auth=StaffAuth(), summary="管理员查看演示文稿治理日志")
def admin_list_slide_operations(
    request,
    action_type: str = "all",
    success: bool | None = None,
    keyword: str = "",
    slide_id: str = "",
    operation_id: str = "",
    page: int = 1,
    page_size: int = 20,
):

    normalized_action_type = action_type.strip().lower()
    if normalized_action_type not in VALID_OPERATION_ACTION_TYPES:
        raise HttpError(400, f"不支持的治理动作筛选：{action_type}")

    page = max(1, page)
    page_size = max(1, min(page_size, 100))

    queryset = SlideAdminActionLog.objects.all()
    if normalized_action_type != "all":
        queryset = queryset.filter(action_type=normalized_action_type)
    if success is not None:
        queryset = queryset.filter(success=success)

    normalized_operation_id = operation_id.strip()
    if normalized_operation_id:
        operation_uuid = _parse_uuid_or_none(normalized_operation_id, field_name="operation_id")
        if not operation_uuid:
            raise HttpError(400, "operation_id 非法，必须是 UUID")
        queryset = queryset.filter(id=operation_uuid)

    normalized_slide_id = slide_id.strip()
    if normalized_slide_id:
        slide_uuid = _parse_uuid_or_none(normalized_slide_id, field_name="slide_id")
        if slide_uuid:
            queryset = queryset.filter(target_slide_ids_text__icontains=f"|{slide_uuid}|")

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(action_type__icontains=normalized_keyword)
            | Q(operator_name__icontains=normalized_keyword)
            | Q(result_message__icontains=normalized_keyword)
            | Q(error_message__icontains=normalized_keyword)
            | Q(target_slide_ids_text__icontains=normalized_keyword)
            | Q(trace_id__icontains=normalized_keyword)
        )
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= Q(operator_id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by("-created_at")
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(queryset[offset : offset + page_size])

    return {
        "items": [_serialize_operation_item(item) for item in rows],
        "pagination": {
            "total": total,
            "page": page,
            "page_size": page_size,
            "total_pages": total_pages,
        },
        "summary": {
            "total_operations": total,
            "success_operations": queryset.filter(success=True).count(),
            "failed_operations": queryset.filter(success=False).count(),
            "dry_run_operations": queryset.filter(dry_run=True).count(),
        },
    }

@router.get("/slides/operations/{operation_id}", auth=StaffAuth(), summary="管理员查看演示文稿治理日志详情")
def admin_get_slide_operation_detail(request, operation_id: str):

    operation_uuid = _parse_uuid_or_none(operation_id, field_name="operation_id")
    if not operation_uuid:
        raise HttpError(400, "operation_id 非法，必须是 UUID")

    operation = SlideAdminActionLog.objects.filter(id=operation_uuid).first()
    if not operation:
        raise HttpError(404, "治理日志不存在")

    return {"operation": _serialize_operation_detail(operation)}

@router.get("/slides/{slide_id}", auth=StaffAuth(), summary="管理员查看演示文稿详情")
def admin_get_slide_detail(request, slide_id: str):

    project = (
        SlideProject.objects.annotate(
            history_count=Count("histories", distinct=True),
            change_count=Count("changes", distinct=True),
        )
        .filter(id=slide_id)
        .first()
    )
    if not project:
        raise HttpError(404, "演示文稿不存在")

    organization_name_map, space_name_map, user_name_map = _build_name_maps([project])
    slide_payload = _serialize_slide_item(
        project,
        organization_name_map=organization_name_map,
        space_name_map=space_name_map,
        user_name_map=user_name_map,
    )
    slide_payload.update(
        {
            "canvas_width": project.canvas_width,
            "canvas_height": project.canvas_height,
            "theme": project.theme or {},
            "font_meta": project.font_meta or {},
            "pptx_oss_url": project.pptx_oss_url or "",
            "previous_status": project.previous_status or "",
        }
    )

    pages = list(SlidePage.objects.using(postgres_app_db_alias()).filter(project=project).order_by("order")[:20])
    recent_histories = list(
        SlideHistory.objects.using(postgres_app_db_alias()).filter(project=project).order_by("-created_at")[:8]
    )
    recent_changes = list(
        SlideChange.objects.using(postgres_app_db_alias()).filter(project=project).order_by("-created_at")[:8]
    )

    return {
        "slide": slide_payload,
        "stats": {
            "history_count": int(getattr(project, "history_count", 0) or 0),
            "change_count": int(getattr(project, "change_count", 0) or 0),
            "page_count": int(project.page_count or 0),
            "dirty_page_count": len(project.dirty_page_ids or []),
            "named_history_count": SlideHistory.objects.using(postgres_app_db_alias()).filter(project=project, is_named=True).count(),
        },
        "pages": [_serialize_slide_page(item) for item in pages],
        "recent_histories": [_serialize_slide_history(item) for item in recent_histories],
        "recent_changes": [_serialize_slide_change(item) for item in recent_changes],
    }

@router.post("/slides/{slide_id}/status/archive", auth=AdminPermissionAuth("slide:delete"), summary="管理员归档演示文稿")
def admin_archive_slide(request, slide_id: str, payload: AdminSlideSensitiveActionSchema):
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or "").strip()

    try:
        project = _get_slide_or_404(slide_id)
        before_snapshot = _slide_sensitive_snapshot(project)
        updated = _archive_slide_project(project, request.auth)
    except HttpError as exc:
        _record_slide_admin_action(
            request=request,
            action_type="single_archive",
            target_slide_ids=[slide_id],
            requested_count=1,
            updated_count=0,
            skipped_count=0,
            dry_run=False,
            success=False,
            error_message=str(exc),
            request_payload={"slide_id": slide_id},
            result_payload={"failed_count": 1},
        )
        raise

    message = "演示文稿已归档" if updated else "演示文稿已处于归档状态"
    operation = _record_slide_admin_action(
        request=request,
        action_type="single_archive",
        target_slide_ids=[slide_id],
        requested_count=1,
        updated_count=1 if updated else 0,
        skipped_count=0 if updated else 1,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={"slide_id": slide_id},
        result_payload={
            "updated": updated,
            "updated_ids": [slide_id] if updated else [],
            "skipped_ids": [] if updated else [slide_id],
            "failed_count": 0,
        },
    )
    _record_slide_sensitive_action(
        request=request,
        permission_code="slide:delete",
        action="slide.archive",
        target_ids=[slide_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=1 if updated else 0,
        before_preview=[before_snapshot],
        after_preview=[_slide_sensitive_snapshot(_get_slide_or_404(slide_id))],
    )

    return {
        "message": message,
        "updated_at": timezone.now(),
        "operation_id": str(operation.id) if operation else None,
    }

@router.post("/slides/{slide_id}/status/restore", auth=AdminPermissionAuth("slide:restore"), summary="管理员恢复演示文稿")
def admin_restore_slide(request, slide_id: str, payload: AdminSlideSensitiveActionSchema):
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or "").strip()

    try:
        project = _get_slide_or_404(slide_id)
        before_snapshot = _slide_sensitive_snapshot(project)
        updated = _restore_slide_project(project, request.auth)
    except StorageQuotaExceededError as exc:
        _record_slide_admin_action(
            request=request,
            action_type="single_restore",
            target_slide_ids=[slide_id],
            requested_count=1,
            updated_count=0,
            skipped_count=0,
            dry_run=False,
            success=False,
            error_message=str(exc),
            request_payload={"slide_id": slide_id},
            result_payload={"failed_count": 1},
        )
        raise HttpError(422, str(exc)) from exc
    except HttpError as exc:
        _record_slide_admin_action(
            request=request,
            action_type="single_restore",
            target_slide_ids=[slide_id],
            requested_count=1,
            updated_count=0,
            skipped_count=0,
            dry_run=False,
            success=False,
            error_message=str(exc),
            request_payload={"slide_id": slide_id},
            result_payload={"failed_count": 1},
        )
        raise

    message = "演示文稿已恢复" if updated else "演示文稿已处于可用状态"
    operation = _record_slide_admin_action(
        request=request,
        action_type="single_restore",
        target_slide_ids=[slide_id],
        requested_count=1,
        updated_count=1 if updated else 0,
        skipped_count=0 if updated else 1,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={"slide_id": slide_id},
        result_payload={
            "updated": updated,
            "updated_ids": [slide_id] if updated else [],
            "skipped_ids": [] if updated else [slide_id],
            "failed_count": 0,
        },
    )
    _record_slide_sensitive_action(
        request=request,
        permission_code="slide:restore",
        action="slide.restore",
        target_ids=[slide_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=1 if updated else 0,
        before_preview=[before_snapshot],
        after_preview=[_slide_sensitive_snapshot(_get_slide_or_404(slide_id))],
    )

    return {
        "message": message,
        "updated": updated,
        "updated_at": timezone.now(),
        "operation_id": str(operation.id) if operation else None,
    }

@router.post("/slides/batch/archive", auth=AdminPermissionAuth("slide:delete"), summary="管理员批量归档演示文稿")
def admin_batch_archive_slides(request, body: AdminSlideBatchActionSchema):
    reason = _ensure_sensitive_reason(body.reason)
    ticket_id = (body.ticket_id or "").strip()

    requested_ids = _normalize_batch_ids(body.slide_ids, field_name="slide_ids")
    project_map = {
        str(item.id): item
        for item in SlideProject.objects.filter(id__in=requested_ids)
    }
    updated_ids: list[str] = []
    skipped_ids: list[str] = []
    failed_items: list[dict[str, str]] = []

    before_snapshots = {
        slide_id: _slide_sensitive_snapshot(project)
        for slide_id, project in project_map.items()
    }

    for slide_id in requested_ids:
        project = project_map.get(slide_id)
        if not project:
            failed_items.append({"id": slide_id, "message": "演示文稿不存在"})
            continue

        try:
            changed = _archive_slide_project(project, request.auth)
            if changed:
                updated_ids.append(slide_id)
            else:
                skipped_ids.append(slide_id)
        except HttpError as exc:
            failed_items.append({"id": slide_id, "message": str(exc)})

    response = _build_batch_result(
        noun="演示文稿",
        action="归档",
        requested_ids=requested_ids,
        updated_ids=updated_ids,
        skipped_ids=skipped_ids,
        failed_items=failed_items,
    )
    operation = _record_slide_admin_action(
        request=request,
        action_type="batch_archive",
        target_slide_ids=requested_ids,
        requested_count=len(requested_ids),
        updated_count=len(updated_ids),
        skipped_count=len(skipped_ids),
        dry_run=False,
        success=not failed_items,
        result_message=response["message"],
        error_message=_summarize_failed_items(failed_items),
        request_payload={"slide_ids": requested_ids},
        result_payload={
            **response,
            "updated_at": response["updated_at"].isoformat() if response.get("updated_at") else None,
        },
    )
    refreshed_map = {
        str(item.id): item
        for item in SlideProject.objects.filter(id__in=requested_ids)
    }
    _record_slide_sensitive_action(
        request=request,
        permission_code="slide:delete",
        action="slide.archive",
        target_ids=requested_ids,
        reason=reason,
        ticket_id=ticket_id,
        affected_count=len(updated_ids),
        before_preview=[
            before_snapshots.get(item_id, {"slide_id": item_id, "unavailable": True})
            for item_id in requested_ids
        ],
        after_preview=[
            _slide_sensitive_snapshot(refreshed_map[item_id])
            for item_id in requested_ids
            if item_id in refreshed_map
        ],
    )
    response["operation_id"] = str(operation.id) if operation else None
    return response

@router.post("/slides/batch/restore", auth=AdminPermissionAuth("slide:restore"), summary="管理员批量恢复演示文稿")
def admin_batch_restore_slides(request, body: AdminSlideBatchActionSchema):
    reason = _ensure_sensitive_reason(body.reason)
    ticket_id = (body.ticket_id or "").strip()

    requested_ids = _normalize_batch_ids(body.slide_ids, field_name="slide_ids")
    project_map = {
        str(item.id): item
        for item in SlideProject.objects.filter(id__in=requested_ids)
    }
    updated_ids: list[str] = []
    skipped_ids: list[str] = []
    failed_items: list[dict[str, str]] = []

    before_snapshots = {
        slide_id: _slide_sensitive_snapshot(project)
        for slide_id, project in project_map.items()
    }

    for slide_id in requested_ids:
        project = project_map.get(slide_id)
        if not project:
            failed_items.append({"id": slide_id, "message": "演示文稿不存在"})
            continue

        try:
            changed = _restore_slide_project(project, request.auth)
            if changed:
                updated_ids.append(slide_id)
            else:
                skipped_ids.append(slide_id)
        except (HttpError, StorageQuotaExceededError) as exc:
            failed_items.append({"id": slide_id, "message": str(exc)})

    response = _build_batch_result(
        noun="演示文稿",
        action="恢复",
        requested_ids=requested_ids,
        updated_ids=updated_ids,
        skipped_ids=skipped_ids,
        failed_items=failed_items,
    )
    operation = _record_slide_admin_action(
        request=request,
        action_type="batch_restore",
        target_slide_ids=requested_ids,
        requested_count=len(requested_ids),
        updated_count=len(updated_ids),
        skipped_count=len(skipped_ids),
        dry_run=False,
        success=not failed_items,
        result_message=response["message"],
        error_message=_summarize_failed_items(failed_items),
        request_payload={"slide_ids": requested_ids},
        result_payload={
            **response,
            "updated_at": response["updated_at"].isoformat() if response.get("updated_at") else None,
        },
    )
    refreshed_map = {
        str(item.id): item
        for item in SlideProject.objects.filter(id__in=requested_ids)
    }
    _record_slide_sensitive_action(
        request=request,
        permission_code="slide:restore",
        action="slide.restore",
        target_ids=requested_ids,
        reason=reason,
        ticket_id=ticket_id,
        affected_count=len(updated_ids),
        before_preview=[
            before_snapshots.get(item_id, {"slide_id": item_id, "unavailable": True})
            for item_id in requested_ids
        ],
        after_preview=[
            _slide_sensitive_snapshot(refreshed_map[item_id])
            for item_id in requested_ids
            if item_id in refreshed_map
        ],
    )
    response["operation_id"] = str(operation.id) if operation else None
    return response
