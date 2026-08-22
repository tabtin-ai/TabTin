"""
Attachment API 接口

附件上传（分片）、完成、取消、复用、删除引用、列表查询。
"""
import logging
from uuid import UUID

from django.db.utils import OperationalError, ProgrammingError
from django.http import HttpRequest
from ninja import Router, Query, File
from ninja.files import UploadedFile

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import AttachmentService
from apps.tabdata.schemas import (
    AttachmentUploadTaskCreate, AttachmentUploadTaskResponse,
    AttachmentPartUploadResponse, AttachmentCompleteResponse,
    AttachmentReuseRequest, AttachmentReferenceOut,
    AttachmentAccessRequest,
    ErrorResponse,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    permission_denied_response,
    api_error_handler,
    retryable_write_sqlstate,
    write_contention_response,
)
from apps.tabdata.models import (
    AttachmentUpload, AttachmentReference,
    TableRecord, TableField,
)
from apps.services.oss.models import FileRecord
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


@router.post(
    "/attachments/upload-task",
    response={
        200: dict,
        400: ErrorResponse,
        401: ErrorResponse,
        403: ErrorResponse,
        500: ErrorResponse,
        503: ErrorResponse,
    },
    auth=jwt_auth,
    summary="创建附件上传任务"
)
@api_error_handler
def create_attachment_upload_task(request: HttpRequest, data: AttachmentUploadTaskCreate):
    try:
        service = AttachmentService(user=request.auth)
        result = service.create_upload_task(
            table_id=data.table_id,
            field_id=data.field_id,
            record_id=data.record_id,
            files=[file.dict() for file in data.files],
            task_type=data.task_type,
        )
    except (OperationalError, ProgrammingError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            "[create_attachment_upload_task] write contention (sqlstate=%s)",
            sqlstate,
        )
        return write_contention_response()
    response = AttachmentUploadTaskResponse(**result)
    return success_response(response.dict())


@router.post(
    "/attachments/upload-task/{task_id}/files/{upload_item_id}/part",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="上传附件分片"
)
@api_error_handler
def upload_attachment_part(
    request: HttpRequest,
    task_id: UUID,
    upload_item_id: UUID,
    part_number: int,
    chunk: UploadedFile = File(...)
):
    try:
        service = AttachmentService(user=request.auth)
        result = service.upload_part(task_id, upload_item_id, part_number, chunk)
        response = AttachmentPartUploadResponse(**result)
        return success_response(response.dict(), message=_("tabdata.chunk_upload_success"))
    except AttachmentUpload.DoesNotExist:
        return not_found_response("上传任务")


@router.post(
    "/attachments/upload-task/{task_id}/files/{upload_item_id}/complete",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="完成附件上传"
)
@api_error_handler
def complete_attachment_upload(request: HttpRequest, task_id: UUID, upload_item_id: UUID):
    try:
        service = AttachmentService(user=request.auth)
        result = service.complete_upload(task_id, upload_item_id)
        response = AttachmentCompleteResponse(**result)
        return success_response(response.dict(), message=_("tabdata.attachment_upload_done"))
    except AttachmentUpload.DoesNotExist:
        return not_found_response("上传任务")
    except RuntimeError as e:
        logger.exception("完成附件上传失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.attachment_upload_failed"), status_code=500)


@router.post(
    "/attachments/upload-task/{task_id}/files/{upload_item_id}/report-part",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="报告直传分片完成（前端直传 OSS 后调用）"
)
@api_error_handler
def report_part_uploaded(
    request: HttpRequest,
    task_id: UUID,
    upload_item_id: UUID,
    part_number: int = Query(...),
    etag: str = Query(...),
    part_size: int = Query(...),
):
    """前端直传某个分片到 OSS 后，调用此接口报告 etag 以更新进度。"""
    try:
        service = AttachmentService(user=request.auth)
        result = service.report_part_uploaded(
            task_id, upload_item_id, part_number, etag, part_size,
        )
        return success_response(result, message=_("tabdata.chunk_report_success"))
    except AttachmentUpload.DoesNotExist:
        return not_found_response("上传任务")


@router.post(
    "/attachments/upload-task/{task_id}/files/{upload_item_id}/abort",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="取消附件上传"
)
@api_error_handler
def abort_attachment_upload(request: HttpRequest, task_id: UUID, upload_item_id: UUID):
    try:
        service = AttachmentService(user=request.auth)
        result = service.abort_upload(task_id, upload_item_id)
        return success_response(result, message=_("tabdata.upload_task_cancelled"))
    except AttachmentUpload.DoesNotExist:
        return not_found_response("上传任务")


@router.post(
    "/attachments/reuse",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="跨表复用附件"
)
@api_error_handler
def reuse_attachment(request: HttpRequest, data: AttachmentReuseRequest):
    try:
        service = AttachmentService(user=request.auth)
        reference = service.reuse_attachment(
            file_id=data.file_id,
            table_id=data.table_id,
            field_id=data.field_id,
            record_id=data.record_id
        )
        response = AttachmentReferenceOut(**reference)
        return success_response(response.dict(), message=_("tabdata.attachment_reuse_success"))
    except FileRecord.DoesNotExist:
        return not_found_response("文件")
    except TableField.DoesNotExist:
        return not_found_response("字段")
    except TableRecord.DoesNotExist:
        return not_found_response("记录")


@router.post(
    "/attachments/access-url",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="按 TabData 业务权限重新签发附件访问地址",
)
@api_error_handler
def resolve_attachment_access(request: HttpRequest, data: AttachmentAccessRequest):
    service = AttachmentService(user=request.auth)
    try:
        result = service.resolve_attachment_access(
            file_id=data.file_id,
            table_id=data.table_id,
            field_id=data.field_id,
            record_id=data.record_id,
            reference_id=data.reference_id,
        )
    except PermissionError:
        return permission_denied_response("无权限访问该表格附件")
    except (AttachmentReference.DoesNotExist, FileRecord.DoesNotExist):
        return not_found_response("附件")
    return success_response(result)


@router.delete(
    "/attachments/{reference_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="移除附件引用"
)
@api_error_handler
def remove_attachment_reference(
    request: HttpRequest,
    reference_id: UUID,
    delete_file: bool = Query(False, description="无引用时删除文件")
):
    try:
        service = AttachmentService(user=request.auth)
        result = service.remove_reference(reference_id, delete_if_orphan=delete_file)
        return success_response(result, message=_("tabdata.attachment_ref_removed"))
    except AttachmentReference.DoesNotExist:
        return not_found_response("附件引用")


@router.get(
    "/records/{record_id}/attachments",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取记录附件列表"
)
@api_error_handler
def list_record_attachments(request: HttpRequest, record_id: UUID):
    try:
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id, is_deleted=False)
    except TableRecord.DoesNotExist:
        return not_found_response("记录")

    service = AttachmentService(user=request.auth)
    if not service.check_table_permission(str(record.table_id), 'viewer'):
        return permission_denied_response("无权限访问该记录")

    attachments = service.list_record_attachments(record_id)
    response = [AttachmentReferenceOut(**item).dict() for item in attachments]
    return success_response({'attachments': response, 'total': len(response)})
