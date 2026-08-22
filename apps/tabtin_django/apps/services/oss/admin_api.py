"""
OSS 后台治理 API

说明：
- 读接口：仅 staff 可访问
- 写接口：仅 superuser 可执行
- 路由挂载到 /api/auth/admin/oss/*
"""

from __future__ import annotations

import logging
from uuid import UUID

from django.db.models import Count, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils import timezone
from ninja import Query, Router
from ninja.errors import HttpError
from urllib.parse import urlparse

from apps.services.billing.models import OrganizationStorageUsage
from apps.services.common.exceptions import ConfigurationException
from apps.users.auth.admin_audit import record_admin_sensitive_action
from apps.users.auth.permissions import AdminPermissionAuth, StaffAuth

from .admin_schemas import (
    AdminOssBatchDeleteRequestSchema,
    AdminOssBatchDeleteResponseSchema,
    AdminOssBatchDeleteSkipItemSchema,
    AdminOssBatchRepairOrganizationRequestSchema,
    AdminOssBatchRepairOrganizationResponseSchema,
    AdminOssBatchRepairOrganizationResultSchema,
    AdminOssCostOverviewResponseSchema,
    AdminOssCostSummarySchema,
    AdminOssFileDetailResponseSchema,
    AdminOssFileItemSchema,
    AdminOssFileListResponseSchema,
    AdminOssFileSummarySchema,
    AdminOssFileUsageItemSchema,
    AdminOssOperationItemSchema,
    AdminOssOperationListResponseSchema,
    AdminOssOperationSummarySchema,
    AdminOssPaginationSchema,
    AdminOssReferenceItemSchema,
    AdminOssTaskItemSchema,
    AdminOssTaskListResponseSchema,
    AdminOssTaskSummarySchema,
    AdminOssOrganizationRepairAssessmentSchema,
    AdminOssOrganizationCostItemSchema,
)
from .models import FileRecord, OSSAdminActionLog, UploadTask
from .services.factory import get_oss_service

router = Router(auth=StaffAuth())
logger = logging.getLogger(__name__)

VALID_FILE_TYPES = {'all', 'image', 'document', 'video', 'audio', 'archive', 'other'}
VALID_FILE_STATUS = {'all', 'uploading', 'completed', 'failed', 'deleted'}
VALID_TASK_TYPES = {'all', 'single', 'batch', 'chunk'}
VALID_TASK_STATUS = {'all', 'pending', 'processing', 'completed', 'failed', 'cancelled'}
VALID_OPERATION_ACTION_TYPES = {'all', *[item[0] for item in OSSAdminActionLog.ACTION_TYPE_CHOICES]}
VALID_REPAIR_STATES = {
    'all',
    'repairable',
    'conflict',
    'insufficient_evidence',
    'lookup_error',
    'owned',
    'deleted',
}
REPAIR_REASON_ALREADY_OWNED = 'already_owned'
REPAIR_REASON_FILE_DELETED = 'file_deleted'
REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR = 'attachment_reference_lookup_error'
REPAIR_REASON_MULTIPLE_REFERENCES = 'multiple_reference_organizations'
REPAIR_REASON_MULTIPLE_UPLOAD_TASKS = 'multiple_upload_task_organizations'
REPAIR_REASON_CROSS_SOURCE_CONFLICT = 'cross_source_organization_conflict'
REPAIR_REASON_UNIQUE_REFERENCE = 'unique_reference_organization'
REPAIR_REASON_UNIQUE_UPLOAD_TASK = 'unique_upload_task_organization'
REPAIR_REASON_UNIQUE_DUAL_EVIDENCE = 'unique_reference_and_upload_task_organization'
REPAIR_REASON_MISSING_EVIDENCE = 'missing_organization_evidence'
VALID_REPAIR_REASON_CODES = {
    'all',
    REPAIR_REASON_ALREADY_OWNED,
    REPAIR_REASON_FILE_DELETED,
    REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR,
    REPAIR_REASON_MULTIPLE_REFERENCES,
    REPAIR_REASON_MULTIPLE_UPLOAD_TASKS,
    REPAIR_REASON_CROSS_SOURCE_CONFLICT,
    REPAIR_REASON_UNIQUE_REFERENCE,
    REPAIR_REASON_UNIQUE_UPLOAD_TASK,
    REPAIR_REASON_UNIQUE_DUAL_EVIDENCE,
    REPAIR_REASON_MISSING_EVIDENCE,
}
_REPAIR_EVAL_CHUNK_SIZE = 500

REPAIR_ACTION_NOOP = 'no_action_needed'
REPAIR_ACTION_AUTO_REPAIR = 'auto_repair'
REPAIR_ACTION_REVIEW_REFERENCE_CONFLICT = 'review_reference_conflict'
REPAIR_ACTION_REVIEW_UPLOAD_TASK_CONFLICT = 'review_upload_task_conflict'
REPAIR_ACTION_REVIEW_CROSS_SOURCE_CONFLICT = 'review_cross_source_conflict'
REPAIR_ACTION_BACKFILL_EVIDENCE = 'backfill_organization_evidence'
REPAIR_ACTION_RETRY_REFERENCE_LOOKUP = 'retry_reference_lookup'


def _ensure_sensitive_reason(*, dry_run: bool, reason: str) -> str:
    if dry_run:
        return ''
    normalized = (reason or '').strip()
    if not normalized:
        raise HttpError(400, 'reason 不能为空')
    return normalized


def _mask_path_like(value: str) -> str:
    normalized = (value or '').strip()
    if not normalized:
        return ''
    parts = [segment for segment in normalized.split('/') if segment]
    if not parts:
        return '***'
    tail = parts[-1]
    if len(tail) > 8:
        tail = f"{tail[:4]}***{tail[-2:]}"
    return f"***/{tail}"


def _mask_url(value: str) -> str:
    normalized = (value or '').strip()
    if not normalized:
        return ''
    parsed = urlparse(normalized)
    if not parsed.scheme or not parsed.netloc:
        return _mask_path_like(normalized)
    return f"{parsed.scheme}://{parsed.netloc}/***"


def _build_asset_sensitive_snapshot(file_record: FileRecord) -> dict:
    return {
        'file_id': str(file_record.id),
        'file_name': file_record.file_name,
        'status': file_record.status,
        'organization_id': str(getattr(file_record, 'organization_id', '') or ''),
        'masked_file_key': _mask_path_like(str(file_record.file_key or '')),
        'masked_file_path': _mask_path_like(str(file_record.file_path or '')),
        'masked_file_url': _mask_url(str(getattr(file_record, 'file_url', '') or '')),
    }


def _record_asset_sensitive_action(
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
    extra: dict | None = None,
) -> None:
    if not target_ids:
        return
    before_json: dict = {
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'assets_preview': before_preview[:20],
    }
    if not before_preview:
        before_json = {'unavailable': True, 'reason': '未能采集资源变更前快照'}
    after_json = {
        'total_target_count': len(target_ids),
        'target_ids_preview': target_ids[:20],
        'affected_count': affected_count,
        'assets_preview': after_preview[:20],
    }
    if extra:
        before_json.update(extra)
        after_json.update(extra)
    record_admin_sensitive_action(
        request,
        permission_code=permission_code,
        action=action,
        target_type='asset',
        target_id=target_ids[0] if len(target_ids) == 1 else 'batch',
        reason=reason,
        ticket_id=ticket_id,
        before_json=before_json,
        after_json=after_json,
    )

def _parse_uuid_or_none(raw: str | None) -> UUID | None:
    if not raw:
        return None
    value = str(raw).strip()
    if not value:
        return None
    try:
        return UUID(value)
    except ValueError:
        return None

def _normalize_file_ids(raw_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized

def _normalize_organization_ids(raw_ids: list[str]) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        value = str(raw).strip()
        if not value or value in seen:
            continue
        seen.add(value)
        normalized.append(value)
    return normalized

def _extract_operator_display_name(user_obj) -> str:
    display_fn = getattr(user_obj, 'get_display_name', None)
    if callable(display_fn):
        return display_fn()
    return (
        getattr(user_obj, 'username', None)
        or getattr(user_obj, 'email', None)
        or getattr(user_obj, 'phone', None)
        or str(getattr(user_obj, 'id', ''))
    )

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

def _serialize_operation_item(item: OSSAdminActionLog) -> AdminOssOperationItemSchema:
    target_file_ids = item.target_file_ids if isinstance(item.target_file_ids, list) else []
    normalized_ids = [str(file_id).strip() for file_id in target_file_ids if str(file_id).strip()]
    organization_ids = item.organization_ids if isinstance(item.organization_ids, list) else []
    normalized_organization_ids = _normalize_organization_ids(
        [str(organization_id) for organization_id in organization_ids]
    )

    return AdminOssOperationItemSchema(
        id=str(item.id),
        action_type=item.action_type,
        operator_id=str(item.operator_id) if item.operator_id else None,
        operator_name=item.operator_name or '',
        organization_id=str(item.organization_id or '').strip(),
        organization_ids=normalized_organization_ids,
        target_file_ids=normalized_ids,
        requested_count=int(item.requested_count or 0),
        processed_count=int(item.processed_count or 0),
        deleted_count=int(item.deleted_count or 0),
        skipped_count=int(item.skipped_count or 0),
        dry_run=item.dry_run,
        success=item.success,
        message=item.message or '',
        error_message=item.error_message or '',
        trace_id=item.trace_id or '',
        created_at=item.created_at,
    )

def _record_oss_admin_action(
    *,
    request,
    action_type: str,
    target_file_ids: list[str],
    requested_count: int,
    processed_count: int,
    deleted_count: int,
    skipped_count: int,
    dry_run: bool,
    success: bool,
    message: str = '',
    error_message: str = '',
    request_payload: dict | None = None,
    result_payload: dict | None = None,
    organization_ids_override: list[str] | None = None,
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
        operator_name = _extract_operator_display_name(user)

    normalized_file_ids = _normalize_file_ids([str(item) for item in target_file_ids])
    target_file_ids_text = f"|{'|'.join(normalized_file_ids)}|" if normalized_file_ids else ''
    if organization_ids_override is None:
        organization_ids = _derive_organization_ids_from_files(normalized_file_ids)
    else:
        organization_ids = _normalize_organization_ids([str(item) for item in organization_ids_override])
    organization_ids_text = f"|{'|'.join(organization_ids)}|" if organization_ids else ''
    organization_id = organization_ids[0] if len(organization_ids) == 1 else ''
    ip_address, user_agent = _extract_request_meta(request)

    try:
        OSSAdminActionLog.objects.create(
            action_type=action_type,
            operator_id=operator_id,
            operator_name=operator_name,
            organization_id=organization_id,
            organization_ids=organization_ids,
            organization_ids_text=organization_ids_text,
            target_file_ids=normalized_file_ids,
            target_file_ids_text=target_file_ids_text,
            requested_count=max(0, requested_count),
            processed_count=max(0, processed_count),
            deleted_count=max(0, deleted_count),
            skipped_count=max(0, skipped_count),
            dry_run=dry_run,
            success=success,
            message=message or '',
            error_message=error_message or '',
            request_payload=request_payload or {},
            result_payload=result_payload or {},
            trace_id=_extract_trace_id(request),
            ip_address=ip_address,
            user_agent=user_agent,
        )
    except Exception:
        logger.exception('写入 OSS 后台治理日志失败')

def _extract_organization_space(metadata: dict | None) -> tuple[str | None, str | None]:
    if not isinstance(metadata, dict):
        return None, None
    organization_id = str(metadata.get('organization_id', '')).strip()
    space_id = str(metadata.get('space_id', '')).strip()
    return organization_id or None, space_id or None

def _extract_file_organization_id(file_record: FileRecord) -> str | None:
    direct_organization_id = str(getattr(file_record, 'organization_id', '') or '').strip()
    if direct_organization_id:
        return direct_organization_id
    metadata_organization_id, _ = _extract_organization_space(file_record.metadata)
    return metadata_organization_id

def _build_unowned_file_filter() -> Q:
    """
    仅筛出没有 organization 归属的文件。

    需要同时兼容：
    1. 新链路直接写入 FileRecord.organization_id
    2. 旧链路只把 organization_id 放进 metadata
    """
    return (
        (Q(organization_id='') | Q(organization_id__isnull=True))
        & (Q(metadata__organization_id='') | Q(metadata__organization_id__isnull=True))
    )

def _derive_organization_ids_from_files(target_file_ids: list[str]) -> list[str]:
    file_ids: list[UUID] = []
    for raw_file_id in target_file_ids:
        file_uuid = _parse_uuid_or_none(raw_file_id)
        if file_uuid is not None:
            file_ids.append(file_uuid)

    if not file_ids:
        return []

    organization_ids: list[str] = []
    for file_record in FileRecord.objects.filter(id__in=file_ids).only('organization_id', 'metadata'):
        organization_id = _extract_file_organization_id(file_record)
        if organization_id:
            organization_ids.append(organization_id)
    return _normalize_organization_ids(organization_ids)

def _collect_attachment_reference_organization_ids_batch(
    file_ids: list[UUID],
) -> tuple[dict[str, list[str]], str | None]:
    if not file_ids:
        return {}, None

    try:
        from apps.tabdata.models import AttachmentReference
    except (ModuleNotFoundError, LookupError, RuntimeError):
        return {}, 'unavailable'

    try:
        organization_rows = AttachmentReference.objects.filter(
            file_id__in=file_ids,
            is_deleted=False,
        ).values_list('file_id', 'organization_id')
    except Exception:
        logger.exception('批量查询附件引用 organization 归属失败: file_count=%s', len(file_ids))
        return {}, 'lookup_error'

    organization_map: dict[str, list[str]] = {}
    for file_id, organization_id in organization_rows:
        key = str(file_id)
        organization_map.setdefault(key, []).append(str(organization_id))

    return {
        file_id: _normalize_organization_ids(organization_ids)
        for file_id, organization_ids in organization_map.items()
    }, None

def _collect_attachment_reference_organization_ids(file_uuid: UUID) -> tuple[list[str], str | None]:
    organization_map, lookup_state = _collect_attachment_reference_organization_ids_batch([file_uuid])
    return organization_map.get(str(file_uuid), []), lookup_state

def _collect_upload_task_organization_ids_batch(file_ids: list[UUID]) -> dict[str, list[str]]:
    if not file_ids:
        return {}

    organization_rows = (
        UploadTask.objects.filter(files__id__in=file_ids)
        .exclude(organization_id='')
        .exclude(organization_id__isnull=True)
        .values_list('files__id', 'organization_id')
        .distinct()
    )
    organization_map: dict[str, list[str]] = {}
    for file_id, organization_id in organization_rows:
        key = str(file_id)
        organization_map.setdefault(key, []).append(str(organization_id))

    return {
        file_id: _normalize_organization_ids(organization_ids)
        for file_id, organization_ids in organization_map.items()
    }

def _collect_upload_task_organization_ids(file_record: FileRecord) -> list[str]:
    organization_map = _collect_upload_task_organization_ids_batch([file_record.id])
    return organization_map.get(str(file_record.id), [])

def _build_organization_repair_action(
    reason_code: str,
) -> tuple[str, str, str]:
    if reason_code in {
        REPAIR_REASON_UNIQUE_REFERENCE,
        REPAIR_REASON_UNIQUE_UPLOAD_TASK,
        REPAIR_REASON_UNIQUE_DUAL_EVIDENCE,
    }:
        return (
            REPAIR_ACTION_AUTO_REPAIR,
            '可直接批量修复',
            '证据唯一，可直接执行“归属修复”将 organization 归属写回文件记录。',
        )
    if reason_code == REPAIR_REASON_MULTIPLE_REFERENCES:
        return (
            REPAIR_ACTION_REVIEW_REFERENCE_CONFLICT,
            '先清理多引用冲突',
            '同一文件存在多个有效引用 organization，请先确认仍生效的引用，再决定最终归属。',
        )
    if reason_code == REPAIR_REASON_MULTIPLE_UPLOAD_TASKS:
        return (
            REPAIR_ACTION_REVIEW_UPLOAD_TASK_CONFLICT,
            '先核对上传任务归属',
            '同一文件被多个 organization 上传任务关联，需先核对真实上传来源再处理。',
        )
    if reason_code == REPAIR_REASON_CROSS_SOURCE_CONFLICT:
        return (
            REPAIR_ACTION_REVIEW_CROSS_SOURCE_CONFLICT,
            '先人工裁决冲突',
            '附件引用与上传任务给出的 organization 不一致，需要人工确认最终归属。',
        )
    if reason_code == REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR:
        return (
            REPAIR_ACTION_RETRY_REFERENCE_LOOKUP,
            '排查引用查询链路',
            '附件引用查询失败，建议先检查 tabdata/AttachmentReference 可用性，再重新评估。',
        )
    if reason_code == REPAIR_REASON_MISSING_EVIDENCE:
        return (
            REPAIR_ACTION_BACKFILL_EVIDENCE,
            '补齐归属证据',
            '请优先检查 UploadTask.organization_id、AttachmentReference.organization_id 和历史 metadata.organization_id 是否漏写。',
        )
    if reason_code == REPAIR_REASON_FILE_DELETED:
        return (
            REPAIR_ACTION_NOOP,
            '无需处理',
            '文件已删除，通常只需保留审计记录。',
        )
    return (
        REPAIR_ACTION_NOOP,
        '无需处理',
        '文件已有 organization 归属，无需再执行修复。',
    )

def _build_organization_repair_result_from_evidence(
    file_record: FileRecord,
    *,
    reference_organization_ids: list[str],
    reference_lookup_state: str | None,
    upload_task_organization_ids: list[str],
) -> AdminOssOrganizationRepairAssessmentSchema:
    current_organization_id = _extract_file_organization_id(file_record)
    resolved_organization_id: str | None = None
    evidence_source = ''
    repaired = False
    reason = ''
    reason_code = REPAIR_REASON_MISSING_EVIDENCE
    repair_state = 'insufficient_evidence'

    if current_organization_id:
        repair_state = 'owned'
        reason_code = REPAIR_REASON_ALREADY_OWNED
        reason = '文件已有 organization 归属'
    elif file_record.status == 'deleted':
        repair_state = 'deleted'
        reason_code = REPAIR_REASON_FILE_DELETED
        reason = '文件已删除'
    elif reference_lookup_state == 'lookup_error':
        repair_state = 'lookup_error'
        reason_code = REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR
        reason = '附件引用查询失败，暂不支持自动修复'
    elif len(reference_organization_ids) > 1:
        repair_state = 'conflict'
        reason_code = REPAIR_REASON_MULTIPLE_REFERENCES
        reason = '存在多个引用 organization，无法安全修复'
    elif len(upload_task_organization_ids) > 1:
        repair_state = 'conflict'
        reason_code = REPAIR_REASON_MULTIPLE_UPLOAD_TASKS
        reason = '存在多个上传任务 organization，无法安全修复'
    elif (
        len(reference_organization_ids) == 1
        and len(upload_task_organization_ids) == 1
        and reference_organization_ids[0] != upload_task_organization_ids[0]
    ):
        repair_state = 'conflict'
        reason_code = REPAIR_REASON_CROSS_SOURCE_CONFLICT
        reason = '引用 organization 与上传任务 organization 冲突'
    elif len(reference_organization_ids) == 1:
        repair_state = 'repairable'
        resolved_organization_id = reference_organization_ids[0]
        evidence_source = (
            'attachment_reference+upload_task'
            if len(upload_task_organization_ids) == 1
            else 'attachment_reference'
        )
        reason_code = (
            REPAIR_REASON_UNIQUE_DUAL_EVIDENCE
            if len(upload_task_organization_ids) == 1
            else REPAIR_REASON_UNIQUE_REFERENCE
        )
        repaired = True
    elif len(upload_task_organization_ids) == 1:
        repair_state = 'repairable'
        resolved_organization_id = upload_task_organization_ids[0]
        evidence_source = 'upload_task'
        reason_code = REPAIR_REASON_UNIQUE_UPLOAD_TASK
        repaired = True
    else:
        repair_state = 'insufficient_evidence'
        reason_code = REPAIR_REASON_MISSING_EVIDENCE
        reason = '缺少可验证的 organization 证据'

    (
        recommended_action_code,
        recommended_action_label,
        recommended_action_detail,
    ) = _build_organization_repair_action(reason_code)

    return AdminOssOrganizationRepairAssessmentSchema(
        file_id=str(file_record.id),
        file_name=file_record.file_name or '',
        repair_state=repair_state,
        reason_code=reason_code,
        recommended_action_code=recommended_action_code,
        recommended_action_label=recommended_action_label,
        recommended_action_detail=recommended_action_detail,
        current_organization_id=current_organization_id,
        resolved_organization_id=resolved_organization_id,
        evidence_source=evidence_source,
        reference_organization_ids=reference_organization_ids,
        upload_task_organization_ids=upload_task_organization_ids,
        repaired=repaired,
        reason=reason,
    )

def _build_organization_repair_results(
    file_records: list[FileRecord],
) -> dict[str, AdminOssOrganizationRepairAssessmentSchema]:
    if not file_records:
        return {}

    file_ids = [item.id for item in file_records]
    reference_organization_map, reference_lookup_state = _collect_attachment_reference_organization_ids_batch(
        file_ids,
    )
    upload_task_organization_map = _collect_upload_task_organization_ids_batch(file_ids)

    results: dict[str, AdminOssOrganizationRepairAssessmentSchema] = {}
    for file_record in file_records:
        file_id = str(file_record.id)
        results[file_id] = _build_organization_repair_result_from_evidence(
            file_record,
            reference_organization_ids=reference_organization_map.get(file_id, []),
            reference_lookup_state=reference_lookup_state,
            upload_task_organization_ids=upload_task_organization_map.get(file_id, []),
        )
    return results

def _build_organization_repair_result(
    file_record: FileRecord,
) -> AdminOssBatchRepairOrganizationResultSchema:
    reference_organization_ids, reference_lookup_state = _collect_attachment_reference_organization_ids(
        file_record.id,
    )
    upload_task_organization_ids = _collect_upload_task_organization_ids(file_record)
    result = _build_organization_repair_result_from_evidence(
        file_record,
        reference_organization_ids=reference_organization_ids,
        reference_lookup_state=reference_lookup_state,
        upload_task_organization_ids=upload_task_organization_ids,
    )
    return AdminOssBatchRepairOrganizationResultSchema(**result.dict())

def _apply_organization_scope_repair(file_record: FileRecord, organization_id: str) -> None:
    metadata = file_record.metadata if isinstance(file_record.metadata, dict) else {}
    metadata = dict(metadata)
    metadata['organization_id'] = organization_id
    file_record.organization_id = organization_id
    file_record.metadata = metadata
    file_record.save(update_fields=['organization_id', 'metadata', 'updated_at'])

def _build_file_item(
    file_record: FileRecord,
    organization_repair: AdminOssOrganizationRepairAssessmentSchema | None = None,
) -> AdminOssFileItemSchema:
    metadata_organization_id, space_id = _extract_organization_space(file_record.metadata)
    organization_id = _extract_file_organization_id(file_record) or metadata_organization_id
    return AdminOssFileItemSchema(
        id=str(file_record.id),
        file_name=file_record.file_name,
        file_key=file_record.file_key,
        file_path=file_record.file_path,
        file_size=int(file_record.file_size or 0),
        file_size_display=file_record.get_file_size_display(),
        file_type=file_record.file_type,
        mime_type=file_record.mime_type,
        file_extension=file_record.file_extension,
        bucket_name=file_record.bucket_name,
        is_public=file_record.is_public,
        status=file_record.status,
        upload_user=file_record.upload_user or '',
        upload_source=file_record.upload_source or '',
        download_count=int(file_record.download_count or 0),
        view_count=int(file_record.view_count or 0),
        ref_count=int(file_record.ref_count or 0),
        organization_id=organization_id,
        space_id=space_id,
        organization_repair=organization_repair,
        created_at=file_record.created_at,
        updated_at=file_record.updated_at,
        deleted_at=file_record.deleted_at,
    )

def _organization_repair_matches_filters(
    repair_result: AdminOssOrganizationRepairAssessmentSchema,
    *,
    repair_state: str,
    repair_reason_code: str,
) -> bool:
    if repair_state != 'all' and repair_result.repair_state != repair_state:
        return False
    if repair_reason_code != 'all' and repair_result.reason_code != repair_reason_code:
        return False
    return True

def _accumulate_repair_stats(
    stats: dict[str, int],
    repair: AdminOssOrganizationRepairAssessmentSchema,
) -> None:
    """将单条修复评估结果累加进 repair_stats 字典（分块处理专用）。"""
    if repair.repair_state == 'repairable':
        stats['repairable_unowned_files'] += 1
        if repair.reason_code == REPAIR_REASON_UNIQUE_REFERENCE:
            stats['repairable_from_attachment_reference_files'] += 1
        elif repair.reason_code == REPAIR_REASON_UNIQUE_UPLOAD_TASK:
            stats['repairable_from_upload_task_files'] += 1
        elif repair.reason_code == REPAIR_REASON_UNIQUE_DUAL_EVIDENCE:
            stats['repairable_from_dual_evidence_files'] += 1
    elif repair.repair_state == 'conflict':
        stats['conflict_unowned_files'] += 1
        if repair.reason_code == REPAIR_REASON_MULTIPLE_REFERENCES:
            stats['conflict_reference_files'] += 1
        elif repair.reason_code == REPAIR_REASON_MULTIPLE_UPLOAD_TASKS:
            stats['conflict_upload_task_files'] += 1
        elif repair.reason_code == REPAIR_REASON_CROSS_SOURCE_CONFLICT:
            stats['conflict_cross_source_files'] += 1
    elif repair.repair_state in ('insufficient_evidence', 'lookup_error'):
        stats['unverifiable_unowned_files'] += 1
        if repair.reason_code == REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR:
            stats['lookup_error_unowned_files'] += 1
        else:
            stats['missing_evidence_unowned_files'] += 1

def _build_file_inventory_summary(
    records,
    organization_repair_map: dict[str, AdminOssOrganizationRepairAssessmentSchema] | None = None,
) -> dict[str, int]:
    summary = {
        'total_size': 0,
        'orphan_files': 0,
        'orphan_size': 0,
        'owned_files': 0,
        'owned_size': 0,
        'unowned_files': 0,
        'unowned_size': 0,
        'orphan_unowned_files': 0,
        'orphan_unowned_size': 0,
        'repairable_unowned_files': 0,
        'conflict_unowned_files': 0,
        'unverifiable_unowned_files': 0,
        'repairable_from_attachment_reference_files': 0,
        'repairable_from_upload_task_files': 0,
        'repairable_from_dual_evidence_files': 0,
        'conflict_reference_files': 0,
        'conflict_upload_task_files': 0,
        'conflict_cross_source_files': 0,
        'missing_evidence_unowned_files': 0,
        'lookup_error_unowned_files': 0,
    }
    for file_record in records:
        if file_record.status == 'deleted':
            continue

        file_size = int(file_record.file_size or 0)
        organization_id = _extract_file_organization_id(file_record)
        is_orphan = file_record.status == 'completed' and int(file_record.ref_count or 0) == 0

        summary['total_size'] += file_size
        if organization_id:
            summary['owned_files'] += 1
            summary['owned_size'] += file_size
        else:
            summary['unowned_files'] += 1
            summary['unowned_size'] += file_size
            organization_repair = None
            if organization_repair_map is not None:
                organization_repair = organization_repair_map.get(str(file_record.id))
            if organization_repair is not None:
                if organization_repair.repair_state == 'repairable':
                    summary['repairable_unowned_files'] += 1
                    if organization_repair.reason_code == REPAIR_REASON_UNIQUE_REFERENCE:
                        summary['repairable_from_attachment_reference_files'] += 1
                    elif organization_repair.reason_code == REPAIR_REASON_UNIQUE_UPLOAD_TASK:
                        summary['repairable_from_upload_task_files'] += 1
                    elif organization_repair.reason_code == REPAIR_REASON_UNIQUE_DUAL_EVIDENCE:
                        summary['repairable_from_dual_evidence_files'] += 1
                elif organization_repair.repair_state == 'conflict':
                    summary['conflict_unowned_files'] += 1
                    if organization_repair.reason_code == REPAIR_REASON_MULTIPLE_REFERENCES:
                        summary['conflict_reference_files'] += 1
                    elif organization_repair.reason_code == REPAIR_REASON_MULTIPLE_UPLOAD_TASKS:
                        summary['conflict_upload_task_files'] += 1
                    elif organization_repair.reason_code == REPAIR_REASON_CROSS_SOURCE_CONFLICT:
                        summary['conflict_cross_source_files'] += 1
                elif organization_repair.repair_state in {'insufficient_evidence', 'lookup_error'}:
                    summary['unverifiable_unowned_files'] += 1
                    if organization_repair.reason_code == REPAIR_REASON_ATTACHMENT_LOOKUP_ERROR:
                        summary['lookup_error_unowned_files'] += 1
                    else:
                        summary['missing_evidence_unowned_files'] += 1

        if not is_orphan:
            continue

        summary['orphan_files'] += 1
        summary['orphan_size'] += file_size
        if not organization_id:
            summary['orphan_unowned_files'] += 1
            summary['orphan_unowned_size'] += file_size

    return summary

def _build_task_item(task: UploadTask) -> AdminOssTaskItemSchema:
    return AdminOssTaskItemSchema(
        task_id=str(task.id),
        task_name=task.task_name,
        task_type=task.task_type,
        status=task.status,
        progress=float(task.progress or 0.0),
        total_files=int(task.total_files or 0),
        completed_files=int(task.completed_files or 0),
        failed_files=int(task.failed_files or 0),
        total_size=int(task.total_size or 0),
        uploaded_size=int(task.uploaded_size or 0),
        error_message=task.error_message or '',
        created_by=task.created_by or '',
        organization_id=str(task.organization_id or '').strip(),
        created_at=task.created_at,
        updated_at=task.updated_at,
        started_at=task.started_at,
        completed_at=task.completed_at,
    )

@router.get('/oss/files', response=AdminOssFileListResponseSchema, auth=StaffAuth(), tags=['后台资源管理'])
def list_admin_oss_files(
    request,
    keyword: str = '',
    file_type: str = 'all',
    status: str = 'all',
    upload_source: str = '',
    is_public: bool | None = Query(None),
    orphan_only: bool = Query(False),
    unowned_only: bool = Query(False),
    repair_state: str = 'all',
    repair_reason_code: str = 'all',
    organization_id: str = '',
    space_id: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台文件列表（支持 orphan_only / unowned_only 等治理筛选）"""

    file_type = file_type.strip().lower()
    status = status.strip().lower()
    repair_state = repair_state.strip().lower()
    repair_reason_code = repair_reason_code.strip().lower()
    if file_type not in VALID_FILE_TYPES:
        raise HttpError(400, 'file_type 参数不合法')
    if status not in VALID_FILE_STATUS:
        raise HttpError(400, 'status 参数不合法')
    if repair_state not in VALID_REPAIR_STATES:
        raise HttpError(400, 'repair_state 参数不合法')
    if repair_reason_code not in VALID_REPAIR_REASON_CODES:
        raise HttpError(400, 'repair_reason_code 参数不合法')

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = FileRecord.objects.all()

    if file_type != 'all':
        queryset = queryset.filter(file_type=file_type)
    if status != 'all':
        queryset = queryset.filter(status=status)
    if upload_source.strip():
        queryset = queryset.filter(upload_source=upload_source.strip())
    if is_public is not None:
        queryset = queryset.filter(is_public=is_public)
    if orphan_only:
        queryset = queryset.filter(ref_count=0, status='completed')
    if unowned_only:
        queryset = queryset.filter(_build_unowned_file_filter())
    if organization_id.strip():
        normalized_organization_id = organization_id.strip()
        queryset = queryset.filter(
            Q(organization_id=normalized_organization_id)
            | Q(metadata__organization_id=normalized_organization_id)
        )
    if space_id.strip():
        queryset = queryset.filter(metadata__space_id=space_id.strip())

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(file_name__icontains=normalized_keyword)
            | Q(file_key__icontains=normalized_keyword)
            | Q(file_hash__icontains=normalized_keyword)
            | Q(upload_user__icontains=normalized_keyword)
            | Q(upload_source__icontains=normalized_keyword)
        )
        file_uuid = _parse_uuid_or_none(normalized_keyword)
        if file_uuid:
            keyword_filter |= Q(id=file_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-created_at')
    offset = (page - 1) * page_size

    page_rows: list[FileRecord]
    page_repair_map: dict[str, AdminOssOrganizationRepairAssessmentSchema]
    if repair_state == 'all' and repair_reason_code == 'all':
        total = queryset.count()
        total_pages = (total + page_size - 1) // page_size if total else 0
        if total_pages and page > total_pages:
            page = total_pages
            offset = (page - 1) * page_size

        page_rows = list(queryset[offset:offset + page_size])
        page_repair_map = _build_organization_repair_results(page_rows)
    else:
        _db_deterministic = (
            repair_state in ('owned', 'deleted')
            or (repair_state == 'all' and repair_reason_code in (
                REPAIR_REASON_ALREADY_OWNED, REPAIR_REASON_FILE_DELETED,
            ))
        )

        if _db_deterministic:
            if repair_state == 'owned' or (
                repair_state == 'all'
                and repair_reason_code == REPAIR_REASON_ALREADY_OWNED
            ):
                repair_qs = queryset.exclude(_build_unowned_file_filter())
            else:
                repair_qs = queryset.filter(
                    _build_unowned_file_filter(), status='deleted',
                )

            if (
                repair_state != 'all'
                and repair_reason_code != 'all'
                and (repair_state, repair_reason_code) not in {
                    ('owned', REPAIR_REASON_ALREADY_OWNED),
                    ('deleted', REPAIR_REASON_FILE_DELETED),
                }
            ):
                repair_qs = queryset.none()

            total = repair_qs.count()
            total_pages = (total + page_size - 1) // page_size if total else 0
            if total_pages and page > total_pages:
                page = total_pages
                offset = (page - 1) * page_size

            page_rows = list(repair_qs[offset:offset + page_size])
            page_repair_map = _build_organization_repair_results(page_rows)
        else:
            repair_qs = queryset
            if repair_state in (
                'repairable', 'conflict', 'insufficient_evidence', 'lookup_error',
            ):
                repair_qs = repair_qs.filter(
                    _build_unowned_file_filter(),
                ).exclude(status='deleted')
            elif repair_state == 'all' and repair_reason_code != 'all':
                repair_qs = repair_qs.filter(
                    _build_unowned_file_filter(),
                ).exclude(status='deleted')

            repair_base_qs = (
                repair_qs
                .only('id', 'file_name', 'organization_id', 'metadata', 'status')
                .order_by('-created_at', 'pk')
            )
            matched_ids: list[UUID] = []
            _chunk_offset = 0
            while True:
                chunk = list(
                    repair_base_qs[_chunk_offset:_chunk_offset + _REPAIR_EVAL_CHUNK_SIZE]
                )
                if not chunk:
                    break
                chunk_repair_map = _build_organization_repair_results(chunk)
                for row in chunk:
                    repair = chunk_repair_map.get(str(row.id))
                    if repair and _organization_repair_matches_filters(
                        repair,
                        repair_state=repair_state,
                        repair_reason_code=repair_reason_code,
                    ):
                        matched_ids.append(row.id)
                _chunk_offset += _REPAIR_EVAL_CHUNK_SIZE

            total = len(matched_ids)
            total_pages = (total + page_size - 1) // page_size if total else 0
            if total_pages and page > total_pages:
                page = total_pages
                offset = (page - 1) * page_size

            paged_ids = matched_ids[offset:offset + page_size]
            if paged_ids:
                page_row_map = FileRecord.objects.in_bulk(paged_ids)
                page_rows = [
                    page_row_map[fid] for fid in paged_ids if fid in page_row_map
                ]
            else:
                page_rows = []
            page_repair_map = (
                _build_organization_repair_results(page_rows) if page_rows else {}
            )

    items = [
        _build_file_item(item, organization_repair=page_repair_map.get(str(item.id)))
        for item in page_rows
    ]

    all_files = FileRecord.objects.all()
    non_deleted_qs = all_files.exclude(status='deleted')
    unowned_q = _build_unowned_file_filter()
    orphan_q = Q(ref_count=0, status='completed')

    file_counts = all_files.aggregate(
        total_files=Count('id'),
        completed_files=Count('id', filter=Q(status='completed')),
        failed_files=Count('id', filter=Q(status='failed')),
        deleted_files=Count('id', filter=Q(status='deleted')),
        public_files=Count('id', filter=Q(status='completed', is_public=True)),
        private_files=Count('id', filter=Q(status='completed', is_public=False)),
    )
    inv_agg = non_deleted_qs.aggregate(
        total_size=Coalesce(Sum('file_size'), Value(0)),
        _non_deleted_count=Count('id'),
        unowned_files=Count('id', filter=unowned_q),
        unowned_size=Coalesce(Sum('file_size', filter=unowned_q), Value(0)),
        orphan_files=Count('id', filter=orphan_q),
        orphan_size=Coalesce(Sum('file_size', filter=orphan_q), Value(0)),
        orphan_unowned_files=Count('id', filter=orphan_q & unowned_q),
        orphan_unowned_size=Coalesce(
            Sum('file_size', filter=orphan_q & unowned_q), Value(0),
        ),
    )

    repair_stats = {k: 0 for k in (
        'repairable_unowned_files', 'conflict_unowned_files', 'unverifiable_unowned_files',
        'repairable_from_attachment_reference_files', 'repairable_from_upload_task_files',
        'repairable_from_dual_evidence_files', 'conflict_reference_files',
        'conflict_upload_task_files', 'conflict_cross_source_files',
        'missing_evidence_unowned_files', 'lookup_error_unowned_files',
    )}
    if inv_agg['unowned_files'] > 0:
        unowned_base_qs = (
            non_deleted_qs.filter(unowned_q)
            .only('id', 'file_name', 'organization_id', 'metadata', 'status')
            .order_by('pk')
        )
        _stats_offset = 0
        while True:
            chunk = list(
                unowned_base_qs[_stats_offset:_stats_offset + _REPAIR_EVAL_CHUNK_SIZE]
            )
            if not chunk:
                break
            chunk_repair_map = _build_organization_repair_results(chunk)
            for repair in chunk_repair_map.values():
                _accumulate_repair_stats(repair_stats, repair)
            _stats_offset += _REPAIR_EVAL_CHUNK_SIZE

    summary = AdminOssFileSummarySchema(
        total_files=file_counts['total_files'],
        filtered_files=total,
        completed_files=file_counts['completed_files'],
        failed_files=file_counts['failed_files'],
        deleted_files=file_counts['deleted_files'],
        public_files=file_counts['public_files'],
        private_files=file_counts['private_files'],
        total_size=inv_agg['total_size'],
        orphan_files=inv_agg['orphan_files'],
        orphan_size=inv_agg['orphan_size'],
        owned_files=inv_agg['_non_deleted_count'] - inv_agg['unowned_files'],
        owned_size=inv_agg['total_size'] - inv_agg['unowned_size'],
        unowned_files=inv_agg['unowned_files'],
        unowned_size=inv_agg['unowned_size'],
        orphan_unowned_files=inv_agg['orphan_unowned_files'],
        orphan_unowned_size=inv_agg['orphan_unowned_size'],
        **repair_stats,
    )

    return AdminOssFileListResponseSchema(
        items=items,
        pagination=AdminOssPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get('/oss/files/{file_id}', response=AdminOssFileDetailResponseSchema, auth=StaffAuth(), tags=['后台资源管理'])
def get_admin_oss_file_detail(request, file_id: str):
    """后台文件详情"""

    file_uuid = _parse_uuid_or_none(file_id)
    if file_uuid is None:
        raise HttpError(400, '无效 file_id')

    file_record = FileRecord.objects.filter(id=file_uuid).first()
    if file_record is None:
        raise HttpError(404, '文件不存在')

    reference_items: list[AdminOssReferenceItemSchema] = []
    reference_count = 0
    try:
        # 延迟导入，避免与 tabdata 模块初始化形成循环依赖。
        from apps.tabdata.models import AttachmentReference
    except (ModuleNotFoundError, LookupError, RuntimeError):
        AttachmentReference = None

    if AttachmentReference is not None:
        reference_qs = AttachmentReference.objects.filter(file_id=file_uuid).order_by('-created_at')
        reference_count = reference_qs.count()
        references = list(reference_qs[:50])
        reference_items = [
            AdminOssReferenceItemSchema(
                reference_id=str(item.id),
                organization_id=str(item.organization_id),
                space_id=str(item.space_id) if item.space_id else None,
                table_id=str(item.table_id),
                field_id=str(item.field_id),
                record_id=str(item.record_id) if item.record_id else None,
                is_deleted=item.is_deleted,
                created_at=item.created_at,
                updated_at=item.updated_at,
            )
            for item in references
        ]
    else:
        logger.info('tabdata 未安装，OSS 文件详情跳过附件引用查询: file=%s', file_uuid)

    # FileUsage 引用追踪
    from .models import FileUsage
    usage_qs = FileUsage.objects.filter(file_record=file_record).order_by('-created_at')
    usage_count = usage_qs.count()
    usage_items = [
        AdminOssFileUsageItemSchema(
            id=str(u.id),
            module=u.module,
            context_type=u.context_type or '',
            context_id=u.context_id or '',
            user_id=str(u.user_id) if u.user_id else '',
            is_active=u.is_active,
            created_at=u.created_at,
            deactivated_at=u.deactivated_at,
        )
        for u in usage_qs[:50]
    ]

    related_tasks = list(
        UploadTask.objects.filter(files=file_record).order_by('-created_at')[:20]
    )
    task_items = [_build_task_item(item) for item in related_tasks]
    organization_repair = _build_organization_repair_result(file_record)

    return AdminOssFileDetailResponseSchema(
        file=_build_file_item(file_record, organization_repair=organization_repair),
        references=reference_items,
        reference_count=reference_count,
        usages=usage_items,
        usage_count=usage_count,
        related_tasks=task_items,
    )

@router.get('/oss/tasks', response=AdminOssTaskListResponseSchema, auth=StaffAuth(), tags=['后台资源管理'])
def list_admin_oss_tasks(
    request,
    task_type: str = 'all',
    status: str = 'all',
    keyword: str = '',
    created_by: str = '',
    organization_id: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台上传任务列表"""

    task_type = task_type.strip().lower()
    status = status.strip().lower()
    if task_type not in VALID_TASK_TYPES:
        raise HttpError(400, 'task_type 参数不合法')
    if status not in VALID_TASK_STATUS:
        raise HttpError(400, 'status 参数不合法')

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = UploadTask.objects.all()
    if task_type != 'all':
        queryset = queryset.filter(task_type=task_type)
    if status != 'all':
        queryset = queryset.filter(status=status)
    if created_by.strip():
        queryset = queryset.filter(created_by=created_by.strip())
    if organization_id.strip():
        queryset = queryset.filter(organization_id=organization_id.strip())

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(task_name__icontains=normalized_keyword)
            | Q(created_by__icontains=normalized_keyword)
            | Q(error_message__icontains=normalized_keyword)
        )
        task_uuid = _parse_uuid_or_none(normalized_keyword)
        if task_uuid:
            keyword_filter |= Q(id=task_uuid)
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-created_at')
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(queryset[offset:offset + page_size])
    items = [_build_task_item(item) for item in rows]

    task_agg = queryset.aggregate(
        processing_tasks=Count('id', filter=Q(status='processing')),
        completed_tasks=Count('id', filter=Q(status='completed')),
        failed_tasks=Count('id', filter=Q(status='failed')),
        cancelled_tasks=Count('id', filter=Q(status='cancelled')),
    )
    summary = AdminOssTaskSummarySchema(total_tasks=total, **task_agg)

    return AdminOssTaskListResponseSchema(
        items=items,
        pagination=AdminOssPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get('/oss/operations', response=AdminOssOperationListResponseSchema, auth=StaffAuth(), tags=['后台资源管理'])
def list_admin_oss_operations(
    request,
    action_type: str = 'all',
    success: bool | None = Query(None),
    keyword: str = '',
    file_id: str = '',
    operator_id: str = '',
    organization_id: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台治理操作日志列表"""

    action_type = action_type.strip().lower()
    if action_type not in VALID_OPERATION_ACTION_TYPES:
        raise HttpError(400, 'action_type 参数不合法')

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))

    queryset = OSSAdminActionLog.objects.all()
    if action_type != 'all':
        queryset = queryset.filter(action_type=action_type)
    if success is not None:
        queryset = queryset.filter(success=success)

    normalized_operator_id = operator_id.strip()
    if normalized_operator_id:
        operator_uuid = _parse_uuid_or_none(normalized_operator_id)
        if operator_uuid is None:
            raise HttpError(400, 'operator_id 参数不合法')
        queryset = queryset.filter(operator_id=operator_uuid)

    normalized_file_id = file_id.strip()
    if normalized_file_id:
        file_uuid = _parse_uuid_or_none(normalized_file_id)
        if file_uuid is None:
            raise HttpError(400, 'file_id 参数不合法')
        queryset = queryset.filter(target_file_ids_text__icontains=f'|{file_uuid}|')

    normalized_organization_id = organization_id.strip()
    if normalized_organization_id:
        queryset = queryset.filter(
            Q(organization_id=normalized_organization_id)
            | Q(organization_ids_text__icontains=f'|{normalized_organization_id}|')
        )

    normalized_keyword = keyword.strip()
    if normalized_keyword:
        keyword_filter = (
            Q(action_type__icontains=normalized_keyword)
            | Q(operator_name__icontains=normalized_keyword)
            | Q(message__icontains=normalized_keyword)
            | Q(error_message__icontains=normalized_keyword)
            | Q(trace_id__icontains=normalized_keyword)
        )
        keyword_uuid = _parse_uuid_or_none(normalized_keyword)
        if keyword_uuid:
            keyword_filter |= (
                Q(id=keyword_uuid)
                | Q(operator_id=keyword_uuid)
                | Q(target_file_ids_text__icontains=f'|{keyword_uuid}|')
            )
        queryset = queryset.filter(keyword_filter)

    queryset = queryset.order_by('-created_at')
    total = queryset.count()
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    rows = list(queryset[offset:offset + page_size])
    items = [_serialize_operation_item(item) for item in rows]

    summary = AdminOssOperationSummarySchema(
        total_operations=total,
        success_operations=queryset.filter(success=True).count(),
        failed_operations=queryset.filter(success=False).count(),
        dry_run_operations=queryset.filter(dry_run=True).count(),
    )

    return AdminOssOperationListResponseSchema(
        items=items,
        pagination=AdminOssPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.get('/oss/costs', response=AdminOssCostOverviewResponseSchema, auth=StaffAuth(), tags=['后台资源管理'])
def get_admin_oss_cost_overview(
    request,
    organization_keyword: str = '',
    page: int = 1,
    page_size: int = 20,
):
    """后台存储用量对账视图（文件侧 vs 计量侧）"""

    page = max(page, 1)
    page_size = max(1, min(page_size, 100))
    normalized_organization_keyword = organization_keyword.strip()

    file_usage_map: dict[str, dict[str, int]] = {}

    direct_qs = FileRecord.objects.exclude(status='deleted').exclude(
        Q(organization_id='') | Q(organization_id__isnull=True)
    )
    if normalized_organization_keyword:
        direct_qs = direct_qs.filter(organization_id__icontains=normalized_organization_keyword)
    for row in direct_qs.values('organization_id').annotate(
        file_count=Count('id'),
        file_storage_bytes=Coalesce(Sum('file_size'), Value(0)),
    ):
        file_usage_map[row['organization_id']] = {
            'file_count': row['file_count'],
            'file_storage_bytes': row['file_storage_bytes'],
        }

    metadata_only_qs = (
        FileRecord.objects.exclude(status='deleted')
        .filter(Q(organization_id='') | Q(organization_id__isnull=True))
        .exclude(Q(metadata__organization_id='') | Q(metadata__organization_id__isnull=True))
        .only('metadata', 'file_size')
    )
    for record in metadata_only_qs:
        ws_id = str((record.metadata or {}).get('organization_id', '') or '').strip()
        if not ws_id:
            continue
        if normalized_organization_keyword and normalized_organization_keyword not in ws_id:
            continue
        current = file_usage_map.setdefault(ws_id, {'file_count': 0, 'file_storage_bytes': 0})
        current['file_count'] += 1
        current['file_storage_bytes'] += int(record.file_size or 0)

    unowned_files = 0
    unowned_file_storage_bytes = 0
    if not normalized_organization_keyword:
        unowned_agg = (
            FileRecord.objects.exclude(status='deleted')
            .filter(_build_unowned_file_filter())
            .aggregate(
                count=Count('id'),
                total_size=Coalesce(Sum('file_size'), Value(0)),
            )
        )
        unowned_files = unowned_agg['count']
        unowned_file_storage_bytes = unowned_agg['total_size']

    metered_qs = OrganizationStorageUsage.objects.all()
    if normalized_organization_keyword:
        metered_qs = metered_qs.filter(organization_id__icontains=normalized_organization_keyword)

    metered_map: dict[str, OrganizationStorageUsage] = {}
    for usage in metered_qs:
        organization_id = str(usage.organization_id or '').strip()
        if not organization_id:
            continue
        metered_map[organization_id] = usage

    organization_ids = set(file_usage_map.keys()) | set(metered_map.keys())
    items_all: list[AdminOssOrganizationCostItemSchema] = []
    for organization_id in organization_ids:
        file_usage = file_usage_map.get(organization_id, {})
        metered = metered_map.get(organization_id)

        file_count = int(file_usage.get('file_count') or 0)
        file_storage_bytes = int(file_usage.get('file_storage_bytes') or 0)
        metered_file_count = int((metered.active_file_count if metered else 0) or 0)
        metered_storage_bytes = int((metered.active_storage_bytes if metered else 0) or 0)

        items_all.append(
            AdminOssOrganizationCostItemSchema(
                organization_id=organization_id,
                file_count=file_count,
                file_storage_bytes=file_storage_bytes,
                metered_file_count=metered_file_count,
                metered_storage_bytes=metered_storage_bytes,
                storage_gap_bytes=file_storage_bytes - metered_storage_bytes,
                last_metered_at=metered.last_metered_at if metered else None,
                metered_updated_at=metered.updated_at if metered else None,
            )
        )

    items_all.sort(key=lambda item: (-item.file_storage_bytes, item.organization_id))
    total = len(items_all)
    total_pages = (total + page_size - 1) // page_size if total else 0
    if total_pages and page > total_pages:
        page = total_pages

    offset = (page - 1) * page_size
    paged_items = items_all[offset:offset + page_size]

    total_file_storage_bytes = sum(item.file_storage_bytes for item in items_all)
    total_metered_storage_bytes = sum(item.metered_storage_bytes for item in items_all)
    file_organization_ids = set(file_usage_map.keys())
    metered_organization_ids = set(metered_map.keys())
    summary = AdminOssCostSummarySchema(
        organization_count=total,
        file_organization_count=len(file_organization_ids),
        metered_organization_count=len(metered_organization_ids),
        total_file_storage_bytes=total_file_storage_bytes,
        total_metered_storage_bytes=total_metered_storage_bytes,
        total_storage_gap_bytes=total_file_storage_bytes - total_metered_storage_bytes,
        file_only_organization_count=len(file_organization_ids - metered_organization_ids),
        metered_only_organization_count=len(metered_organization_ids - file_organization_ids),
        organization_gap_count=sum(1 for item in items_all if item.storage_gap_bytes != 0),
        unowned_files=unowned_files,
        unowned_file_storage_bytes=unowned_file_storage_bytes,
    )

    return AdminOssCostOverviewResponseSchema(
        items=paged_items,
        pagination=AdminOssPaginationSchema(
            total=total,
            page=page,
            page_size=page_size,
            total_pages=total_pages,
        ),
        summary=summary,
    )

@router.post(
    '/oss/files/batch/delete',
    response=AdminOssBatchDeleteResponseSchema,
    auth=AdminPermissionAuth('asset:delete'),
    tags=['后台资源管理'],
)
def batch_delete_admin_oss_files(request, payload: AdminOssBatchDeleteRequestSchema):
    """批量删除文件"""
    reason = _ensure_sensitive_reason(dry_run=payload.dry_run, reason=payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    input_file_ids = _normalize_file_ids(payload.file_ids)
    if not input_file_ids:
        raise HttpError(400, '请至少选择 1 个文件')
    if len(input_file_ids) > 200:
        raise HttpError(400, '单次批量操作最多 200 个文件')

    skipped: list[AdminOssBatchDeleteSkipItemSchema] = []
    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []
    for raw_id in input_file_ids:
        file_uuid = _parse_uuid_or_none(raw_id)
        if file_uuid is None:
            skipped.append(AdminOssBatchDeleteSkipItemSchema(file_id=raw_id, reason='无效 UUID'))
            continue
        normalized = str(file_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(file_uuid)

    file_map = {
        str(item.id): item
        for item in FileRecord.objects.filter(id__in=valid_uuid_list)
    }

    candidates: list[FileRecord] = []
    for file_id in normalized_ids:
        file_record = file_map.get(file_id)
        if file_record is None:
            skipped.append(AdminOssBatchDeleteSkipItemSchema(file_id=file_id, reason='文件不存在'))
            continue
        if file_record.status == 'deleted':
            skipped.append(AdminOssBatchDeleteSkipItemSchema(file_id=file_id, reason='文件已删除'))
            continue
        if not str(file_record.file_key).strip():
            skipped.append(AdminOssBatchDeleteSkipItemSchema(file_id=file_id, reason='缺少 file_key'))
            continue
        candidates.append(file_record)

    request_payload = {
        'file_ids': input_file_ids,
        'dry_run': payload.dry_run,
    }
    before_preview = [_build_asset_sensitive_snapshot(item) for item in candidates]

    if payload.dry_run:
        response = AdminOssBatchDeleteResponseSchema(
            success=True,
            message=f'模拟删除完成：成功 {len(candidates)}，跳过 {len(skipped)}',
            dry_run=True,
            requested_count=len(input_file_ids),
            processed_count=len(candidates),
            deleted_count=0,
            skipped=skipped,
            items=[_build_file_item(item) for item in candidates],
        )
        _record_oss_admin_action(
            request=request,
            action_type='batch_delete',
            target_file_ids=input_file_ids,
            requested_count=response.requested_count,
            processed_count=response.processed_count,
            deleted_count=response.deleted_count,
            skipped_count=len(response.skipped),
            dry_run=True,
            success=True,
            message=response.message,
            request_payload=request_payload,
            result_payload={
                'deleted_file_ids': [],
                'skipped': [
                    {'file_id': item.file_id, 'reason': item.reason}
                    for item in response.skipped
                ],
            },
        )
        return response

    remote_delete_enabled = True
    remote_delete_skipped_reason = ''
    try:
        oss_service = get_oss_service()
    except ConfigurationException as exc:
        # 管理端批量删除以 FileRecord 逻辑删除为主；当 bucket 配置缺失时降级为
        # “仅 DB 侧删除 + 标记远端删除跳过”，避免 500 阻断治理链路。
        remote_delete_enabled = False
        remote_delete_skipped_reason = str(exc)
        logger.warning("Admin 批量删除降级为 DB-only: %s", remote_delete_skipped_reason)
        oss_service = None
    except Exception as exc:
        error_message = f'初始化 OSS 服务失败: {exc}'
        _record_oss_admin_action(
            request=request,
            action_type='batch_delete',
            target_file_ids=input_file_ids,
            requested_count=len(input_file_ids),
            processed_count=len(candidates),
            deleted_count=0,
            skipped_count=len(skipped),
            dry_run=False,
            success=False,
            message='批量删除执行失败',
            error_message=error_message,
            request_payload=request_payload,
            result_payload={},
        )
        raise HttpError(503, {
            'code': 'OSS_CLIENT_INIT_FAILED',
            'message': error_message,
        }) from exc

    deleted_items: list[FileRecord] = []
    remote_delete_skipped_count = 0
    for file_record in candidates:
        if remote_delete_enabled and oss_service is not None:
            try:
                delete_result = oss_service.delete_file(file_record.file_key)
            except Exception as exc:  # noqa: BLE001
                skipped.append(
                    AdminOssBatchDeleteSkipItemSchema(
                        file_id=str(file_record.id),
                        reason=f'远端删除异常: {exc}',
                    )
                )
                continue
            if not delete_result.get('success'):
                skipped.append(
                    AdminOssBatchDeleteSkipItemSchema(
                        file_id=str(file_record.id),
                        reason=str(delete_result.get('message') or '远端删除失败'),
                    )
                )
                continue
        else:
            remote_delete_skipped_count += 1
        _ws_id = getattr(file_record, 'organization_id', '') or (file_record.metadata or {}).get('organization_id', '') or ''
        _file_size = file_record.file_size or 0

        from .models import FileUsage
        FileUsage.objects.filter(
            file_record=file_record, is_active=True,
        ).update(is_active=False, deactivated_at=timezone.now())
        file_record.ref_count = 0
        file_record.save(update_fields=['ref_count'])
        file_record.soft_delete()

        if _ws_id and _file_size > 0:
            try:
                from apps.services.billing.services import OrganizationStorageBillingService
                OrganizationStorageBillingService.apply_storage_delta(
                    organization_id=_ws_id,
                    file_id=str(file_record.id),
                    delta_bytes=-int(_file_size),
                    user_id=str(getattr(request.auth, 'id', '')),
                    biz_type="oss_admin_batch_delete",
                    biz_id=str(file_record.id),
                )
            except Exception:
                logger.warning(
                    "Admin 批量删除存储计量释放失败: file=%s", file_record.id, exc_info=True,
                )
                try:
                    from apps.services.billing.services.degradation_tracker import track_billing_degradation
                    track_billing_degradation(meter_key="storage.admin_delete", organization_id=_ws_id, error="admin batch delete billing failed")
                except Exception:
                    pass

        deleted_items.append(file_record)

    response = AdminOssBatchDeleteResponseSchema(
        success=True,
        message=(
            f"删除完成：成功 {len(deleted_items)}，跳过 {len(skipped)}"
            + (
                f"（远端删除跳过 {remote_delete_skipped_count}，原因：{remote_delete_skipped_reason}）"
                if remote_delete_skipped_count > 0
                else ''
            )
        ),
        dry_run=False,
        requested_count=len(input_file_ids),
        processed_count=len(candidates),
        deleted_count=len(deleted_items),
        skipped=skipped,
        items=[_build_file_item(item) for item in deleted_items],
    )

    _record_oss_admin_action(
        request=request,
        action_type='batch_delete',
        target_file_ids=input_file_ids,
        requested_count=response.requested_count,
        processed_count=response.processed_count,
        deleted_count=response.deleted_count,
        skipped_count=len(response.skipped),
        dry_run=False,
        success=True,
        message=response.message,
        request_payload=request_payload,
        result_payload={
            'deleted_file_ids': [str(item.id) for item in deleted_items],
            'remote_delete_enabled': remote_delete_enabled,
            'remote_delete_skipped_count': remote_delete_skipped_count,
            'remote_delete_skipped_reason': remote_delete_skipped_reason,
            'skipped': [
                {'file_id': item.file_id, 'reason': item.reason}
                for item in response.skipped
            ],
        },
    )
    if not payload.dry_run:
        _record_asset_sensitive_action(
            request=request,
            permission_code='asset:delete',
            action='asset.delete',
            target_ids=normalized_ids,
            reason=reason,
            ticket_id=ticket_id,
            affected_count=response.deleted_count,
            before_preview=before_preview,
            after_preview=[
                {
                    'file_id': str(item.id),
                    'status': 'deleted',
                    'organization_id': str(getattr(item, 'organization_id', '') or ''),
                    'remote_delete_skipped': not remote_delete_enabled,
                }
                for item in deleted_items
            ],
            extra={
                'bucket_missing': not remote_delete_enabled,
                'remote_delete_skipped_count': remote_delete_skipped_count,
                'remote_delete_skipped_reason': remote_delete_skipped_reason,
            },
        )
    return response

@router.post(
    '/oss/files/batch/repair-organization',
    response=AdminOssBatchRepairOrganizationResponseSchema,
    auth=AdminPermissionAuth('asset:repair'),
    tags=['后台资源管理'],
)
def batch_repair_admin_oss_file_organizations(
    request,
    payload: AdminOssBatchRepairOrganizationRequestSchema,
):
    """批量修复文件的 organization 归属（仅在证据唯一时执行）"""
    reason = _ensure_sensitive_reason(dry_run=payload.dry_run, reason=payload.reason)
    ticket_id = (payload.ticket_id or '').strip()

    input_file_ids = _normalize_file_ids(payload.file_ids)
    if not input_file_ids:
        raise HttpError(400, '请至少选择 1 个文件')
    if len(input_file_ids) > 200:
        raise HttpError(400, '单次批量操作最多 200 个文件')

    normalized_ids: list[str] = []
    valid_uuid_list: list[UUID] = []
    results: list[AdminOssBatchRepairOrganizationResultSchema] = []
    for raw_id in input_file_ids:
        file_uuid = _parse_uuid_or_none(raw_id)
        if file_uuid is None:
            results.append(
                AdminOssBatchRepairOrganizationResultSchema(
                    file_id=raw_id,
                    repaired=False,
                    reason='无效 UUID',
                )
            )
            continue
        normalized = str(file_uuid)
        normalized_ids.append(normalized)
        valid_uuid_list.append(file_uuid)

    file_map = {
        str(item.id): item
        for item in FileRecord.objects.filter(id__in=valid_uuid_list)
    }

    before_preview_by_id = {
        str(file_record.id): _build_asset_sensitive_snapshot(file_record)
        for file_record in file_map.values()
    }

    for file_id in normalized_ids:
        file_record = file_map.get(file_id)
        if file_record is None:
            results.append(
                AdminOssBatchRepairOrganizationResultSchema(
                    file_id=file_id,
                    repaired=False,
                    reason='文件不存在',
                )
            )
            continue

        result = _build_organization_repair_result(file_record)
        if result.repaired and not payload.dry_run and result.resolved_organization_id:
            try:
                _apply_organization_scope_repair(file_record, result.resolved_organization_id)
            except Exception as exc:
                logger.exception('修复文件 organization 归属失败: file=%s', file_record.id)
                result = AdminOssBatchRepairOrganizationResultSchema(
                    **{
                        **result.dict(),
                        'repaired': False,
                        'reason': f'写入归属失败: {exc}',
                    }
                )
        results.append(result)

    repaired_count = sum(1 for item in results if item.repaired)
    skipped_count = len(results) - repaired_count
    processed_count = len(results)
    action_organization_ids = [
        item.resolved_organization_id
        for item in results
        if item.repaired and item.resolved_organization_id
    ]

    message = (
        f'模拟修复完成：可修复 {repaired_count}，跳过 {skipped_count}'
        if payload.dry_run
        else f'归属修复完成：成功 {repaired_count}，跳过 {skipped_count}'
    )

    response = AdminOssBatchRepairOrganizationResponseSchema(
        success=True,
        message=message,
        dry_run=payload.dry_run,
        requested_count=len(input_file_ids),
        processed_count=processed_count,
        repaired_count=repaired_count,
        skipped_count=skipped_count,
        results=results,
    )

    _record_oss_admin_action(
        request=request,
        action_type='repair_organization_scope',
        target_file_ids=input_file_ids,
        requested_count=response.requested_count,
        processed_count=response.processed_count,
        deleted_count=0,
        skipped_count=response.skipped_count,
        dry_run=payload.dry_run,
        success=True,
        message=response.message,
        request_payload={
            'file_ids': input_file_ids,
            'dry_run': payload.dry_run,
        },
        result_payload={
            'repaired_file_ids': [item.file_id for item in results if item.repaired],
            'results': [item.dict() for item in results],
        },
        organization_ids_override=action_organization_ids,
    )
    if not payload.dry_run:
        repaired_ids = [item.file_id for item in results if item.repaired]
        _record_asset_sensitive_action(
            request=request,
            permission_code='asset:repair',
            action='asset.repair_organization',
            target_ids=normalized_ids,
            reason=reason,
            ticket_id=ticket_id,
            affected_count=response.repaired_count,
            before_preview=[
                before_preview_by_id.get(item_id, {'file_id': item_id, 'unavailable': True})
                for item_id in normalized_ids
            ],
            after_preview=[
                {
                    'file_id': item.file_id,
                    'status': 'repaired',
                    'resolved_organization_id': item.resolved_organization_id,
                    'repair_state': item.repair_state,
                    'reason_code': item.reason_code,
                }
                for item in results
                if item.repaired
            ],
        )
    return response
