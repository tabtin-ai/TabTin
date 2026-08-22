import logging
from functools import wraps
from typing import Optional
from uuid import UUID

from django.core.exceptions import ObjectDoesNotExist
from django.db.utils import OperationalError, ProgrammingError
from django.http import HttpRequest, JsonResponse

from apps.tabdata.error_codes import ErrorCode, get_error_response
from apps.tabtinspace.services.organization_control_guard import (
    OrganizationControlBlockedError,
    organization_control_blocked_response,
)
from apps.users.membership.exceptions import MembershipException, QuotaExceededError

_impl_logger = logging.getLogger(__name__)


def impl_error_handler(resource_name: str):
    """统一 impl 层错误处理装饰器，消除重复 try/except 模板。"""
    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except ValueError as e:
                return JsonResponse(
                    get_error_response(ErrorCode.VALIDATION_ERROR, detail=str(e)),
                    status=400,
                )
            except PermissionError:
                return JsonResponse(
                    get_error_response(ErrorCode.PERMISSION_DENIED, f'无权限操作{resource_name}'),
                    status=403,
                )
            except OrganizationControlBlockedError as e:
                return organization_control_blocked_response(e)
            except (MembershipException, QuotaExceededError) as e:
                return JsonResponse(
                    get_error_response(ErrorCode.PERMISSION_DENIED, str(e)),
                    status=403,
                )
            except ObjectDoesNotExist:
                return JsonResponse(
                    get_error_response(ErrorCode.NOT_FOUND, f'{resource_name}不存在'),
                    status=404,
                )
            except (ProgrammingError, OperationalError):
                _impl_logger.exception('Open API %s DB error', resource_name)
                return JsonResponse(
                    get_error_response(ErrorCode.INTERNAL_ERROR, f'{resource_name}数据库操作异常，请稍后重试'),
                    status=500,
                )
            except Exception:
                _impl_logger.exception('Open API %s error', resource_name)
                return JsonResponse(
                    get_error_response(ErrorCode.INTERNAL_ERROR, f'{resource_name}操作失败，请稍后重试'),
                    status=500,
                )
        return wrapper
    return decorator


_PUBLIC_OPEN_API_BASE_PATH = "/api/open/v1"


def _space_data_base_path(space_id: UUID) -> str:
    return f'{_PUBLIC_OPEN_API_BASE_PATH}/spaces/{space_id}/data'


def _organization_data_base_path(organization_id: UUID) -> str:
    return f'{_PUBLIC_OPEN_API_BASE_PATH}/organizations/{organization_id}/data'


_OPEN_API_SCOPE_REFERENCE = {
    'table:read': '读取表元信息、Schema、Developer Contract 与数据库映射',
    'table:create': '通过 Open API 创建表格',
    'table:update': '通过 Open API 更新表格',
    'table:delete': '通过 Open API 删除表格',
    'field:read': '读取字段列表与字段元数据',
    'field:create': '通过 Open API 创建字段',
    'field:update': '通过 Open API 更新字段',
    'field:delete': '通过 Open API 删除字段',
    'record:read': '查询记录、增量同步、结构化查询',
    'record:create': '创建记录、批量创建、Upsert',
    'record:update': '更新记录与批量更新',
    'record:delete': '删除记录与批量删除',
    'view:read': '读取视图列表与视图配置',
    'view:create': '通过 Open API 创建视图',
    'view:update': '通过 Open API 更新视图',
    'view:delete': '通过 Open API 删除视图',
    'aggregation:read': '聚合查询（COUNT / SUM / AVG / MIN / MAX 等）',
    'import:write': '导入预览、CSV / JSON / Excel 导入',
    'export:read': 'CSV / JSON / Excel / PDF 导出',
    'webhook:manage': '创建、编辑、测试、停用表级 Webhook',
    'db_connection:manage': '创建和管理只读 PostgreSQL 连接',
    'sql:query': 'Agent SQL 只读查询与目录',
    'sql:execute': 'Agent SQL 写入执行',
    'storage:read': '列出附件、获取下载链接、获取文件元信息',
    'storage:write': '上传、删除附件，预签名上传',
}


def _build_endpoint_entry(
    *,
    method: str,
    path: str,
    description: str,
    operation_id: str,
    group: str,
    required_scopes: Optional[list[str]] = None,
    supports_etag: bool = False,
    supports_idempotency: bool = False,
) -> dict[str, object]:
    payload: dict[str, object] = {
        'method': method,
        'path': path,
        'description': description,
        'operation_id': operation_id,
        'group': group,
    }
    if required_scopes:
        payload['required_scopes'] = required_scopes
    if supports_etag:
        payload['supports_etag'] = True
    if supports_idempotency:
        payload['supports_idempotency'] = True
    return payload


def _table_scoped_token_has_no_space_capability(request: HttpRequest) -> bool:
    api_token = getattr(request, 'api_token', None)
    return api_token is not None and getattr(api_token, 'table_ids', None) is not None


def _filter_tables_for_token(request: HttpRequest, tables) -> list:
    api_token = getattr(request, 'api_token', None)
    if api_token is None:
        return list(tables)
    return [
        table
        for table in tables
        if api_token.can_access_table(
            str(table.id),
            space_id=str(table.space_id) if getattr(table, 'space_id', None) else None,
        )
    ]


def _deny_legacy_space_level_endpoint_for_table_scoped_token() -> JsonResponse:
    return JsonResponse(
        get_error_response(
            ErrorCode.PERMISSION_DENIED,
            '当前 Token 为表级授权，不能访问 Space 级数据库能力，请改用表级接口。',
        ),
        status=403,
    )

