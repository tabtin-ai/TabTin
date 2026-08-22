"""
Organization 级 Developer API 路由

与 ``api_open_space`` 平行：资源归属以 Organization 为准，不再把 Space 建模成数据库。

路径前缀: /api/open/v1/organizations/{organization_id}/data/...

首批入口：home / db-info / tables list+create。其余表级操作可继续走 table_id 路由或后续补齐。
"""
from typing import List, Optional
from uuid import UUID

from django.http import HttpRequest
from ninja import Router, Schema
from pydantic import Field as PydField

from apps.tabdata.api_helpers import api_error_handler
from apps.tabdata.api_open_schemas import InlineFieldDefinition
from apps.tabdata.api_open_impl.space_impl import (
    create_organization_data_table_impl,
    get_organization_data_db_info_impl,
    get_organization_data_home_impl,
)
from apps.tabdata.api_open import list_tables_impl
from apps.tabdata.auth_open_api import (
    idempotent,
    open_api_auth,
    require_organization_access,
    require_scope,
)

router = Router(tags=["Organization Developer API"])

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


class OrganizationDataCreateTableBody(Schema):
    """在指定 Organization 下创建 org-only 数据表（不挂 Space）。"""
    name: str = PydField(description='表格名称', min_length=1, max_length=100)
    description: Optional[str] = PydField(default=None, description='表格描述')
    icon: Optional[str] = PydField(default=None, description='表格图标')
    use_default_fields: bool = PydField(
        default=True,
        description='是否创建默认字段（传入 fields 时自动忽略）',
    )
    fields: Optional[List[InlineFieldDefinition]] = PydField(
        default=None,
        description='内联字段定义列表，一步建表+定义 schema',
    )


@router.get(
    "/organizations/{organization_id}/data",
    auth=open_api_auth,
    summary="获取当前 Organization 的数据入口概览",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope(*_DISCOVERY_SCOPES)
@require_organization_access
@api_error_handler
def get_organization_data_home(request: HttpRequest, organization_id: UUID):
    """返回 Organization 作为资源归属入口的聚合说明。"""
    return get_organization_data_home_impl(request, organization_id)


@router.get(
    "/organizations/{organization_id}/data/db-info",
    auth=open_api_auth,
    summary="获取 Organization 下各表数据库映射信息",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('db_connection:manage')
@require_organization_access
@api_error_handler
def get_organization_data_db_info(request: HttpRequest, organization_id: UUID):
    return get_organization_data_db_info_impl(request, organization_id)


@router.get(
    "/organizations/{organization_id}/data/tables",
    auth=open_api_auth,
    summary="列出当前 Organization 下的数据表",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:read')
@require_organization_access
@api_error_handler
def list_organization_data_tables(request: HttpRequest, organization_id: UUID):
    return list_tables_impl(request, organization_id=str(organization_id))


@router.post(
    "/organizations/{organization_id}/data/tables",
    auth=open_api_auth,
    summary="在当前 Organization 下创建 org-only 数据表",
    response={201: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: dict},
)
@require_scope('table:create')
@require_organization_access(required_role='editor')
@idempotent
@api_error_handler
def create_organization_data_table(
    request: HttpRequest,
    organization_id: UUID,
    body: OrganizationDataCreateTableBody,
):
    return create_organization_data_table_impl(request, organization_id, body)
