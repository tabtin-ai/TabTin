"""
MCPConnectionService — MCP 连接管理。

- local：归属 Device（stdio / http 均可）
- remote：归属 Organization（仅 http）；组织成员可读，editor+ 可写
- runtime-config：Electron main 取解密 transport（不下发 renderer）
"""
import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.core.exceptions import ValidationError
from django.db import IntegrityError, transaction

from apps.tabtinspace.models import Device, MCPConnection, Organization, SecureCredential
from apps.services.common.db_router import postgres_app_db_alias
from .base import BaseService, ServiceError

logger = logging.getLogger(__name__)

_FULL_CLEAN_EXCLUDE = ['credential']


def _format_validation_error(exc: ValidationError) -> str:
    try:
        return '; '.join(exc.messages)
    except Exception:
        return str(exc)


class MCPConnectionService(BaseService):
    """MCP 连接管理：local（device）+ remote（organization）。"""

    def create_connection(
        self,
        device_id: UUID,
        name: str,
        description: str = '',
        transport: str = 'stdio',
        command: str = '',
        args: Optional[list] = None,
        cwd: str = '',
        endpoint: str = '',
        config: Optional[dict] = None,
        credential_value: Optional[str] = None,
        credential_name: Optional[str] = None,
        enabled: bool = True,
    ) -> Optional[MCPConnection]:
        if not self.user:
            return None

        try:
            device = Device.objects.get(id=device_id, user_id=self.user.id)
        except Device.DoesNotExist:
            return None

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                credential = None
                if credential_value:
                    credential = SecureCredential.objects.create(
                        organization=device.organization,
                        user_id=self.user.id,
                        device=device,
                        name=credential_name or f"{name}-mcp",
                        credential_type='api_key',
                        encrypted_value='',
                    )
                    credential.set_value(credential_value)
                    credential.save(update_fields=['encrypted_value'])

                conn = MCPConnection(
                    device=device,
                    name=name,
                    description=description or '',
                    transport=transport,
                    command=command,
                    args=args or [],
                    cwd=cwd,
                    endpoint=endpoint,
                    config=config or {},
                    credential=credential,
                    enabled=enabled,
                )
                conn.full_clean(
                    exclude=_FULL_CLEAN_EXCLUDE,
                    validate_unique=False,
                    validate_constraints=False,
                )
                conn.save()
        except ValidationError as exc:
            raise ServiceError('MCP_CONNECTION_INVALID', _format_validation_error(exc), 400)
        except IntegrityError:
            raise ServiceError('MCP_CONNECTION_NAME_CONFLICT', '同一设备下已存在同名 MCP 连接', 400)

        logger.info(
            "[MCP] connection created: %s (transport=%s) on device %s",
            name, transport, device_id,
        )
        return conn

    def create_org_connection(
        self,
        organization_id: UUID,
        name: str,
        endpoint: str,
        description: str = '',
        config: Optional[dict] = None,
        credential_value: Optional[str] = None,
        credential_name: Optional[str] = None,
        enabled: bool = True,
    ) -> MCPConnection:
        """创建组织级 remote MCP（仅 http）。需要 editor+。"""
        if not self.user:
            raise ServiceError('AUTH_REQUIRED', '未登录', 401)
        if not self.check_organization_permission(str(organization_id), 'editor'):
            raise ServiceError('ORG_PERMISSION_DENIED', '无权限在组织中创建远程 MCP 连接', 403)

        endpoint = (endpoint or '').strip()
        if not endpoint:
            raise ServiceError('MCP_CONNECTION_INVALID', '远程 MCP 必须提供 endpoint', 400)

        try:
            organization = Organization.objects.get(id=organization_id)
        except Organization.DoesNotExist:
            raise ServiceError('ORG_NOT_FOUND', '组织不存在', 404)

        # 幂等：同组织同 endpoint 已存在则拒绝重复创建（防连点共享）。
        if MCPConnection.objects.filter(
            organization_id=organization_id,
            scope='remote',
            endpoint=endpoint,
        ).exists():
            raise ServiceError(
                'MCP_CONNECTION_ENDPOINT_CONFLICT',
                '同一组织下已存在相同 endpoint 的远程 MCP 连接',
                409,
            )

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                credential = None
                if credential_value:
                    credential = SecureCredential.objects.create(
                        organization=organization,
                        user_id=self.user.id,
                        device=None,
                        name=credential_name or f"{name}-mcp",
                        credential_type='api_key',
                        encrypted_value='',
                    )
                    credential.set_value(credential_value)
                    credential.save(update_fields=['encrypted_value'])

                conn = MCPConnection(
                    organization=organization,
                    created_by_id=self.user.id,
                    name=name.strip(),
                    description=description or '',
                    transport='http',
                    endpoint=endpoint,
                    config=config or {},
                    credential=credential,
                    enabled=enabled,
                )
                conn.full_clean(
                    exclude=_FULL_CLEAN_EXCLUDE,
                    validate_unique=False,
                    validate_constraints=False,
                )
                conn.save()
        except ValidationError as exc:
            raise ServiceError('MCP_CONNECTION_INVALID', _format_validation_error(exc), 400)
        except IntegrityError:
            raise ServiceError('MCP_CONNECTION_NAME_CONFLICT', '同一组织下已存在同名 MCP 连接', 400)

        logger.info(
            "[MCP] org connection created: %s on organization %s",
            name, organization_id,
        )
        return conn

    def list_connections(self, device_id: UUID) -> List[MCPConnection]:
        if not self.user:
            return []
        return list(
            MCPConnection.objects.filter(
                device_id=device_id,
                device__user_id=self.user.id,
            ).select_related('credential').order_by('-created_at')
        )

    def list_org_connections(self, organization_id: UUID) -> List[MCPConnection]:
        if not self.user:
            return []
        if not self.check_organization_permission(str(organization_id), 'viewer'):
            return []
        return list(
            MCPConnection.objects.filter(
                organization_id=organization_id,
                scope='remote',
            ).select_related('credential').order_by('-created_at')
        )

    def get_connection(self, connection_id: UUID) -> Optional[MCPConnection]:
        """local：设备所有者；remote：组织成员。"""
        try:
            conn = MCPConnection.objects.select_related(
                'device', 'organization', 'credential',
            ).get(id=connection_id)
        except MCPConnection.DoesNotExist:
            return None
        if not self.user:
            return None
        if conn.device_id:
            if str(conn.device.user_id) != str(self.user.id):
                return None
            return conn
        if conn.organization_id:
            if not self.check_organization_permission(str(conn.organization_id), 'viewer'):
                return None
            return conn
        return None

    def update_connection(
        self,
        connection_id: UUID,
        name: Optional[str] = None,
        description: Optional[str] = None,
        transport: Optional[str] = None,
        command: Optional[str] = None,
        args: Optional[list] = None,
        cwd: Optional[str] = None,
        endpoint: Optional[str] = None,
        config: Optional[dict] = None,
        credential_value: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[MCPConnection]:
        conn = self.get_connection(connection_id)
        if not conn:
            return None
        if conn.organization_id and not self.check_organization_permission(
            str(conn.organization_id), 'editor',
        ):
            raise ServiceError('ORG_PERMISSION_DENIED', '无权限更新组织远程 MCP 连接', 403)
        if conn.scope == 'remote' and transport is not None and transport != 'http':
            raise ServiceError('MCP_CONNECTION_INVALID', '组织远程 MCP 仅支持 http', 400)

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                update_fields = ['updated_at']
                if name is not None:
                    conn.name = name
                    update_fields.append('name')
                if description is not None:
                    conn.description = description
                    update_fields.append('description')
                if transport is not None:
                    conn.transport = transport
                    update_fields.append('transport')
                if command is not None:
                    conn.command = command
                    update_fields.append('command')
                if args is not None:
                    conn.args = args
                    update_fields.append('args')
                if cwd is not None:
                    conn.cwd = cwd
                    update_fields.append('cwd')
                if endpoint is not None:
                    conn.endpoint = endpoint
                    update_fields.append('endpoint')
                if config is not None:
                    conn.config = config
                    update_fields.append('config')
                if enabled is not None:
                    conn.enabled = enabled
                    update_fields.append('enabled')

                if credential_value is not None:
                    org = conn.organization or (conn.device.organization if conn.device else None)
                    device = conn.device
                    if conn.credential:
                        conn.credential.credential_type = 'api_key'
                        conn.credential.set_value(credential_value)
                        conn.credential.save(
                            update_fields=['credential_type', 'encrypted_value', 'updated_at'],
                        )
                    else:
                        credential = SecureCredential.objects.create(
                            organization=org,
                            user_id=self.user.id,
                            device=device,
                            name=f"{conn.name}-mcp",
                            credential_type='api_key',
                            encrypted_value='',
                        )
                        credential.set_value(credential_value)
                        credential.save(update_fields=['encrypted_value'])
                        conn.credential = credential
                        update_fields.append('credential_id')

                conn.full_clean(
                    exclude=_FULL_CLEAN_EXCLUDE,
                    validate_unique=False,
                    validate_constraints=False,
                )
                conn.save(update_fields=update_fields)
        except ValidationError as exc:
            raise ServiceError('MCP_CONNECTION_INVALID', _format_validation_error(exc), 400)
        except IntegrityError:
            raise ServiceError('MCP_CONNECTION_NAME_CONFLICT', '同归属下已存在同名 MCP 连接', 400)

        logger.info("[MCP] connection updated: %s (id=%s)", conn.name, connection_id)
        return conn

    def record_probe(self, connection_id: UUID, last_probe: Optional[dict] = None) -> Optional[MCPConnection]:
        conn = self.get_connection(connection_id)
        if not conn:
            return None
        conn.last_probe = last_probe or {}
        conn.save(update_fields=['last_probe', 'updated_at'])
        logger.info("[MCP] probe recorded for %s (id=%s)", conn.name, connection_id)
        return conn

    def delete_connection(self, connection_id: UUID) -> bool:
        conn = self.get_connection(connection_id)
        if not conn:
            return False
        if conn.organization_id and not self.check_organization_permission(
            str(conn.organization_id), 'editor',
        ):
            raise ServiceError('ORG_PERMISSION_DENIED', '无权限删除组织远程 MCP 连接', 403)
        credential = conn.credential
        logger.info("[MCP] connection deleted: %s (id=%s)", conn.name, connection_id)
        conn.delete()
        if credential and not credential.mcp_connections.exists() and not credential.servers.exists():
            credential.delete()
        return True

    def get_runtime_config(self, connection_id: UUID) -> Dict[str, Any]:
        """返回 spawn/HTTP 所需完整配置（含解密凭据）。

        产品契约（组织 remote）：
        - 调用方须为组织成员（viewer+）；密钥只给 Electron/Daemon main，禁止进 renderer。
        - 连接必须 ``enabled=True``；停用后不可再取密。
        - HTTP 凭据始终注入 ``headers``（即便配置了 ``credential_env``），避免客户端
          只消费 header 时丢密；``credential_env`` 仍写入 ``env`` 供 stdio/兼容路径。
        """
        conn = self.get_connection(connection_id)
        if not conn:
            raise ServiceError('MCP_CONNECTION_NOT_FOUND', 'MCP 连接不存在或无权访问', 404)
        if not conn.enabled:
            raise ServiceError('MCP_CONNECTION_DISABLED', 'MCP 连接已停用，无法获取运行时配置', 403)

        env: Dict[str, str] = {}
        headers: Dict[str, str] = {}
        config = conn.config or {}
        if isinstance(config.get('env'), dict):
            env = {str(k): str(v) for k, v in config['env'].items() if v is not None}
        if isinstance(config.get('headers'), dict):
            headers = {str(k): str(v) for k, v in config['headers'].items() if v is not None}

        if conn.credential_id and conn.credential:
            secret = conn.credential.get_value() or ''
            if secret:
                # 约定：config.credential_header / credential_env 指定注入位置；默认 Authorization Bearer
                header_name = str(config.get('credential_header') or 'Authorization')
                env_name = config.get('credential_env')
                if env_name:
                    env[str(env_name)] = secret
                # HTTP（含组织 remote）必须能走 header；stdio 在未指定 env 时同样走 header 字段
                # （stdio 客户端可忽略 headers）。
                inject_header = conn.transport == 'http' or not env_name
                if inject_header:
                    if not secret.lower().startswith('bearer ') and header_name.lower() == 'authorization':
                        headers[header_name] = f'Bearer {secret}'
                    else:
                        headers[header_name] = secret

        return {
            'id': conn.id,
            'name': conn.name,
            'description': conn.description or '',
            'transport': conn.transport,
            'command': conn.command or '',
            'args': conn.args or [],
            'cwd': conn.cwd or '',
            'endpoint': conn.endpoint or '',
            'env': env,
            'headers': headers,
            'enabled': conn.enabled,
        }
