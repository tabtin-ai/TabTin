"""
RemoteServerService — SSH 远程服务器管理

负责 RemoteServer + SecureCredential 的 CRUD、凭据加密存储。
"""
import logging
from typing import List, Optional, Dict, Any
from uuid import UUID

from django.db import transaction

from apps.services.common.db_router import postgres_app_db_alias

from apps.tabtinspace.models import RemoteServer, SecureCredential, Device
from .base import BaseService

logger = logging.getLogger(__name__)


class RemoteServerService(BaseService):
    """SSH 远程服务器管理服务"""

    # ── RemoteServer CRUD ──

    def create_server(
        self,
        device_id: UUID,
        name: str,
        host: str,
        port: int,
        username: str,
        auth_method: str,
        credential_value: Optional[str] = None,
        credential_name: Optional[str] = None,
    ) -> Optional[RemoteServer]:
        """创建 SSH 服务器并关联加密凭据。

        credential_value 为明文密码或私钥内容，后端加密存储。
        """
        if not self.user:
            return None

        try:
            device = Device.objects.get(id=device_id, user_id=self.user.id)
        except Device.DoesNotExist:
            return None

        with transaction.atomic(using=postgres_app_db_alias()):
            credential = None
            if credential_value:
                cred_type = 'ssh_key' if auth_method == 'key' else 'ssh_password'
                credential = SecureCredential.objects.create(
                    organization=device.organization,
                    user_id=self.user.id,
                    name=credential_name or f"{name}-{cred_type}",
                    credential_type=cred_type,
                    encrypted_value='',
                )
                credential.set_value(credential_value)
                credential.save(update_fields=['encrypted_value'])

            server = RemoteServer.objects.create(
                device=device,
                name=name,
                host=host,
                port=port,
                username=username,
                auth_method=auth_method,
                credential=credential,
            )

        logger.info(
            "[SSH] server created: %s (%s@%s:%d) on device %s",
            name, username, host, port, device_id,
        )
        return server

    def list_servers(self, device_id: UUID) -> List[RemoteServer]:
        """列出设备下所有 SSH 服务器。"""
        if not self.user:
            return []
        return list(
            RemoteServer.objects.filter(
                device_id=device_id,
                device__user_id=self.user.id,
            ).select_related('credential').order_by('-created_at')
        )

    def get_server(self, server_id: UUID) -> Optional[RemoteServer]:
        """获取单个服务器，检查所有权。"""
        try:
            server = RemoteServer.objects.select_related('device', 'credential').get(id=server_id)
        except RemoteServer.DoesNotExist:
            return None
        if not self.user or str(server.device.user_id) != str(self.user.id):
            return None
        return server

    def update_server(
        self,
        server_id: UUID,
        name: Optional[str] = None,
        host: Optional[str] = None,
        port: Optional[int] = None,
        username: Optional[str] = None,
        auth_method: Optional[str] = None,
        credential_value: Optional[str] = None,
        status: Optional[str] = None,
    ) -> Optional[RemoteServer]:
        """更新服务器配置。credential_value 非空时重新加密凭据。"""
        server = self.get_server(server_id)
        if not server:
            return None

        update_fields = ['updated_at']
        if name is not None:
            server.name = name
            update_fields.append('name')
        if host is not None:
            server.host = host
            update_fields.append('host')
        if port is not None:
            server.port = port
            update_fields.append('port')
        if username is not None:
            server.username = username
            update_fields.append('username')
        if status is not None:
            server.status = status
            update_fields.append('status')

        if auth_method is not None and credential_value is not None:
            server.auth_method = auth_method
            update_fields.append('auth_method')
            cred_type = 'ssh_key' if auth_method == 'key' else 'ssh_password'
            if server.credential:
                server.credential.credential_type = cred_type
                server.credential.set_value(credential_value)
                server.credential.save(update_fields=['credential_type', 'encrypted_value', 'updated_at'])
            else:
                credential = SecureCredential.objects.create(
                    organization=server.device.organization,
                    user_id=self.user.id,
                    name=f"{server.name}-{cred_type}",
                    credential_type=cred_type,
                    encrypted_value='',
                )
                credential.set_value(credential_value)
                credential.save(update_fields=['encrypted_value'])
                server.credential = credential
                update_fields.append('credential_id')

        server.save(update_fields=update_fields)
        logger.info("[SSH] server updated: %s (id=%s)", server.name, server_id)
        return server

    def reset_host_key(self, server_id: UUID) -> Optional[RemoteServer]:
        """重置服务器 host key fingerprint（用户确认服务器重装后调用）。"""
        server = self.get_server(server_id)
        if not server:
            return None
        os_info = server.os_info if isinstance(server.os_info, dict) else {}
        os_info.pop('host_key_fingerprint', None)
        os_info.pop('host_key_type', None)
        server.os_info = os_info
        server.save(update_fields=['os_info', 'updated_at'])
        logger.info("[SSH] host key fingerprint reset for %s (id=%s)", server.name, server_id)
        return server

    def delete_server(self, server_id: UUID) -> bool:
        """删除服务器及其关联凭据。"""
        server = self.get_server(server_id)
        if not server:
            return False
        credential = server.credential
        logger.info("[SSH] server deleted: %s (id=%s)", server.name, server_id)
        server.delete()
        if credential and not credential.servers.exists():
            credential.delete()
        return True
