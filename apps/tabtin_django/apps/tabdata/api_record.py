"""
Record API 接口

Record CRUD、批量操作。
"""
import json
import logging
from uuid import UUID

from django.http import HttpRequest, HttpResponse, JsonResponse
from ninja import Body, Router

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import RecordService
from apps.tabdata.schemas import (
    TableRecordCreate, TableRecordUpdate,
    BulkRecordCreateRequest, BulkRecordUpdateRequest,
    RecordReorderRequest, BulkRecordDeleteRequest,
    RecordUpsertRequest,
    ErrorResponse,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    permission_denied_response, validation_error_response,
    api_error_handler, record_version_conflict_response,
    retryable_write_sqlstate, write_contention_response,
)
from apps.tabdata.api_utils import (
    parse_int_param,
    normalize_record_field_key_type,
    sanitize_pagination_params,
)
from apps.tabdata.utils.record_serializers import (
    serialize_record,
    serialize_records,
    filter_native_record_fields,
)
from django.db.utils import ProgrammingError, OperationalError
from apps.tabdata.exceptions import RecordVersionConflictError
from apps.users.membership.exceptions import MembershipException, QuotaExceededError as MembershipQuotaExceededError
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


# ==================== Record List ====================

@router.get(
    "/tables/{table_id}/records",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的记录列表"
)
@api_error_handler
def list_records(
    request: HttpRequest,
    table_id: UUID
):
    """
    获取表格的记录列表（支持分页、搜索、排序、增量同步）
    """
    page, page_size = sanitize_pagination_params(
        request.GET.get('page'),
        request.GET.get('page_size')
    )

    search = request.GET.get('search')
    if search in ['null', 'undefined', '']:
        search = None

    sort_by = request.GET.get('sort_by')
    if sort_by in ['null', 'undefined', '']:
        sort_by = None

    sort_order = request.GET.get('sort_order', 'asc') or 'asc'

    filters_raw = request.GET.get('filters')
    filters = None
    if filters_raw and filters_raw not in ('null', 'undefined', ''):
        try:
            filters = json.loads(filters_raw)
        except (ValueError, TypeError):
            filters = None

    fields_param = request.GET.get('fields')
    fields_set = None
    if fields_param and fields_param not in ['null', 'undefined']:
        fields_set = {f.strip() for f in fields_param.split(',') if f.strip()}
    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType')
    )

    since_version = parse_int_param(request.GET.get('since_version'))

    header_version = request.headers.get('if-none-match') if hasattr(request, 'headers') else None
    if header_version:
        header_version = header_version.strip().strip('"')
        if header_version.startswith('W/'):
            header_version = header_version[2:]
        header_version_int = parse_int_param(header_version)
    else:
        header_version_int = None

    # 同 get_view_records：ETag header 版本仅用于 304 判断，不用于 since_version 查询
    reference_version_for_query = since_version
    reference_version_for_304 = since_version if since_version is not None else header_version_int

    only_delta = (request.GET.get('only_delta', 'false') or 'false').lower() in ('true', '1', 'yes')

    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    result = service.list_records(
        table_id=table_id,
        page=page,
        page_size=page_size,
        search=search,
        filters=filters,
        sort_by=sort_by,
        sort_order=sort_order,
        since_version=reference_version_for_query,
        only_delta=only_delta,
        field_key_type=field_key_type,
        rls_context=rls_ctx,
    )

    visible_fields = result.get('visible_fields') or {}
    if fields_set is not None and visible_fields:
        if field_key_type == 'id':
            allowed_keys = set(visible_fields.get('ids', []))
        elif field_key_type == 'dbFieldName':
            allowed_keys = set(visible_fields.get('dbFieldNames', []))
        else:
            allowed_keys = set(visible_fields.get('names', []))
        fields_set = {f for f in fields_set if f in allowed_keys}

    latest_version = result.get('latest_version', 0)
    has_changes = result.get('has_changes', True)

    if reference_version_for_304 is not None and not has_changes:
        response = HttpResponse(status=304)
        response['ETag'] = str(latest_version)
        return response

    records = result.get('records', [])
    # Phase 3D: _list_records_native 已返回序列化后的 dict 列表，
    # 无需再调用 serialize_records（它期望 ORM 对象）。
    # 仅在有 fields_set 时进行字段过滤。
    if records and isinstance(records[0], dict):
        serialized_records = records
        if fields_set:
            # ``data`` 固定按字段名输出，``fields_set`` 在 id/dbFieldName 模式下是
            # id/dbFieldName key——直接用它过滤 ``data`` 会整体清空（ 同源）。
            # 借 ``visible_fields`` 的并列数组把 key 映射回字段名后再过滤。
            data_fields_set = fields_set
            if field_key_type != 'name' and visible_fields:
                names = visible_fields.get('names', [])
                src_keys = visible_fields.get(
                    'ids' if field_key_type == 'id' else 'dbFieldNames', [],
                )
                key_to_name = {
                    str(k): names[i]
                    for i, k in enumerate(src_keys) if i < len(names)
                }
                data_fields_set = {key_to_name.get(k, k) for k in fields_set}
            filter_native_record_fields(
                serialized_records, fields_set,
                data_fields_set=data_fields_set,
            )
    else:
        serialized_records = serialize_records(
            records,
            fields=fields_set,
            field_key_type=field_key_type,
        )

    payload = {
        'records': serialized_records,
        'total': result.get('total', 0),
        'matched_total': result.get('matched_total', len(serialized_records)),
        'page': page,
        'page_size': page_size,
        'latest_version': latest_version,
        'delta': bool(only_delta and reference_version_for_query is not None),
        'requires_full_reload': bool(result.get('requires_full_reload', False)),
    }

    response = JsonResponse(success_response(payload), status=200)
    response['ETag'] = str(latest_version)
    return response


# ==================== Record CRUD Operations ====================
# 注意：具体路径的路由必须在参数化路由之前定义，避免路由匹配冲突

@router.post(
    "/records",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建记录"
)
@api_error_handler
def create_record(request: HttpRequest, data: TableRecordCreate):
    """
    创建新记录

    Args:
        data: 记录数据

    Returns:
        创建的记录
    """
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = RecordService(user=request.auth)
        payload = data.resolved_payload()
        result = service.create_record(
            table_id=data.table_id,
            data=payload,
            order_context=data.order_context.model_dump(exclude_none=True) if data.order_context else None,
            rls_context=rls_ctx,
        )

        record, error_msg = result
        if error_msg:
            return validation_error_response(error_msg)

        return 201, success_response(
            data=serialize_record(
                record,
                field_key_type=normalize_record_field_key_type(data.field_key_type),
            ),
            message=_("tabdata.record_created")
        )
    except ValueError as e:
        return validation_error_response(str(e))
    except MembershipQuotaExceededError as e:
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(e),
            status_code=403,
            detail=str(e)
        )
    except MembershipException as e:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(e),
            status_code=403,
        )


# ==================== Bulk Record Operations ====================

@router.post(
    "/records/bulk-create",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="批量创建记录"
)
@api_error_handler
def bulk_create_records(request: HttpRequest, data: BulkRecordCreateRequest):
    """
    批量创建记录

    Args:
        data: 批量创建数据

    Returns:
        批量操作结果
    """
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        operation_group_id = UUID(str(data.operation_group_id)) if data.operation_group_id else None
        service = RecordService(user=request.auth)
        created_records, errors = service.bulk_create_records(
            table_id=data.table_id,
            records_data=data.resolved_records(),
            field_key_type=data.field_key_type,
            order_context=data.order_context.model_dump(exclude_none=True) if data.order_context else None,
            operation_group_id=operation_group_id,
            rls_context=rls_ctx,
        )
        stats = getattr(service, "last_bulk_operation_stats", {}) or {}
        warnings = getattr(service, "last_bulk_field_warnings", None) or []
        response_data = {
            "success_count": len(created_records),
            "records": serialize_records(
                created_records,
                field_key_type=normalize_record_field_key_type(data.field_key_type),
            ),
            "errors": errors,
            **stats,
        }
        if warnings:
            response_data["warnings"] = warnings

        return 201, success_response(
            data=response_data,
            message=_("tabdata.batch_record_created", count=len(created_records))
        )
    except ValueError as e:
        return validation_error_response(str(e))
    except MembershipQuotaExceededError as e:
        return error_response(
            ErrorCode.QUOTA_EXCEEDED,
            message=str(e),
            status_code=403,
            detail=str(e)
        )
    except MembershipException as e:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message=str(e),
            status_code=403,
        )
    except (ProgrammingError, OperationalError) as e:
        logger.error("[bulk_create_records] DB error: %s", e, exc_info=True)
        return error_response(
            ErrorCode.DB_SCHEMA_ERROR,
            message="数据库操作异常，请稍后重试",
            status_code=500,
            detail="如持续出现，请联系管理员检查数据库状态",
        )


@router.post(
    "/records/bulk-update",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="批量更新记录"
)
@api_error_handler
def bulk_update_records(request: HttpRequest, data: BulkRecordUpdateRequest):
    """
    批量更新记录

    Args:
        data: 批量更新数据

    Returns:
        批量操作结果

    注意：
    - 返回完整的记录数据，不受 ?fields 查询参数影响
    - 这样前端可以正确更新本地状态，避免数据丢失
    """
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        operation_group_id = UUID(str(data.operation_group_id)) if data.operation_group_id else None
        field_key_type = normalize_record_field_key_type(
            (request.GET.get('field_key_type') or request.GET.get('fieldKeyType')) if hasattr(request, 'GET') else None
        )
        service = RecordService(user=request.auth)
        record_updates = [
            {
                "record_id": str(item.record_id),
                "data": item.data,
                **({"base_snapshot": item.base_snapshot} if getattr(item, 'base_snapshot', None) else {}),
            }
            for item in data.updates
        ]
        updated_records, errors = service.bulk_update_records(
            record_updates,
            operation_group_id=operation_group_id,
            rls_context=rls_ctx,
        )
        stats = getattr(service, "last_bulk_operation_stats", {}) or {}

        # ⭐ 始终返回完整记录数据，不进行字段过滤
        payload = {
            "success_count": len(updated_records),
            "records": serialize_records(
                updated_records,
                field_key_type=field_key_type,
            ),
            "errors": errors,
            "conflicts": getattr(service, '_last_bulk_update_conflicts', []),
            **stats,
        }

        return success_response(payload, message=_("tabdata.batch_record_updated", count=len(updated_records)))
    except ValueError as e:
        return validation_error_response(str(e))


@router.post(
    "/records/reorder",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="重排记录顺序"
)
@api_error_handler
def reorder_records(request: HttpRequest, data: RecordReorderRequest):
    """
    重排记录顺序（支持多条记录拖拽）。

    语义：
    - `position=end`：移动到末尾
    - `position=before|after`：相对锚点记录插入
    - `group_values`：可选，跨分组拖拽时同步分组字段值
    """
    try:
        field_key_type = normalize_record_field_key_type(
            (request.GET.get('field_key_type') or request.GET.get('fieldKeyType')) if hasattr(request, 'GET') else None
        )
        from apps.tabdata.services.rls_service import RLSContext
        service = RecordService(user=request.auth)
        rls_ctx = RLSContext.from_request(request)
        reordered_records, errors = service.reorder_records(
            table_id=data.table_id,
            record_ids=data.record_ids,
            anchor_record_id=data.anchor_record_id,
            position=data.position,
            view_id=data.view_id,
            group_values=data.group_values,
            rls_context=rls_ctx,
        )
        stats = getattr(service, "last_bulk_operation_stats", {}) or {}

        payload = {
            "success_count": len(reordered_records),
            "records": serialize_records(
                reordered_records,
                field_key_type=field_key_type,
            ),
            "errors": errors,
            **stats,
        }
        return success_response(payload, message=_("tabdata.batch_record_reordered", count=len(reordered_records)))
    except ValueError as e:
        return validation_error_response(str(e))


@router.post(
    "/records/bulk-delete",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse},
    auth=jwt_auth,
    summary="批量删除记录"
)
@api_error_handler
def bulk_delete_records(request: HttpRequest, data: BulkRecordDeleteRequest):
    """
    批量删除记录

    Args:
        data: 批量删除数据

    Returns:
        批量操作结果
    """
    try:
        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        operation_group_id = UUID(str(data.operation_group_id)) if data.operation_group_id else None
        service = RecordService(user=request.auth)
        deleted_count, errors, deleted_record_ids, failed_record_ids = service.bulk_delete_records(
            data.record_ids,
            operation_group_id=operation_group_id,
            rls_context=rls_ctx,
        )
        stats = getattr(service, "last_bulk_operation_stats", {}) or {}

        return success_response({
            "success_count": deleted_count,
            "errors": errors,
            "deleted_record_ids": deleted_record_ids,
            "failed_record_ids": failed_record_ids,
            **stats,
        }, message=_("tabdata.batch_record_deleted", count=deleted_count))
    except ValueError as e:
        return validation_error_response(str(e))
    except (ProgrammingError, OperationalError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            "[bulk_delete_records] write contention (sqlstate=%s)",
            sqlstate,
        )
        return write_contention_response()


@router.post(
    "/records/upsert",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="按唯一字段去重写入",
)
@api_error_handler
def upsert_records(request: HttpRequest, data: RecordUpsertRequest):
    """Agent JWT upsert — 复用 open API ``upsert_records_impl``。"""
    from apps.tabdata.api_open_impl.record_impl import upsert_records_impl
    from apps.tabdata.api_open_schemas import UpsertBody

    body = UpsertBody(
        records=data.records,
        upsert_on=data.upsert_on,
        field_key_type=data.field_key_type,
    )
    return upsert_records_impl(request, data.table_id, body)


# ==================== Single Record Operations (参数化路由放在最后) ====================

@router.get(
    "/records/{record_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取记录详情"
)
@api_error_handler
def get_record(request: HttpRequest, record_id: UUID):
    """
    获取记录详情

    Phase 3D: 从原生列读取，返回序列化后的 dict。

    Args:
        record_id: 记录ID

    Returns:
        记录详情
    """
    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)

    fields_param = request.GET.get('fields')
    fields_set = None
    if fields_param and fields_param not in ['null', 'undefined']:
        fields_set = {f.strip() for f in fields_param.split(',') if f.strip()}

    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType')
    )

    from apps.tabdata.exceptions import RLSAccessDenied
    try:
        record_data = service.get_record_data(
            record_id,
            fields=fields_set,
            field_key_type=field_key_type,
            rls_context=rls_ctx,
        )
    except RLSAccessDenied:
        return permission_denied_response("行级安全策略限制了对此记录的访问")

    if not record_data:
        return not_found_response("记录")

    return success_response(record_data)


@router.put(
    "/records/{record_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse},
    auth=jwt_auth,
    summary="更新记录"
)
@api_error_handler
def update_record(request: HttpRequest, record_id: UUID, data: TableRecordUpdate):
    """
    更新记录

    Args:
        record_id: 记录ID
        data: 更新数据

    Returns:
        更新后的记录
    """
    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)

    service = RecordService(user=request.auth)
    payload = data.resolved_payload()
    try:
        result = service.update_record(
            record_id=record_id,
            data=payload,
            rls_context=rls_ctx,
            expected_version=data.expected_version,
        )
    except RecordVersionConflictError as exc:
        logger.warning(
            "[update_record] version conflict: record=%s expected=%s",
            exc.record_id,
            exc.expected_version,
        )
        return record_version_conflict_response()
    except (ProgrammingError, OperationalError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            "[update_record] write contention (sqlstate=%s)",
            sqlstate,
        )
        return write_contention_response()
    record, error_msg = result
    if error_msg:
        return validation_error_response(error_msg)
    if record is None:
        # 防御服务层遗漏错误信息，避免把 None 交给序列化器变成 500。
        return validation_error_response(
            "该记录已被其他协作者删除，您刚才的修改未保存"
        )

    return success_response(
        data=serialize_record(
            record,
            field_key_type=normalize_record_field_key_type(data.field_key_type),
        ),
        message=_("tabdata.record_updated")
    )


@router.delete(
    "/records/{record_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 500: ErrorResponse, 503: ErrorResponse},
    auth=jwt_auth,
    summary="删除记录"
)
@api_error_handler
def delete_record(request: HttpRequest, record_id: UUID):
    """
    删除记录（不可恢复）

    Args:
        record_id: 记录ID

    Returns:
        删除结果
    """
    from apps.tabdata.services.rls_service import RLSContext
    rls_ctx = RLSContext.from_request(request)

    raw_expected_version = request.GET.get('expected_version')
    if raw_expected_version is None:
        raw_expected_version = request.GET.get('expectedVersion')
    expected_version = parse_int_param(raw_expected_version)
    if (
        raw_expected_version not in (None, '', 'null', 'undefined')
        and expected_version is None
    ):
        return validation_error_response("expected_version 必须为整数")

    service = RecordService(user=request.auth)
    try:
        success = service.delete_record(
            record_id,
            rls_context=rls_ctx,
            expected_version=expected_version,
        )
    except RecordVersionConflictError as exc:
        logger.warning(
            "[delete_record] version conflict: record=%s expected=%s",
            exc.record_id,
            exc.expected_version,
        )
        return record_version_conflict_response()
    except (ProgrammingError, OperationalError) as exc:
        sqlstate = retryable_write_sqlstate(exc)
        if not sqlstate:
            raise
        logger.warning(
            "[delete_record] write contention (sqlstate=%s)",
            sqlstate,
        )
        return write_contention_response()

    if not success:
        return permission_denied_response("删除记录失败，权限不足或记录不存在")

    return success_response(message=_("tabdata.record_deleted"))
