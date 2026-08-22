"""
Open API Storage 路由 & 实现

面向外部集成 / SDK 的附件存储 API，支持 JWT 和 API Token 双认证。
提供文件上传、下载、列表、删除等能力。

Legacy 路径前缀: /api/tabdata/open/v1/tables/{table_id}/storage  (待废弃)
Space 级路径前缀: /api/open/v1/spaces/{space_id}/data/tables/{table_id}/storage
"""

import hashlib
import logging
import os
import uuid
from typing import Optional
from uuid import UUID

from django.conf import settings
from django.db import transaction
from django.db.models import F
from django.http import HttpRequest
from django.utils import timezone
from ninja import Router, Schema, File, Form
from ninja.files import UploadedFile
from pydantic import Field as PydField

from apps.tabdata.auth_open_api import (
    open_api_auth,
    require_scope,
    require_table_access,
)
from apps.tabdata.api_helpers import (
    success_response,
    error_response,
    not_found_response,
    permission_denied_response,
    api_error_handler,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS, FILE_BASED_FIELD_TYPES
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models import (
    Table,
    TableField,
    TableRecord,
    AttachmentUpload,
    AttachmentReference,
)
from apps.services.oss.models import FileRecord, UploadTask
from apps.services.oss.services.file_access import (
    resolve_authorized_file,
    resolve_file_access,
)
from apps.services.oss.services.public_assets import build_public_asset_url
from apps.services.oss.services.factory import get_oss_service
from apps.services.common.utils import get_file_type_from_extension
from apps.tabdata.services import AttachmentService

logger = logging.getLogger(__name__)

router = Router(tags=["Storage"])


# ── Schemas ──────────────────────────────────────────────


class PresignedUploadRequest(Schema):
    """Get presigned URL for direct-to-OSS upload."""
    field_id: str = PydField(description='Attachment field UUID')
    file_name: str = PydField(description='Original file name')
    file_size: int = PydField(gt=0, le=500 * 1024 * 1024, description='File size in bytes (max 500MB)')
    mime_type: str = PydField(default='application/octet-stream', description='MIME type')
    record_id: Optional[str] = PydField(default=None, description='Record UUID (optional)')


# ── Helpers ──────────────────────────────────────────────


def _validate_attachment_field(table: Table, field_id: str) -> TableField:
    """Validate that a field exists, belongs to the table, and is an attachment type."""
    field = TableField.objects.using(TABDATA_DB_ALIAS).get(
        id=field_id, table=table, is_deleted=False,
    )
    if field.field_type not in FILE_BASED_FIELD_TYPES:
        raise ValueError(f"Field {field_id} is not an attachment type")
    return field


def _get_table(table_id: UUID) -> Table:
    """Fetch table or raise ObjectDoesNotExist."""
    return Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)


def _private_file_accessible_in_organization(
    file_record: FileRecord,
    organization_id,
) -> bool:
    file_organization_id = str(file_record.organization_id or '')
    target_organization_id = str(organization_id or '')
    if file_organization_id:
        return bool(
            target_organization_id
            and file_organization_id == target_organization_id
        )
    if not target_organization_id:
        return False
    # Legacy private files may predate organization_id. Only accept them when
    # every active reference proves the same organization; otherwise fail closed.
    reference_organizations = set(
        str(value)
        for value in AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            file_id=file_record.id,
            is_deleted=False,
            organization_id=F('table__organization_id'),
        ).values_list('table__organization_id', flat=True).distinct()
    )
    return reference_organizations == {target_organization_id}


def _file_delivery_fields(
    file_record: FileRecord,
    *,
    organization_id=None,
    oss_service=None,
) -> dict:
    """Keep legacy URL fields usable without exposing a bare private object URL."""
    if file_record.is_public:
        return {
            'access_url': build_public_asset_url(file_record.file_key) or file_record.access_url or '',
            'cdn_url': file_record.cdn_url or '',
            'access_mode': 'public',
            'expires_in': None,
            'expires_at': None,
        }

    if not _private_file_accessible_in_organization(file_record, organization_id):
        return {
            'access_url': '',
            'cdn_url': '',
            'access_mode': 'denied',
            'expires_in': None,
            'expires_at': None,
        }

    accessible = resolve_authorized_file(
        file_record,
        expiration=3600,
        oss_service=oss_service,
    )
    return {
        'access_url': accessible.url,
        # Older clients prefer cdn_url when present. A bare CDN URL is not
        # usable for a private object and must not outrank the signed URL.
        'cdn_url': '',
        'access_mode': accessible.access_mode,
        'expires_in': accessible.expires_in,
        'expires_at': accessible.expires_at,
    }


def _file_record_to_dict(
    file_record: FileRecord,
    *,
    organization_id=None,
    oss_service=None,
) -> dict:
    """Serialize a FileRecord to API response dict."""
    result = {
        'file_id': str(file_record.id),
        'file_name': file_record.file_name,
        'file_size': file_record.file_size,
        'mime_type': file_record.mime_type,
        'file_type': file_record.file_type,
        'is_public': file_record.is_public,
        'status': file_record.status,
        'created_at': file_record.created_at.isoformat() if file_record.created_at else None,
        'updated_at': file_record.updated_at.isoformat() if file_record.updated_at else None,
    }
    result.update(_file_delivery_fields(
        file_record,
        organization_id=organization_id,
        oss_service=oss_service,
    ))
    return result


def _reference_to_dict(
    ref: AttachmentReference,
    file_record: Optional[FileRecord] = None,
    *,
    organization_id=None,
    oss_service=None,
) -> dict:
    """Serialize an AttachmentReference (with its FileRecord) to API response dict."""
    if file_record is None:
        file_record = FileRecord.objects.using('default').filter(id=ref.file_id).first()

    result = {
        'reference_id': str(ref.id),
        'file_id': str(ref.file_id),
        'table_id': str(ref.table_id),
        'field_id': str(ref.field_id),
        'record_id': str(ref.record_id) if ref.record_id else None,
        'is_deleted': ref.is_deleted,
        'created_at': ref.created_at.isoformat() if ref.created_at else None,
        'updated_at': ref.updated_at.isoformat() if ref.updated_at else None,
    }
    if file_record:
        result.update({
            'file_name': file_record.file_name,
            'file_size': file_record.file_size,
            'mime_type': file_record.mime_type,
        })
        result.update(_file_delivery_fields(
            file_record,
            organization_id=organization_id,
            oss_service=oss_service,
        ))
    return result


# ── Endpoints ────────────────────────────────────────────


def storage_upload_impl(
    request: HttpRequest,
    table_id: UUID,
    field_id: str,
    file: UploadedFile,
    record_id: Optional[str] = None,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    # ── O2: Validate UUID format for field_id / record_id ────
    try:
        UUID(field_id)
    except (ValueError, AttributeError):
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            f'Invalid field_id format: {field_id}',
            status_code=400,
        )
    if record_id is not None:
        try:
            UUID(record_id)
        except (ValueError, AttributeError):
            return error_response(
                ErrorCode.VALIDATION_ERROR,
                f'Invalid record_id format: {record_id}',
                status_code=400,
            )

    user = request.auth
    table = _get_table(table_id)
    field = _validate_attachment_field(table, field_id)

    record = None
    if record_id:
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(
            id=record_id, table=table, is_deleted=False,
        )

    # Check organization storage quota
    organization_id = table.organization_id
    if not organization_id:
        raise ValueError("Table is missing organization information")

    max_size = getattr(settings, 'OSS_MAX_FILE_SIZE', 500 * 1024 * 1024)
    if file.size > max_size:
        raise ValueError(f"File size {file.size} exceeds maximum allowed size {max_size}")

    if file.size > 0:
        from apps.services.billing.services import OrganizationStorageBillingService
        OrganizationStorageBillingService.assert_storage_upload_allowed(
            organization_id=str(organization_id),
            incoming_bytes=int(file.size),
        )

    # Build object key
    service = AttachmentService(user=user)
    original_filename = file.name or 'unnamed'
    file_extension = os.path.splitext(original_filename)[1].lower().lstrip('.')
    object_key = service._build_object_key(
        organization_id=str(organization_id),
        table_id=str(table.id),
        file_name=original_filename,
    )

    # Read file content once for hash + upload
    file.seek(0)
    file_content = file.read()
    file_hash = hashlib.md5(file_content).hexdigest()
    file.seek(0)

    # Detect MIME type — prefer python-magic, fall back to client-provided type
    try:
        import magic
        mime_type = magic.from_buffer(file_content, mime=True)
    except Exception:
        mime_type = file.content_type or 'application/octet-stream'
        logger.debug(
            "python-magic unavailable, using fallback MIME type: %s (file=%s)",
            mime_type, original_filename,
        )

    # Upload to OSS
    oss_service = get_oss_service()
    upload_result = oss_service.upload_file(
        file, object_key,
        content_type=mime_type,
        file_hash=file_hash,
    )
    if not upload_result.get('success'):
        raise RuntimeError(f"OSS upload failed: {upload_result.get('message', 'unknown error')}")

    if not oss_service.set_object_private(object_key):
        try:
            oss_service.delete_file(object_key)
        except Exception:
            logger.error("Failed to clean up OSS file after private ACL failure %s", object_key)
        raise RuntimeError("私有附件访问权限设置失败，请检查 OSS Bucket/AK 权限")

    # ── O1: Cross-database write with manual cleanup on failure ────
    # Django does not support cross-database transactions.  We write
    # FileRecord to 'default' DB first, then create AttachmentReference on
    # TABDATA_DB.  If any downstream step fails, we clean up the orphaned
    # FileRecord and the already-uploaded OSS object.

    # Step 1 – Create FileRecord (default DB)
    file_record = FileRecord.objects.using('default').create(
        file_name=original_filename,
        file_key=object_key,
        file_path=os.path.dirname(object_key),
        file_size=file.size,
        file_type=get_file_type_from_extension(file_extension),
        mime_type=mime_type,
        file_extension=file_extension,
        file_hash=file_hash,
        bucket_name=oss_service.config.get('bucket_name'),
        access_url=upload_result['data'].get('access_url', ''),
        cdn_url=upload_result['data'].get('cdn_url', ''),
        is_public=False,
        upload_user=str(user.id) if user else '',
        upload_source='tabdata_open_api',
        organization_id=str(organization_id),
        status='completed',
        metadata={
            'organization_id': str(organization_id),
            'table_id': str(table.id),
            'field_id': str(field.id),
            'record_id': str(record.id) if record else None,
        },
        tags=['tabdata', 'open_api'],
    )

    try:
        # Step 2 – Create AttachmentReference (TABDATA DB)
        reference = AttachmentReference.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=organization_id,
            space_id=table.space_id,
            table=table,
            field=field,
            record=record,
            file_id=file_record.id,
            created_by=user if user else None,
            permission_scope={
                'organization_id': str(organization_id),
                'table_id': str(table.id),
                'field_id': str(field.id),
                'table_is_public': table.is_public,
            },
            usage_metadata={'source': 'open_api_upload'},
        )

        # Step 3 – Record storage allocation (non-blocking: log warning on failure)
        try:
            from apps.services.billing.services import OrganizationStorageBillingService
            OrganizationStorageBillingService.apply_storage_delta(
                organization_id=str(organization_id),
                file_id=str(file_record.id),
                delta_bytes=int(file_record.file_size or 0),
                user_id=str(user.id) if user else '',
                biz_type='attachment_upload',
                biz_id=str(reference.id),
                metadata={
                    'table_id': str(table.id),
                    'field_id': str(field.id),
                    'record_id': str(record.id) if record else '',
                    'source': 'open_api_upload',
                },
            )
        except Exception:
            logger.warning(
                "Storage billing update failed for organization=%s file=%s, "
                "storage metrics may be inaccurate",
                organization_id, file_record.id,
                exc_info=True,
            )
    except Exception as exc:
        # Rollback: delete the orphaned FileRecord
        try:
            file_record.delete()
        except Exception:
            logger.error("Failed to clean up orphaned FileRecord %s", file_record.id)
        # Rollback: remove the already-uploaded OSS object
        try:
            oss_service.delete_file(object_key)
        except Exception:
            logger.error("Failed to clean up OSS file %s", object_key)
        raise  # Re-raise so api_error_handler returns a proper error response

    accessible_file = resolve_file_access(
        file_record,
        user,
        expiration=3600,
        oss_service=oss_service,
    )

    return success_response({
        'file_id': str(file_record.id),
        'reference_id': str(reference.id),
        'file_name': file_record.file_name,
        'file_size': file_record.file_size,
        'mime_type': file_record.mime_type,
        'access_url': accessible_file.url,
        'expires_in': accessible_file.expires_in,
    })


@router.post(
    "/tables/{table_id}/storage/upload",
    auth=open_api_auth,
    summary="Upload file to table attachment field",
)
@require_scope('storage:write')
@require_table_access
@api_error_handler
def storage_upload(
    request: HttpRequest,
    table_id: UUID,
    field_id: str = Form(...),
    file: UploadedFile = File(...),
    record_id: str = Form(None),
):
    """
    Simple single-file upload (proxied through Django).

    Accepts multipart/form-data with:
    - field_id: UUID of an attachment field
    - file: the file to upload
    - record_id: (optional) UUID of the record to attach the file to

    Returns file metadata including file_id and access_url.
    """
    return storage_upload_impl(request, table_id, field_id, file, record_id)


def storage_presigned_upload_impl(
    request: HttpRequest,
    table_id: UUID,
    body: PresignedUploadRequest,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    user = request.auth
    table = _get_table(table_id)
    _validate_attachment_field(table, body.field_id)

    if body.record_id:
        TableRecord.objects.using(TABDATA_DB_ALIAS).get(
            id=body.record_id, table=table, is_deleted=False,
        )

    organization_id = table.organization_id
    if not organization_id:
        raise ValueError("Table is missing organization information")

    max_size = getattr(settings, 'OSS_MAX_FILE_SIZE', 500 * 1024 * 1024)
    if body.file_size > max_size:
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            f'File size {body.file_size} exceeds maximum of {max_size} bytes',
            status_code=400,
        )

    if body.file_size > 0:
        from apps.services.billing.services import OrganizationStorageBillingService
        OrganizationStorageBillingService.assert_storage_upload_allowed(
            organization_id=str(organization_id),
            incoming_bytes=int(body.file_size),
        )

    service = AttachmentService(user=user)
    result = service.create_upload_task(
        table_id=table_id,
        field_id=UUID(body.field_id),
        files=[{
            'file_name': body.file_name,
            'file_size': body.file_size,
            'mime_type': body.mime_type,
        }],
        record_id=UUID(body.record_id) if body.record_id else None,
        task_type='chunk',
    )

    file_info = result['files'][0]
    presign_expiration = 600

    object_key = file_info['object_key']
    oss_service = get_oss_service()
    try:
        upload_url = oss_service.generate_presigned_url(
            object_key,
            expiration=presign_expiration,
            method='PUT',
            content_type=body.mime_type or 'application/octet-stream',
        )
    except Exception as exc:
        return error_response(f"Failed to generate presigned URL: {exc}")

    return success_response({
        'upload_url': upload_url,
        'object_key': object_key,
        'task_id': result['task_id'],
        'upload_item_id': file_info['upload_item_id'],
        'upload_id': file_info.get('upload_id', ''),
        'total_parts': file_info.get('total_parts', 1),
        'part_presigned_urls': file_info.get('part_presigned_urls', {}),
        'expires_in': presign_expiration,
    })


@router.post(
    "/tables/{table_id}/storage/presigned-upload",
    auth=open_api_auth,
    summary="Get presigned URL for direct upload",
)
@require_scope('storage:write')
@require_table_access
@api_error_handler
def storage_presigned_upload(
    request: HttpRequest,
    table_id: UUID,
    body: PresignedUploadRequest,
):
    return storage_presigned_upload_impl(request, table_id, body)


def storage_complete_upload_impl(
    request: HttpRequest,
    table_id: UUID,
    upload_item_id: UUID,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    user = request.auth

    try:
        upload = AttachmentUpload.objects.using(TABDATA_DB_ALIAS).get(
            id=upload_item_id,
            table_id=table_id,
        )
    except AttachmentUpload.DoesNotExist:
        return not_found_response("upload task")

    service = AttachmentService(user=user)
    result = service.complete_upload(
        task_id=upload.upload_task_id,
        upload_item_id=upload_item_id,
    )

    return success_response({
        'upload_item_id': result.get('upload_item_id'),
        'file_id': result.get('file_id'),
        'status': result.get('status'),
        'reference': result.get('reference'),
    })


@router.post(
    "/tables/{table_id}/storage/presigned-upload/{upload_item_id}/complete",
    auth=open_api_auth,
    summary="Complete presigned upload",
)
@require_scope('storage:write')
@require_table_access
@api_error_handler
def storage_complete_upload(
    request: HttpRequest,
    table_id: UUID,
    upload_item_id: UUID,
):
    return storage_complete_upload_impl(request, table_id, upload_item_id)


def storage_download_impl(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    table = _get_table(table_id)
    authoritative_organization_id = table.organization_id
    # The table owns the authorization boundary. A denormalized reference
    # organization is only an integrity assertion and must never grant access.
    reference = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        file_id=file_id,
        organization_id=authoritative_organization_id,
        is_deleted=False,
    ).first()
    if not reference:
        return not_found_response("file")

    try:
        file_record = FileRecord.objects.using('default').get(
            id=file_id, status='completed',
        )
    except FileRecord.DoesNotExist:
        return not_found_response("file")

    if file_record.is_public:
        return success_response({
            'download_url': build_public_asset_url(file_record.file_key) or file_record.access_url or '',
            'file_name': file_record.file_name,
            'file_size': file_record.file_size,
            'mime_type': file_record.mime_type,
            'expires_in': None,
        })

    if not _private_file_accessible_in_organization(
        file_record,
        authoritative_organization_id,
    ):
        return not_found_response("file")

    expiration = 3600
    oss_service = get_oss_service()
    try:
        download_url = oss_service.generate_presigned_url(
            file_record.file_key,
            expiration=expiration,
            method='GET',
        )
    except Exception as exc:
        return error_response(f"Failed to generate download URL: {exc}")

    return success_response({
        'download_url': download_url,
        'file_name': file_record.file_name,
        'file_size': file_record.file_size,
        'mime_type': file_record.mime_type,
        'expires_in': expiration,
    })


@router.get(
    "/tables/{table_id}/storage/{file_id}/download",
    auth=open_api_auth,
    summary="Download file (get presigned download URL)",
)
@require_scope('storage:read')
@require_table_access
@api_error_handler
def storage_download(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    """
    Get a presigned download URL for the file.

    The URL is valid for 1 hour by default.
    """
    return storage_download_impl(request, table_id, file_id)


def storage_list_impl(
    request: HttpRequest,
    table_id: UUID,
    field_id: str = None,
    record_id: str = None,
    page: int = 1,
    page_size: int = 20,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    if page < 1:
        page = 1
    if page_size < 1 or page_size > 100:
        page_size = 20

    table = _get_table(table_id)
    authoritative_organization_id = table.organization_id
    qs = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        organization_id=authoritative_organization_id,
        is_deleted=False,
    )
    if field_id:
        qs = qs.filter(field_id=field_id)
    if record_id:
        qs = qs.filter(record_id=record_id)

    # FileRecord lives on the default alias, so enforce the file/table
    # organization invariant before pagination instead of leaking dirty rows in
    # metadata or in the total count.
    candidate_file_ids = list(qs.values_list('file_id', flat=True).distinct())
    candidate_file_records = FileRecord.objects.using('default').filter(
        id__in=candidate_file_ids,
    )
    authorized_file_ids = [
        file_record.id
        for file_record in candidate_file_records
        if file_record.is_public or _private_file_accessible_in_organization(
            file_record,
            authoritative_organization_id,
        )
    ]
    qs = qs.filter(file_id__in=authorized_file_ids)
    total = qs.count()
    offset = (page - 1) * page_size
    refs = list(qs.order_by('-created_at')[offset:offset + page_size])

    # Batch-fetch file records for efficiency
    file_ids = [ref.file_id for ref in refs]
    file_records_map = {}
    if file_ids:
        file_records = FileRecord.objects.using('default').filter(
            id__in=file_ids,
        )
        file_records_map = {fr.id: fr for fr in file_records}

    oss_service = get_oss_service() if any(
        file_record and not file_record.is_public
        for file_record in file_records_map.values()
    ) else None
    files = [
        _reference_to_dict(
            ref,
            file_records_map.get(ref.file_id),
            organization_id=authoritative_organization_id,
            oss_service=oss_service,
        )
        for ref in refs
    ]

    return success_response({
        'files': files,
        'total': total,
        'page': page,
        'page_size': page_size,
    })


@router.get(
    "/tables/{table_id}/storage",
    auth=open_api_auth,
    summary="List files attached to table",
)
@require_scope('storage:read')
@require_table_access
@api_error_handler
def storage_list(
    request: HttpRequest,
    table_id: UUID,
    field_id: str = None,
    record_id: str = None,
    page: int = 1,
    page_size: int = 20,
):
    """
    List files attached to a table, optionally filtered by field_id and/or record_id.

    Returns paginated list of file references with metadata.
    """
    return storage_list_impl(request, table_id, field_id, record_id, page, page_size)


def storage_file_info_impl(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    table = _get_table(table_id)
    authoritative_organization_id = table.organization_id
    ref = AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
        table_id=table_id,
        file_id=file_id,
        organization_id=authoritative_organization_id,
        is_deleted=False,
    ).first()
    if not ref:
        return not_found_response("file")

    try:
        file_record = FileRecord.objects.using('default').get(id=file_id)
    except FileRecord.DoesNotExist:
        return not_found_response("file")

    if not file_record.is_public and not _private_file_accessible_in_organization(
        file_record,
        authoritative_organization_id,
    ):
        return not_found_response("file")

    data = _file_record_to_dict(
        file_record,
        organization_id=authoritative_organization_id,
        oss_service=get_oss_service() if not file_record.is_public else None,
    )
    data.update({
        'reference_id': str(ref.id),
        'table_id': str(ref.table_id),
        'field_id': str(ref.field_id),
        'record_id': str(ref.record_id) if ref.record_id else None,
    })

    return success_response(data)


@router.get(
    "/tables/{table_id}/storage/{file_id}",
    auth=open_api_auth,
    summary="Get file metadata",
)
@require_scope('storage:read')
@require_table_access
@api_error_handler
def storage_file_info(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    return storage_file_info_impl(request, table_id, file_id)


def storage_delete_impl(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    """业务实现 — 供 Space 级路由直接调用。"""
    user = request.auth

    refs = list(
        AttachmentReference.objects.using(TABDATA_DB_ALIAS).filter(
            table_id=table_id,
            file_id=file_id,
            is_deleted=False,
        )
    )
    if not refs:
        return not_found_response("file")

    service = AttachmentService(user=user)
    deleted_reference_ids = []

    for ref in refs:
        result = service.remove_reference(ref.id, delete_if_orphan=True)
        deleted_reference_ids.append(result.get('reference_id', str(ref.id)))

    return success_response({
        'file_id': str(file_id),
        'deleted_references': deleted_reference_ids,
        'count': len(deleted_reference_ids),
    })


@router.delete(
    "/tables/{table_id}/storage/{file_id}",
    auth=open_api_auth,
    summary="Delete file",
)
@require_scope('storage:write')
@require_table_access
@api_error_handler
def storage_delete(
    request: HttpRequest,
    table_id: UUID,
    file_id: UUID,
):
    """
    Delete a file attachment.

    Marks the AttachmentReference as deleted. If no other references remain
    for this file within the organization, the storage allocation is released.
    Physical file deletion is handled asynchronously.
    """
    return storage_delete_impl(request, table_id, file_id)
