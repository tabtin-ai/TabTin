"""
Space 级 Developer API 路由（@deprecated ）

历史入口：以 Space 为路径前缀暴露 TabData。

**#6603 起请优先使用 Organization 平行入口**
``/api/open/v1/organizations/{organization_id}/data/...``（见 ``api_open_org``）。
资源归属以 Organization 为准；Space 仅为可选宿主，不再等同「数据库」。

本模块路由短期内保留以兼容既有 Token / SDK；新集成勿再依赖
「Space = 数据库」叙事。

路径前缀: /api/open/v1
"""
import copy
import logging
from typing import List, Optional
from uuid import UUID

from django.http import HttpRequest, JsonResponse
from django.db.models import Q
from ninja import Router, Schema
from ninja import File as NinjaFile, Form
from ninja.files import UploadedFile
from pydantic import Field as PydField

from apps.tabdata.api_agent_sql import (
    sql_catalog_impl,
    sql_execute_impl,
    sql_query_impl,
)
from apps.tabdata.api_helpers import api_error_handler, success_response
from apps.tabdata.field_creation_contract import UI_CREATABLE_FIELD_TYPES
from apps.tabdata.api_open_schemas import (
    AggregationBody,
    BulkCreateBody,
    BulkDeleteBody,
    BulkUpdateBody,
    InlineFieldDefinition,
    OpenCreateFieldBody,
    OpenExportPDFBody,
    OpenCreateRecordBody,
    OpenCreateViewBody,
    OpenExportCSVBody,
    OpenExportExcelBody,
    OpenExportJSONBody,
    OpenImportCSVBody,
    OpenImportExcelBody,
    OpenImportJSONBody,
    OpenImportPreviewBody,
    OpenUpdateFieldBody,
    OpenUpdateRecordBody,
    OpenUpdateTableBody,
    OpenUpdateViewBody,
    QueryRecordsBody,
    RLSPolicyBody,
    RLSPolicyUpdateBody,
    RLSToggleBody,
    UpsertBody,
    WebhookCreateBody,
    WebhookUpdateBody,
)
from apps.tabdata.api_open_impl.common import (
    _deny_legacy_space_level_endpoint_for_table_scoped_token,
)
from apps.tabdata.api_open_impl.space_impl import (
    _get_effective_space_ids_for_token,
    _normalize_token_table_ids,
    create_space_data_table_impl,
    get_open_space_impl,
    get_space_data_db_info_impl,
    get_space_data_home_impl,
    list_open_spaces_impl,
)
from apps.tabdata.api_open import (
    aggregate_records_impl,
    batch_create_records_impl,
    batch_delete_records_impl,
    batch_update_records_impl,
    create_db_connection_impl,
    create_policy_impl,
    create_record_impl,
    create_webhook_impl,
    delete_db_connection_impl,
    delete_policy_impl,
    delete_record_impl,
    delete_webhook_impl,
    get_record_impl,
    export_table_to_csv_impl,
    export_table_to_excel_impl,
    export_table_to_json_impl,
    export_table_to_pdf_impl,
    get_db_connection_impl,
    get_field_map_impl,
    get_open_import_template_impl,
    export_table_openapi_spec_route_impl,
    get_table_developer_contract_route_impl,
    get_table_impl,
    list_tables_impl,
    open_delete_table_impl,
    open_update_table_impl,
    import_table_from_csv_impl,
    import_table_from_excel_impl,
    import_table_from_json_impl,
    list_fields_impl,
    list_policies_impl,
    list_webhooks_impl,
    open_create_field_impl,
    open_create_view_impl,
    open_delete_field_impl,
    open_delete_view_impl,
    open_get_view_data_impl,
    open_list_views_impl,
    open_update_field_impl,
    open_update_view_impl,
    preview_open_import_data_impl,
    query_records_get_impl,
    query_records_post_impl,
    reset_db_connection_password_impl,
    test_webhook_impl,
    toggle_rls_impl,
    update_policy_impl,
    update_record_impl,
    update_webhook_impl,
    upsert_records_impl,
)
from apps.tabdata.api_open_storage import (
    PresignedUploadRequest,
    storage_complete_upload_impl,
    storage_delete_impl,
    storage_download_impl,
    storage_file_info_impl,
    storage_list_impl,
    storage_presigned_upload_impl,
    storage_upload_impl,
)
from apps.tabdata.auth_open_api import (
    check_export_quota,
    idempotent,
    open_api_auth,
    require_space_access,
    require_scope,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.models import Table
from apps.tabdata.schemas import (
    AgentSQLExecuteRequest,
    AgentSQLQueryRequest,
)

logger = logging.getLogger(__name__)

router = Router(tags=["Space Developer API"])

_DISCOVERY_SCOPES = (
    'table:read',
    'table:create',
    'record:read',
    'record:create',
    'field:read',
    'view:read',
    'sql:query',
    'sql:execute',
    'db_connection:manage',
)

_openapi_spec_cache: Optional[dict] = None


def _get_open_api_spec() -> dict:
    """
    获取仅包含 Open API (/api/open/v1/) 路由的 OpenAPI spec。
    结果缓存在模块级变量中，避免重复生成。
    """
    global _openapi_spec_cache
    if _openapi_spec_cache is not None:
        return _openapi_spec_cache

    try:
        from tabtin.urls import api as main_api
        full_schema = main_api.get_openapi_schema()
    except Exception:
        logger.exception("Failed to generate OpenAPI schema")
        return {"openapi": "3.1.0", "info": {"title": "TabTin Open API", "version": "1.0.0"}, "paths": {}}

    filtered = copy.deepcopy(full_schema)
    open_prefix = "/api/open/v1/"
    filtered_paths = {}
    for path, ops in (filtered.get("paths") or {}).items():
        if path.startswith(open_prefix):
            filtered_paths[path] = ops
    filtered["paths"] = filtered_paths
    filtered["info"] = {
        "title": "TabTin Developer Open API",
        "description": "Agent / 外部系统可用的数据接口。认证方式：Bearer Token（API Token 或 JWT）。",
        "version": "1.0.0",
    }

    _openapi_spec_cache = filtered
    return filtered


class SpaceDataCreateTableBody(Schema):
    """在指定 Space（数据库）内创建数据表。"""
    name: str = PydField(description='表格名称', min_length=1, max_length=100)
    description: Optional[str] = PydField(default=None, description='表格描述')
    icon: Optional[str] = PydField(default=None, description='表格图标')
    use_default_fields: bool = PydField(default=True, description='是否创建默认字段（传入 fields 时自动忽略）')
    fields: Optional[List[InlineFieldDefinition]] = PydField(default=None, description='内联字段定义列表，一步建表+定义 schema')



def _ensure_token_can_access_space(
    request: HttpRequest,
    *,
    space_id: UUID,
) -> Optional[JsonResponse]:
    effective_space_ids = _get_effective_space_ids_for_token(request)
    if effective_space_ids is None:
        return None
    if str(space_id) in effective_space_ids:
        return None
    return JsonResponse(
        get_error_response(
            ErrorCode.PERMISSION_DENIED,
            'Token 无权访问当前 Space',
        ),
        status=403,
    )


def _requires_full_space_scope(request: HttpRequest) -> bool:
    return _normalize_token_table_ids(request) is not None


def _resolve_space_table(space_id: UUID, table_id: UUID) -> Optional[Table]:
    return (
        Table.objects.using(TABDATA_DB_ALIAS)
        .filter(id=table_id, space_id=space_id)
        .only('id', 'space_id')
        .first()
    )


def _ensure_webhook_belongs_to_space(
    webhook_id: UUID,
    space_id: UUID,
) -> Optional[JsonResponse]:
    from apps.tabdata.models_webhook import TableWebhook
    from apps.tabtinspace.services.host_resolver import resolve_host

    space = resolve_host(space_id)
    if not space:
        return JsonResponse(
            get_error_response(
                ErrorCode.NOT_FOUND,
                'Space 不存在',
            ),
            status=404,
        )
    exists = (
        TableWebhook.objects.using(TABDATA_DB_ALIAS)
        .filter(
            Q(organization_id=space.organization_id)
            | Q(organization_id__isnull=True, space_id=space_id),
            id=webhook_id,
            space_id__in=[space_id, None],
        )
        .exists()
    )
    if not exists:
        return JsonResponse(
            get_error_response(
                ErrorCode.NOT_FOUND,
                'Webhook 不存在，或不属于当前 Space',
            ),
            status=404,
        )
    return None


def _ensure_table_belongs_to_space(
    request: HttpRequest,
    *,
    space_id: UUID,
    table_id: UUID,
) -> Optional[JsonResponse]:
    table = _resolve_space_table(space_id, table_id)
    if table is None:
        return JsonResponse(
            get_error_response(
                ErrorCode.TABLE_NOT_FOUND,
                '表格不存在，或不属于当前 Space',
            ),
            status=404,
        )
    api_token = getattr(request, 'api_token', None)
    if api_token and not api_token.can_access_table(str(table_id), space_id=str(space_id)):
        return JsonResponse(
            get_error_response(
                ErrorCode.PERMISSION_DENIED,
                'Token 无权访问当前表格',
            ),
            status=403,
        )
    request._api_table_id = str(table_id)
    return None


# ---------------------------------------------------------------------------
# 组合检查函数 — 消除路由层重复样板
# ---------------------------------------------------------------------------

def _check_space_table(request: HttpRequest, space_id: UUID, table_id: UUID) -> Optional[JsonResponse]:
    """校验 token→space 访问 + table 归属 space，失败返回错误响应。"""
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    return _ensure_table_belongs_to_space(request, space_id=space_id, table_id=table_id)


def _check_space_full_scope(request: HttpRequest, space_id: UUID) -> Optional[JsonResponse]:
    """校验 token→space 访问 + 必须是 space 级授权（非 table 级），失败返回错误响应。"""
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    if _requires_full_space_scope(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    return None


def _check_space_webhook(request: HttpRequest, space_id: UUID, webhook_id: UUID) -> Optional[JsonResponse]:
    """校验 token→space 访问 + webhook 归属 space，失败返回错误响应。"""
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    return _ensure_webhook_belongs_to_space(webhook_id, space_id)


@router.get(
    "/openapi.json",
    auth=open_api_auth,
    summary="获取 Open API 的 OpenAPI (Swagger) 规范",
    response={200: dict, 401: dict, 500: dict},
)
@api_error_handler
def get_openapi_spec(request: HttpRequest):
    """
    返回仅包含 Developer Open API 路由的 OpenAPI 3.x 规范。
    Agent 可据此自动发现所有可用端点、参数 schema 和响应格式。
    """
    spec = _get_open_api_spec()
    return JsonResponse(spec, status=200)


FIELD_TYPE_CATALOG = {
    'text': {
        'label': '单行文本',
        'cell_value_type': 'string',
        'options_schema': {},
    },
    'long_text': {
        'label': '多行文本',
        'cell_value_type': 'string',
        'options_schema': {},
    },
    'number': {
        'label': '数字',
        'cell_value_type': 'number',
        'options_schema': {
            'precision': {'type': 'integer', 'description': '小数位数（0-8）'},
        },
    },
    'percent': {
        'label': '百分比',
        'cell_value_type': 'number',
        'options_schema': {
            'precision': {'type': 'integer', 'description': '小数位数（0-8）'},
        },
    },
    'currency': {
        'label': '货币',
        'cell_value_type': 'number',
        'options_schema': {
            'precision': {'type': 'integer', 'description': '小数位数（0-8）'},
            'symbol': {'type': 'string', 'description': '货币符号，如 ¥ 或 $'},
        },
    },
    'rating': {
        'label': '评分',
        'cell_value_type': 'number',
        'options_schema': {
            'max': {'type': 'integer', 'description': '最大星数（1-10），默认 5'},
        },
    },
    'select': {
        'label': '单选',
        'cell_value_type': 'string',
        'options_schema': {
            'choices': {'type': 'array', 'items': {'type': 'string'}, 'description': '选项列表'},
        },
    },
    'multi_select': {
        'label': '多选',
        'cell_value_type': 'string',
        'is_multiple': True,
        'options_schema': {
            'choices': {'type': 'array', 'items': {'type': 'string'}, 'description': '选项列表'},
        },
    },
    'checkbox': {
        'label': '复选框',
        'cell_value_type': 'boolean',
        'options_schema': {},
    },
    'date': {
        'label': '日期',
        'cell_value_type': 'dateTime',
        'options_schema': {
            'format': {'type': 'string', 'description': '日期格式，如 YYYY-MM-DD'},
        },
    },
    'created_time': {
        'label': '创建时间',
        'cell_value_type': 'dateTime',
        'computed': True,
        'options_schema': {},
    },
    'last_modified_time': {
        'label': '最后修改时间',
        'cell_value_type': 'dateTime',
        'computed': True,
        'options_schema': {},
    },
    'url': {
        'label': '网址',
        'cell_value_type': 'string',
        'options_schema': {},
    },
    'email': {
        'label': '邮箱',
        'cell_value_type': 'string',
        'options_schema': {},
    },
    'phone': {
        'label': '电话',
        'cell_value_type': 'string',
        'options_schema': {
            'phone_region': {'type': 'string', 'enum': ['CN', 'US', 'international']},
        },
    },
    'user': {
        'label': '成员',
        'cell_value_type': 'string',
        'options_schema': {
            'multiple': {'type': 'boolean', 'description': '是否多选'},
        },
    },
    'created_by': {
        'label': '创建人',
        'cell_value_type': 'string',
        'computed': True,
        'options_schema': {},
    },
    'last_modified_by': {
        'label': '最后修改人',
        'cell_value_type': 'string',
        'computed': True,
        'options_schema': {},
    },
    'attachment': {
        'label': '附件',
        'cell_value_type': 'string',
        'is_multiple': True,
        'options_schema': {},
    },
    'link': {
        'label': '关联',
        'cell_value_type': 'string',
        'is_multiple': True,
        'options_schema': {
            'foreignTableId': {'type': 'string', 'description': '关联目标表 ID'},
            'relationship': {'type': 'string', 'enum': ['OneOne', 'OneMany', 'ManyOne', 'ManyMany']},
            'isOneWay': {'type': 'boolean'},
        },
    },
}


@router.get(
    "/field-types",
    auth=open_api_auth,
    summary="获取所有支持的字段类型及其 options schema",
    response={200: dict, 401: dict},
)
@api_error_handler
def get_field_types(request: HttpRequest):
    """
    返回当前 TabData UI 已开放创建的字段类型及其 options 参数 schema。
    Agent 可据此在创建字段时选择正确的 field_type 和 options。
    """
    return JsonResponse(
        success_response(data={
            'field_types': {
                field_type: definition
                for field_type, definition in FIELD_TYPE_CATALOG.items()
                if field_type in UI_CREATABLE_FIELD_TYPES
            },
        }),
        status=200,
    )


@router.get(
    "/spaces",
    auth=open_api_auth,
    summary="列出当前 Token / 用户可访问的 Space",
    response={200: dict, 401: dict, 403: dict, 500: dict},
)
@require_scope(*_DISCOVERY_SCOPES)
@api_error_handler
def list_open_spaces(request: HttpRequest):
    """列出可访问的 Space，作为开发者 API 的一级入口。"""
    is_archived_raw = request.GET.get('is_archived')
    is_archived = None
    if is_archived_raw not in (None, '', 'null', 'undefined'):
        is_archived = is_archived_raw.lower() in ('1', 'true', 'yes')

    return list_open_spaces_impl(
        request,
        organization_id=request.GET.get('organization_id') or None,
        space_type=request.GET.get('type') or None,
        status=request.GET.get('status') or None,
        is_archived=is_archived,
    )


@router.get(
    "/spaces/{space_id}",
    auth=open_api_auth,
    summary="获取 Space 开发者入口详情",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope(*_DISCOVERY_SCOPES)
@require_space_access
@api_error_handler
def get_open_space(request: HttpRequest, space_id: UUID):
    """返回单个 Space 的基础信息与开发者入口路径。"""
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    return get_open_space_impl(request, space_id)


@router.get(
    "/spaces/{space_id}/data",
    auth=open_api_auth,
    summary="获取当前 Space 的数据库入口概览",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope(*_DISCOVERY_SCOPES)
@require_space_access
@api_error_handler
def get_space_data_home(request: HttpRequest, space_id: UUID):
    """
    返回 Space 作为“数据库入口”的聚合说明。
    用于 Space 设置中的开发者控制台与外部 SDK 初始化。
    """
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    return get_space_data_home_impl(request, space_id)


@router.get(
    "/spaces/{space_id}/data/db-info",
    auth=open_api_auth,
    summary="获取 Space 数据库信息",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_space_access
@api_error_handler
def get_space_data_db_info(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return get_space_data_db_info_impl(request, space_id)


@router.get(
    "/spaces/{space_id}/data/db-connection",
    auth=open_api_auth,
    summary="获取 Space 只读数据库连接",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_space_access(required_role='editor')
@api_error_handler
def get_space_data_db_connection(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return get_db_connection_impl(request, space_id)


@router.post(
    "/spaces/{space_id}/data/db-connection",
    auth=open_api_auth,
    summary="创建 Space 只读数据库连接",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_space_access(required_role='editor')
@api_error_handler
def create_space_data_db_connection(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return create_db_connection_impl(request, space_id)


@router.delete(
    "/spaces/{space_id}/data/db-connection",
    auth=open_api_auth,
    summary="删除 Space 只读数据库连接",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_data_db_connection(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return delete_db_connection_impl(request, space_id)


@router.post(
    "/spaces/{space_id}/data/db-connection/reset-password",
    auth=open_api_auth,
    summary="重置 Space 只读数据库连接密码",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_space_access(required_role='editor')
@api_error_handler
def reset_space_data_db_connection_password(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return reset_db_connection_password_impl(request, space_id)


@router.get(
    "/spaces/{space_id}/data/tables",
    auth=open_api_auth,
    summary="列出当前 Space 下的所有数据表",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:read')
@require_space_access
@api_error_handler
def list_space_data_tables(request: HttpRequest, space_id: UUID):
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    return list_tables_impl(request, space_id=str(space_id))


@router.post(
    "/spaces/{space_id}/data/tables",
    auth=open_api_auth,
    summary="在当前 Space（数据库）中创建数据表",
    response={201: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_data_table(
    request: HttpRequest,
    space_id: UUID,
    body: SpaceDataCreateTableBody,
):
    if err := _check_space_full_scope(request, space_id):
        return err
    return create_space_data_table_impl(request, space_id, body)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}",
    auth=open_api_auth,
    summary="获取当前 Space 下某张数据表详情",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:read')
@require_space_access
@api_error_handler
def get_space_data_table(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return get_table_impl(request, table_id)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}",
    auth=open_api_auth,
    summary="更新当前 Space 下的数据表",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:update')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_data_table(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenUpdateTableBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_update_table_impl(request, table_id, body)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}",
    auth=open_api_auth,
    summary="删除当前 Space 下的数据表",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:delete')
@require_space_access(required_role='owner')
@api_error_handler
def delete_space_data_table(request: HttpRequest, space_id: UUID, table_id: UUID):
    """通过 Space 路由删除数据表"""
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_delete_table_impl(request, table_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/fields",
    auth=open_api_auth,
    summary="获取当前 Space 下某张数据表的字段列表",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('field:read')
@require_space_access
@api_error_handler
def list_space_data_table_fields(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return list_fields_impl(request, table_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/records",
    auth=open_api_auth,
    summary="查询当前 Space 下某张数据表的记录（GET）",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:read')
@require_space_access
@api_error_handler
def get_space_data_table_records(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return query_records_get_impl(request, table_id)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records/query",
    auth=open_api_auth,
    summary="查询当前 Space 下某张数据表的记录（POST）",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:read')
@require_space_access
@api_error_handler
def query_space_data_table_records(
    request: HttpRequest,
    space_id: UUID,
    table_id: UUID,
    body: QueryRecordsBody,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return query_records_post_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records",
    auth=open_api_auth,
    summary="在当前 Space 下某张数据表中创建记录",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_data_table_record(
    request: HttpRequest,
    space_id: UUID,
    table_id: UUID,
    body: OpenCreateRecordBody,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return create_record_impl(request, table_id, body)


@router.get(
    "/spaces/{space_id}/data/sql/catalog",
    auth=open_api_auth,
    summary="获取当前 Space 的 SQL 目录",
    response={200: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
)
@require_scope('sql:query')
@require_space_access
@api_error_handler
def get_space_data_sql_catalog(request: HttpRequest, space_id: UUID):
    if err := _check_space_full_scope(request, space_id):
        return err
    return sql_catalog_impl(request, space_id)


@router.post(
    "/spaces/{space_id}/data/sql/query",
    auth=open_api_auth,
    summary="执行当前 Space 的只读 SQL 查询",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
)
@require_scope('sql:query')
@require_space_access
@api_error_handler
def query_space_data_sql(
    request: HttpRequest,
    space_id: UUID,
    data: AgentSQLQueryRequest,
):
    if err := _check_space_full_scope(request, space_id):
        return err
    return sql_query_impl(request, space_id, data)


@router.post(
    "/spaces/{space_id}/data/sql/execute",
    auth=open_api_auth,
    summary="执行当前 Space 的写入 SQL",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
)
@require_scope('sql:execute')
@require_space_access(required_role='editor')
@api_error_handler
def execute_space_data_sql(
    request: HttpRequest,
    space_id: UUID,
    data: AgentSQLExecuteRequest,
):
    if err := _check_space_full_scope(request, space_id):
        return err
    return sql_execute_impl(request, space_id, data)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 字段 CRUD
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/fields",
    auth=open_api_auth,
    summary="创建字段",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('field:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_field(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenCreateFieldBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_create_field_impl(request, table_id, body)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}/fields/{field_id}",
    auth=open_api_auth,
    summary="更新字段",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('field:update')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_field(request: HttpRequest, space_id: UUID, table_id: UUID, field_id: UUID, body: OpenUpdateFieldBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_update_field_impl(request, table_id, field_id, body)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}/fields/{field_id}",
    auth=open_api_auth,
    summary="删除字段",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('field:delete')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_field(request: HttpRequest, space_id: UUID, table_id: UUID, field_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_delete_field_impl(request, table_id, field_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/field-map",
    auth=open_api_auth,
    summary="获取字段名称到 ID 的映射",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('field:read')
@require_space_access
@api_error_handler
def get_space_field_map(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return get_field_map_impl(request, table_id)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 记录 — 批量 / Upsert（静态子路径必须注册在参数路径之前，
#   否则 Ninja 用 <str:record_id> 匹配 "batch-create" 等路径导致 405）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records/batch-create",
    auth=open_api_auth,
    summary="批量创建记录",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def batch_create_space_records(request: HttpRequest, space_id: UUID, table_id: UUID, body: BulkCreateBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return batch_create_records_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records/batch-update",
    auth=open_api_auth,
    summary="批量更新记录",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:update')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def batch_update_space_records(request: HttpRequest, space_id: UUID, table_id: UUID, body: BulkUpdateBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return batch_update_records_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records/batch-delete",
    auth=open_api_auth,
    summary="批量删除记录",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict, 503: dict},
)
@require_scope('record:delete')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def batch_delete_space_records(request: HttpRequest, space_id: UUID, table_id: UUID, body: BulkDeleteBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return batch_delete_records_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/records/upsert",
    auth=open_api_auth,
    summary="按唯一字段去重写入",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def upsert_space_records(request: HttpRequest, space_id: UUID, table_id: UUID, body: UpsertBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return upsert_records_impl(request, table_id, body)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 记录 — 查询详情 / 更新 / 删除（参数路径 {record_id} 放在静态子路径之后）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/records/{record_id}",
    auth=open_api_auth,
    summary="获取单条记录详情",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:read')
@require_space_access
@api_error_handler
def get_space_data_table_record(request: HttpRequest, space_id: UUID, table_id: UUID, record_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return get_record_impl(request, table_id, record_id)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}/records/{record_id}",
    auth=open_api_auth,
    summary="更新记录",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:update')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_record(request: HttpRequest, space_id: UUID, table_id: UUID, record_id: UUID, body: OpenUpdateRecordBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return update_record_impl(request, table_id, record_id, body)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}/records/{record_id}",
    auth=open_api_auth,
    summary="删除记录",
    response={200: dict, 401: dict, 403: dict, 404: dict, 409: dict, 500: dict, 503: dict},
)
@require_scope('record:delete')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_record(request: HttpRequest, space_id: UUID, table_id: UUID, record_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return delete_record_impl(request, table_id, record_id)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 视图 CRUD
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/views",
    auth=open_api_auth,
    summary="列出视图",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('view:read')
@require_space_access
@api_error_handler
def list_space_views(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_list_views_impl(request, table_id)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/views",
    auth=open_api_auth,
    summary="创建视图",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('view:create')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_view(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenCreateViewBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_create_view_impl(request, table_id, body)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}/views/{view_id}",
    auth=open_api_auth,
    summary="更新视图",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('view:update')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_view(request: HttpRequest, space_id: UUID, table_id: UUID, view_id: UUID, body: OpenUpdateViewBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_update_view_impl(request, table_id, view_id, body)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}/views/{view_id}",
    auth=open_api_auth,
    summary="删除视图",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('view:delete')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_view(request: HttpRequest, space_id: UUID, table_id: UUID, view_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_delete_view_impl(request, table_id, view_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/views/{view_id}/records",
    auth=open_api_auth,
    summary="获取视图数据",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('view:read')
@require_space_access
@api_error_handler
def get_space_view_records(request: HttpRequest, space_id: UUID, table_id: UUID, view_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return open_get_view_data_impl(request, table_id, view_id)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 聚合统计
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/aggregation",
    auth=open_api_auth,
    summary="聚合统计",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('aggregation:read')
@require_space_access
@api_error_handler
def aggregate_space_records(request: HttpRequest, space_id: UUID, table_id: UUID, body: AggregationBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return aggregate_records_impl(request, table_id, body)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 导入 / 导出
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/import/preview",
    auth=open_api_auth,
    summary="预览导入",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('import:write')
@require_space_access(required_role='editor')
@api_error_handler
def preview_space_import(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenImportPreviewBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return preview_open_import_data_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/import/csv",
    auth=open_api_auth,
    summary="导入 CSV",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('import:write')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def import_space_csv(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenImportCSVBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return import_table_from_csv_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/import/json",
    auth=open_api_auth,
    summary="导入 JSON",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('import:write')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def import_space_json(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenImportJSONBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return import_table_from_json_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/import/excel",
    auth=open_api_auth,
    summary="导入 Excel",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('import:write')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def import_space_excel(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenImportExcelBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return import_table_from_excel_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/export/csv",
    auth=open_api_auth,
    summary="导出 CSV",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('export:read')
@check_export_quota
@require_space_access
@api_error_handler
def export_space_csv(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenExportCSVBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return export_table_to_csv_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/export/json",
    auth=open_api_auth,
    summary="导出 JSON",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('export:read')
@check_export_quota
@require_space_access
@api_error_handler
def export_space_json(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenExportJSONBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return export_table_to_json_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/export/excel",
    auth=open_api_auth,
    summary="导出 Excel",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('export:read')
@check_export_quota
@require_space_access
@api_error_handler
def export_space_excel(request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenExportExcelBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return export_table_to_excel_impl(request, table_id, body)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 存储（附件）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/storage/upload",
    auth=open_api_auth,
    summary="上传文件到附件字段",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:write')
@require_space_access(required_role='editor')
@api_error_handler
def upload_space_storage(
    request: HttpRequest,
    space_id: UUID,
    table_id: UUID,
    field_id: str = Form(...),
    file: UploadedFile = NinjaFile(...),
    record_id: str = Form(None),
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_upload_impl(request, table_id, field_id, file, record_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/storage",
    auth=open_api_auth,
    summary="列出表格附件文件",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:read')
@require_space_access
@api_error_handler
def list_space_storage(
    request: HttpRequest,
    space_id: UUID,
    table_id: UUID,
    field_id: str = None,
    record_id: str = None,
    page: int = 1,
    page_size: int = 20,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_list_impl(request, table_id, field_id, record_id, page, page_size)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/storage/{file_id}/download",
    auth=open_api_auth,
    summary="获取文件下载链接",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:read')
@require_space_access
@api_error_handler
def download_space_storage(request: HttpRequest, space_id: UUID, table_id: UUID, file_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_download_impl(request, table_id, file_id)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}/storage/{file_id}",
    auth=open_api_auth,
    summary="删除文件",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:write')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_storage(request: HttpRequest, space_id: UUID, table_id: UUID, file_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_delete_impl(request, table_id, file_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/storage/{file_id}/info",
    auth=open_api_auth,
    summary="获取文件元信息",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:read')
@require_space_access
@api_error_handler
def get_space_storage_file_info(request: HttpRequest, space_id: UUID, table_id: UUID, file_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_file_info_impl(request, table_id, file_id)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/storage/presigned-upload",
    auth=open_api_auth,
    summary="获取预签名上传 URL",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:write')
@require_space_access(required_role='editor')
@api_error_handler
def presigned_upload_space_storage(request: HttpRequest, space_id: UUID, table_id: UUID, body: PresignedUploadRequest):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_presigned_upload_impl(request, table_id, body)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/storage/presigned-upload/{upload_item_id}/complete",
    auth=open_api_auth,
    summary="完成预签名上传",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('storage:write')
@require_space_access(required_role='editor')
@api_error_handler
def complete_presigned_upload_space_storage(request: HttpRequest, space_id: UUID, table_id: UUID, upload_item_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return storage_complete_upload_impl(request, table_id, upload_item_id)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Webhook
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.get(
    "/spaces/{space_id}/data/webhooks",
    auth=open_api_auth,
    summary="列出当前 Space 的 Webhook",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('webhook:manage')
@require_space_access
@api_error_handler
def list_space_webhooks(request: HttpRequest, space_id: UUID):
    if err := _ensure_token_can_access_space(request, space_id=space_id):
        return err
    request.GET = request.GET.copy()
    request.GET['space_id'] = str(space_id)
    return list_webhooks_impl(request)


@router.post(
    "/spaces/{space_id}/data/webhooks",
    auth=open_api_auth,
    summary="创建 Webhook",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('webhook:manage')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_webhook(request: HttpRequest, space_id: UUID, body: WebhookCreateBody):
    token_scope_error = _ensure_token_can_access_space(request, space_id=space_id)
    if token_scope_error:
        return token_scope_error
    body.space_id = str(space_id)
    return create_webhook_impl(request, body)


@router.patch(
    "/spaces/{space_id}/data/webhooks/{webhook_id}",
    auth=open_api_auth,
    summary="更新 Webhook",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('webhook:manage')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_webhook(request: HttpRequest, space_id: UUID, webhook_id: UUID, body: WebhookUpdateBody):
    if err := _check_space_webhook(request, space_id, webhook_id):
        return err
    return update_webhook_impl(request, webhook_id, body)


@router.delete(
    "/spaces/{space_id}/data/webhooks/{webhook_id}",
    auth=open_api_auth,
    summary="删除 Webhook",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('webhook:manage')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_webhook(request: HttpRequest, space_id: UUID, webhook_id: UUID):
    if err := _check_space_webhook(request, space_id, webhook_id):
        return err
    return delete_webhook_impl(request, webhook_id)


@router.post(
    "/spaces/{space_id}/data/webhooks/{webhook_id}/test",
    auth=open_api_auth,
    summary="测试 Webhook",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('webhook:manage')
@require_space_access(required_role='editor')
@api_error_handler
def test_space_webhook(request: HttpRequest, space_id: UUID, webhook_id: UUID):
    if err := _check_space_webhook(request, space_id, webhook_id):
        return err
    return test_webhook_impl(request, webhook_id)


# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 行级安全 (RLS)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/policies",
    auth=open_api_auth,
    summary="列出行级安全策略",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('policy:read')
@require_space_access
@api_error_handler
def list_space_policies(request: HttpRequest, space_id: UUID, table_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return list_policies_impl(request, table_id)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/policies",
    auth=open_api_auth,
    summary="创建行级安全策略",
    response={201: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('policy:manage')
@require_space_access(required_role='editor')
@idempotent
@api_error_handler
def create_space_policy(request: HttpRequest, space_id: UUID, table_id: UUID, body: RLSPolicyBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return create_policy_impl(request, table_id, body)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}/policies/{policy_id}",
    auth=open_api_auth,
    summary="更新行级安全策略",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('policy:manage')
@require_space_access(required_role='editor')
@api_error_handler
def update_space_policy(request: HttpRequest, space_id: UUID, table_id: UUID, policy_id: UUID, body: RLSPolicyUpdateBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return update_policy_impl(request, table_id, policy_id, body)


@router.delete(
    "/spaces/{space_id}/data/tables/{table_id}/policies/{policy_id}",
    auth=open_api_auth,
    summary="删除行级安全策略",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('policy:manage')
@require_space_access(required_role='editor')
@api_error_handler
def delete_space_policy(request: HttpRequest, space_id: UUID, table_id: UUID, policy_id: UUID):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return delete_policy_impl(request, table_id, policy_id)


@router.patch(
    "/spaces/{space_id}/data/tables/{table_id}/rls",
    auth=open_api_auth,
    summary="启用或关闭行级安全",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('policy:manage')
@require_space_access(required_role='editor')
@api_error_handler
def toggle_space_rls(request: HttpRequest, space_id: UUID, table_id: UUID, body: RLSToggleBody):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return toggle_rls_impl(request, table_id, body)


class TriggerCascadeBody(Schema):
    """保留旧请求结构，仅用于返回明确的能力退役状态。"""

    field_ids: Optional[list[str]] = PydField(default=None)
    record_ids: Optional[list[str]] = PydField(default=None)


def _computed_cascade_gone_response():
    return 410, {
        "success": False,
        "code": "TABDATA_COMPUTED_FIELDS_RETIRED",
        "message": "公式、Lookup、Rollup 及其级联重算能力已退役。",
        "data": None,
    }


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/trigger-cascade",
    auth=open_api_auth,
    summary="触发级联重算（已退役）",
    description="兼容旧客户端的退役占位端点；固定返回 HTTP 410 Gone。",
    response={410: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('record:update')
@require_space_access(required_role='editor')
@api_error_handler
def trigger_space_cascade(
    request: HttpRequest,
    space_id: UUID,
    table_id: UUID,
    body: TriggerCascadeBody,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return _computed_cascade_gone_response()


# ──────────────────────────────────────────────────────────
# 表级 Developer Contract / API Info / Import Template / PDF Export
# ──────────────────────────────────────────────────────────


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/developer-contract",
    auth=open_api_auth,
    summary="获取表级 Open API 开发者契约",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:read')
@require_space_access
@api_error_handler
def get_table_developer_contract(
    request: HttpRequest, space_id: UUID, table_id: UUID,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return get_table_developer_contract_route_impl(request, table_id, space_id=space_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/openapi.json",
    auth=open_api_auth,
    summary="获取表级 OpenAPI 规范",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:read')
@require_space_access
@api_error_handler
def get_table_openapi_spec(
    request: HttpRequest, space_id: UUID, table_id: UUID,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return export_table_openapi_spec_route_impl(request, table_id, space_id=space_id)


@router.get(
    "/spaces/{space_id}/data/tables/{table_id}/import/template",
    auth=open_api_auth,
    summary="获取导入模板（CSV / JSON）",
    response={200: str, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('import:write', 'table:read')
@require_space_access
@api_error_handler
def get_import_template(
    request: HttpRequest, space_id: UUID, table_id: UUID,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return get_open_import_template_impl(request, table_id)


@router.post(
    "/spaces/{space_id}/data/tables/{table_id}/export/pdf",
    auth=open_api_auth,
    summary="导出 PDF",
    response={200: bytes, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('export:read')
@check_export_quota
@require_space_access
@api_error_handler
def export_table_pdf(
    request: HttpRequest, space_id: UUID, table_id: UUID, body: OpenExportPDFBody,
):
    if err := _check_space_table(request, space_id, table_id):
        return err
    return export_table_to_pdf_impl(request, table_id, body)
