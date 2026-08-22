"""
TabDoc Admin 管理 API

说明：
- 仅后台 staff 用户可访问读接口
- 仅后台 superuser 可执行治理写操作

错误响应格式：
- 所有 HttpError 均通过全局异常处理器（users/auth/exceptions.py）
  转为统一的 {success: false, code: str, message: str, data: null} 结构，
  与 api.py 的错误响应格式一致。
"""

from __future__ import annotations

import csv
import io
import logging
from uuid import UUID

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db.models import Case, Count, Exists, IntegerField, OuterRef, Q, Value, When
from django.http import HttpResponse
from django.utils import timezone
from ninja import Query, Router
from ninja.errors import HttpError

from apps.tabtinspace.models import Organization
from apps.tabtinspace.services.host_resolver import host_name_map
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabdoc.models import Document, DocumentAdminActionLog, DocumentPermission, DocumentVersion
from apps.tabdoc.services.document_service import DocumentService
from apps.tabdoc.services import ConflictError
from apps.i18n import _
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth, SuperuserAuth

from .admin_schemas import (
    AdminDocAuditExportRequestSchema,
    AdminDocBatchMutationRequestSchema,
    AdminDocBatchMutationResponseSchema,
    AdminDocBatchSkipItemSchema,
    AdminDocDetailResponseSchema,
    AdminDocDetailStatsSchema,
    AdminDocListItemSchema,
    AdminDocListResponseSchema,
    AdminDocOperationItemSchema,
    AdminDocOperationListResponseSchema,
    AdminDocOperationSummarySchema,
    AdminDocPaginationSchema,
    AdminDocPermissionSchema,
    AdminDocPermissionsUpdateRequestSchema,
    AdminDocPermissionsUpdateResponseSchema,
    AdminDocRestoreRequestSchema,
    AdminDocRestoreResponseSchema,
    AdminDocSensitiveActionRequestSchema,
    AdminDocSummarySchema,
    AdminDocVersionSchema,
)

User = get_user_model()
router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

VALID_DOC_STATUSES = {'active', 'archived', 'trashed'}
VALID_PERMISSION_SUBJECT_TYPES = {'user', 'role'}
VALID_PERMISSION_ROLES = {'viewer', 'editor', 'admin'}
VALID_ACTION_TYPES = {
    'all',
    'batch_archive',
    'batch_restore',
    'single_archive',
    'single_restore',
    'batch_trash',
    'batch_untrash',
    'single_trash',
    'single_untrash',
    'restore_version',
    'update_permissions',
    'audit_export',
}


def _ensure_sensitive_reason(reason: str) -> str:
    normalized = (reason or '').strip()
    if not normalized:
        raise HttpError(400, 'reason 不能为空')
    return normalized


def _build_document_sensitive_snapshot(document: Document) -> dict:
    return {
        'document_id': str(document.id),
        'title': document.title,
        'status': document.status,
        'is_trashed': bool(getattr(document, 'trashed_at', None)),
        'trashed_at': document.trashed_at.isoformat() if getattr(document, 'trashed_at', None) else None,
        'previous_status': getattr(document, 'previous_status', '') or '',
        'organization_id': str(document.organization_id),
        'space_id': str(document.space_id),
        'latest_version': int(document.latest_version or 0),
    }


def _record_doc_sensitive_action(
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
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'documents_preview': before_preview[:20],
    }
    if not before_preview:
        before_json = {'unavailable': True, 'reason': '未能采集文档变更前快照'}
    after_json = {
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'documents_preview': after_preview[:20],
    }
    record_admin_sensitive_action(
        request,
        permission_code=permission_code,
        action=action,
        target_type='doc',
        target_id=target_ids[0] if len(target_ids) == 1 else 'batch',
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_json,
        after_json=after_json,
    )

def _parse_uuid_or_none(raw: str | None) -> UUID | None:
    if not raw:
        return None
    value = raw.strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError as exc:
        raise HttpError(400, _("tabdoc.invalid_uuid", value=raw)) from exc

def _try_parse_uuid(raw: str) -> UUID | None:
    value = raw.strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None

def _extract_user_display_name(user_obj) -> str:
    display_fn = getattr(user_obj, 'get_display_name', None)
    if callable(display_fn):
        return display_fn()
    return user_obj.username or user_obj.email or user_obj.phone or str(user_obj.id)

def _build_user_name_map(user_ids: set[str]) -> dict[str, str]:
    if not user_ids:
        return {}
    return {
        str(item.id): _extract_user_display_name(item)
        for item in User.objects.filter(id__in=user_ids)
    }

def _build_name_maps(
    documents: list[Document],
) -> tuple[dict[str, str], dict[str, str], dict[str, str], dict[str, str]]:
    organization_ids = {str(item.organization_id) for item in documents if item.organization_id}
    space_ids = {str(item.space_id) for item in documents if item.space_id}
    parent_ids = {str(item.parent_id) for item in documents if item.parent_id}
    user_ids = {
        str(item.created_by_id)
        for item in documents
        if item.created_by_id
    } | {
        str(item.updated_by_id)
        for item in documents
        if item.updated_by_id
    }

    organization_name_map = {
        str(item.id): item.name
        for item in Organization.objects.filter(id__in=organization_ids)
    }
    space_name_map = host_name_map(space_ids)
    parent_title_map = {
        str(item.id): item.title
        for item in Document.objects.filter(id__in=parent_ids)
    }
    user_name_map = _build_user_name_map(user_ids)
    return organization_name_map, space_name_map, parent_title_map, user_name_map

def _build_document_item(
    document: Document,
    *,
    organization_name_map: dict[str, str],
    space_name_map: dict[str, str],
    parent_title_map: dict[str, str],
    user_name_map: dict[str, str],
) -> AdminDocListItemSchema:
    document_id = str(document.id)
    organization_id = str(document.organization_id)
    space_id_str = str(document.space_id)
    parent_id = str(document.parent_id) if document.parent_id else None
    created_by_id = str(document.created_by_id) if document.created_by_id else None
    updated_by_id = str(document.updated_by_id) if document.updated_by_id else None

    return AdminDocListItemSchema(
        id=document_id,
        title=document.title,
        status=document.status,
        organization_id=organization_id,
        organization_name=organization_name_map.get(organization_id),
        space_id=space_id_str,
        space_name=space_name_map.get(space_id_str),
        parent_id=parent_id,
        parent_title=parent_title_map.get(parent_id) if parent_id else None,
        latest_version=document.latest_version,
        icon=document.icon or '',
        tags=document.tags or [],
        permission_override_count=getattr(document, 'permission_override_count', 0),
        version_count=getattr(document, 'version_count', 0),
        content_length=len(document.description_plaintext or ''),
        created_by_id=created_by_id,
        created_by_name=user_name_map.get(created_by_id) if created_by_id else None,
        updated_by_id=updated_by_id,
        updated_by_name=user_name_map.get(updated_by_id) if updated_by_id else None,
        is_trashed=bool(getattr(document, 'trashed_at', None)),
        trashed_at=document.trashed_at,
        previous_status=getattr(document, 'previous_status', '') or '',
        created_at=document.created_at,
        updated_at=document.updated_at,
    )

def _normalize_document_ids(raw_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized

def _extract_request_meta(request) -> tuple[str | None, str]:
    from apps.users.auth.utils import get_client_ip
    client_ip = get_client_ip(request)
    meta = getattr(request, 'META', {}) or {}
    user_agent = str(meta.get('HTTP_USER_AGENT', '')).strip()
    return (client_ip or None), user_agent

def _extract_trace_id(request) -> str:
    headers = getattr(request, 'headers', None)
    trace_id = ''
    if headers is not None:
        trace_id = (
            str(headers.get('X-Trace-Id') or '')
            or str(headers.get('X-Request-Id') or '')
        ).strip()
    if trace_id:
        return trace_id[:128]

    meta = getattr(request, 'META', {}) or {}
    trace_id = (
        str(meta.get('HTTP_X_TRACE_ID') or '')
        or str(meta.get('HTTP_X_REQUEST_ID') or '')
    ).strip()
    return trace_id[:128]

def _schema_to_dict(item) -> dict:
    if hasattr(item, 'model_dump'):
        return item.model_dump()
    if hasattr(item, 'dict'):
        return item.dict()
    if isinstance(item, dict):
        return item
    return {}

def _serialize_operation_item(item: DocumentAdminActionLog) -> AdminDocOperationItemSchema:
    target_document_ids = item.target_document_ids if isinstance(item.target_document_ids, list) else []
    normalized_ids = [str(document_id).strip() for document_id in target_document_ids if str(document_id).strip()]
    return AdminDocOperationItemSchema(
        id=str(item.id),
        action_type=item.action_type,
        operator_id=str(item.operator_id) if item.operator_id else None,
        operator_name=item.operator_name or '',
        target_document_ids=normalized_ids,
        requested_count=item.requested_count,
        updated_count=item.updated_count,
        skipped_count=item.skipped_count,
        dry_run=item.dry_run,
        success=item.success,
        result_message=item.result_message or '',
        error_message=item.error_message or '',
        trace_id=item.trace_id or '',
        created_at=item.created_at,
    )

def _record_doc_admin_action(
    *,
    request,
    action_type: str,
    target_document_ids: list[str],
    requested_count: int,
    updated_count: int,
    skipped_count: int,
    dry_run: bool,
    success: bool,
    result_message: str = '',
    error_message: str = '',
    request_payload: dict | None = None,
    result_payload: dict | None = None,
) -> None:
    user = request.auth
    operator_id = None
    if user and getattr(user, 'id', None):
        try:
            operator_id = UUID(str(user.id))
        except (TypeError, ValueError):
            operator_id = None

    operator_name = ''
    if user:
        operator_name = _extract_user_display_name(user)

    normalized_document_ids = _normalize_document_ids([str(item) for item in target_document_ids])
    target_document_ids_text = f"|{'|'.join(normalized_document_ids)}|" if normalized_document_ids else ''
    ip_address, user_agent = _extract_request_meta(request)

    try:
        DocumentAdminActionLog.objects.create(
            action_type=action_type,
            operator_id=operator_id,
            operator_name=operator_name,
            target_document_ids=normalized_document_ids,
            target_document_ids_text=target_document_ids_text,
            requested_count=max(0, requested_count),
            updated_count=max(0, updated_count),
            skipped_count=max(0, skipped_count),
            dry_run=dry_run,
            success=success,
            result_message=result_message or '',
            error_message=error_message or '',
            request_payload=request_payload or {},
            result_payload=result_payload or {},
            trace_id=_extract_trace_id(request),
            ip_address=ip_address,
            user_agent=user_agent or '',
        )
    except Exception:
        logger.exception('写入文档治理日志失败')

def _annotated_document_queryset():
    return Document.objects.annotate(
        permission_override_count=Count(
            'permissions',
            filter=Q(permissions__is_active=True),
            distinct=True,
        ),
        version_count=Count('versions', distinct=True),
    )

def _get_document_or_404(document_uuid: UUID) -> Document:
    document = _annotated_document_queryset().filter(id=document_uuid).first()
    if document is None:
        raise HttpError(404, _("tabdoc.document_not_found"))
    return document

def _serialize_versions(versions: list[DocumentVersion]) -> list[AdminDocVersionSchema]:
    creator_ids = {
        str(item.created_by_id)
        for item in versions
        if item.created_by_id
    }
    creator_name_map = _build_user_name_map(creator_ids)
    return [
        AdminDocVersionSchema(
            id=str(item.id),
            document_id=str(item.document_id),
            version=item.version,
            created_by_id=str(item.created_by_id) if item.created_by_id else None,
            created_by_name=creator_name_map.get(str(item.created_by_id)) if item.created_by_id else None,
            last_saved_at=item.last_saved_at,
            created_at=item.created_at,
        )
        for item in versions
    ]

def _get_merged_recent_versions(document: Document) -> list[AdminDocVersionSchema]:
    """P1-13: 合并 VersionHistory + DocumentVersion 的版本列表，按 created_at 倒序取前 20。"""
    from apps.collab.models import VersionHistory

    merged: list[AdminDocVersionSchema] = []

    vh_rows = list(
        VersionHistory.objects.using("postgresql").filter(
            resource_type="docs", resource_id=str(document.id),
        ).order_by("-created_at")[:20]
    )
    vh_editor_ids = {row.editor_id for row in vh_rows if row.editor_id}
    vh_user_map = _build_user_name_map(vh_editor_ids)
    for row in vh_rows:
        merged.append(AdminDocVersionSchema(
            id=str(row.id),
            document_id=str(row.resource_id),
            version=None,
            created_by_id=row.editor_id or None,
            created_by_name=vh_user_map.get(row.editor_id) if row.editor_id else None,
            last_saved_at=row.created_at,
            created_at=row.created_at,
        ))

    vh_ids = {str(row.id) for row in vh_rows}
    legacy_rows = list(
        DocumentVersion.objects.filter(document_id=document.id)
        .order_by("-created_at")[:20]
    )
    for row in legacy_rows:
        if str(row.id) not in vh_ids:
            merged.append(AdminDocVersionSchema(
                id=str(row.id),
                document_id=str(row.document_id),
                version=row.version,
                created_by_id=str(row.created_by_id) if row.created_by_id else None,
                created_by_name=None,
                last_saved_at=row.last_saved_at,
                created_at=row.created_at,
            ))

    merged.sort(key=lambda x: x.created_at, reverse=True)
    return merged[:20]

def _serialize_permissions(permissions: list[DocumentPermission]) -> list[AdminDocPermissionSchema]:
    creator_ids = {
        str(item.created_by_id)
        for item in permissions
        if item.created_by_id
    }
    creator_name_map = _build_user_name_map(creator_ids)
    return [
        AdminDocPermissionSchema(
            id=str(item.id),
            document_id=str(item.document_id),
            subject_type=item.subject_type,
            subject_id=item.subject_id,
            permission=item.permission,
            is_active=item.is_active,
            created_by_id=str(item.created_by_id) if item.created_by_id else None,
            created_by_name=creator_name_map.get(str(item.created_by_id)) if item.created_by_id else None,
            created_at=item.created_at,
            updated_at=item.updated_at,
        )
        for item in permissions
    ]

def _validate_permission_entries(entries: list[dict]) -> list[dict]:
    normalized_entries: list[dict] = []
    dedup_map: dict[tuple[str, str], dict] = {}

    for entry in entries:
        subject_type = str(entry.get('subject_type', '')).strip().lower()
        subject_id = str(entry.get('subject_id', '')).strip()
        permission = str(entry.get('permission', '')).strip().lower()
        is_active = bool(entry.get('is_active', True))

        if subject_type not in VALID_PERMISSION_SUBJECT_TYPES:
            raise HttpError(400, _("tabdoc.invalid_subject_type"))
        if not subject_id:
            raise HttpError(400, _("tabdoc.subject_id_required"))
        if permission not in VALID_PERMISSION_ROLES:
            raise HttpError(400, _("tabdoc.invalid_permission_role"))

        if subject_type == 'role' and subject_id not in {'owner', 'admin', 'editor', 'viewer'}:
            raise HttpError(400, _("tabdoc.invalid_role_subject_id"))

        dedup_map[(subject_type, subject_id)] = {
            'subject_type': subject_type,
            'subject_id': subject_id,
            'permission': permission,
            'is_active': is_active,
        }

    for key in sorted(dedup_map.keys()):
        normalized_entries.append(dedup_map[key])
    return normalized_entries

@router.get('/docs', response=AdminDocListResponseSchema, auth=StaffAuth(), tags=['后台文档管理'])
def list_admin_docs(
    request,
    keyword: str = '',
    status: str = 'all',
    organization_id: str = '',
    space_id: str = '',
    updated_by_id: str = '',
    has_permission_override: bool | None = Query(None),
    page: int = 1,
    page_size: int = 20,
):
    """后台全局文档列表"""

    status = status.strip().lower()
    if status not in {'all', *VALID_DOC_STATUSES}:
        raise HttpError(400, _("tabdoc.invalid_status_param"))

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = _annotated_document_queryset()

    if status == 'trashed':
        queryset = queryset.filter(trashed_at__isnull=False)
    else:
        queryset = queryset.filter(trashed_at__isnull=True)

    if status != 'all' and status != 'trashed':
        queryset = queryset.filter(status=status)

    organization_uuid = _parse_uuid_or_none(organization_id)
    if organization_uuid:
        queryset = queryset.filter(organization_id=organization_uuid)

    space_uuid = _parse_uuid_or_none(space_id)
    if space_uuid:
        queryset = queryset.filter(space_id=space_uuid)

    normalized_updated_by_id = updated_by_id.strip()
    if normalized_updated_by_id:
        queryset = queryset.filter(updated_by_id=normalized_updated_by_id)

    if has_permission_override is True:
        queryset = queryset.filter(permission_override_count__gt=0)
    elif has_permission_override is False:
        queryset = queryset.filter(permission_override_count=0)

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(title__icontains=normalized_keyword)
            | Q(description_plaintext__icontains=normalized_keyword)
        )
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= Q(id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-updated_at')

    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    documents = list(queryset[offset:offset + page_size])
    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps(documents)

    items = [
        _build_document_item(
            item,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            parent_title_map=parent_title_map,
            user_name_map=user_name_map,
        )
        for item in documents
    ]

    has_active_perm = DocumentPermission.objects.filter(
        document_id=OuterRef('pk'), is_active=True,
    )
    summary_agg = Document.objects.aggregate(
        total_documents=Count('id'),
        active_documents=Count(
            Case(When(status='active', trashed_at__isnull=True, then=Value(1)), output_field=IntegerField())
        ),
        archived_documents=Count(
            Case(When(status='archived', trashed_at__isnull=True, then=Value(1)), output_field=IntegerField())
        ),
        trashed_documents=Count(
            Case(When(trashed_at__isnull=False, then=Value(1)), output_field=IntegerField())
        ),
        documents_with_permission_overrides=Count(
            Case(
                When(Exists(has_active_perm), then=Value(1)),
                output_field=IntegerField(),
            ),
        ),
    )
    summary = AdminDocSummarySchema(
        total_documents=summary_agg['total_documents'],
        filtered_documents=total,
        active_documents=summary_agg['active_documents'],
        archived_documents=summary_agg['archived_documents'],
        trashed_documents=summary_agg['trashed_documents'],
        documents_with_permission_overrides=summary_agg['documents_with_permission_overrides'],
    )

    return AdminDocListResponseSchema(
        items=items,
        pagination=AdminDocPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get(
    '/docs/operations',
    response=AdminDocOperationListResponseSchema,
    auth=StaffAuth(),
    tags=['后台文档管理'],
)
def list_admin_doc_operations(
    request,
    action_type: str = 'all',
    success: bool | None = Query(None),
    keyword: str = '',
    document_id: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台治理动作列表"""

    action_type = action_type.strip().lower()
    if action_type not in VALID_ACTION_TYPES:
        raise HttpError(400, _("tabdoc.invalid_action_type_param"))

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = DocumentAdminActionLog.objects.all()
    if action_type != 'all':
        queryset = queryset.filter(action_type=action_type)

    if success is not None:
        queryset = queryset.filter(success=success)

    document_uuid = _parse_uuid_or_none(document_id)
    if document_uuid:
        queryset = queryset.filter(target_document_ids_text__icontains=f'|{document_uuid}|')

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(action_type__icontains=normalized_keyword)
            | Q(operator_name__icontains=normalized_keyword)
            | Q(result_message__icontains=normalized_keyword)
            | Q(error_message__icontains=normalized_keyword)
            | Q(target_document_ids_text__icontains=normalized_keyword)
            | Q(trace_id__icontains=normalized_keyword)
        )
        keyword_uuid = _try_parse_uuid(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= Q(operator_id=keyword_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-created_at')
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(queryset[offset:offset + page_size])
    items = [_serialize_operation_item(item) for item in rows]

    summary = AdminDocOperationSummarySchema(
        total_operations=total,
        success_operations=queryset.filter(success=True).count(),
        failed_operations=queryset.filter(success=False).count(),
        dry_run_operations=queryset.filter(dry_run=True).count(),
    )

    return AdminDocOperationListResponseSchema(
        items=items,
        pagination=AdminDocPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.post('/docs/audit/export', auth=StaffAuth(), tags=['后台文档管理'])
def export_doc_audit_logs(request, payload: AdminDocAuditExportRequestSchema):
    """导出治理审计日志（CSV）"""

    action_type = payload.action_type.strip().lower()
    if action_type not in VALID_ACTION_TYPES:
        raise HttpError(400, _("tabdoc.invalid_action_type_param"))

    limit = max(1, min(payload.limit, 20000))
    queryset = DocumentAdminActionLog.objects.all()

    if action_type != 'all':
        queryset = queryset.filter(action_type=action_type)
    if payload.success is not None:
        queryset = queryset.filter(success=payload.success)

    document_uuid = _parse_uuid_or_none(payload.document_id)
    if document_uuid:
        queryset = queryset.filter(target_document_ids_text__icontains=f'|{document_uuid}|')

    keyword = payload.keyword.strip() if payload.keyword else ''
    if keyword:
        queryset = queryset.filter(
            Q(action_type__icontains=keyword)
            | Q(operator_name__icontains=keyword)
            | Q(result_message__icontains=keyword)
            | Q(error_message__icontains=keyword)
            | Q(target_document_ids_text__icontains=keyword)
            | Q(trace_id__icontains=keyword)
        )

    rows = list(queryset.order_by('-created_at')[:limit])

    stream = io.StringIO()
    writer = csv.writer(stream)
    writer.writerow(
        [
            'log_id',
            'action_type',
            'operator_id',
            'operator_name',
            'target_document_ids',
            'requested_count',
            'updated_count',
            'skipped_count',
            'dry_run',
            'success',
            'result_message',
            'error_message',
            'trace_id',
            'ip_address',
            'created_at',
        ]
    )

    for item in rows:
        target_document_ids = item.target_document_ids if isinstance(item.target_document_ids, list) else []
        writer.writerow(
            [
                str(item.id),
                item.action_type,
                str(item.operator_id) if item.operator_id else '',
                item.operator_name or '',
                '|'.join([str(doc_id) for doc_id in target_document_ids]),
                item.requested_count,
                item.updated_count,
                item.skipped_count,
                'true' if item.dry_run else 'false',
                'success' if item.success else 'failed',
                item.result_message or '',
                item.error_message or '',
                item.trace_id or '',
                item.ip_address or '',
                timezone.localtime(item.created_at).strftime('%Y-%m-%d %H:%M:%S'),
            ]
        )

    response = HttpResponse(
        '\ufeff' + stream.getvalue(),
        content_type='text/csv; charset=utf-8',
    )
    filename = f'doc_admin_audit_{timezone.localtime().strftime("%Y%m%d_%H%M%S")}.csv'
    response['Content-Disposition'] = f'attachment; filename="{filename}"'

    _record_doc_admin_action(
        request=request,
        action_type='audit_export',
        target_document_ids=[],
        requested_count=0,
        updated_count=0,
        skipped_count=0,
        dry_run=False,
        success=True,
        result_message=_("tabdoc.audit_export_result", count=len(rows)),
        request_payload={
            'action_type': action_type,
            'success': payload.success,
            'keyword': keyword,
            'document_id': payload.document_id,
            'limit': limit,
        },
        result_payload={'count': len(rows)},
    )
    return response

@router.get('/docs/{document_id}', response=AdminDocDetailResponseSchema, auth=StaffAuth(), tags=['后台文档管理'])
def get_admin_doc_detail(request, document_id: str):
    """后台文档详情"""

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps([document])
    item = _build_document_item(
        document,
        organization_name_map=organization_name_map,
        space_name_map=space_name_map,
        parent_title_map=parent_title_map,
        user_name_map=user_name_map,
    )

    # P1-13: 同时查 VersionHistory（主表）和 DocumentVersion（存量旧数据），合并返回
    merged_versions = _get_merged_recent_versions(document)
    permissions = list(
        DocumentPermission.objects.filter(document_id=document.id)
        .order_by('-updated_at')[:200]
    )

    return AdminDocDetailResponseSchema(
        document=item,
        content_raw=document.description_markdown or '',
        content_plaintext=document.description_plaintext or '',
        recent_versions=merged_versions,
        permissions=_serialize_permissions(permissions),
        stats=AdminDocDetailStatsSchema(
            total_versions=document.version_count,
            total_permission_overrides=len(permissions),
            active_permission_overrides=sum(1 for item in permissions if item.is_active),
        ),
    )

def _batch_update_document_status(
    *,
    request,
    payload: AdminDocBatchMutationRequestSchema,
    target_status: str,
    action_type: str,
    permission_code: str,
    sensitive_action: str,
) -> AdminDocBatchMutationResponseSchema:
    reason = _ensure_sensitive_reason(payload.reason) if not payload.dry_run else ''
    ticket_id = (payload.ticket_id or '').strip()
    input_document_ids = _normalize_document_ids(payload.document_ids)
    if not input_document_ids:
        raise HttpError(400, _("tabdoc.batch_min_one_document"))
    if len(input_document_ids) > 500:
        raise HttpError(400, _("tabdoc.batch_max_500_documents"))

    skipped: list[AdminDocBatchSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []

    for raw_id in input_document_ids:
        document_uuid = _try_parse_uuid(raw_id)
        if document_uuid is None:
            skipped.append(AdminDocBatchSkipItemSchema(document_id=raw_id, reason=_("tabdoc.invalid_uuid_reason")))
            continue
        normalized = str(document_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(document_uuid)

    document_map = {
        str(item.id): item
        for item in _annotated_document_queryset().filter(id__in=valid_uuid_list)
    }

    updated_documents: list[Document] = []
    before_snapshots: dict[str, dict] = {}

    try:
        with transaction.atomic(using="postgresql"):
            for document_id in normalized_ids:
                document = document_map.get(document_id)
                if document is None:
                    skipped.append(AdminDocBatchSkipItemSchema(document_id=document_id, reason=_("tabdoc.document_not_found")))
                    continue
                before_snapshots[document_id] = _build_document_sensitive_snapshot(document)

                if getattr(document, 'trashed_at', None):
                    skipped.append(AdminDocBatchSkipItemSchema(document_id=document_id, reason='文档在回收站中，请先使用回收站恢复'))
                    continue

                if document.status == target_status:
                    skipped.append(AdminDocBatchSkipItemSchema(document_id=document_id, reason=_("tabdoc.status_unchanged")))
                    continue

                updated_documents.append(document)
                if payload.dry_run:
                    continue

                document.status = target_status
                document.updated_by = request.auth
                document.save(update_fields=['status', 'updated_by', 'updated_at'])
                if target_status == 'archived':
                    ResourceBridge.on_archive(document, user=request.auth)
                else:
                    ResourceBridge.on_restore(document, user=request.auth)
    except ConflictError as exc:
        raise HttpError(409, str(exc))

    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps(updated_documents)
    items = [
        _build_document_item(
            item,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            parent_title_map=parent_title_map,
            user_name_map=user_name_map,
        )
        for item in updated_documents
    ]

    action_name = '归档' if target_status == 'archived' else '恢复'
    mode_prefix = '模拟' if payload.dry_run else '执行'
    response = AdminDocBatchMutationResponseSchema(
        success=True,
        message=_("tabdoc.batch_operation_result", mode=mode_prefix, action=action_name, success_count=len(items), skip_count=len(skipped)),
        dry_run=payload.dry_run,
        requested_count=len(input_document_ids),
        processed_count=len(items),
        updated_count=len(items),
        skipped=skipped,
        items=items,
    )
    _record_doc_admin_action(
        request=request,
        action_type=action_type,
        target_document_ids=input_document_ids,
        requested_count=len(input_document_ids),
        updated_count=len(items),
        skipped_count=len(skipped),
        dry_run=payload.dry_run,
        success=True,
        result_message=response.message,
        request_payload={
            'document_ids': input_document_ids,
            'dry_run': payload.dry_run,
            'target_status': target_status,
        },
        result_payload={
            'updated_count': len(items),
            'skipped': [_schema_to_dict(item) for item in skipped],
        },
    )
    if not payload.dry_run:
        target_ids = normalized_ids
        _record_doc_sensitive_action(
            request=request,
            permission_code=permission_code,
            action=sensitive_action,
            target_ids=target_ids,
            reason=reason,
            ticket_id=ticket_id,
            affected_count=len(items),
            before_preview=[
                before_snapshots.get(item_id, {'document_id': item_id, 'unavailable': True})
                for item_id in target_ids
            ],
            after_preview=[_build_document_sensitive_snapshot(item) for item in updated_documents],
        )
    return response


def _batch_update_document_trash_state(
    *,
    request,
    payload: AdminDocBatchMutationRequestSchema,
    target_trashed: bool,
    permission_code: str,
    sensitive_action: str,
) -> AdminDocBatchMutationResponseSchema:
    reason = _ensure_sensitive_reason(payload.reason) if not payload.dry_run else ''
    ticket_id = (payload.ticket_id or '').strip()
    input_document_ids = _normalize_document_ids(payload.document_ids)
    if not input_document_ids:
        raise HttpError(400, _("tabdoc.batch_min_one_document"))
    if len(input_document_ids) > 500:
        raise HttpError(400, _("tabdoc.batch_max_500_documents"))

    skipped: list[AdminDocBatchSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []

    for raw_id in input_document_ids:
        document_uuid = _try_parse_uuid(raw_id)
        if document_uuid is None:
            skipped.append(AdminDocBatchSkipItemSchema(document_id=raw_id, reason=_("tabdoc.invalid_uuid_reason")))
            continue
        normalized = str(document_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(document_uuid)

    document_map = {
        str(item.id): item
        for item in _annotated_document_queryset().filter(id__in=valid_uuid_list)
    }

    updated_documents: list[Document] = []
    before_snapshots: dict[str, dict] = {}

    try:
        with transaction.atomic(using="postgresql"):
            for document_id in normalized_ids:
                document = document_map.get(document_id)
                if document is None:
                    skipped.append(AdminDocBatchSkipItemSchema(document_id=document_id, reason=_("tabdoc.document_not_found")))
                    continue
                before_snapshots[document_id] = _build_document_sensitive_snapshot(document)

                is_trashed = bool(getattr(document, 'trashed_at', None))
                if is_trashed == target_trashed:
                    skipped.append(AdminDocBatchSkipItemSchema(document_id=document_id, reason=_("tabdoc.status_unchanged")))
                    continue

                updated_documents.append(document)
                if payload.dry_run:
                    continue

                if target_trashed:
                    document.trash(user_id=getattr(request.auth, 'id', None), save=False)
                    document.updated_by = request.auth
                    document.save(update_fields=[
                        'status', 'trashed_at', 'trashed_by', 'previous_status',
                        'updated_by', 'updated_at',
                    ])
                    ResourceBridge.on_trash(document, user=request.auth)
                else:
                    ResourceBridge.check_restore_quota(document)
                    document.restore_from_trash(save=False)
                    document.updated_by = request.auth
                    document.save(update_fields=[
                        'status', 'trashed_at', 'trashed_by', 'previous_status',
                        'updated_by', 'updated_at',
                    ])
                    ResourceBridge.on_restore(document, user=request.auth)
    except ConflictError as exc:
        raise HttpError(409, str(exc))

    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps(updated_documents)
    items = [
        _build_document_item(
            item,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            parent_title_map=parent_title_map,
            user_name_map=user_name_map,
        )
        for item in updated_documents
    ]

    action_name = '逻辑删除' if target_trashed else '回收站恢复'
    mode_prefix = '模拟' if payload.dry_run else '执行'
    response = AdminDocBatchMutationResponseSchema(
        success=True,
        message=_("tabdoc.batch_operation_result", mode=mode_prefix, action=action_name, success_count=len(items), skip_count=len(skipped)),
        dry_run=payload.dry_run,
        requested_count=len(input_document_ids),
        processed_count=len(items),
        updated_count=len(items),
        skipped=skipped,
        items=items,
    )
    action_type = 'batch_trash' if target_trashed else 'batch_untrash'
    _record_doc_admin_action(
        request=request,
        action_type=action_type,
        target_document_ids=input_document_ids,
        requested_count=len(input_document_ids),
        updated_count=len(items),
        skipped_count=len(skipped),
        dry_run=payload.dry_run,
        success=True,
        result_message=response.message,
        request_payload={
            'document_ids': input_document_ids,
            'dry_run': payload.dry_run,
            'target_trashed': target_trashed,
        },
        result_payload={
            'updated_count': len(items),
            'skipped': [_schema_to_dict(item) for item in skipped],
        },
    )
    if not payload.dry_run:
        target_ids = normalized_ids
        _record_doc_sensitive_action(
            request=request,
            permission_code=permission_code,
            action=sensitive_action,
            target_ids=target_ids,
            reason=reason,
            ticket_id=ticket_id,
            affected_count=len(items),
            before_preview=[
                before_snapshots.get(item_id, {'document_id': item_id, 'unavailable': True})
                for item_id in target_ids
            ],
            after_preview=[_build_document_sensitive_snapshot(item) for item in updated_documents],
        )
    return response


@router.post(
    '/docs/batch/archive',
    response=AdminDocBatchMutationResponseSchema,
    auth=AdminPermissionAuth('doc:delete'),
    tags=['后台文档管理'],
)
def batch_archive_docs(request, payload: AdminDocBatchMutationRequestSchema):
    """批量归档文档。归档为软删除操作，可通过 batch/restore 恢复。"""
    return _batch_update_document_status(
        request=request,
        payload=payload,
        target_status='archived',
        action_type='batch_archive',
        permission_code='doc:delete',
        sensitive_action='doc.archive',
    )

@router.post(
    '/docs/batch/restore',
    response=AdminDocBatchMutationResponseSchema,
    auth=AdminPermissionAuth('doc:restore'),
    tags=['后台文档管理'],
)
def batch_restore_docs(request, payload: AdminDocBatchMutationRequestSchema):
    """批量恢复文档"""
    return _batch_update_document_status(
        request=request,
        payload=payload,
        target_status='active',
        action_type='batch_restore',
        permission_code='doc:restore',
        sensitive_action='doc.restore',
    )


@router.post(
    '/docs/batch/trash',
    response=AdminDocBatchMutationResponseSchema,
    auth=AdminPermissionAuth('doc:delete'),
    tags=['后台文档管理'],
)
def batch_trash_docs(request, payload: AdminDocBatchMutationRequestSchema):
    """批量逻辑删除文档：移入回收站，可通过 untrash 恢复。"""
    return _batch_update_document_trash_state(
        request=request,
        payload=payload,
        target_trashed=True,
        permission_code='doc:delete',
        sensitive_action='doc.trash',
    )


@router.post(
    '/docs/batch/untrash',
    response=AdminDocBatchMutationResponseSchema,
    auth=AdminPermissionAuth('doc:restore'),
    tags=['后台文档管理'],
)
def batch_untrash_docs(request, payload: AdminDocBatchMutationRequestSchema):
    """批量从回收站恢复文档。"""
    return _batch_update_document_trash_state(
        request=request,
        payload=payload,
        target_trashed=False,
        permission_code='doc:restore',
        sensitive_action='doc.untrash',
    )

def _build_single_status_mutation_response(
    document: Document,
    *,
    message: str,
) -> AdminDocRestoreResponseSchema:
    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps([document])
    return AdminDocRestoreResponseSchema(
        success=True,
        message=message,
        document=_build_document_item(
            document,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            parent_title_map=parent_title_map,
            user_name_map=user_name_map,
        ),
    )

@router.post(
    '/docs/{document_id}/status/archive',
    response=AdminDocRestoreResponseSchema,
    auth=AdminPermissionAuth('doc:delete'),
    tags=['后台文档管理'],
)
def archive_admin_doc(request, document_id: str, payload: AdminDocSensitiveActionRequestSchema):
    """单文档归档。⚠️ 语义说明：此操作为软删除（归档），文档状态变为 archived，可通过 restore 恢复。"""
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    before_snapshot = _build_document_sensitive_snapshot(document)
    if getattr(document, 'trashed_at', None):
        raise HttpError(400, '文档在回收站中，请先使用回收站恢复')
    updated_count = 0
    skipped_count = 0
    message = _("tabdoc.document_already_archived")

    if document.status == 'archived':
        skipped_count = 1
    else:
        document.status = 'archived'
        document.updated_by = request.auth
        document.save(update_fields=['status', 'updated_by', 'updated_at'])
        ResourceBridge.on_archive(document, user=request.auth)
        updated_count = 1
        message = _("tabdoc.document_archive_success")

    refreshed = _get_document_or_404(document.id)
    response = _build_single_status_mutation_response(refreshed, message=message)

    _record_doc_admin_action(
        request=request,
        action_type='single_archive',
        target_document_ids=[document_id],
        requested_count=1,
        updated_count=updated_count,
        skipped_count=skipped_count,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={'document_id': document_id},
        result_payload={'status': refreshed.status},
    )
    _record_doc_sensitive_action(
        request=request,
        permission_code='doc:delete',
        action='doc.archive',
        target_ids=[document_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=updated_count,
        before_preview=[before_snapshot],
        after_preview=[_build_document_sensitive_snapshot(refreshed)],
    )
    return response

@router.post(
    '/docs/{document_id}/status/restore',
    response=AdminDocRestoreResponseSchema,
    auth=AdminPermissionAuth('doc:restore'),
    tags=['后台文档管理'],
)
def restore_admin_doc_status(request, document_id: str, payload: AdminDocSensitiveActionRequestSchema):
    """单文档恢复"""
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    before_snapshot = _build_document_sensitive_snapshot(document)
    if getattr(document, 'trashed_at', None):
        raise HttpError(400, '文档在回收站中，请使用回收站恢复')
    updated_count = 0
    skipped_count = 0
    message = _("tabdoc.document_already_active")

    if document.status == 'active':
        skipped_count = 1
    else:
        document.status = 'active'
        document.updated_by = request.auth
        document.save(update_fields=['status', 'updated_by', 'updated_at'])
        ResourceBridge.on_restore(document, user=request.auth)
        updated_count = 1
        message = _("tabdoc.document_restore_success")

    refreshed = _get_document_or_404(document.id)
    response = _build_single_status_mutation_response(refreshed, message=message)

    _record_doc_admin_action(
        request=request,
        action_type='single_restore',
        target_document_ids=[document_id],
        requested_count=1,
        updated_count=updated_count,
        skipped_count=skipped_count,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={'document_id': document_id},
        result_payload={'status': refreshed.status},
    )
    _record_doc_sensitive_action(
        request=request,
        permission_code='doc:restore',
        action='doc.restore',
        target_ids=[document_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=updated_count,
        before_preview=[before_snapshot],
        after_preview=[_build_document_sensitive_snapshot(refreshed)],
    )
    return response


@router.post(
    '/docs/{document_id}/trash',
    response=AdminDocRestoreResponseSchema,
    auth=AdminPermissionAuth('doc:delete'),
    tags=['后台文档管理'],
)
def trash_admin_doc(request, document_id: str, payload: AdminDocSensitiveActionRequestSchema):
    """单文档逻辑删除：移入回收站。"""
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    before_snapshot = _build_document_sensitive_snapshot(document)
    updated_count = 0
    skipped_count = 0
    message = '文档已在回收站'

    if getattr(document, 'trashed_at', None):
        skipped_count = 1
    else:
        document.trash(user_id=getattr(request.auth, 'id', None), save=False)
        document.updated_by = request.auth
        document.save(update_fields=[
            'status', 'trashed_at', 'trashed_by', 'previous_status',
            'updated_by', 'updated_at',
        ])
        ResourceBridge.on_trash(document, user=request.auth)
        updated_count = 1
        message = '文档已逻辑删除'

    refreshed = _get_document_or_404(document.id)
    response = _build_single_status_mutation_response(refreshed, message=message)

    _record_doc_admin_action(
        request=request,
        action_type='single_trash',
        target_document_ids=[document_id],
        requested_count=1,
        updated_count=updated_count,
        skipped_count=skipped_count,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={'document_id': document_id},
        result_payload={'status': refreshed.status, 'trashed_at': refreshed.trashed_at.isoformat() if refreshed.trashed_at else None},
    )
    _record_doc_sensitive_action(
        request=request,
        permission_code='doc:delete',
        action='doc.trash',
        target_ids=[document_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=updated_count,
        before_preview=[before_snapshot],
        after_preview=[_build_document_sensitive_snapshot(refreshed)],
    )
    return response


@router.post(
    '/docs/{document_id}/untrash',
    response=AdminDocRestoreResponseSchema,
    auth=AdminPermissionAuth('doc:restore'),
    tags=['后台文档管理'],
)
def untrash_admin_doc(request, document_id: str, payload: AdminDocSensitiveActionRequestSchema):
    """单文档从回收站恢复。"""
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    before_snapshot = _build_document_sensitive_snapshot(document)
    updated_count = 0
    skipped_count = 0
    message = '文档不在回收站'

    if not getattr(document, 'trashed_at', None):
        skipped_count = 1
    else:
        ResourceBridge.check_restore_quota(document)
        document.restore_from_trash(save=False)
        document.updated_by = request.auth
        document.save(update_fields=[
            'status', 'trashed_at', 'trashed_by', 'previous_status',
            'updated_by', 'updated_at',
        ])
        ResourceBridge.on_restore(document, user=request.auth)
        updated_count = 1
        message = '文档已从回收站恢复'

    refreshed = _get_document_or_404(document.id)
    response = _build_single_status_mutation_response(refreshed, message=message)

    _record_doc_admin_action(
        request=request,
        action_type='single_untrash',
        target_document_ids=[document_id],
        requested_count=1,
        updated_count=updated_count,
        skipped_count=skipped_count,
        dry_run=False,
        success=True,
        result_message=message,
        request_payload={'document_id': document_id},
        result_payload={'status': refreshed.status, 'trashed_at': refreshed.trashed_at.isoformat() if refreshed.trashed_at else None},
    )
    _record_doc_sensitive_action(
        request=request,
        permission_code='doc:restore',
        action='doc.untrash',
        target_ids=[document_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=updated_count,
        before_preview=[before_snapshot],
        after_preview=[_build_document_sensitive_snapshot(refreshed)],
    )
    return response


@router.post(
    '/docs/{document_id}/restore',
    response=AdminDocRestoreResponseSchema,
    auth=AdminPermissionAuth('doc:restore'),
    tags=['后台文档管理'],
)
def restore_admin_doc_version(request, document_id: str, payload: AdminDocRestoreRequestSchema):
    """恢复文档到指定版本"""
    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    document = _get_document_or_404(document_uuid)
    before_snapshot = _build_document_sensitive_snapshot(document)
    if getattr(document, 'trashed_at', None):
        raise HttpError(400, '文档在回收站中，请先使用回收站恢复')

    # P1-13: 优先从 VersionHistory 查找，回退到 DocumentVersion
    from apps.collab.models import VersionHistory

    service = DocumentService(user=request.auth)
    target_version: DocumentVersion | None = None
    target_vh: VersionHistory | None = None

    if payload.version_id:
        version_uuid = _parse_uuid_or_none(payload.version_id)
        if version_uuid is None:
            raise HttpError(400, _("tabdoc.invalid_version_id"))
        target_vh = VersionHistory.objects.using("postgresql").filter(
            id=version_uuid, resource_type="docs", resource_id=str(document.id),
        ).first()
        if not target_vh:
            target_version = DocumentVersion.objects.filter(
                document_id=document.id, id=version_uuid,
            ).first()
    elif payload.version is not None:
        if payload.version <= 0:
            raise HttpError(400, _("tabdoc.version_must_be_positive"))
        target_version = (
            DocumentVersion.objects.filter(document_id=document.id, version=payload.version)
            .order_by('-created_at')
            .first()
        )
    else:
        raise HttpError(400, _("tabdoc.version_or_version_id_required"))

    if target_vh is None and target_version is None:
        raise HttpError(404, _("tabdoc.target_version_not_found"))

    try:
        if target_vh:
            refreshed = service.restore_history(
                document,
                history_id=str(target_vh.id),
            )
            result_version_id = str(target_vh.id)
            result_version = None
        else:
            refreshed = service.restore_to_version_full(
                document,
                target_version,
                skip_permission_check=True,
            )
            result_version_id = str(target_version.id)
            result_version = target_version.version
    except ConflictError as exc:
        raise HttpError(409, str(exc))

    organization_name_map, space_name_map, parent_title_map, user_name_map = _build_name_maps([refreshed])
    response = AdminDocRestoreResponseSchema(
        success=True,
        message=_("tabdoc.version_restore_success"),
        document=_build_document_item(
            refreshed,
            organization_name_map=organization_name_map,
            space_name_map=space_name_map,
            parent_title_map=parent_title_map,
            user_name_map=user_name_map,
        ),
    )
    _record_doc_admin_action(
        request=request,
        action_type='restore_version',
        target_document_ids=[document_id],
        requested_count=1,
        updated_count=1,
        skipped_count=0,
        dry_run=False,
        success=True,
        result_message=response.message,
        request_payload={
            'document_id': document_id,
            'version': payload.version,
            'version_id': payload.version_id,
        },
        result_payload={
            'restored_to_latest_version': refreshed.latest_version,
            'target_version_id': result_version_id,
            'target_version': result_version,
        },
    )
    _record_doc_sensitive_action(
        request=request,
        permission_code='doc:restore',
        action='doc.restore_version',
        target_ids=[document_id],
        reason=reason,
        ticket_id=ticket_id,
        affected_count=1,
        before_preview=[
            {
                **before_snapshot,
                'target_version_id': result_version_id,
                'target_version': result_version,
            }
        ],
        after_preview=[_build_document_sensitive_snapshot(refreshed)],
    )
    return response

@router.post(
    '/docs/{document_id}/permissions',
    response=AdminDocPermissionsUpdateResponseSchema,
    auth=AdminPermissionAuth('doc:permission_update'),
    tags=['后台文档管理'],
)
def update_admin_doc_permissions(request, document_id: str, payload: AdminDocPermissionsUpdateRequestSchema):
    """覆盖更新文档权限（后台权限码控制，必须记录敏感原因）"""

    document_uuid = _try_parse_uuid(document_id)
    if document_uuid is None:
        raise HttpError(400, _("tabdoc.invalid_document_id"))

    reason = _ensure_sensitive_reason(payload.reason)
    ticket_id = (payload.ticket_id or '').strip()
    document = _get_document_or_404(document_uuid)
    before_permissions = list(document.permissions.all().order_by('-updated_at')[:200])
    before_snapshot = {
        'document': _build_document_sensitive_snapshot(document),
        'permissions': [
            {
                'subject_type': item.subject_type,
                'subject_id': item.subject_id,
                'permission': item.permission,
                'is_active': item.is_active,
            }
            for item in before_permissions
        ],
    }
    raw_entries: list[dict] = []
    for entry in payload.entries:
        if hasattr(entry, 'model_dump'):
            raw_entries.append(entry.model_dump())
        elif hasattr(entry, 'dict'):
            raw_entries.append(entry.dict())
        else:
            raw_entries.append(
                {
                    'subject_type': entry.subject_type,
                    'subject_id': entry.subject_id,
                    'permission': entry.permission,
                    'is_active': entry.is_active,
                }
            )

    normalized_entries = _validate_permission_entries(raw_entries)

    with transaction.atomic(using="postgresql"):
        document.permissions.all().delete()
        created_entries: list[DocumentPermission] = []
        for entry in normalized_entries:
            created_entries.append(
                DocumentPermission.objects.create(
                    document=document,
                    subject_type=entry['subject_type'],
                    subject_id=entry['subject_id'],
                    permission=entry['permission'],
                    is_active=entry['is_active'],
                    created_by=request.auth,
                    granted_by=str(request.auth.id) if request.auth else '',
                )
            )

    response = AdminDocPermissionsUpdateResponseSchema(
        success=True,
        message=_("tabdoc.permissions_updated", count=len(created_entries)),
        entries=_serialize_permissions(created_entries),
    )
    after_snapshot = {
        'document': _build_document_sensitive_snapshot(document),
        'permissions': [
            {
                'subject_type': item.subject_type,
                'subject_id': item.subject_id,
                'permission': item.permission,
                'is_active': item.is_active,
            }
            for item in created_entries
        ],
    }
    record_admin_sensitive_action(
        request,
        permission_code='doc:permission_update',
        action='doc.permissions.update',
        target_type='doc',
        target_id=document_id,
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_snapshot,
        after_json=after_snapshot,
    )
    _record_doc_admin_action(
        request=request,
        action_type='update_permissions',
        target_document_ids=[document_id],
        requested_count=len(payload.entries),
        updated_count=len(created_entries),
        skipped_count=0,
        dry_run=False,
        success=True,
        result_message=response.message,
        request_payload={
            'document_id': document_id,
            'entries': raw_entries,
            'reason': reason,
            'ticket_id': ticket_id,
        },
        result_payload={
            'updated_entry_count': len(created_entries),
        },
    )
    return response
