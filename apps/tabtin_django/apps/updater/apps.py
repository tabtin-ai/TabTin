import logging
import os

from django.apps import AppConfig
from django.conf import settings

from tabtin.startup_policy import StartupCapability, resolve_startup_policy

logger = logging.getLogger(__name__)


class UpdaterConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.updater'
    verbose_name = 'Application Updater'

    def ready(self):
        policy = resolve_startup_policy(os.environ)
        if not policy.allows(StartupCapability.OFFICIAL_UPDATER):
            return
        cdn_domain = getattr(settings, 'UPDATER_OSS_CDN_DOMAIN', '') or getattr(settings, 'ALIYUN_OSS_CDN_DOMAIN', '')
        if not cdn_domain:
            logger.warning(
                "[updater] UPDATER_OSS_CDN_DOMAIN 未配置。"
                "若 OSS bucket 为 private 模式，桌面更新推送将完全不可用。"
            )
