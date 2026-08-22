"""Space 级 Open API 业务逻辑 impl 层。

路由处理器位于 api_open_space.py，本模块仅包含业务逻辑实现。
"""
import logging
from typing import Optional
from uuid import UUID

from django.conf import settings as django_settings
from django.db import transaction
from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.api_open_impl.common import (
    _PUBLIC_OPEN_API_BASE_PATH,
    _filter_tables_for_token,
    impl_error_handler,
)
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.field_creation_contract import validate_ui_creatable_field_types
from apps.tabdata.models import Table
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.schemas import TableOut
from apps.tabdata.services import TableService
from apps.tabtinspace.memory_defaults import resolve_full_memory_config
from apps.tabtinspace.schemas.space import SpaceOut
from apps.tabtinspace.services import SpaceService

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 共享辅助函数
# ---------------------------------------------------------------------------

def _build_space_ref(space) -> dict:
    return {
        'id': str(space.id),
        'name': space.name,
        'organization_id': str(space.organization_id),
        'type': space.type,
    }


def _build_data_endpoint_catalog(space_id: UUID) -> dict:
    base = f'{_PUBLIC_OPEN_API_BASE_PATH}/spaces/{space_id}/data'
    return {
        'base_path': _PUBLIC_OPEN_API_BASE_PATH,
        'space_path': f'{_PUBLIC_OPEN_API_BASE_PATH}/spaces/{space_id}',
        'data_path': base,
        'tables_path': f'{base}/tables',
        'sql_catalog_path': f'{base}/sql/catalog',
        'sql_query_path': f'{base}/sql/query',
        'sql_execute_path': f'{base}/sql/execute',
        'db_info_path': f'{base}/db-info',
        'db_connection_path': f'{base}/db-connection',
    }


def _build_organization_data_endpoint_catalog(organization_id: UUID) -> dict:
    """#6603：Organization 级 Open API 入口目录（与 Space 入口平行）。"""
    from apps.tabdata.api_open_impl.common import _organization_data_base_path

    base = _organization_data_base_path(organization_id)
    return {
        'base_path': _PUBLIC_OPEN_API_BASE_PATH,
        'organization_path': f'{_PUBLIC_OPEN_API_BASE_PATH}/organizations/{organization_id}',
        'data_path': base,
        'tables_path': f'{base}/tables',
        'db_info_path': f'{base}/db-info',
    }


def _normalize_token_table_ids(request: HttpRequest) -> Optional[set[str]]:
    api_token = getattr(request, 'api_token', None)
    raw_table_ids = getattr(api_token, 'table_ids', None) if api_token else None
    if raw_table_ids is None:
        return None
    return {str(table_id) for table_id in raw_table_ids}


def _normalize_token_space_ids(request: HttpRequest) -> Optional[set[str]]:
    api_token = getattr(request, 'api_token', None)
    raw_space_ids = getattr(api_token, 'space_ids', None) if api_token else None
    if raw_space_ids is None:
        return None
    return {str(space_id) for space_id in raw_space_ids}


def _get_effective_space_ids_for_token(request: HttpRequest) -> Optional[set[str]]:
    token_space_ids = _normalize_token_space_ids(request)
    if token_space_ids is not None:
        return token_space_ids

    token_table_ids = _normalize_token_table_ids(request)
    if token_table_ids is None:
        return None

    return {
        str(space_id)
        for space_id in Table.objects.using(TABDATA_DB_ALIAS)
        .filter(id__in=token_table_ids)
        .values_list('space_id', flat=True)
    }


# ---------------------------------------------------------------------------
# Impl 函数
# ---------------------------------------------------------------------------

@impl_error_handler('Space 列表')
def list_open_spaces_impl(request: HttpRequest, **query_params):
    organization_id = query_params.get('organization_id')
    space_type = query_params.get('space_type')
    status = query_params.get('status')
    is_archived = query_params.get('is_archived')

    service = SpaceService(user=request.auth)
    spaces = []
    page = 1
    page_size = 200
    total = None
    while total is None or len(spaces) < total:
        page_items, total = service.list_spaces(
            organization_id=UUID(organization_id) if organization_id else None,
            space_type=space_type,
            status=status,
            is_archived=is_archived,
            page=page,
            page_size=page_size,
        )
        if not page_items:
            break
        spaces.extend(page_items)
        if len(page_items) < page_size:
            break
        page += 1

    effective_space_ids = _get_effective_space_ids_for_token(request)

    serialized = []
    for space in spaces:
        if effective_space_ids is not None and str(space.id) not in effective_space_ids:
            continue
        item = SpaceOut.from_orm(space).dict()
        ac = item.get("agent_config") or {}
        ac["memory"] = resolve_full_memory_config(ac.get("memory"))
        item["agent_config"] = ac
        item['developer_entry'] = {
            'space_path': f'{_PUBLIC_OPEN_API_BASE_PATH}/spaces/{space.id}',
            'data_path': f'{_PUBLIC_OPEN_API_BASE_PATH}/spaces/{space.id}/data',
        }
        serialized.append(item)

    return JsonResponse(
        success_response(data={'spaces': serialized, 'total': len(serialized)}),
        status=200,
    )


@impl_error_handler('Space 详情')
def get_open_space_impl(request: HttpRequest, space_id: UUID):
    service = SpaceService(user=request.auth)
    space = service.get_space(space_id)
    if space is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Space 不存在'),
            status=404,
        )

    payload = SpaceOut.from_orm(space).dict()
    ac = payload.get("agent_config") or {}
    ac["memory"] = resolve_full_memory_config(ac.get("memory"))
    payload["agent_config"] = ac
    payload['developer_entry'] = _build_data_endpoint_catalog(space_id)
    token_table_ids = _normalize_token_table_ids(request)
    payload['developer_scope'] = {
        'space_scoped': token_table_ids is None,
        'table_scoped': token_table_ids is not None,
    }
    return JsonResponse(success_response(data=payload), status=200)


@impl_error_handler('Space 数据入口')
def get_space_data_home_impl(request: HttpRequest, space_id: UUID):
    token_tids = _normalize_token_table_ids(request)
    space_service = SpaceService(user=request.auth)
    table_service = TableService(user=request.auth)

    space = space_service.get_space(space_id)
    if space is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Space 不存在'),
            status=404,
        )

    tables = _filter_tables_for_token(
        request,
        table_service.list_tables(space_id=space_id),
    )
    pg_config = django_settings.DATABASES.get('postgresql', {})

    return JsonResponse(
        success_response(data={
            'space': _build_space_ref(space),
            'database': {
                'schema_name': DDLManager.schema_name(space_id),
                'engine': 'PostgreSQL',
                'host': pg_config.get('HOST', ''),
                'port': int(pg_config.get('PORT') or 5432),
                'name': pg_config.get('NAME', ''),
                'table_count': len(tables),
            },
            'entrypoints': _build_data_endpoint_catalog(space_id),
            'modeling': {
                'database': 'space',
                'table': 'table',
                'view': 'view',
                'note': '开发者 API 以 Space 为数据库入口，Table 为数据库中的数据表。',
            },
            'capabilities': {
                'space_scoped': token_tids is None,
                'table_scoped': token_tids is not None,
                'sql_enabled': token_tids is None,
                'db_connection_enabled': token_tids is None,
            },
        }),
        status=200,
    )


@impl_error_handler('数据库信息')
def get_space_data_db_info_impl(request: HttpRequest, space_id: UUID):
    service = TableService(user=request.auth)
    tables = _filter_tables_for_token(
        request,
        service.list_tables(space_id=space_id),
    )

    schema_name = DDLManager.schema_name(space_id)
    pg_config = django_settings.DATABASES.get('postgresql', {})

    table_info = []
    for table in tables:
        table_uuid = UUID(str(table.id))
        table_info.append({
            'id': str(table.id),
            'name': table.name,
            'db_table_name': DDLManager.table_name(table_uuid),
            'qualified_name': DDLManager.qualified_table_name(space_id, table_uuid),
        })

    return JsonResponse(
        success_response(data={
            'schema_name': schema_name,
            'database': {
                'host': pg_config.get('HOST', ''),
                'port': int(pg_config.get('PORT') or 5432),
                'name': pg_config.get('NAME', ''),
                'engine': 'PostgreSQL',
                'note': '请通过 API Token 访问数据，或联系管理员获取只读数据库账号',
            },
            'tables': table_info,
        }),
        status=200,
    )


@impl_error_handler('Organization 数据入口')
def get_organization_data_home_impl(request: HttpRequest, organization_id: UUID):
    """#6603：Organization 作为资源归属入口的聚合说明。"""
    from apps.tabtinspace.models import Organization

    token_tids = _normalize_token_table_ids(request)
    table_service = TableService(user=request.auth)

    organization = (
        Organization.objects.using(TABDATA_DB_ALIAS)
        .filter(id=organization_id)
        .first()
    )
    if organization is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, 'Organization 不存在'),
            status=404,
        )

    tables = _filter_tables_for_token(
        request,
        table_service.list_tables(organization_id=organization_id),
    )
    pg_config = django_settings.DATABASES.get('postgresql', {})

    return JsonResponse(
        success_response(data={
            'organization': {
                'id': str(organization.id),
                'name': organization.name,
            },
            'database': {
                'schema_name': DDLManager.schema_name(organization_id),
                'engine': 'PostgreSQL',
                'host': pg_config.get('HOST', ''),
                'port': int(pg_config.get('PORT') or 5432),
                'name': pg_config.get('NAME', ''),
                'table_count': len(tables),
                'note': (
                    'org-only 表使用 as_{organization_id_hex} schema；'
                    '仍挂 Space 的表使用各自 as_{space_id_hex} schema。'
                ),
            },
            'entrypoints': _build_organization_data_endpoint_catalog(organization_id),
            'modeling': {
                'owner': 'organization',
                'table': 'table',
                'view': 'view',
                'note': (
                    '开发者 API 以 Organization 为资源归属入口；'
                    '原生 PG schema 按 Space 或 Organization 分区。'
                ),
            },
            'capabilities': {
                'organization_scoped': True,
                'table_scoped': token_tids is not None,
                'sql_enabled': False,
                'db_connection_enabled': False,
            },
        }),
        status=200,
    )


@impl_error_handler('Organization 数据库信息')
def get_organization_data_db_info_impl(request: HttpRequest, organization_id: UUID):
    """#6603：列出组织下各表及其实际 schema 分区。"""
    from apps.tabdata.native.ddl_manager import resolve_schema_partition_id

    service = TableService(user=request.auth)
    tables = _filter_tables_for_token(
        request,
        service.list_tables(organization_id=organization_id),
    )

    pg_config = django_settings.DATABASES.get('postgresql', {})

    table_info = []
    for table in tables:
        table_uuid = UUID(str(table.id))
        partition_id = resolve_schema_partition_id(table)
        table_info.append({
            'id': str(table.id),
            'name': table.name,
            'space_id': str(table.space_id) if table.space_id else None,
            'db_table_name': DDLManager.table_name(table_uuid),
            'schema_name': DDLManager.schema_name(partition_id),
            'qualified_name': DDLManager.qualified_table_name(partition_id, table_uuid),
        })

    return JsonResponse(
        success_response(data={
            'organization_id': str(organization_id),
            'org_only_schema_name': DDLManager.schema_name(organization_id),
            'database': {
                'host': pg_config.get('HOST', ''),
                'port': int(pg_config.get('PORT') or 5432),
                'name': pg_config.get('NAME', ''),
                'engine': 'PostgreSQL',
                'note': '请通过 API Token 访问数据，或联系管理员获取只读数据库账号',
            },
            'tables': table_info,
        }),
        status=200,
    )


@impl_error_handler('创建表格')
def create_organization_data_table_impl(request: HttpRequest, organization_id: UUID, body):
    """#6603：在 Organization 下创建 org-only 表（不挂 Space）。"""
    inline_fields = body.fields
    use_defaults = body.use_default_fields if not inline_fields else False
    if inline_fields:
        field_type_error = validate_ui_creatable_field_types(
            field.field_type for field in inline_fields
        )
        if field_type_error:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, field_type_error),
                status=400,
            )

    service = TableService(user=request.auth)
    table = service.create_table(
        organization_id=organization_id,
        space_id=None,
        name=body.name,
        description=body.description or '',
        icon=body.icon,
        use_default_fields=use_defaults,
    )
    if not table:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, "创建表格失败，权限不足"),
            status=403,
        )

    created_fields = []
    if inline_fields:
        from apps.tabdata.models import TableField as _TF

        for idx, fd in enumerate(inline_fields):
            try:
                field = service.create_field(
                    table_id=table.id,
                    name=fd.name,
                    field_type=fd.field_type,
                    description=fd.description or '',
                    options=fd.options,
                    default_value=fd.default_value,
                )
                if field and fd.is_primary:
                    _TF.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id, is_primary=True,
                    ).update(is_primary=False)
                    _TF.objects.using(TABDATA_DB_ALIAS).filter(
                        id=field.id,
                    ).update(is_primary=True)
                if field:
                    created_fields.append({
                        'id': str(field.id),
                        'name': field.name,
                        'field_type': field.field_type,
                    })
            except Exception as field_err:
                logger.warning(
                    'create_organization_data_table_impl: field #%d (%s) failed: %s',
                    idx, fd.name, field_err,
                )
                service.delete_table(table.id)
                return JsonResponse(
                    get_error_response(
                        ErrorCode.VALIDATION_ERROR,
                        f"字段 '{fd.name}' 创建失败: {field_err}，表已回滚",
                    ),
                    status=400,
                )

    resp_data = TableOut.from_orm(table).dict()
    if created_fields:
        resp_data['fields'] = created_fields

    return JsonResponse(
        success_response(data=resp_data),
        status=201,
    )

@impl_error_handler('创建表格')
def create_space_data_table_impl(request: HttpRequest, space_id: UUID, body):
    inline_fields = body.fields
    use_defaults = body.use_default_fields if not inline_fields else False
    if inline_fields:
        field_type_error = validate_ui_creatable_field_types(
            field.field_type for field in inline_fields
        )
        if field_type_error:
            return JsonResponse(
                get_error_response(ErrorCode.VALIDATION_ERROR, field_type_error),
                status=400,
            )

    service = TableService(user=request.auth)
    table = service.create_table(
        space_id=space_id,
        name=body.name,
        description=body.description or '',
        icon=body.icon,
        use_default_fields=use_defaults,
    )
    if not table:
        return JsonResponse(
            get_error_response(ErrorCode.PERMISSION_DENIED, "创建表格失败，权限不足"),
            status=403,
        )

    created_fields = []
    if inline_fields:
        from apps.tabdata.models import TableField as _TF

        for idx, fd in enumerate(inline_fields):
            try:
                field = service.create_field(
                    table_id=table.id,
                    name=fd.name,
                    field_type=fd.field_type,
                    description=fd.description or '',
                    options=fd.options,
                    default_value=fd.default_value,
                )
                if field and fd.is_primary:
                    _TF.objects.using(TABDATA_DB_ALIAS).filter(
                        table_id=table.id, is_primary=True,
                    ).update(is_primary=False)
                    _TF.objects.using(TABDATA_DB_ALIAS).filter(
                        id=field.id,
                    ).update(is_primary=True)
                if field:
                    created_fields.append({
                        'id': str(field.id),
                        'name': field.name,
                        'field_type': field.field_type,
                    })
            except Exception as field_err:
                logger.warning(
                    'create_space_data_table_impl: field #%d (%s) failed: %s',
                    idx, fd.name, field_err,
                )
                service.delete_table(table.id)
                return JsonResponse(
                    get_error_response(
                        ErrorCode.VALIDATION_ERROR,
                        f"字段 '{fd.name}' 创建失败: {field_err}，表已回滚",
                    ),
                    status=400,
                )

    resp_data = TableOut.from_orm(table).dict()
    if created_fields:
        resp_data['fields'] = created_fields

    return JsonResponse(
        success_response(data=resp_data),
        status=201,
    )
