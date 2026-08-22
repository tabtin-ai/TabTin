"""
WebSocket Gateway 更新功能扩展
为 GatewayConsumer 添加更新推送和进度上报能力

Important: This Mixin relies on attributes and methods defined by
``GatewayConsumerProtocol`` (see ``apps.services.common.ws.protocol``).
When mixed into a Consumer class, the Consumer MUST satisfy that protocol.
"""
import logging
from typing import TYPE_CHECKING, Any, Dict
from channels.db import database_sync_to_async
from pydantic import ValidationError

from apps.services.common.ws.protocol import (
    build_envelope, new_event_id, ERROR_SCHEMA_INVALID,
)
from .models import UpdateLog
from .ws_protocol import UpdateProgressPayload
from .services.query_service import UpdateQueryService

if TYPE_CHECKING:
    from apps.services.common.ws.protocol import GatewayConsumerProtocol

logger = logging.getLogger(__name__)


class UpdateWSMixin:
    """
    更新功能 Mixin，用于扩展 GatewayConsumer。

    Relies on ``GatewayConsumerProtocol`` attributes:
      device_fingerprint, user_id, organization_id, channel_name,
      channel_layer, joined_groups, _send_envelope, _send_error, send
    """

    # 客户端元数据（在 auth 时设置）
    client_version: str = "0.0.0"
    client_platform: str = ""
    client_arch: str = ""
    client_channel: str = "stable"
    client_update_capable: bool = False

    def _extend_auth_handler(self, envelope: Dict[str, Any]) -> None:
        """
        扩展认证处理，解析客户端元数据
        应在 _handle_auth 中调用
        """
        payload = envelope.get("payload", {})
        device = payload.get("device") if isinstance(payload.get("device"), dict) else {}
        capabilities = payload.get("capabilities")
        declared_capabilities = {
            str(item).strip().lower()
            for item in capabilities
            if isinstance(item, str) and item.strip()
        } if isinstance(capabilities, list) else set()

        # 兼容两种来源：
        # 1. 旧协议：client_version / platform / arch / channel 位于 auth payload 顶层
        # 2. 新协议：客户端元数据挂在 payload.device 中
        self.client_version = (
            payload.get("client_version")
            or device.get("app_version")
            or "0.0.0"
        )
        self.client_platform = payload.get("platform") or device.get("platform") or ""
        self.client_arch = payload.get("arch") or device.get("arch") or ""
        self.client_channel = (
            payload.get("channel")
            or device.get("channel")
            or "stable"
        )
        self.client_update_capable = (
            "update" in declared_capabilities
            or bool(self.client_platform and self.client_arch and device.get("app_version"))
        )

        logger.info(
            f"[WS Update] Client connected: version={self.client_version} "
            f"platform={self.client_platform or '-'} arch={self.client_arch or '-'} "
            f"channel={self.client_channel} update_capable={self.client_update_capable}"
        )

    async def _auto_join_update_group(self) -> None:
        """
        认证成功后自动加入更新推送分组
        应在 _handle_auth 成功后调用
        """
        if not self.client_update_capable or not self.client_platform or not self.client_arch:
            logger.debug("[WS Update] Client skipped update group join: missing update metadata")
            return

        # 构造分组名: app.update.{platform}.{arch}.{channel}
        group_name = f"app.update.{self.client_platform}.{self.client_arch}.{self.client_channel}"

        await self.channel_layer.group_add(group_name, self.channel_name)
        self.joined_groups.add(group_name)

        logger.info(f"[WS Update] Client joined update group: {group_name}")

    async def _handle_update_progress(self, envelope: Dict[str, Any]) -> None:
        """
        处理客户端上报的更新进度
        消息类型: app.update.progress
        """
        request_id = envelope["request_id"]
        payload = envelope.get("payload", {})

        try:
            progress_data = UpdateProgressPayload(**payload)

            # 记录到数据库
            await self._log_update_progress(progress_data)

            # 发送 ACK
            await self._send_envelope(build_envelope(
                "app.update.progress.ok", request_id, {"received": True}
            ))

            logger.debug(
                f"[WS Update] Progress reported: {self.device_fingerprint} -> "
                f"v{progress_data.version} {progress_data.status} "
                f"{progress_data.progress}%"
            )

        except ValidationError as e:
            logger.warning(f"[WS Update] Invalid progress payload: {e}")
            await self._send_error(
                request_id,
                ERROR_SCHEMA_INVALID,
                f"Invalid progress data: {e}"
            )

    @database_sync_to_async
    def _log_update_progress(self, progress_data: UpdateProgressPayload) -> None:
        """
        同步方法：记录更新日志到数据库
        """
        # 同一设备同一目标版本可能因为多次 check / push 产生多条 available 日志。
        # 不能用 get_or_create，否则会在进度上报时触发 MultipleObjectsReturned。
        in_flight_statuses = ['checking', 'available', 'downloading', 'downloaded', 'installing']
        log = (
            UpdateLog.objects.filter(
                device_id=self.device_fingerprint or self.channel_name,
                to_version=progress_data.version,
                status__in=in_flight_statuses,
            )
            .order_by('-started_at')
            .first()
        )

        if log is None:
            UpdateLog.objects.create(
                user_id=self.user_id or '',
                organization_id=self.organization_id or '',
                device_id=self.device_fingerprint or self.channel_name,
                to_version=progress_data.version,
                from_version=progress_data.from_version or self.client_version,
                platform=self.client_platform,
                arch=self.client_arch,
                channel=self.client_channel,
                trigger_source=progress_data.trigger_source or 'ws_push',
                status=progress_data.status,
                progress=progress_data.progress,
            )
            return

        # 更新现有记录
        log.status = progress_data.status
        log.progress = progress_data.progress

        if progress_data.status == 'installed':
            log.mark_success()
        elif progress_data.status == 'failed':
            log.mark_failed(
                error_code=progress_data.error_code or 'UNKNOWN',
                error_message=progress_data.error_message or ''
            )
        else:
            log.save()

    async def app_update_available(self, event: Dict[str, Any]) -> None:
        """
        Channel Layer 事件处理器：接收更新推送
        由 UpdatePushService 通过 channel_layer.group_send() 触发

        event 结构:
        {
            "type": "app.update.available",
            "payload": UpdateAvailablePayload
        }
        """
        try:
            payload = event["payload"]

            # 灰度控制：检查是否应该推送给此客户端
            if not self._should_receive_update(payload):
                logger.debug(
                    f"[WS Update] Skipped update push (rollout/version): "
                    f"{self.device_fingerprint}"
                )
                return

            eid = new_event_id()
            await self._send_envelope(build_envelope(
                "app.update.available",
                eid,
                payload,
                event_id=eid,
            ))

            logger.info(
                f"[WS Update] Pushed update v{payload['version']} to "
                f"user={self.user_id} device={self.device_fingerprint}"
            )

            # 记录推送事件（可选）
            await self._log_update_push_event(payload)

        except Exception as e:
            logger.error(f"[WS Update] Failed to push update: {e}", exc_info=True)

    def _should_receive_update(self, payload: Dict[str, Any]) -> bool:
        """
        判断是否应该推送给此客户端

        检查项：
        1. 版本是否比当前新
        2. 灰度比例
        """
        from packaging import version

        # 1. 检查版本
        try:
            current_ver = version.parse(self.client_version)
            new_ver = version.parse(payload["version"])

            if current_ver >= new_ver:
                return False
        except Exception as e:
            logger.warning(f"[WS Update] Version parse error: {e}")
            return False

        # 2. 检查灰度
        rollout_percentage = payload.get("rollout_percentage", 100)
        if rollout_percentage < 100:
            import hashlib
            device_key = self.device_fingerprint or self.channel_name or ""
            if not device_key:
                return False
            hash_val = int(hashlib.md5(device_key.encode()).hexdigest(), 16)
            if (hash_val % 100) >= rollout_percentage:
                return False

        return True

    @database_sync_to_async
    def _log_update_push_event(self, payload: Dict[str, Any]) -> None:
        """记录推送事件（创建 UpdateLog）"""
        UpdateLog.objects.create(
            user_id=self.user_id or '',
            device_id=self.device_fingerprint or self.channel_name or '',
            organization_id=self.organization_id or '',
            from_version=self.client_version,
            to_version=payload["version"],
            platform=self.client_platform,
            arch=self.client_arch,
            channel=self.client_channel,
            trigger_source='ws_push',
            status='available',
            progress=0
        )



# 使用示例（在 gateway.py 中）:
#
# from apps.updater.ws_handler import UpdateWSMixin
#
# class GatewayConsumer(UpdateWSMixin, AsyncWebsocketConsumer):
#     async def _handle_auth(self, envelope):
#         # 现有认证逻辑...
#
#         # 扩展：解析客户端元数据
#         self._extend_auth_handler(envelope)
#
#         # 认证成功后自动加入更新分组
#         await self._auto_join_update_group()
#
#     def _handlers(self):
#         handlers = {
#             # 现有 handlers...
#             "app.update.progress": self._handle_update_progress,
#         }
#         return handlers
