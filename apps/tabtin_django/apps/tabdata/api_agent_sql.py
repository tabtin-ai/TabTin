"""
Agent SQL API — 提供安全的 SQL 查询和执行接口。

路由：
  POST /spaces/{space_id}/sql/query    — 只读 SQL 查询
  POST /spaces/{space_id}/sql/execute  — 写入 SQL 执行
  GET  /spaces/{space_id}/sql/catalog  — 表/字段目录
"""

import logging
from uuid import UUID

from ninja import Router
from django.http import HttpRequest

from apps.tabdata.auth_open_api import open_api_auth, require_scope, require_space_access
from apps.tabdata.api_helpers import (
    success_response,
    error_response,
    api_error_handler,
)
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.schemas import (
    AgentSQLQueryRequest,
    AgentSQLExecuteRequest,
)
from apps.tabdata.native.agent_sql import (
    AgentSQLExecutor,
    AgentSQLError,
    ForbiddenSQLError,
    SchemaViolationError,
    WriteUnsafeError,
)
from apps.tabdata.native.name_resolver import (
    NameResolutionError,
    get_resolver,
)
from apps.tabdata.services.rls_service import RLSContext

logger = logging.getLogger(__name__)

router = Router(tags=["Agent SQL"])


def _deny_table_scoped_space_sql(request: HttpRequest):
    api_token = getattr(request, 'api_token', None)
    if api_token is not None and getattr(api_token, 'table_ids', None) is not None:
        return error_response(
            ErrorCode.PERMISSION_DENIED,
            message='当前 Token 为表级授权，不能访问 Space 级 SQL 能力',
            status_code=403,
        )
    return None


def sql_query_impl(request: HttpRequest, space_id: UUID, data: AgentSQLQueryRequest):
    table_scoped_error = _deny_table_scoped_space_sql(request)
    if table_scoped_error is not None:
        return table_scoped_error

    try:
        from apps.services.common.sandbox_policy import load_sandbox_config_for_space
        sql_mode = load_sandbox_config_for_space(str(space_id)).get("sql_mode", "read_write")
        rls_ctx = RLSContext.from_request(request)
        executor = AgentSQLExecutor(space_id, request.auth, rls_context=rls_ctx, sql_mode=sql_mode)
        result = executor.execute_read(data.sql, data.params)
        return success_response(result)
    except NameResolutionError as e:
        return error_response(
            ErrorCode.SQL_NAME_RESOLUTION_FAILED,
            status_code=400,
            detail=str(e),
        )
    except ForbiddenSQLError as e:
        return error_response(
            ErrorCode.SQL_FORBIDDEN,
            status_code=400,
            detail=str(e),
        )
    except SchemaViolationError as e:
        return error_response(
            ErrorCode.SQL_SCHEMA_VIOLATION,
            status_code=403,
            detail=str(e),
        )
    except AgentSQLError as e:
        return error_response(
            ErrorCode.SQL_EXECUTION_ERROR,
            status_code=400,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("[AgentSQL] query error: %s", e)
        return error_response(
            ErrorCode.SQL_EXECUTION_ERROR,
            message="SQL 查询执行失败，请稍后重试",
            status_code=500,
        )




@router.post(
    "/spaces/{space_id}/sql/query",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
    auth=open_api_auth,
    summary="Agent SQL 只读查询",
)
@require_scope('sql:query')
@require_space_access
@api_error_handler
def sql_query(request: HttpRequest, space_id: UUID, data: AgentSQLQueryRequest):
    """
    执行只读 SQL 查询。

    支持中文表名和字段名，系统自动解析为内部标识符。
    仅支持 SELECT 查询，自动限制最大返回行数。
    """
    return sql_query_impl(request, space_id, data)


def sql_execute_impl(request: HttpRequest, space_id: UUID, data: AgentSQLExecuteRequest):
    table_scoped_error = _deny_table_scoped_space_sql(request)
    if table_scoped_error is not None:
        return table_scoped_error

    from apps.tabtinspace.services.organization_control_guard import (
        OrganizationControlBlockedError,
        assert_org_resource_write_for_space,
        organization_control_blocked_response,
    )

    try:
        assert_org_resource_write_for_space(space_id)

        from apps.services.common.sandbox_policy import load_sandbox_config_for_space
        sql_mode = load_sandbox_config_for_space(str(space_id)).get("sql_mode", "read_write")
        rls_ctx = RLSContext.from_request(request)
        executor = AgentSQLExecutor(space_id, request.auth, rls_context=rls_ctx, sql_mode=sql_mode)
        result = executor.execute_write(
            data.sql,
            data.params,
            allow_delete=data.allow_delete,
        )
        return success_response(result)
    except OrganizationControlBlockedError as e:
        return organization_control_blocked_response(e)
    except NameResolutionError as e:
        return error_response(
            ErrorCode.SQL_NAME_RESOLUTION_FAILED,
            status_code=400,
            detail=str(e),
        )
    except ForbiddenSQLError as e:
        return error_response(
            ErrorCode.SQL_FORBIDDEN,
            status_code=400,
            detail=str(e),
        )
    except SchemaViolationError as e:
        return error_response(
            ErrorCode.SQL_SCHEMA_VIOLATION,
            status_code=403,
            detail=str(e),
        )
    except WriteUnsafeError as e:
        return error_response(
            ErrorCode.SQL_WRITE_UNSAFE,
            status_code=400,
            detail=str(e),
        )
    except AgentSQLError as e:
        return error_response(
            ErrorCode.SQL_EXECUTION_ERROR,
            status_code=400,
            detail=str(e),
        )
    except Exception as e:
        logger.exception("[AgentSQL] execute error: %s", e)
        return error_response(
            ErrorCode.SQL_EXECUTION_ERROR,
            message="SQL 写入执行失败，请稍后重试",
            status_code=500,
        )




@router.post(
    "/spaces/{space_id}/sql/execute",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
    auth=open_api_auth,
    summary="Agent SQL 写入执行",
)
@require_scope('sql:execute')
@require_space_access(required_role='editor')
@api_error_handler
def sql_execute(request: HttpRequest, space_id: UUID, data: AgentSQLExecuteRequest):
    """
    执行写入 SQL 操作（INSERT/UPDATE/DELETE）。

    支持中文表名和字段名。系统自动注入版本号和时间戳。
    DELETE 需设置 allow_delete=true 显式授权。
    """
    return sql_execute_impl(request, space_id, data)


def sql_catalog_impl(request: HttpRequest, space_id: UUID):
    table_scoped_error = _deny_table_scoped_space_sql(request)
    if table_scoped_error is not None:
        return table_scoped_error

    try:
        resolver = get_resolver(space_id)
        catalog = resolver.build_catalog(space_id=space_id, compact=False)
        return success_response(catalog)
    except Exception as e:
        logger.exception("[AgentSQL] catalog error: %s", e)
        return error_response(
            ErrorCode.SQL_EXECUTION_ERROR,
            message="获取表目录信息失败，请稍后重试",
            status_code=500,
        )


@router.get(
    "/spaces/{space_id}/sql/catalog",
    response={200: dict, 401: dict, 403: dict, 404: dict, 429: dict, 500: dict},
    auth=open_api_auth,
    summary="Agent SQL 表/字段目录",
)
@require_scope('sql:query')
@require_space_access
@api_error_handler
def sql_catalog(request: HttpRequest, space_id: UUID):
    """
    获取 Space 中所有表和字段的目录信息。

    Agent 可先调用此接口了解可用的表结构，再编写 SQL 查询。
    """
    return sql_catalog_impl(request, space_id)


