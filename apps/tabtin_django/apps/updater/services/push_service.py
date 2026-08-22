"""
更新推送服务 - 负责通过 WebSocket 推送更新通知
"""
import logging
from typing import Optional
from channels.layers import get_channel_layer
from asgiref.sync import async_to_sync
from django.utils import timezone

from ..models import AppRelease, UpdatePushRecord
from ..ws_protocol import UpdateAvailablePayload

logger = logging.getLogger(__name__)


class UpdatePushService:
    """更新推送协调器"""

    def __init__(self):
        self.channel_layer = get_channel_layer()

    def push_update(
        self,
        release: AppRelease,
        *,
        rollout_percentage: Optional[int] = None,
        silent: bool = False,
        pushed_by=None
    ) -> UpdatePushRecord:
        """
        推送更新通知给在线客户端

        Args:
            release: 发布对象
            rollout_percentage: 灰度比例 0-100，None 表示使用 release 的配置
            silent: 是否静默下载（不弹窗）
            pushed_by: 推送操作人

        Returns:
            UpdatePushRecord: 推送记录
        """
        if release.is_draft or not release.published_at:
            raise ValueError(f"Release {release.version} is not published yet")

        # 使用传入的灰度比例，或默认使用 release 的配置
        effective_rollout = rollout_percentage if rollout_percentage is not None else release.rollout_percentage

        # 构建 payload
        payload = UpdateAvailablePayload(
            version=release.version,
            platform=release.platform,
            arch=release.arch,
            channel=release.channel,
            file_url=release.file_url,
            feed_url=release.get_effective_feed_url(),
            manifest_url=release.get_manifest_url(),
            manifest_file=release.get_manifest_file(),
            file_size=release.file_size,
            checksum=release.checksum_sha256,
            release_notes=release.release_notes,
            release_notes_en=release.release_notes_en,
            release_date=release.published_at.isoformat(),
            mandatory=release.is_mandatory,
            silent=silent,
            priority=release.priority,
            rollout_percentage=effective_rollout
        ).model_dump()

        # 计算目标 group: app.update.{platform}.{arch}.{channel}
        group_name = f"app.update.{release.platform}.{release.arch}.{release.channel}"

        # 创建推送记录
        push_record = UpdatePushRecord.objects.create(
            release=release,
            target_group=group_name,
            rollout_percentage=effective_rollout,
            silent=silent,
            pushed_by=pushed_by,
            status='pending'
        )

        try:
            # 通过 Channel Layer 广播到 WebSocket 消费者
            async_to_sync(self.channel_layer.group_send)(
                group_name,
                {
                    "type": "app.update.available",  # 对应 Consumer 的 app_update_available 方法
                    "payload": payload
                }
            )

            # 标记为已发送
            push_record.status = 'sent'
            push_record.save(update_fields=['status'])

            logger.info(
                f"[UpdatePush] Broadcasted v{release.version} to {group_name}, "
                f"rollout={effective_rollout}%, silent={silent}"
            )

        except Exception as e:
            logger.error(f"[UpdatePush] Failed to broadcast: {e}", exc_info=True)
            push_record.status = 'failed'
            push_record.error_message = str(e)
            push_record.save(update_fields=['status', 'error_message'])
            raise

        return push_record

    def push_update_to_all_platforms(
        self,
        version: str,
        channel: str = 'stable',
        **kwargs
    ) -> list[UpdatePushRecord]:
        """
        推送指定版本到所有平台

        Args:
            version: 版本号
            channel: 渠道
            **kwargs: 传递给 push_update 的其他参数

        Returns:
            list[UpdatePushRecord]: 推送记录列表
        """
        releases = AppRelease.objects.filter(
            version=version,
            channel=channel,
            is_draft=False,
            published_at__isnull=False
        )

        records = []
        for release in releases:
            try:
                record = self.push_update(release, **kwargs)
                records.append(record)
            except Exception as e:
                logger.error(
                    f"[UpdatePush] Failed to push {release}: {e}",
                    exc_info=True
                )

        return records

    def increase_rollout(
        self,
        release: AppRelease,
        new_percentage: int,
        pushed_by=None
    ) -> UpdatePushRecord:
        """
        增加灰度比例并推送

        Args:
            release: 发布对象
            new_percentage: 新的灰度比例（必须大于当前值）
            pushed_by: 操作人

        Returns:
            UpdatePushRecord: 推送记录
        """
        if new_percentage <= release.rollout_percentage:
            raise ValueError(
                f"New rollout percentage ({new_percentage}%) must be greater than "
                f"current ({release.rollout_percentage}%)"
            )

        if new_percentage > 100:
            raise ValueError("Rollout percentage cannot exceed 100%")

        # 更新 release 的灰度比例
        release.rollout_percentage = new_percentage
        release.save(update_fields=['rollout_percentage', 'updated_at'])

        # 推送更新
        return self.push_update(
            release,
            rollout_percentage=new_percentage,
            pushed_by=pushed_by
        )
