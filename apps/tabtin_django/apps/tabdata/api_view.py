"""
View API 接口

View CRUD、视图数据查询（records/statistics）。
"""
import json
import logging
from typing import Optional
from uuid import UUID

from django.http import HttpRequest, HttpResponse, JsonResponse
from ninja import Router

from apps.users.auth.permissions import JWTAuth

from apps.tabdata.services import TableService, ViewService, ViewDataService
from apps.tabdata.schemas import (
    TableViewCreate, TableViewUpdate, TableViewColumnMetaUpdate,
    ViewReorderRequest,
    ViewConfigValidateRequest,
    ErrorResponse,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.api_helpers import (
    success_response, error_response, not_found_response,
    permission_denied_response, validation_error_response,
    api_error_handler,
)
from apps.tabdata.api_utils import (
    parse_int_param,
    normalize_filter_logic,
    normalize_record_field_key_type,
    parse_if_none_match_etag,
    build_view_records_query_signature,
    build_view_records_etag,
    sanitize_pagination_params,
    serialize_view_payload,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import TableView
from apps.tabdata.view_column_meta_compat import get_view_column_meta_compat_summary
from apps.i18n import _

logger = logging.getLogger(__name__)

router = Router(tags=["TabData"])
jwt_auth = JWTAuth()


# ==================== View CRUD ====================

@router.get(
    "/metrics/view-column-meta-compat-summary",
    response={200: dict, 403: ErrorResponse},
    auth=jwt_auth,
    summary="视图 column_meta 兼容使用摘要"
)
def get_view_column_meta_compat_summary_api(request: HttpRequest):
    if not request.auth:
        return permission_denied_response("Need login")
    return success_response(get_view_column_meta_compat_summary())

@router.get(
    "/tables/{table_id}/views",
    response={200: dict, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取表格的视图列表"
)
@api_error_handler
def list_views(
    request: HttpRequest,
    table_id: UUID
):
    """
    获取表格的视图列表

    Args:
        table_id: 表格ID
        view_type: 视图类型（可选，查询参数）

    Returns:
        视图列表
    """
    # 手动获取查询参数，避免类型验证问题
    view_type = request.GET.get('view_type', None)
    if view_type in ['null', 'undefined', '']:
        view_type = None

    service = ViewService(user=request.auth)
    views = service.list_views(table_id=table_id, view_type=view_type)

    # 手动序列化
    serialized_views = [serialize_view_payload(view) for view in views]

    return success_response({
        "views": serialized_views,
        "total": len(serialized_views)
    })


@router.post(
    "/views/validate-config",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="验证视图配置"
)
@api_error_handler
def validate_view_config(request: HttpRequest, data: ViewConfigValidateRequest):
    """
    验证视图配置是否合法

    Args:
        data: 视图配置验证请求

    Returns:
        验证结果（包含错误、警告和建议）
    """
    from apps.tabdata.models import Table
    from apps.tabdata.utils.view_validators import ViewConfigValidator

    try:
        # 获取表格
        table = Table.objects.using(TABDATA_DB_ALIAS).filter(id=data.table_id).first()
        if not table:
            return not_found_response("表格")

        # 检查权限
        service = TableService(user=request.auth)
        if not service.check_table_permission(str(data.table_id), 'viewer'):
            return permission_denied_response("无权限访问该表格")

        # 验证配置
        is_valid, errors, warnings = ViewConfigValidator.validate(
            table, data.view_type, data.config
        )

        # 获取配置建议
        suggestions = ViewConfigValidator.get_config_suggestions(
            table, data.view_type
        )

        return success_response({
            "is_valid": is_valid,
            "errors": errors,
            "warnings": warnings,
            "suggestions": suggestions
        })

    except ValueError as e:
        logger.warning("验证视图配置参数错误: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("验证视图配置失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.view_config_validate_failed"), status_code=500)


@router.get(
    "/views/{view_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取视图详情"
)
@api_error_handler
def get_view(request: HttpRequest, view_id: UUID):
    """
    获取视图详情

    Args:
        view_id: 视图ID

    Returns:
        视图详情
    """
    service = ViewService(user=request.auth)
    view = service.get_view(view_id)

    if not view:
        return not_found_response("视图")

    return success_response(serialize_view_payload(view))


@router.post(
    "/views",
    response={201: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="创建视图"
)
@api_error_handler
def create_view(request: HttpRequest, data: TableViewCreate):
    """
    创建新视图

    Args:
        data: 视图数据

    Returns:
        创建的视图
    """
    service = ViewService(user=request.auth)
    view = service.create_view(
        table_id=data.table_id,
        name=data.name,
        view_type=data.view_type,
        description=data.description,
        filter=data.filter,
        filters=data.filters,
        sorts=data.sorts,
        groups=data.groups,
        visible_fields=data.visible_fields,
        field_order=data.field_order,
        column_meta=data.column_meta,
        config=data.config
    )

    if not view:
        return permission_denied_response("创建视图失败，权限不足")

    return 201, success_response(
        data=serialize_view_payload(view),
        message=_("tabdata.view_created")
    )


@router.put(
    "/views/{view_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="更新视图"
)
@api_error_handler
def update_view(request: HttpRequest, view_id: UUID, data: TableViewUpdate):
    """
    更新视图

    Args:
        view_id: 视图ID
        data: 更新数据

    Returns:
        更新后的视图
    """
    service = ViewService(user=request.auth)
    view = service.update_view(
        view_id=view_id,
        name=data.name,
        description=data.description,
        filter=data.filter,
        filters=data.filters,
        sorts=data.sorts,
        groups=data.groups,
        visible_fields=data.visible_fields,
        field_order=data.field_order,
        column_meta=data.column_meta,
        config=data.config,
        is_shared=data.is_shared,
        is_locked=data.is_locked
    )

    if not view:
        return not_found_response("视图")

    return success_response(
        data=serialize_view_payload(view),
        message=_("tabdata.view_updated")
    )


@router.put(
    "/views/{view_id}/column-meta",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="更新视图列元数据"
)
@api_error_handler
def update_view_column_meta(request: HttpRequest, view_id: UUID, data: TableViewColumnMetaUpdate):
    """
    更新视图列元数据（column_meta 专用接口）

    Args:
        view_id: 视图ID
        data: 列元数据补丁

    Returns:
        更新后的视图
    """
    import logging as _logging
    _dbg = _logging.getLogger('tabdata.debug.column_meta')
    service = ViewService(user=request.auth)
    try:
        column_meta = data.to_column_meta_map()
        _dbg.warning('[column-meta] incoming column_meta keys=%s sample=%s',
                     list(column_meta.keys())[:5],
                     {k: v for k, v in list(column_meta.items())[:3]})
        view = service.update_view(
            view_id=view_id,
            column_meta=column_meta,
        )
    except ValueError as e:
        _dbg.warning('[column-meta] ValueError: %s', e)
        return validation_error_response(str(e))

    if not view:
        _dbg.warning('[column-meta] view not found for view_id=%s', view_id)
        return not_found_response("视图")

    payload = serialize_view_payload(view)
    _dbg.warning('[column-meta] response visible_fields=%s field_order=%s',
                 payload.get('visible_fields'),
                 payload.get('field_order'))
    _dbg.warning('[column-meta] response column_meta sample=%s',
                 {k: v for k, v in list(payload.get('column_meta', {}).items())[:5]})
    return success_response(
        data=payload,
        message=_("tabdata.view_column_config_updated")
    )


@router.delete(
    "/views/{view_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="删除视图"
)
@api_error_handler
def delete_view(request: HttpRequest, view_id: UUID):
    """
    删除视图

    Args:
        view_id: 视图ID

    Returns:
        删除结果
    """
    service = ViewService(user=request.auth)
    success = service.delete_view(view_id)

    if not success:
        return not_found_response("视图")

    return success_response(message=_("tabdata.view_deleted"))


@router.post(
    "/tables/{table_id}/views/set-default/{view_id}",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="设置首个视图"
)
@api_error_handler
def set_default_view(request: HttpRequest, table_id: UUID, view_id: UUID):
    """
    设置表格的首个视图。

    路由名称保留给旧客户端；当前语义为将目标视图移动到 order 第一。

    Args:
        table_id: 表格ID
        view_id: 视图ID

    Returns:
        操作结果
    """
    service = ViewService(user=request.auth)
    success = service.set_default_view(table_id, view_id)

    if not success:
        return not_found_response("表格或视图")

    return success_response(message=_("tabdata.default_view_set"))


@router.post(
    "/tables/{table_id}/views/reorder",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="重新排序视图"
)
@api_error_handler
def reorder_views(request: HttpRequest, table_id: UUID, data: ViewReorderRequest):
    """
    重新排序表格的视图

    Args:
        table_id: 表格ID
        data: 排序数据

    Returns:
        操作结果
    """
    service = ViewService(user=request.auth)
    success = service.reorder_views(table_id, data.view_orders)

    if not success:
        return permission_denied_response("重新排序失败，权限不足")

    return success_response(message=_("tabdata.view_reordered"))


# ==================== View Data ====================

@router.get(
    "/views/{view_id}/records",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取视图数据"
)
@api_error_handler
def get_view_records(
    request: HttpRequest,
    view_id: UUID
):
    """
    获取视图的数据（应用过滤、排序、分组等配置）
    """
    def _parse_json_param(name: str) -> Optional[object]:
        raw = request.GET.get(name)
        if raw in (None, '', 'null', 'undefined'):
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(_("tabdata.param_json_error", name=name, detail=str(exc))) from exc

    page, page_size = sanitize_pagination_params(
        request.GET.get('page'),
        request.GET.get('page_size')
    )

    date_range = request.GET.get('date_range')
    if date_range in ['null', 'undefined', '']:
        date_range = None

    fields_param = request.GET.get('fields')
    fields_list = None
    if fields_param and fields_param not in ['null', 'undefined']:
        fields_list = [f.strip() for f in fields_param.split(',') if f.strip()]
    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType')
    )

    search = request.GET.get('search')
    if search in ['null', 'undefined']:
        search = None
    if isinstance(search, str):
        search = search.strip()
        if not search:
            search = None

    search_field_ids_param = request.GET.get('search_field_ids')
    search_field_ids = None
    if search_field_ids_param and search_field_ids_param not in ['null', 'undefined']:
        search_field_ids = [f.strip() for f in search_field_ids_param.split(',') if f.strip()]

    try:
        raw_search_hide_not_match_rows = request.GET.get('search_hide_not_match_rows')
        search_hide_not_match_rows = False
        if raw_search_hide_not_match_rows not in (None, '', 'null', 'undefined'):
            normalized_bool = str(raw_search_hide_not_match_rows).strip().lower()
            if normalized_bool in ('true', '1', 'yes', 'on'):
                search_hide_not_match_rows = True
            elif normalized_bool in ('false', '0', 'no', 'off'):
                search_hide_not_match_rows = False
            else:
                raise ValueError(_("tabdata.param_must_be_boolean"))

        since_version = parse_int_param(request.GET.get('since_version'))

        header_version = request.headers.get('if-none-match') if hasattr(request, 'headers') else None
        header_version_int, header_query_signature = parse_if_none_match_etag(header_version)

        # reference_version_for_query: 仅使用 URL 显式传入的 since_version，
        # 用于 service 层的增量/变更判断。ETag header 的版本号不应作为 since_version，
        # 否则在视图配置变更（如隐藏字段）后，记录未变但 query_signature 已变时，
        # 会跳过 304 却返回 records=[] 的空响应。
        reference_version_for_query = since_version
        # reference_version_for_304: 同时考虑 ETag header，仅用于 304 条件检查。
        reference_version_for_304 = since_version if since_version is not None else header_version_int

        only_delta = (request.GET.get('only_delta', 'false') or 'false').lower() in ('true', '1', 'yes')

        filters_param = _parse_json_param('filters')
        if filters_param is not None and not isinstance(filters_param, list):
            raise ValueError(_("tabdata.param_filters_must_be_list"))

        groups_param = _parse_json_param('groups')
        if groups_param is not None and not isinstance(groups_param, list):
            raise ValueError(_("tabdata.param_groups_must_be_list"))

        sorts_param = _parse_json_param('sorts')
        if sorts_param is not None and not isinstance(sorts_param, list):
            raise ValueError(_("tabdata.param_sorts_must_be_list"))

        raw_filter_logic = request.GET.get('filter_logic')
        filter_logic = normalize_filter_logic(raw_filter_logic)
        if raw_filter_logic not in (None, '', 'null', 'undefined') and filter_logic is None:
            raise ValueError(_("tabdata.param_filter_logic_invalid"))

        per_group_limit = parse_int_param(request.GET.get('per_group_limit'))
        group_offsets_raw = request.GET.get('group_offsets')
        group_offsets = None
        if group_offsets_raw and group_offsets_raw not in ('null', 'undefined'):
            try:
                group_offsets = json.loads(group_offsets_raw)
                if not isinstance(group_offsets, dict):
                    group_offsets = None
            except (json.JSONDecodeError, TypeError):
                group_offsets = None

        # 如果请求显式覆写了查询语义（分组/筛选/字段范围/日期范围等），
        # 即使版本号未变化，也必须返回 200 + body，避免 304 丢失当前查询上下文结果。
        has_query_overrides = any([
            filters_param is not None,
            groups_param is not None,
            sorts_param is not None,
            filter_logic is not None,
            date_range is not None,
            fields_list is not None,
            field_key_type != 'name',
            search is not None,
            bool(search_field_ids),
            bool(search_hide_not_match_rows),
        ])

        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ViewDataService(user=request.auth)
        data = service.get_view_records(
            view_id=view_id,
            page=page,
            page_size=page_size,
            fields=fields_list,
            field_key_type=field_key_type,
            since_version=reference_version_for_query,
            only_delta=only_delta,
            date_range=date_range,
            filters=filters_param,
            filter_logic=filter_logic,
            groups=groups_param,
            sorts=sorts_param,
            search=search,
            search_field_ids=search_field_ids,
            search_hide_not_match_rows=search_hide_not_match_rows,
            per_group_limit=per_group_limit,
            group_offsets=group_offsets,
            rls_context=rls_ctx,
        )

        latest_version = data.get('latest_version', 0)
        latest_version_int = parse_int_param(str(latest_version)) or 0
        has_changes = data.get('has_changes', True)

        view_payload = data.get('view') if isinstance(data.get('view'), dict) else {}
        view_config = view_payload.get('config') if isinstance(view_payload.get('config'), dict) else {}
        effective_filter_logic = filter_logic or normalize_filter_logic(view_config.get('filter_logic'))
        query_signature = build_view_records_query_signature({
            'view_id': str(view_id),
            'page': page,
            'page_size': page_size,
            'date_range': date_range,
            'fields': fields_list,
            'field_key_type': field_key_type,
            'only_delta': bool(only_delta),
            'effective_filters': filters_param if filters_param is not None else view_payload.get('filters'),
            'effective_filter_logic': effective_filter_logic,
            'effective_groups': groups_param if groups_param is not None else view_payload.get('groups'),
            'effective_sorts': sorts_param if sorts_param is not None else view_payload.get('sorts'),
            'search': search,
            'search_field_ids': search_field_ids,
            'search_hide_not_match_rows': bool(search_hide_not_match_rows),
            'view_type': view_payload.get('view_type'),
            'view_config': view_payload.get('config'),
            'visible_fields': view_payload.get('visible_fields'),
            'field_order': view_payload.get('field_order'),
        })
        response_etag = build_view_records_etag(latest_version_int, query_signature)

        signature_matches = (
            header_query_signature is not None and
            header_query_signature == query_signature
        )
        allow_304_without_signature = (
            since_version is not None and
            header_query_signature is None and
            not has_query_overrides
        )
        if reference_version_for_304 is not None and not has_changes and (signature_matches or allow_304_without_signature):
            response = HttpResponse(status=304)
            response['ETag'] = response_etag
            return response

        response = JsonResponse(success_response(data), status=200)
        response['ETag'] = response_etag
        return response

    except TableView.DoesNotExist:
        return not_found_response("视图")
    except PermissionError as e:
        logger.warning("获取视图数据权限不足: %s", e)
        return permission_denied_response(str(e) or "tabdata.no_permission")
    except ValueError as e:
        logger.warning("获取视图数据参数错误: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("获取视图数据失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.view_data_failed"), status_code=500)


@router.get(
    "/views/{view_id}/column-statistics",
    response={200: dict, 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 500: ErrorResponse},
    auth=jwt_auth,
    summary="获取视图列统计"
)
@api_error_handler
def get_view_column_statistics(
    request: HttpRequest,
    view_id: UUID
):
    """
    获取视图列统计（基于视图配置或请求覆写的统计函数）。
    """
    def _parse_json_param(name: str) -> Optional[object]:
        raw = request.GET.get(name)
        if raw in (None, '', 'null', 'undefined'):
            return None
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ValueError(_("tabdata.param_json_error", name=name, detail=str(exc))) from exc

    try:
        filters_param = _parse_json_param('filters')
        if filters_param is not None and not isinstance(filters_param, list):
            raise ValueError(_("tabdata.param_filters_must_be_list"))

        filter_logic = request.GET.get('filter_logic')
        if filter_logic in (None, '', 'null', 'undefined'):
            filter_logic = None
        elif filter_logic.lower() not in ('and', 'or'):
            raise ValueError(_("tabdata.param_filter_logic_invalid"))

        funcs_param = _parse_json_param('column_statistic_funcs')
        if funcs_param is not None and not isinstance(funcs_param, dict):
            raise ValueError(_("tabdata.param_column_stats_must_be_object"))

        from apps.tabdata.services.rls_service import RLSContext
        rls_ctx = RLSContext.from_request(request)

        service = ViewDataService(user=request.auth)
        data = service.get_view_column_statistics(
            view_id=view_id,
            column_statistic_funcs=funcs_param if isinstance(funcs_param, dict) else None,
            filters=filters_param if isinstance(filters_param, list) else None,
            filter_logic=filter_logic.lower() if filter_logic else None,
            rls_context=rls_ctx,
        )

        response = success_response(data)
        response['ETag'] = str(data.get('latest_version', 0))
        return response
    except TableView.DoesNotExist:
        return not_found_response("视图")
    except ValueError as e:
        logger.warning("获取视图列统计参数错误: %s", e)
        return validation_error_response(str(e))
    except Exception as e:
        logger.exception("获取视图列统计失败")
        return error_response(ErrorCode.INTERNAL_ERROR, message=_("tabdata.view_column_stats_failed"), status_code=500)
