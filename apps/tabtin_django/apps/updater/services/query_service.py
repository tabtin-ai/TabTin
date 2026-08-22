"""
更新查询服务 - 用于 HTTP 接口和内部查询
"""
import logging
from typing import Optional
from packaging import version as version_parser
from django.db.models import Q

from ..models import AppRelease

logger = logging.getLogger(__name__)


class UpdateQueryService:
    """更新查询服务"""

    def get_latest_release(
        self,
        platform: str,
        arch: str = 'x64',
        channel: str = 'stable',
        current_version: Optional[str] = None
    ) -> Optional[AppRelease]:
        """
        获取最新可用版本

        Args:
            platform: 平台 (mac/win/linux)
            arch: 架构 (x64/arm64)
            channel: 渠道 (stable/beta/alpha)
            current_version: 当前版本号（用于版本比较）

        Returns:
            AppRelease or None
        """
        # 基础查询：已发布、非草稿、未废弃
        queryset = AppRelease.objects.filter(
            platform=platform,
            arch=arch,
            channel=channel,
            is_draft=False,
            published_at__isnull=False,
            deprecated_at__isnull=True
        ).order_by('-published_at')

        latest = queryset.first()

        # 如果没有可用版本
        if not latest:
            return None

        # 如果提供了当前版本，检查是否需要更新
        if current_version:
            try:
                current_ver = version_parser.parse(current_version)
                latest_ver = version_parser.parse(latest.version)

                # 如果当前版本已经是最新或更新，返回 None
                if current_ver >= latest_ver:
                    logger.debug(
                        f"[UpdateQuery] Current version {current_version} is up-to-date "
                        f"(latest: {latest.version})"
                    )
                    return None
            except Exception as e:
                logger.warning(f"[UpdateQuery] Failed to parse version: {e}")
                # 解析失败时，仍然返回最新版本

        return latest

    def should_force_update(
        self,
        current_version: str,
        latest_release: AppRelease
    ) -> bool:
        """
        判断是否需要强制更新

        Args:
            current_version: 当前版本号
            latest_release: 最新版本对象

        Returns:
            bool: 是否强制更新
        """
        # 1. 版本标记为强制更新
        if latest_release.is_mandatory:
            return True

        # 2. 当前版本低于最低兼容版本
        if latest_release.min_compatible_version:
            try:
                current_ver = version_parser.parse(current_version)
                min_ver = version_parser.parse(latest_release.min_compatible_version)
                if current_ver < min_ver:
                    return True
            except Exception as e:
                logger.warning(f"[UpdateQuery] Failed to parse min version: {e}")

        return False

    def get_rollout_eligibility(
        self,
        release: AppRelease,
        user_id: Optional[str] = None,
        device_id: Optional[str] = None
    ) -> bool:
        """
        判断用户/设备是否在灰度范围内

        Args:
            release: 版本对象
            user_id: 用户 ID
            device_id: 设备 ID

        Returns:
            bool: 是否应该推送
        """
        # 1. 白名单用户优先
        if user_id and release.rollout_target_users:
            if user_id in release.rollout_target_users:
                return True

        # 2. 100% 灰度，所有人可见
        if release.rollout_percentage >= 100:
            return True

        # 3. 根据 device_id 哈希决定
        if device_id:
            import hashlib
            hash_val = int(hashlib.md5(device_id.encode()).hexdigest(), 16)
            return (hash_val % 100) < release.rollout_percentage

        # 4. 没有 device_id，保守起见不推送
        return False

    def get_version_statistics(self, channel: str = 'stable') -> dict:
        """
        获取版本统计信息

        Args:
            channel: 渠道

        Returns:
            dict: 统计数据
        """
        from django.db.models import Count
        from ..models import UpdateLog

        # 最新版本
        latest_releases = {}
        for platform in ['mac', 'win', 'linux']:
            release = self.get_latest_release(platform, channel=channel)
            if release:
                latest_releases[platform] = release.version

        # 活跃版本分布（最近7天）
        from django.utils import timezone
        from datetime import timedelta

        seven_days_ago = timezone.now() - timedelta(days=7)

        version_dist = UpdateLog.objects.filter(
            started_at__gte=seven_days_ago,
            channel=channel
        ).values('from_version', 'platform').annotate(
            count=Count('id')
        ).order_by('-count')[:20]

        return {
            'latest_releases': latest_releases,
            'active_version_distribution': list(version_dist),
        }
