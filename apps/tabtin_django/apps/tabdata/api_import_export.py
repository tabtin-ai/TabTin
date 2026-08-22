"""
Import/Export API 接口

数据导入（CSV/Excel/JSON）、数据导出（CSV/Excel/JSON/PDF）。
"""
import json
import logging
from typing import Any, Dict, Optional
from uuid import UUID

from django.http import HttpRequest, HttpResponse
from ninja import Router, Schema, Form, File
from ninja.files import UploadedFile

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import ImportService, ExportService
from apps.tabdata.services.import_error_classifier import (
    classify_import_error, build_error_summary,
)
from apps.tabdata.schemas import (
    ImportPreviewRequest, ImportFromExcelRequest,
    ImportFromCSVRequest, ImportFromJSONRequest,
    ImportSpaceFromJSONRequest,
    AsyncImportFileRequest,
    ExportToCSVRequest, ExportToExcelRequest, ExportToJSONRequest,
    ExportSpaceFromJSONRequest, ExportToPDFRequest,
    ErrorResponse,
)
from apps.tabdata.error_codes import ErrorCode
from django.core.exceptions import ObjectDoesNotExist
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    validation_error_response, permission_denied_response, api_error_handler,
)
from apps.users.membership.exceptions import QuotaExceededError
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()

_EXPORT_DOWNLOAD_EXPIRATION = 30 * 60  # 签名 URL 有效期 30 分钟

_MAX_TEXT_IMPORT_BYTES = 10 * 1024 * 1024   # CSV / JSON body: 10 MB
_MAX_EXCEL_IMPORT_BYTES = 20 * 1024 * 1024  # Excel file: 20 MB

_EXPORT_VIEW_QUERY_KEYS = ('filters', 'filter_logic', 'sorts', 'groups')


def _get_export_view_query(data) -> Dict[str, Any]:
    """仅传递客户端显式提供的查询态，缺省继续使用持久化 View。"""
    return {
        key: value
        for key in _EXPORT_VIEW_QUERY_KEYS
        for value in [getattr(data, key, None)]
        if value is not None
    }


def _parse_export_view_query_params(
    *,
    filters: Optional[str],
    filter_logic: Optional[str],
    sorts: Optional[str],
    groups: Optional[str],
) -> Dict[str, Any]:
    query: Dict[str, Any] = {}
    for key, raw_value in (('filters', filters), ('sorts', sorts), ('groups', groups)):
        if raw_value is None:
            continue
        value = json.loads(raw_value)
        if not isinstance(value, list):
            raise ValueError(f'{key} 必须是 JSON 数组')
        query[key] = value
    if filter_logic is not None:
        if filter_logic not in ('and', 'or'):
            raise ValueError('filter_logic 必须是 and 或 or')
        query['filter_logic'] = filter_logic
    return query


def _dispatch_async_export(request, export_format: str, data) -> HttpResponse:
    """分发异步导出任务并返回 task_id。"""
    from apps.tabdata.tasks.import_export_tasks import async_export_data
    _is_token_auth = getattr(request, 'api_token', None) is not None
    kwargs = {
        'table_id': str(data.table_id),
        'export_format': export_format,
        'user_id': str(request.auth.id),
        'field_ids': [str(fid) for fid in data.field_ids] if data.field_ids else None,
        'record_ids': [str(rid) for rid in data.record_ids] if data.record_ids else None,
        'view_id': str(data.view_id) if data.view_id else None,
        'is_token_auth': _is_token_auth,
        'view_query': _get_export_view_query(data),
    }
    if hasattr(data, 'include_headers'):
        kwargs['include_headers'] = data.include_headers
    if hasattr(data, 'sheet_name'):
        kwargs['sheet_name'] = data.sheet_name
    if hasattr(data, 'format_type'):
        kwargs['format_type'] = data.format_type
    if hasattr(data, 'orientation'):
        kwargs['orientation'] = data.orientation
    if hasattr(data, 'title') and data.title is not None:
        kwargs['title'] = data.title

    # ATK-2: 传递 API Key organization 约束到 Celery 任务
    from apps.users.auth.api_key_context import get_api_key_organization_constraint
    _api_key_wt = get_api_key_organization_constraint()
    if _api_key_wt:
        kwargs['api_key_organization_id'] = _api_key_wt

    task = async_export_data.apply_async(kwargs=kwargs)
    #  W3：登记发起人，让 CLI / headless 能用 GET /tabdata/tasks/{id} 轮询到终态
    # （WS 通知只覆盖有长连接的客户端）。
    from apps.tabdata.services.async_task_registry import KIND_EXPORT, register_task
    register_task(
        task.id,
        kind=KIND_EXPORT,
        user_id=str(request.auth.id),
        table_id=str(data.table_id),
    )
    #  W3：必须回 JsonResponse 而不是 dict——export/csv|json 声明 response={200: str}、
    # excel|pdf 声明 {200: bytes}，Ninja 会拿这个 model 校验 dict 返回值并抛 500
    # （异步分支上线以来一直 500，只有 WS 那侧看起来"能用"）。HttpResponse 子类会跳过校验。
    from django.http import JsonResponse
    return JsonResponse(success_response({
        'async': True,
        'task_id': task.id,
        'message': '已提交异步导出任务，可通过 GET /tabdata/tasks/{task_id} 轮询，或等待 WS 通知下载链接',
    }))


def _build_import_result(
    created_count: int,
    updated_count: int,
    errors: list,
    import_metadata: Optional[dict] = None,
    *,
    service: Optional[ImportService] = None,
):
    """构建统一的导入结果响应（含结构化错误分类）。"""
    classified = getattr(service, "_last_classified_errors", None) if service else None
    if classified is None:
        classified = [classify_import_error(e) for e in errors]

    skipped_count = getattr(service, "_last_skipped_count", 0) if service else 0

    message = "导入完成"
    if created_count > 0:
        message += f"，新建 {created_count} 条"
    if updated_count > 0:
        message += f"，更新 {updated_count} 条"
    if skipped_count > 0:
        message += f"，跳过 {skipped_count} 条"

    return success_response({
        "created_count": created_count,
        "updated_count": updated_count,
        "skipped_count": skipped_count,
        "error_summary": build_error_summary(classified),
        "errors": [e.to_dict() for e in classified],
        "import_metadata": import_metadata,
    }, message=message)


def _validate_space_organization(request: HttpRequest, space_id: UUID):
    """校验 Space 归属 organization，通过返回 None，失败返回错误响应。"""
    organization_id = request.headers.get("X-Organization-Id", "").strip()
    if organization_id:
        try:
            from apps.tabtinspace.services.base import ensure_space_in_organization
            ensure_space_in_organization(organization_id, str(space_id))
        except ValueError:
            return not_found_response("智能体空间")
    return None


# ==================== Import Preview ====================

@router.post(
    "/import/preview",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导入前数据预览"
)
@api_error_handler
def preview_import_data(request: HttpRequest, data: Form[ImportPreviewRequest], file: File[UploadedFile]):
    """
    导入前数据预览和验证
    支持上传文件查看导入预览、字段匹配建议、数据验证结果
    """
    try:
        file_type = data.file_type
        _ALLOWED_FILE_TYPES = {'csv', 'excel', 'xlsx', 'xls', 'json'}
        if file_type not in _ALLOWED_FILE_TYPES:
            return validation_error_response(f"不支持的文件类型: {file_type}，允许: {', '.join(sorted(_ALLOWED_FILE_TYPES))}")

        raw_bytes = file.read()
        size_limit = _MAX_EXCEL_IMPORT_BYTES if file_type in ('excel', 'xlsx', 'xls') else _MAX_TEXT_IMPORT_BYTES
        if len(raw_bytes) > size_limit:
            return validation_error_response(f"文件超过 {size_limit // (1024 * 1024)}MB 限制")

        if file_type == 'csv':
            try:
                file_content = raw_bytes.decode('utf-8-sig')
            except UnicodeDecodeError:
                try:
                    file_content = raw_bytes.decode('gbk')
                except UnicodeDecodeError:
                    return validation_error_response("CSV 文件编码不支持，请使用 UTF-8 或 GBK 编码")
        elif file_type in ('excel', 'xlsx', 'xls'):
            file_content = raw_bytes
            file_type = 'excel'
        elif file_type == 'json':
            try:
                file_content = raw_bytes.decode('utf-8')
            except UnicodeDecodeError:
                try:
                    file_content = raw_bytes.decode('gbk')
                except UnicodeDecodeError:
                    return validation_error_response("JSON 文件编码不支持，请使用 UTF-8 或 GBK 编码")
        else:
            return validation_error_response(f"不支持的文件类型: {file_type}")

        service = ImportService(user=request.auth)
        preview_result = service.preview_import(
            table_id=data.table_id,
            file_content=file_content,
            file_type=file_type,
            preview_rows=data.preview_rows,
        )

        return success_response(preview_result)

    except ValueError as e:
        logger.warning("导入预览格式错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("导入预览失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.import_preview_failed"), status_code=500)


class ImportPreviewJsonRequest(Schema):
    """JSON body 导入预览请求（供 Daemon/CLI 使用）。"""
    table_id: UUID
    file_type: str
    file_content: Optional[str] = None
    file_base64: Optional[str] = None
    preview_rows: int = 10
    sheet_name: Optional[str] = None


@router.post(
    "/import/preview-json",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导入前数据预览（JSON body）"
)
@api_error_handler
def preview_import_data_json(request: HttpRequest, data: ImportPreviewJsonRequest):
    """
    通过 JSON body 进行导入预览。
    供 Daemon CLI 代理层使用，避免 multipart 上传。
    """
    _ALLOWED_FILE_TYPES = {'csv', 'excel', 'json'}
    if data.file_type not in _ALLOWED_FILE_TYPES:
        return validation_error_response(
            f"不支持的文件类型: {data.file_type}，允许: {', '.join(sorted(_ALLOWED_FILE_TYPES))}"
        )

    if data.file_type == 'excel':
        if not data.file_base64:
            return validation_error_response("file_type 为 excel 时必须提供 file_base64")
        import base64
        raw = data.file_base64
        if ',' in raw:
            raw = raw.split(',', 1)[1]
        try:
            file_content = base64.b64decode(raw)
        except Exception:
            return validation_error_response("file_base64 不是有效的 base64 编码")
        if len(file_content) > _MAX_EXCEL_IMPORT_BYTES:
            return validation_error_response(f"Excel 文件超过 {_MAX_EXCEL_IMPORT_BYTES // (1024 * 1024)}MB 限制")
    else:
        if not data.file_content:
            return validation_error_response("file_content 不能为空")
        file_content = data.file_content
        if len(file_content.encode('utf-8')) > _MAX_TEXT_IMPORT_BYTES:
            return validation_error_response(
                f"{data.file_type.upper()} 内容超过 {_MAX_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制"
            )

    try:
        service = ImportService(user=request.auth)
        preview_result = service.preview_import(
            table_id=data.table_id,
            file_content=file_content,
            file_type=data.file_type,
            preview_rows=data.preview_rows,
            sheet_name=data.sheet_name,
        )
        return success_response(preview_result)

    except ValueError as e:
        logger.warning("导入预览格式错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("导入预览失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.import_preview_failed"), status_code=500)


# ==================== Import APIs ====================

@router.post(
    "/import/csv",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从CSV导入数据"
)
@api_error_handler
def import_from_csv(request: HttpRequest, data: ImportFromCSVRequest):
    """
    从CSV文件导入数据到表格
    支持增量导入（更新已有记录）

    Args:
        data: 导入请求数据

    Returns:
        导入结果
    """
    try:
        if len(data.csv_content.encode('utf-8')) > _MAX_TEXT_IMPORT_BYTES:
            return validation_error_response(f"CSV 内容超过 {_MAX_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试")
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)
        service = ImportService(user=request.auth)
        created_count, updated_count, errors = service.import_from_csv(
            table_id=data.table_id,
            file_content=data.csv_content,
            skip_errors=data.skip_errors,
            update_existing=data.update_existing,
            primary_key_field=data.primary_key_field,
            auto_create_missing_fields=data.auto_create_missing_fields,
            rls_context=rls_ctx,
        )
        return _build_import_result(
            created_count, updated_count, errors,
            getattr(service, "last_import_metadata", None),
            service=service,
        )

    except ValueError as e:
        logger.warning("CSV 导入数据校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except QuotaExceededError:
        raise
    except Exception as e:
        logger.exception("CSV 导入失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="CSV 导入失败，请稍后重试", status_code=500)


@router.post(
    "/import/excel",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从Excel导入数据"
)
@api_error_handler
def import_from_excel(request: HttpRequest, data: Form[ImportFromExcelRequest], file: File[UploadedFile]):
    """
    从Excel文件导入数据到表格
    支持增量导入（更新已有记录）
    """
    try:
        file_bytes = file.read()
        if len(file_bytes) > _MAX_EXCEL_IMPORT_BYTES:
            return validation_error_response(f"Excel 文件超过 {_MAX_EXCEL_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试")

        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)
        service = ImportService(user=request.auth)
        created_count, updated_count, errors = service.import_from_excel(
            table_id=data.table_id,
            file_bytes=file_bytes,
            skip_errors=data.skip_errors,
            update_existing=data.update_existing,
            primary_key_field=data.primary_key_field,
            sheet_name=data.sheet_name,
            auto_create_missing_fields=data.auto_create_missing_fields,
            rls_context=rls_ctx,
        )
        return _build_import_result(
            created_count, updated_count, errors,
            getattr(service, "last_import_metadata", None),
            service=service,
        )

    except ValueError as e:
        logger.warning("Excel 导入数据校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except QuotaExceededError:
        raise
    except Exception as e:
        logger.exception("Excel 导入失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="Excel 导入失败，请稍后重试", status_code=500)


class ImportFromExcelBase64Request(Schema):
    """通过 base64 内容导入 Excel（供 Daemon/CLI 使用）。"""
    table_id: UUID
    file_base64: str
    skip_errors: bool = False
    update_existing: bool = False
    primary_key_field: Optional[str] = None
    sheet_name: Optional[str] = None
    auto_create_missing_fields: bool = True


@router.post(
    "/import/excel-base64",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从Excel导入数据（base64 JSON body）"
)
@api_error_handler
def import_from_excel_base64(request: HttpRequest, data: ImportFromExcelBase64Request):
    """
    通过 base64 编码的 Excel 内容导入数据。
    供 Daemon CLI 代理层使用，避免 multipart 上传。
    """
    import base64
    raw = data.file_base64
    if ',' in raw:
        raw = raw.split(',', 1)[1]
    try:
        file_bytes = base64.b64decode(raw)
    except Exception:
        return validation_error_response("file_base64 不是有效的 base64 编码")

    if len(file_bytes) > _MAX_EXCEL_IMPORT_BYTES:
        return validation_error_response(f"Excel 文件超过 {_MAX_EXCEL_IMPORT_BYTES // (1024 * 1024)}MB 限制")

    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)
    service = ImportService(user=request.auth)
    created_count, updated_count, errors = service.import_from_excel(
        table_id=data.table_id,
        file_bytes=file_bytes,
        skip_errors=data.skip_errors,
        update_existing=data.update_existing,
        primary_key_field=data.primary_key_field,
        sheet_name=data.sheet_name,
        auto_create_missing_fields=data.auto_create_missing_fields,
        rls_context=rls_ctx,
    )
    return _build_import_result(
        created_count, updated_count, errors,
        getattr(service, "last_import_metadata", None),
        service=service,
    )


@router.post(
    "/import/json",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从JSON导入数据"
)
@api_error_handler
def import_from_json(request: HttpRequest, data: ImportFromJSONRequest):
    """
    从JSON文件导入数据到表格
    支持增量导入（更新已有记录）

    Args:
        data: 导入请求数据

    Returns:
        导入结果
    """
    try:
        if len(data.json_content.encode('utf-8')) > _MAX_TEXT_IMPORT_BYTES:
            return validation_error_response(f"JSON 内容超过 {_MAX_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试")
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)
        service = ImportService(user=request.auth)
        created_count, updated_count, errors = service.import_from_json(
            table_id=data.table_id,
            json_content=data.json_content,
            skip_errors=data.skip_errors,
            update_existing=data.update_existing,
            primary_key_field=data.primary_key_field,
            auto_create_missing_fields=data.auto_create_missing_fields,
            fast_mode=data.fast_mode,
            rls_context=rls_ctx,
        )
        return _build_import_result(
            created_count, updated_count, errors,
            getattr(service, "last_import_metadata", None),
            service=service,
        )

    except ValueError as e:
        logger.warning("JSON 导入数据校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except QuotaExceededError:
        raise
    except Exception as e:
        logger.exception("JSON 导入失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="JSON 导入失败，请稍后重试", status_code=500)


@router.post(
    "/spaces/import/json",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="从 Space 快照JSON导入数据"
)
@api_error_handler
def import_space_from_json(request: HttpRequest, data: ImportSpaceFromJSONRequest):
    """
    从 base_full 快照导入到指定 Space（会创建新表）

    Args:
        data: Space 导入请求数据

    Returns:
        导入结果（按表汇总）
    """
    ws_err = _validate_space_organization(request, data.space_id)
    if ws_err:
        return ws_err

    if len(data.json_content.encode('utf-8')) > _MAX_TEXT_IMPORT_BYTES:
        return validation_error_response(f"Space JSON 内容超过 {_MAX_TEXT_IMPORT_BYTES // (1024 * 1024)}MB 限制，请拆分后重试")

    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)
        service = ImportService(user=request.auth)
        result = service.import_space_from_json(
            space_id=data.space_id,
            json_content=data.json_content,
            skip_errors=data.skip_errors,
            update_existing=data.update_existing,
            primary_key_field=data.primary_key_field,
            auto_create_missing_fields=data.auto_create_missing_fields,
            rls_context=rls_ctx,
        )

        message = "Space 导入完成"
        if result.get("created_tables", 0) > 0:
            message += f"，创建表 {result['created_tables']} 张"
        if result.get("created_count", 0) > 0:
            message += f"，新建记录 {result['created_count']} 条"
        if result.get("updated_count", 0) > 0:
            message += f"，更新记录 {result['updated_count']} 条"

        return success_response(result, message=message)
    except ValueError as e:
        logger.warning("Space 导入数据校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("Space")
    except QuotaExceededError:
        raise
    except Exception as e:
        logger.exception("Space JSON 导入失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="Space 导入失败，请稍后重试", status_code=500)


@router.get(
    "/import/template/{table_id}",
    response={200: str, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取导入模板"
)
@api_error_handler
def get_import_template(
    request: HttpRequest,
    table_id: UUID,
    file_format: str = 'csv',
):
    """
    获取表格的导入模板（CSV 或 JSON）

    Query:
        file_format: csv（默认）| json
        format: 兼容旧参数名，与 file_format 同义
    """
    try:
        legacy_format = (request.GET.get('format') or '').strip().lower()
        template_format = (file_format or legacy_format or 'csv').strip().lower()
        service = ImportService(user=request.auth)
        template = service.get_import_template(table_id, format=template_format)

        if template_format == 'json':
            # 不用 attachment，避免部分客户端把 JSON 当二进制/CSV 错存
            response = HttpResponse(template, content_type='application/json; charset=utf-8')
            response['Content-Disposition'] = 'inline; filename="import_template.json"'
            return response

        response = HttpResponse(template, content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = 'attachment; filename="import_template.csv"'
        return response
    except ValueError as e:
        logger.warning("获取导入模板校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("获取导入模板失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.import_template_failed"), status_code=500)


_ASYNC_IMPORT_FILE_SIZE_THRESHOLD = 500 * 1024  # DATA-18: 从 2MB 降至 500KB，避免同步路径在慢 DB 下超 Gunicorn 30s 超时
_OSS_TRANSIT_THRESHOLD = 5 * 1024 * 1024  # DATA-3: 超过 5MB 走 OSS 中转，避免撑爆 Redis


def _run_file_import(request: HttpRequest, data, raw_bytes: bytes):
    """文件导入的唯一实现：按大小自动选同步 / Celery 异步路径。

    multipart（``/import/file``，Electron UI）与 base64 JSON（``/import/file-base64``，
    CLI / Daemon 代理层）两条传输通道共用本函数，避免阈值、OSS 中转、编码回退这些
    规则在两处漂移。
    """
    _ALLOWED = {'csv', 'excel', 'xlsx', 'xls', 'json'}
    file_type = data.file_type
    if file_type in ('xlsx', 'xls'):
        file_type = 'excel'
    if file_type not in _ALLOWED:
        return validation_error_response(f"不支持的文件类型: {file_type}")

    try:
        size_limit = _MAX_EXCEL_IMPORT_BYTES if file_type == 'excel' else _MAX_TEXT_IMPORT_BYTES
        if len(raw_bytes) > size_limit:
            return validation_error_response(f"文件超过 {size_limit // (1024 * 1024)}MB 限制")

        use_async = len(raw_bytes) > _ASYNC_IMPORT_FILE_SIZE_THRESHOLD

        if file_type == 'csv':
            try:
                file_content = raw_bytes.decode('utf-8-sig')
            except UnicodeDecodeError:
                file_content = raw_bytes.decode('gbk')
        elif file_type == 'json':
            try:
                file_content = raw_bytes.decode('utf-8-sig')
            except UnicodeDecodeError:
                file_content = raw_bytes.decode('gbk')
        else:
            file_content = None

        if use_async:
            from apps.tabdata.tasks.import_export_tasks import async_import_data

            _is_token_auth = getattr(request, 'api_token', None) is not None
            task_kwargs = {
                'table_id': str(data.table_id),
                'file_type': file_type,
                'user_id': str(request.auth.id),
                'skip_errors': data.skip_errors,
                'update_existing': data.update_existing,
                'primary_key_field': data.primary_key_field,
                'auto_create_missing_fields': data.auto_create_missing_fields,
                'sheet_name': data.sheet_name,
                'is_token_auth': _is_token_auth,
            }

            # ATK-2: 传递 API Key organization 约束到 Celery 任务
            from apps.users.auth.api_key_context import get_api_key_organization_constraint
            _api_key_wt = get_api_key_organization_constraint()
            if _api_key_wt:
                task_kwargs['api_key_organization_id'] = _api_key_wt

            if len(raw_bytes) > _OSS_TRANSIT_THRESHOLD:
                import uuid as _uuid
                from apps.services.oss.services.factory import get_oss_service
                oss = get_oss_service()
                object_key = f"import_transit/{_uuid.uuid4().hex}"
                oss.upload_bytes(raw_bytes, object_key, content_type='application/octet-stream')
                task_kwargs['oss_object_key'] = object_key
            else:
                import base64
                if file_type == 'excel':
                    task_kwargs['file_content'] = base64.b64encode(raw_bytes).decode('ascii')
                else:
                    task_kwargs['file_content'] = file_content

            task = async_import_data.apply_async(kwargs=task_kwargs)
            #  W3：同导出——登记发起人，支撑 GET /tabdata/tasks/{id} 轮询。
            from apps.tabdata.services.async_task_registry import KIND_IMPORT, register_task
            register_task(
                task.id,
                kind=KIND_IMPORT,
                user_id=str(request.auth.id),
                table_id=str(data.table_id),
            )
            return success_response({
                'async': True,
                'task_id': task.id,
                'message': '文件较大，已提交异步导入任务，可通过 GET /tabdata/tasks/{task_id} 轮询，或等待 WS 通知',
            })

        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)
        service = ImportService(user=request.auth)
        if file_type == 'csv':
            created, updated, errors = service.import_from_csv(
                table_id=data.table_id,
                file_content=file_content,
                skip_errors=data.skip_errors,
                update_existing=data.update_existing,
                primary_key_field=data.primary_key_field,
                auto_create_missing_fields=data.auto_create_missing_fields,
                rls_context=rls_ctx,
            )
        elif file_type == 'excel':
            created, updated, errors = service.import_from_excel(
                table_id=data.table_id,
                file_bytes=raw_bytes,
                skip_errors=data.skip_errors,
                update_existing=data.update_existing,
                primary_key_field=data.primary_key_field,
                sheet_name=data.sheet_name,
                auto_create_missing_fields=data.auto_create_missing_fields,
                rls_context=rls_ctx,
            )
        else:
            created, updated, errors = service.import_from_json(
                table_id=data.table_id,
                json_content=file_content,
                skip_errors=data.skip_errors,
                update_existing=data.update_existing,
                primary_key_field=data.primary_key_field,
                auto_create_missing_fields=data.auto_create_missing_fields,
                rls_context=rls_ctx,
            )

        return _build_import_result(
            created, updated, errors,
            getattr(service, 'last_import_metadata', None),
            service=service,
        )

    except ValueError as e:
        logger.warning("文件导入校验失败: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except QuotaExceededError:
        raise
    except Exception as e:
        logger.exception("文件导入失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="导入失败，请稍后重试", status_code=500)


@router.post(
    "/import/file",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="文件导入（大文件自动异步）"
)
@api_error_handler
def import_from_file(request: HttpRequest, data: Form[AsyncImportFileRequest], file: File[UploadedFile]):
    """
    上传文件导入数据。当文件超过阈值 (500 KB) 时自动转为 Celery 异步任务，
    立即返回 task_id，客户端通过 WS 或 GET /tabdata/tasks/{task_id} 轮询获取导入结果。
    """
    return _run_file_import(request, data, file.read())


class AsyncImportFileBase64Request(Schema):
    """``/import/file`` 的 base64 JSON 变体（供 CLI / Daemon 代理层使用）。

    字段与 ``AsyncImportFileRequest`` 一致，只是文件内容改由 ``file_base64`` 承载——
    cli-server 与 Django 之间是 JSON 通道，发不了 multipart。
    """
    table_id: UUID
    file_base64: str
    file_type: str = 'csv'
    skip_errors: bool = False
    update_existing: bool = False
    primary_key_field: Optional[str] = None
    auto_create_missing_fields: bool = True
    sheet_name: Optional[str] = None


@router.post(
    "/import/file-base64",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="文件导入（base64 JSON body，大文件自动异步）"
)
@api_error_handler
def import_from_file_base64(request: HttpRequest, data: AsyncImportFileBase64Request):
    """``/import/file`` 的 JSON 通道版本，行为完全一致（含 500KB 异步阈值与 OSS 中转）。"""
    import base64
    raw = data.file_base64
    if ',' in raw:
        raw = raw.split(',', 1)[1]
    try:
        raw_bytes = base64.b64decode(raw)
    except Exception:
        return validation_error_response("file_base64 不是有效的 base64 编码")
    return _run_file_import(request, data, raw_bytes)


class AsyncImportOSSFileRequest(Schema):
    """已上传到 OSS 的文件导入请求（ W3）。

    只接受 ``file_id``（``FileRecord`` 主键），**不接受裸 object_key**——后者等于让调用方
    指定任意对象让服务端读出来写进自己的表，是一条越权读通道。
    """
    table_id: UUID
    file_id: UUID
    file_type: str = 'csv'
    skip_errors: bool = False
    update_existing: bool = False
    primary_key_field: Optional[str] = None
    auto_create_missing_fields: bool = True
    sheet_name: Optional[str] = None


@router.post(
    "/import/oss-file",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导入已上传到 OSS 的文件（恒异步）"
)
@api_error_handler
def import_from_oss_file(request: HttpRequest, data: AsyncImportOSSFileRequest):
    """#7778 W3：大文件导入的免 body 通道——先把文件传到 OSS，再按 ``file_id`` 导入。

    存在理由：``/import/file-base64`` 把文件塞在 JSON body 里，CLI → cli-server 这一跳
    有 10MB 请求体上限（base64 膨胀 4/3，实际只剩 ~7MB 原始字节可用），而 Django 侧允许
    CSV/JSON 10MB、Excel 20MB。中间这段差值以前只能以"连接被掐断"的形式暴露给用户。
    走本端点时 body 里只有一个 file_id，文件字节从不经过 CLI 通道。

    恒异步：能走到这条路径的文件都远超 500KB 同步阈值，没必要再判一次。

    鉴权三道：① 文件必须是调用方本人上传的（``FileRecord.upload_user``）；
    ② 调用方对目标表要有 editor 权限；③ 文件大小仍受 CSV/JSON 10MB、Excel 20MB 限制。
    """
    from apps.services.oss.models import FileRecord

    _ALLOWED = {'csv', 'excel', 'xlsx', 'xls', 'json'}
    file_type = data.file_type
    if file_type in ('xlsx', 'xls'):
        file_type = 'excel'
    if file_type not in _ALLOWED:
        return validation_error_response(f"不支持的文件类型: {file_type}")

    try:
        file_record = FileRecord.objects.get(id=data.file_id, status='completed')
    except FileRecord.DoesNotExist:
        return not_found_response("上传文件")

    # 只允许导入自己上传的文件：file_id 是 UUID4 不易猜，但"读任意文件内容写进自己的表"
    # 比附件挂载危险得多，这里按发起人严格收口，不沿用 attachment reuse 的宽松口径。
    if str(file_record.upload_user or '') != str(request.auth.id):
        return permission_denied_response()

    size_limit = _MAX_EXCEL_IMPORT_BYTES if file_type == 'excel' else _MAX_TEXT_IMPORT_BYTES
    if int(file_record.file_size or 0) > size_limit:
        return validation_error_response(f"文件超过 {size_limit // (1024 * 1024)}MB 限制")

    from apps.tabdata.services.base import BaseService
    if not BaseService(user=request.auth).check_table_permission(str(data.table_id), 'editor'):
        return permission_denied_response()

    from apps.tabdata.tasks.import_export_tasks import async_import_data

    task_kwargs = {
        'table_id': str(data.table_id),
        'file_type': file_type,
        'user_id': str(request.auth.id),
        'skip_errors': data.skip_errors,
        'update_existing': data.update_existing,
        'primary_key_field': data.primary_key_field,
        'auto_create_missing_fields': data.auto_create_missing_fields,
        'sheet_name': data.sheet_name,
        'is_token_auth': getattr(request, 'api_token', None) is not None,
        'oss_object_key': file_record.file_key,
        # 这个对象背后有 FileRecord + FileUsage + 组织存储计量，任务读完不能删它
        # （删了会留下指向空对象的记录、计量也对不上）；import_transit/ 那种裸中转键才删。
        'oss_cleanup': False,
    }

    from apps.users.auth.api_key_context import get_api_key_organization_constraint
    _api_key_wt = get_api_key_organization_constraint()
    if _api_key_wt:
        task_kwargs['api_key_organization_id'] = _api_key_wt

    task = async_import_data.apply_async(kwargs=task_kwargs)
    from apps.tabdata.services.async_task_registry import KIND_IMPORT, register_task
    register_task(
        task.id,
        kind=KIND_IMPORT,
        user_id=str(request.auth.id),
        table_id=str(data.table_id),
    )
    return success_response({
        'async': True,
        'task_id': task.id,
        'file_id': str(file_record.id),
        'file_name': file_record.file_name,
        'file_size': file_record.file_size,
        'message': '已提交异步导入任务，可通过 GET /tabdata/tasks/{task_id} 轮询，或等待 WS 通知',
    })


# ==================== Async task status ====================

@router.get(
    "/tasks/{task_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="查询异步导入/导出任务状态"
)
@api_error_handler
def get_async_task_status(request: HttpRequest, task_id: str):
    """#7778 W3：CLI / headless 的异步导入导出轮询入口。

    WS ``export_completed`` / ``import_completed`` 只覆盖有长连接的客户端；本端点让
    没有 WS 的调用方按 ``pending | success | failure`` 三态轮询到终态。

    鉴权：任务发起人直接放行；其他人需要对任务关联表有 editor 权限
    （导入导出结果里可能带表内容摘要，读权限不足以看）。
    发起人登记缺失（未登记 / cache 过期）时按任务不存在处理，不回退到无鉴权查询。
    """
    from apps.tabdata.services.async_task_registry import describe_task, get_task_meta

    if not task_id or len(task_id) > 255:
        return validation_error_response("无效的 task_id")

    meta = get_task_meta(task_id)
    if not meta:
        return not_found_response("异步任务")

    if str(request.auth.id) != meta.get('user_id'):
        table_id = meta.get('table_id') or ''
        try:
            UUID(table_id)
        except (ValueError, TypeError):
            return permission_denied_response()
        from apps.tabdata.services.base import BaseService
        if not BaseService(user=request.auth).check_table_permission(table_id, 'editor'):
            return permission_denied_response()

    return success_response(describe_task(task_id, meta))


# ==================== Export APIs ====================

@router.post(
    "/export/csv",
    response={200: str, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导出数据为CSV"
)
@api_error_handler
def export_to_csv(request: HttpRequest, data: ExportToCSVRequest):
    """
    导出表格数据为CSV文件（流式响应）
    支持导出指定字段、选中记录、视图数据
    """
    if getattr(data, 'async_mode', False):
        return _dispatch_async_export(request, 'csv', data)
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ExportService(user=request.auth)
        streaming_content = service.export_to_csv_streaming(
            table_id=data.table_id,
            field_ids=data.field_ids,
            record_ids=data.record_ids,
            view_id=data.view_id,
            include_headers=data.include_headers,
            rls_context=rls_ctx,
            view_query=_get_export_view_query(data),
        )

        from django.http import StreamingHttpResponse
        response = StreamingHttpResponse(streaming_content, content_type='text/csv; charset=utf-8')
        response['Content-Disposition'] = f'attachment; filename="export_{data.table_id}.csv"'
        return response

    except ValueError as e:
        logger.warning("CSV 导出参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("CSV 导出失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="CSV 导出失败，请稍后重试", status_code=500)


@router.post(
    "/export/excel",
    response={200: bytes, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导出数据为Excel"
)
@api_error_handler
def export_to_excel(request: HttpRequest, data: ExportToExcelRequest):
    """
    导出表格数据为Excel文件
    支持导出指定字段、选中记录、视图数据
    """
    if getattr(data, 'async_mode', False):
        return _dispatch_async_export(request, 'excel', data)
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ExportService(user=request.auth)
        excel_bytes = service.export_to_excel(
            table_id=data.table_id,
            field_ids=data.field_ids,
            record_ids=data.record_ids,
            view_id=data.view_id,
            include_headers=data.include_headers,
            sheet_name=data.sheet_name,
            rls_context=rls_ctx,
            view_query=_get_export_view_query(data),
        )

        response = HttpResponse(
            excel_bytes,
            content_type='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
        response['Content-Disposition'] = f'attachment; filename="export_{data.table_id}.xlsx"'
        response['Content-Length'] = len(excel_bytes)
        return response

    except ValueError as e:
        logger.warning("Excel 导出参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("Excel 导出失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="Excel 导出失败，请稍后重试", status_code=500)


@router.post(
    "/export/json",
    response={200: str, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导出数据为JSON"
)
@api_error_handler
def export_to_json(request: HttpRequest, data: ExportToJSONRequest):
    """
    导出表格数据为JSON文件
    支持导出指定字段、选中记录、视图数据
    """
    if getattr(data, 'async_mode', False):
        return _dispatch_async_export(request, 'json', data)
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ExportService(user=request.auth)

        if data.format_type == 'array':
            from django.http import StreamingHttpResponse
            streaming_content = service.export_to_json_streaming(
                table_id=data.table_id,
                field_ids=data.field_ids,
                record_ids=data.record_ids,
                view_id=data.view_id,
                rls_context=rls_ctx,
                view_query=_get_export_view_query(data),
            )
            response = StreamingHttpResponse(streaming_content, content_type='application/json; charset=utf-8')
        else:
            json_content = service.export_to_json(
                table_id=data.table_id,
                field_ids=data.field_ids,
                record_ids=data.record_ids,
                view_id=data.view_id,
                format_type=data.format_type,
                rls_context=rls_ctx,
                view_query=_get_export_view_query(data),
            )
            response = HttpResponse(json_content, content_type='application/json; charset=utf-8')

        response['Content-Disposition'] = f'attachment; filename="export_{data.table_id}.json"'
        return response

    except ValueError as e:
        logger.warning("JSON 导出参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("JSON 导出失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="JSON 导出失败，请稍后重试", status_code=500)


@router.post(
    "/spaces/export/json",
    response={200: str, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导出 Space 快照为JSON"
)
@api_error_handler
def export_space_to_json(request: HttpRequest, data: ExportSpaceFromJSONRequest):
    """
    导出 Space 级快照（BaseJson v1）

    Args:
        data: Space 导出请求数据

    Returns:
        JSON文件内容
    """
    ws_err = _validate_space_organization(request, data.space_id)
    if ws_err:
        return ws_err

    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ExportService(user=request.auth)
        json_content = service.export_space_to_json(
            space_id=data.space_id,
            table_ids=data.table_ids,
            include_archived=data.include_archived,
            format_type=data.format_type,
            rls_context=rls_ctx,
        )

        response = HttpResponse(
            json_content,
            content_type='application/json; charset=utf-8'
        )
        response['Content-Disposition'] = f'attachment; filename="space_{data.space_id}.json"'
        return response
    except ValueError as e:
        logger.warning("Space 导出参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("Space")
    except Exception as e:
        logger.exception("Space JSON 导出失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="Space 导出失败，请稍后重试", status_code=500)


@router.post(
    "/export/pdf",
    response={200: bytes, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="导出数据为PDF"
)
@api_error_handler
def export_to_pdf(request: HttpRequest, data: ExportToPDFRequest):
    """
    导出表格数据为PDF文件
    支持导出指定字段、选中记录、视图数据
    """
    if getattr(data, 'async_mode', False):
        return _dispatch_async_export(request, 'pdf', data)
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ExportService(user=request.auth)
        pdf_bytes = service.export_to_pdf(
            table_id=data.table_id,
            field_ids=data.field_ids,
            record_ids=data.record_ids,
            view_id=data.view_id,
            orientation=data.orientation,
            title=data.title,
            rls_context=rls_ctx,
            view_query=_get_export_view_query(data),
        )

        response = HttpResponse(
            pdf_bytes,
            content_type='application/pdf'
        )
        response['Content-Disposition'] = f'attachment; filename="export_{data.table_id}.pdf"'
        response['Content-Length'] = len(pdf_bytes)
        return response

    except ValueError as e:
        logger.warning("PDF 导出参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("PDF 导出失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message="PDF 导出失败，请稍后重试", status_code=500)


def _authorize_export_download(request: HttpRequest, file_id: str):
    """校验导出文件可下载，返回 ``(错误响应, FileRecord)``——二者必有其一为 None。"""
    from apps.services.oss.models import FileRecord, FileUsage
    from apps.tabdata.constants import TABDATA_DB_ALIAS

    try:
        UUID(file_id)
    except (ValueError, TypeError):
        return validation_error_response("无效的文件 ID 格式"), None

    try:
        file_record = FileRecord.objects.get(id=file_id, status='completed')
    except FileRecord.DoesNotExist:
        return not_found_response("导出文件"), None

    usage = FileUsage.objects.filter(
        file_record=file_record,
        module='tabdata',
        context_type='export',
        is_active=True,
    ).first()
    if not usage or not usage.context_id:
        return not_found_response("导出文件"), None

    from apps.tabdata.models import Table
    table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=usage.context_id).first()
    if not table:
        return not_found_response("关联表格"), None

    from apps.tabdata.services.base import BaseService
    svc = BaseService(user=request.auth)
    # ：org-only 表 space_id 可为 None，走表级权限（含 Organization 回退）
    if not svc.check_table_permission(str(table.id), 'viewer'):
        return permission_denied_response(), None

    return None, file_record


@router.get(
    "/exports/{file_id}/download",
    auth=jwt_auth,
    summary="下载异步导出文件（需认证）",
)
@api_error_handler
def download_export_file(request: HttpRequest, file_id: str, redirect: bool = True):
    """P0-7: 认证下载端点，验证用户身份和表格权限后生成签名 URL 重定向。

    ``?redirect=false``（ W3）改为返回签名 URL 的 JSON——CLI 侧的 HTTP 客户端
    不跟随 302，且跟随时会把 Authorization 头带到 OSS 导致签名校验失败；
    浏览器 / Electron 仍走默认的 302 重定向路径，行为不变。
    """
    err, file_record = _authorize_export_download(request, file_id)
    if err is not None:
        return err

    from apps.services.oss.services.factory import get_oss_service
    oss = get_oss_service()
    presigned_url = oss.generate_presigned_url(
        file_record.file_key,
        expiration=_EXPORT_DOWNLOAD_EXPIRATION,
    )

    if not redirect:
        return success_response({
            'file_id': str(file_record.id),
            'file_name': file_record.file_name,
            'file_size': file_record.file_size,
            'content_type': file_record.mime_type,
            'download_url': presigned_url,
            'expires_in': _EXPORT_DOWNLOAD_EXPIRATION,
        })

    from django.http import HttpResponseRedirect
    return HttpResponseRedirect(presigned_url)


@router.get(
    "/export/stats/{table_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取导出统计信息"
)
@api_error_handler
def get_export_stats(
    request: HttpRequest,
    table_id: UUID,
    record_ids: Optional[str] = None,
    view_id: Optional[UUID] = None,
    filters: Optional[str] = None,
    filter_logic: Optional[str] = None,
    sorts: Optional[str] = None,
    groups: Optional[str] = None,
):
    """
    获取表格导出的统计信息

    Args:
        table_id: 表格ID
        record_ids: 记录ID列表（逗号分隔）
        view_id: 视图ID

    Returns:
        统计信息
    """
    _MAX_STATS_RECORD_IDS = 100
    record_id_list = None
    is_sampled = False
    original_count = 0
    if record_ids:
        try:
            raw_ids = [rid.strip() for rid in record_ids.split(',') if rid.strip()]
            original_count = len(raw_ids)
            if original_count > _MAX_STATS_RECORD_IDS:
                raw_ids = raw_ids[:_MAX_STATS_RECORD_IDS]
                is_sampled = True
            record_id_list = [UUID(rid) for rid in raw_ids]
        except ValueError:
            return validation_error_response("无效的记录ID格式")

    try:
        view_query = _parse_export_view_query_params(
            filters=filters,
            filter_logic=filter_logic,
            sorts=sorts,
            groups=groups,
        )
        service = ExportService(user=request.auth)
        stats = service.get_export_stats(
            table_id=table_id,
            record_ids=record_id_list,
            view_id=view_id,
            view_query=view_query,
        )

        stats['is_sampled'] = is_sampled
        if is_sampled:
            stats['original_record_count'] = original_count

        return success_response(stats)
    except ValueError as e:
        logger.warning("导出统计参数错误: %s", e)
        return validation_error_response(str(e))
    except PermissionError:
        return permission_denied_response()
    except ObjectDoesNotExist:
        return not_found_response("表格")
    except Exception as e:
        logger.exception("导出统计信息获取失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.export_stats_failed"), status_code=500)
