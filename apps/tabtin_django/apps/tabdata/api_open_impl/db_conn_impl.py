from uuid import UUID

from django.conf import settings as django_settings
from django.http import HttpRequest, JsonResponse

from apps.tabdata.api_helpers import success_response
from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.services import TableService
from apps.tabdata.services.db_connection_service import DbConnectionService
from apps.tabdata.api_open_impl.common import (
    _table_scoped_token_has_no_space_capability,
    _deny_legacy_space_level_endpoint_for_table_scoped_token,
    impl_error_handler,
)


@impl_error_handler('数据库连接')
def get_db_connection_impl(request: HttpRequest, space_id: UUID):
    if _table_scoped_token_has_no_space_capability(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    service = DbConnectionService(user=request.auth)
    conn = service.get_connection(space_id)
    if conn is None:
        return JsonResponse(
            success_response(data={'exists': False, 'connection': None}),
            status=200,
        )

    params = conn.get_connection_params()
    return JsonResponse(
        success_response(data={
            'exists': True,
            'connection': {
                'host': params['host'],
                'port': params['port'],
                'database': params['database'],
                'username': params['username'],
                'password': params['password'],
                'schema': params['schema'],
                'connection_string': conn.get_connection_string(),
                'created_at': conn.created_at.isoformat() if conn.created_at else None,
            },
        }),
        status=200,
    )


@impl_error_handler('数据库连接')
def create_db_connection_impl(request: HttpRequest, space_id: UUID):
    if _table_scoped_token_has_no_space_capability(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    service = DbConnectionService(user=request.auth)
    conn = service.create_connection(space_id)

    params = conn.get_connection_params()
    return JsonResponse(
        success_response(
            data={
                'connection': {
                    'host': params['host'],
                    'port': params['port'],
                    'database': params['database'],
                    'username': params['username'],
                    'password': params['password'],
                    'schema': params['schema'],
                    'connection_string': conn.get_connection_string(),
                    'created_at': conn.created_at.isoformat() if conn.created_at else None,
                },
            },
            message='只读数据库连接已创建',
        ),
        status=201,
    )


@impl_error_handler('数据库连接')
def delete_db_connection_impl(request: HttpRequest, space_id: UUID):
    if _table_scoped_token_has_no_space_capability(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    service = DbConnectionService(user=request.auth)
    deleted = service.delete_connection(space_id)
    if not deleted:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, "该 Space 没有只读数据库连接"),
            status=404,
        )
    return JsonResponse(
        success_response(message='只读数据库连接已删除'),
        status=200,
    )


@impl_error_handler('数据库连接')
def reset_db_connection_password_impl(request: HttpRequest, space_id: UUID):
    if _table_scoped_token_has_no_space_capability(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    service = DbConnectionService(user=request.auth)
    conn = service.reset_password(space_id)
    if conn is None:
        return JsonResponse(
            get_error_response(ErrorCode.NOT_FOUND, "该 Space 没有活跃的只读数据库连接"),
            status=404,
        )

    params = conn.get_connection_params()
    return JsonResponse(
        success_response(data={
            'connection': {
                'host': params['host'],
                'port': params['port'],
                'database': params['database'],
                'username': params['username'],
                'password': params['password'],
                'schema': params['schema'],
                'connection_string': conn.get_connection_string(),
            },
        }),
        status=200,
    )


@impl_error_handler('数据库信息')
def get_space_db_info_impl(request: HttpRequest, space_id: UUID):
    if _table_scoped_token_has_no_space_capability(request):
        return _deny_legacy_space_level_endpoint_for_table_scoped_token()
    service = TableService(user=request.auth)
    tables = service.list_tables(space_id=space_id)

    schema_name = DDLManager.schema_name(space_id)

    pg_config = django_settings.DATABASES.get('postgresql', {})

    table_info = []
    for t in tables:
        table_uuid = UUID(str(t.id))
        db_table_name = DDLManager.table_name(table_uuid)
        qualified = DDLManager.qualified_table_name(space_id, table_uuid)
        table_info.append({
            'id': str(t.id),
            'name': t.name,
            'db_table_name': db_table_name,
            'qualified_name': qualified,
        })

    return JsonResponse(
        success_response(data={
            'schema_name': schema_name,
            'database': {
                'host': pg_config.get('HOST', ''),
                'port': int(pg_config.get('PORT', 5432)),
                'name': pg_config.get('NAME', ''),
                'engine': 'PostgreSQL',
                'note': '请通过 API Token 访问数据，或联系管理员获取只读数据库账号',
            },
            'tables': table_info,
        }),
        status=200,
    )
