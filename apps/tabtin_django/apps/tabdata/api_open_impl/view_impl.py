import json
import logging
from uuid import UUID

from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.api_utils import normalize_record_field_key_type, parse_int_param
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.services import TableService
from apps.tabdata.api_open_schemas import OpenCreateViewBody, OpenUpdateViewBody
from apps.tabdata.api_open_impl.common import impl_error_handler

logger = logging.getLogger(__name__)


@impl_error_handler('视图列表')
def open_list_views_impl(request: HttpRequest, table_id: UUID):
    from apps.tabdata.services import ViewService
    from apps.tabdata.api_utils import serialize_view_payload

    service = ViewService(user=request.auth)
    views = service.list_views(table_id)
    serialized = [serialize_view_payload(v) for v in views]
    return JsonResponse(
        success_response(data={'views': serialized, 'total': len(serialized)}),
        status=200,
    )


@impl_error_handler('视图')
def open_create_view_impl(request: HttpRequest, table_id: UUID, body: OpenCreateViewBody):
    from apps.tabdata.services import ViewService
    from apps.tabdata.api_utils import serialize_view_payload

    service = ViewService(user=request.auth)
    view = service.create_view(
        table_id=table_id,
        name=body.name,
        view_type=body.type,
        description=body.description,
        filter=body.filter,
        filters=body.filters,
        sorts=body.sorts,
        groups=body.groups,
        visible_fields=body.visible_fields,
        field_order=body.field_order,
        config=body.config,
    )
    if not view:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, "创建视图失败"),
            status=403,
        )
    return JsonResponse(
        success_response(data=serialize_view_payload(view)),
        status=201,
    )


@impl_error_handler('视图')
def open_update_view_impl(request: HttpRequest, table_id: UUID, view_id: UUID, body: OpenUpdateViewBody):
    from apps.tabdata.services import ViewService
    from apps.tabdata.api_utils import serialize_view_payload

    service = ViewService(user=request.auth)
    view = service.update_view(
        view_id=view_id,
        name=body.name,
        description=body.description,
        filter=body.filter,
        filters=body.filters,
        sorts=body.sorts,
        groups=body.groups,
        visible_fields=body.visible_fields,
        field_order=body.field_order,
        config=body.config,
    )
    if not view:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, "视图不存在"),
            status=404,
        )
    return JsonResponse(
        success_response(data=serialize_view_payload(view)),
        status=200,
    )


@impl_error_handler('视图')
def open_delete_view_impl(request: HttpRequest, table_id: UUID, view_id: UUID):
    from apps.tabdata.services import ViewService

    service = ViewService(user=request.auth)
    success = service.delete_view(view_id)
    if not success:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, "视图不存在或无权删除"),
            status=404,
        )
    return JsonResponse(success_response(message="视图已删除"), status=200)


@impl_error_handler('视图数据')
def open_get_view_data_impl(request: HttpRequest, table_id: UUID, view_id: UUID):
    """按视图配置查询记录数据（应用视图的过滤、排序、分组等配置）"""
    from apps.tabdata.services.view_data_service import ViewDataService

    def _parse_json_param(name: str):
        raw = request.GET.get(name)
        if raw in (None, '', 'null', 'undefined'):
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None

    page = parse_int_param(request.GET.get('page')) or 1
    page_size = min(parse_int_param(request.GET.get('page_size')) or 100, 2000)

    field_key_type = normalize_record_field_key_type(
        request.GET.get('field_key_type') or request.GET.get('fieldKeyType') or 'name'
    )

    fields_param = request.GET.get('fields')
    fields_list = None
    if fields_param and fields_param not in ('null', 'undefined'):
        fields_list = [f.strip() for f in fields_param.split(',') if f.strip()]

    search = request.GET.get('search')
    if search in ('null', 'undefined', ''):
        search = None

    filters = _parse_json_param('filters')
    if filters is not None and not isinstance(filters, list):
        filters = None

    sorts = _parse_json_param('sorts')
    if sorts is not None and not isinstance(sorts, list):
        sorts = None

    groups = _parse_json_param('groups')
    if groups is not None and not isinstance(groups, list):
        groups = None

    filter_logic = request.GET.get('filter_logic')
    if filter_logic in (None, '', 'null', 'undefined'):
        filter_logic = None

    date_range = _parse_json_param('date_range')

    per_group_limit = parse_int_param(request.GET.get('per_group_limit'))

    group_offsets = _parse_json_param('group_offsets')
    if group_offsets is not None and not isinstance(group_offsets, dict):
        group_offsets = None

    search_field_ids_raw = request.GET.get('search_field_ids')
    search_field_ids = None
    if search_field_ids_raw and search_field_ids_raw not in ('null', 'undefined'):
        search_field_ids = [s.strip() for s in search_field_ids_raw.split(',') if s.strip()]

    search_hide_raw = request.GET.get('search_hide_not_match_rows', '').lower()
    search_hide_not_match_rows = search_hide_raw in ('true', '1', 'yes')

    service = ViewDataService(user=request.auth)
    data = service.get_view_records(
        view_id=view_id,
        page=page,
        page_size=page_size,
        fields=fields_list,
        field_key_type=field_key_type,
        filters=filters,
        filter_logic=filter_logic,
        groups=groups,
        sorts=sorts,
        search=search,
        search_field_ids=search_field_ids,
        search_hide_not_match_rows=search_hide_not_match_rows,
        date_range=date_range,
        per_group_limit=per_group_limit,
        group_offsets=group_offsets,
    )

    return JsonResponse(success_response(data=data), status=200)
