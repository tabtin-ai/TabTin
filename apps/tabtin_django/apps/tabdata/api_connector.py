"""
数据连接器 API

提供外部数据源的连接管理、Schema 发现、表导入等接口。
支持 JWT 和 API Token（需 connector:read / connector:manage scope）认证。
"""

import logging
from typing import List, Optional
from uuid import UUID

from django.http import HttpRequest
from ninja import Router
from pydantic import BaseModel, ConfigDict, Field, field_validator

from apps.tabdata.auth_open_api import (
    open_api_auth,
    require_scope,
)
from apps.tabdata.api_helpers import success_response, error_response, api_error_handler
from apps.tabdata.error_codes import ErrorCode
from apps.tabdata.models_connector import (
    SUPPORTED_CONNECTOR_TYPE_SET,
    SUPPORTED_CONNECTOR_TYPES_TEXT,
    SYNC_MODE_SET,
    SYNC_MODE_TEXT,
)
from apps.services.common.executor import run_in_agent_io_executor
from apps.tabdata.schemas import ErrorResponse

logger = logging.getLogger(__name__)

router = Router(tags=["Data Connector"])


# ── Schema ──────────────────────────────────────────────


class CreateConnectorRequest(BaseModel):
    """创建连接器请求"""
    organization_id: str = Field(..., description="组织 ID")
    space_id: str = Field(..., description="Space ID")
    connector_type: str = Field(..., description=f"连接器类型: {SUPPORTED_CONNECTOR_TYPES_TEXT}")
    name: str = Field(..., min_length=1, max_length=200, description="连接名称")
    config: dict = Field(..., description="连接配置（host/port/database/username/password 等）")


class UpdateConnectorRequest(BaseModel):
    """更新连接器请求"""
    name: Optional[str] = Field(None, min_length=1, max_length=200)
    config: Optional[dict] = None
    status: Optional[str] = None


class ImportTableSelection(BaseModel):
    """单个外部表导入选择"""
    model_config = ConfigDict(populate_by_name=True)

    source_schema: str = Field(default="", alias="schema", description="外部 schema 名")
    table: str = Field(..., min_length=1, description="外部表名")
    sync_mode: str = Field(default="proxy", description=f"同步模式: {SYNC_MODE_TEXT}")

    @field_validator("sync_mode")
    @classmethod
    def validate_sync_mode(cls, value: str) -> str:
        if value not in SYNC_MODE_SET:
            raise ValueError(f"sync_mode must be one of: {SYNC_MODE_TEXT}")
        return value


class ImportTablesRequest(BaseModel):
    """导入外部表请求"""
    selections: List[ImportTableSelection] = Field(
        ...,
        min_length=1,
        max_length=50,
        description='要导入的表列表: [{"schema": "public", "table": "orders", "sync_mode": "proxy"}]',
    )


# ── 辅助函数 ──


def _ensure_space_access(request, space_id: str, required_role: str = 'viewer'):
    """校验请求方对指定 Space 的访问权限。"""
    from apps.tabtinspace.models import Space
    from apps.tabtinspace.services.base import BaseService

    user = request.auth
    try:
        from apps.tabtinspace.services.host_resolver import resolve_host
        space = resolve_host(space_id)
        if space is None:
            raise Space.DoesNotExist
        if not BaseService(user=user).check_space_permission(space_id, required_role):
            return None, (403, {
                'success': False,
                'message': f'Access denied to the specified space. {required_role} role is required.',
            })
    except Space.DoesNotExist:
        return None, (404, {'success': False, 'message': 'Space not found.'})

    api_token = getattr(request, 'api_token', None)
    if api_token and not api_token.can_access_space(space_id):
        return None, (403, {'success': False, 'message': 'Token cannot access the specified space.'})

    return space, None


def _get_connector_with_access(connector_id, request, required_role: str = 'viewer'):
    """Fetch a DataConnector and verify the requesting user has space access.

    Returns (connector, error_response).  When access is granted the second
    element is ``None``; otherwise it is a ready-to-return tuple like
    ``(403, {...})`` or ``(404, {...})``.
    """
    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models_connector import DataConnector

    try:
        connector = DataConnector.objects.using(TABDATA_DB_ALIAS).get(id=connector_id)
    except DataConnector.DoesNotExist:
        return None, (404, {'success': False, 'message': 'Connector not found.'})

    _, err = _ensure_space_access(
        request,
        str(connector.space_id),
        required_role=required_role,
    )
    if err:
        return None, err

    return connector, None


def _serialize_connector(connector) -> dict:
    """序列化连接器（不返回敏感配置）"""
    return {
        'id': str(connector.id),
        'organization_id': str(connector.organization_id),
        'space_id': str(connector.space_id),
        'connector_type': connector.connector_type,
        'name': connector.name,
        'status': connector.status,
        'last_error': connector.last_error,
        'last_probe_at': connector.last_probe_at.isoformat() if connector.last_probe_at else None,
        'mapping_count': connector.mappings.count() if hasattr(connector, 'mappings') else 0,
        'created_at': connector.created_at.isoformat(),
        'updated_at': connector.updated_at.isoformat(),
    }


def _serialize_mapping(mapping) -> dict:
    """序列化表映射"""
    return {
        'id': str(mapping.id),
        'table_id': str(mapping.table_id),
        'external_schema': mapping.external_schema,
        'external_table': mapping.external_table,
        'sync_mode': mapping.sync_mode,
        'mirror_interval_minutes': mapping.mirror_interval_minutes,
        'mirror_strategy': mapping.mirror_strategy,
        'last_sync_at': mapping.last_sync_at.isoformat() if mapping.last_sync_at else None,
        'last_sync_status': mapping.last_sync_status,
        'last_sync_row_count': mapping.last_sync_row_count,
        'created_at': mapping.created_at.isoformat(),
    }


# ── 接口 ──────────────────────────────────────────────────


@router.post(
    "/connectors",
    response={200: dict, 400: dict, 401: dict, 403: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="创建数据连接器",
)
@require_scope('connector:manage')
@api_error_handler
def create_connector(request: HttpRequest, body: CreateConnectorRequest):
    """创建新的外部数据源连接。"""
    space, err = _ensure_space_access(request, body.space_id, required_role='editor')
    if err:
        return err

    if str(space.organization_id) != body.organization_id:
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            'organization_id does not match the specified space_id.',
        )

    if body.connector_type not in SUPPORTED_CONNECTOR_TYPE_SET:
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            f'Unsupported connector type: {body.connector_type}. '
            f'Allowed: {SUPPORTED_CONNECTOR_TYPES_TEXT}',
        )

    from apps.tabdata.services.connector_service import ConnectorService
    svc = ConnectorService(user=request.auth)
    connector = svc.create_connector(
        organization_id=str(space.organization_id),
        space_id=body.space_id,
        connector_type=body.connector_type,
        name=body.name,
        config=body.config,
    )
    return success_response(_serialize_connector(connector))


@router.get(
    "/connectors",
    response={200: dict, 401: dict, 403: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="列出 Space 下的连接器",
)
@require_scope('connector:read')
@api_error_handler
def list_connectors(request: HttpRequest, space_id: str):
    """列出指定 Space 下的所有数据连接器。"""
    _, err = _ensure_space_access(request, space_id)
    if err:
        return err
    from apps.tabdata.services.connector_service import ConnectorService
    svc = ConnectorService(user=request.auth)
    connectors = svc.list_connectors(space_id)
    return success_response([_serialize_connector(c) for c in connectors])


@router.get(
    "/connectors/{connector_id}",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="获取连接器详情",
)
@require_scope('connector:read')
@api_error_handler
def get_connector(request: HttpRequest, connector_id: UUID):
    """获取指定连接器的详情。"""
    connector, err = _get_connector_with_access(connector_id, request, required_role='viewer')
    if err:
        return err
    return success_response(_serialize_connector(connector))


@router.patch(
    "/connectors/{connector_id}",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="更新连接器",
)
@require_scope('connector:manage')
@api_error_handler
def update_connector(request: HttpRequest, connector_id: UUID, body: UpdateConnectorRequest):
    """更新连接器配置。"""
    connector, err = _get_connector_with_access(connector_id, request, required_role='editor')
    if err:
        return err
    from apps.tabdata.services.connector_service import ConnectorService
    svc = ConnectorService(user=request.auth)
    fields = body.dict(exclude_none=True)
    connector = svc.update_connector(str(connector_id), **fields)
    return success_response(_serialize_connector(connector))


@router.delete(
    "/connectors/{connector_id}",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="删除连接器",
)
@require_scope('connector:manage')
@api_error_handler
def delete_connector(request: HttpRequest, connector_id: UUID):
    """删除连接器及其所有关联的表。"""
    connector, err = _get_connector_with_access(connector_id, request, required_role='editor')
    if err:
        return err
    from apps.tabdata.services.connector_service import ConnectorService
    svc = ConnectorService(user=request.auth)
    svc.delete_connector(str(connector_id))
    return success_response(message='Connector deleted.')


@router.post(
    "/connectors/{connector_id}/test",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="测试连接",
)
@require_scope('connector:manage')
@api_error_handler
async def test_connection(request: HttpRequest, connector_id: UUID):
    """测试外部数据源的连接是否可用。"""
    def _run_sync():
        connector, err = _get_connector_with_access(connector_id, request, required_role='editor')
        if err:
            return err
        from apps.tabdata.services.connector_service import ConnectorService
        svc = ConnectorService(user=request.auth)
        success, message = svc.test_connection(str(connector_id))
        return success_response({
            'connected': success,
            'message': message,
        })
    return await run_in_agent_io_executor(_run_sync)


@router.post(
    "/connectors/{connector_id}/discover",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="发现外部表结构",
)
@require_scope('connector:read')
@api_error_handler
async def discover_tables(request: HttpRequest, connector_id: UUID):
    """发现外部数据源中的所有表及其字段信息。"""
    def _run_sync():
        connector, err = _get_connector_with_access(connector_id, request, required_role='viewer')
        if err:
            return err
        from apps.tabdata.services.connector_service import ConnectorService
        svc = ConnectorService(user=request.auth)
        tables = svc.discover_tables(str(connector_id))
        return success_response([
            {
                'schema': t.schema,
                'name': t.name,
                'row_count': t.row_count,
                'columns': [
                    {
                        'name': c.name,
                        'data_type': c.data_type,
                        'is_nullable': c.is_nullable,
                        'is_primary_key': c.is_primary_key,
                    }
                    for c in t.columns
                ],
            }
            for t in tables
        ])
    return await run_in_agent_io_executor(_run_sync)


@router.post(
    "/connectors/{connector_id}/import-tables",
    response={200: dict, 400: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="导入外部表到 TabData",
)
@require_scope('connector:manage')
@api_error_handler
async def import_tables(request: HttpRequest, connector_id: UUID, body: ImportTablesRequest):
    """
    将选中的外部表导入为 TabData 表。

    每个选择项需指定 schema、table 和 sync_mode（proxy 或 mirror）。
    """
    selections_data = [selection.model_dump(by_alias=True) for selection in body.selections]

    def _run_sync():
        connector, err = _get_connector_with_access(connector_id, request, required_role='editor')
        if err:
            return err
        from apps.tabdata.services.connector_service import ConnectorService
        svc = ConnectorService(user=request.auth)
        results = svc.import_tables(str(connector_id), selections_data)
        return success_response(results)
    return await run_in_agent_io_executor(_run_sync)


@router.get(
    "/connectors/{connector_id}/tables",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="获取已导入的表列表",
)
@require_scope('connector:read')
@api_error_handler
def list_imported_tables(request: HttpRequest, connector_id: UUID):
    """获取该连接器已导入到 TabData 的表映射列表。"""
    connector, err = _get_connector_with_access(connector_id, request, required_role='viewer')
    if err:
        return err
    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models_connector import ConnectorTableMapping

    mappings = ConnectorTableMapping.objects.using(TABDATA_DB_ALIAS).filter(
        connector_id=connector_id,
    ).order_by('-created_at')
    return success_response([_serialize_mapping(m) for m in mappings])


@router.post(
    "/connectors/{connector_id}/sync/{mapping_id}",
    response={200: dict, 401: dict, 403: dict, 404: dict, 500: ErrorResponse},
    auth=open_api_auth,
    summary="手动触发同步",
)
@require_scope('connector:manage')
@api_error_handler
def trigger_sync(request: HttpRequest, connector_id: UUID, mapping_id: UUID):
    """手动触发镜像表的数据同步（仅 mirror 模式有效）。"""
    connector, err = _get_connector_with_access(connector_id, request, required_role='editor')
    if err:
        return err

    from apps.tabdata.constants import TABDATA_DB_ALIAS
    from apps.tabdata.models_connector import ConnectorTableMapping

    try:
        mapping = ConnectorTableMapping.objects.using(TABDATA_DB_ALIAS).get(
            id=mapping_id,
            connector_id=connector_id,
        )
    except ConnectorTableMapping.DoesNotExist:
        return 404, {'success': False, 'message': 'Table mapping not found.'}

    if mapping.sync_mode != 'mirror':
        return error_response(
            ErrorCode.VALIDATION_ERROR,
            'Manual sync is only supported for mirror mode.',
        )

    # Trigger async sync task
    # C3 / Wave 1.3：freeze 当前 schema_version_token，删表后该任务自动 no-op
    from apps.tabdata.tasks.connector_tasks import sync_connector_table
    from apps.tabdata.services.schema_version_token import (
        FROZEN_TOKEN_KEY, get_table_schema_version_token,
    )
    frozen_token = get_table_schema_version_token(mapping.table_id)
    task_kwargs = {FROZEN_TOKEN_KEY: frozen_token} if frozen_token else {}
    sync_connector_table.apply_async(args=[str(mapping.id)], kwargs=task_kwargs)
    return success_response(message='Sync task submitted.')
