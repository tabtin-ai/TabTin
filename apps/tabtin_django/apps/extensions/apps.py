"""Extension 框架 Django App 配置"""

import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class ExtensionsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.extensions"
    label = "extensions"
    verbose_name = "Extensions"

    def ready(self):
        self._check_encryption_key()
        self._register_contrib_extensions()
        self._register_event_consumers()

    @staticmethod
    def _check_encryption_key():
        """非 DEBUG 环境必须显式配置 CREDENTIAL_ENCRYPTION_KEY，禁止依赖 SECRET_KEY 降级。"""
        from django.conf import settings
        from django.core.exceptions import ImproperlyConfigured
        from apps.extensions.fields import _build_fernet_from_settings

        key = (
            getattr(settings, "CREDENTIAL_ENCRYPTION_KEY", None)
            or getattr(settings, "SSH_CREDENTIAL_ENCRYPTION_KEY", None)
        )
        if not key:
            if not getattr(settings, "DEBUG", False):
                logger.warning(
                    "[Extensions] ⚠️ 生产环境未设置 CREDENTIAL_ENCRYPTION_KEY，"
                    "当前使用 SECRET_KEY 派生密钥，强烈建议配置独立加密密钥"
                )
            return

        try:
            _build_fernet_from_settings(allow_secret_key_fallback=True)
        except ImproperlyConfigured as exc:
            logger.critical("[Extensions] %s", exc)
            raise

    def _register_contrib_extensions(self):
        """注册 contrib/ 下的内置 Extension 到 ExtensionRegistry。

        渠道类 Extension 已迁移到 ChannelAdapter，此处只注册非渠道类 Extension。
        """
        try:
            from apps.extensions.registry import ExtensionRegistry
            from apps.extensions.contrib.webhook_outbound import WebhookOutboundExtension
            from apps.extensions.contrib.github import GitHubExtension
            from apps.extensions.contrib.notification_center import NotificationCenterExtension

            for ext_cls in [
                WebhookOutboundExtension,
                GitHubExtension,
                NotificationCenterExtension,
            ]:
                try:
                    ExtensionRegistry.register(ext_cls())
                except Exception:
                    logger.warning(
                        "[Extensions] 注册 %s 失败", ext_cls.__name__, exc_info=True
                    )
        except Exception:
            logger.warning("[Extensions] 加载 contrib Extensions 失败", exc_info=True)

    def _register_event_consumers(self):
        """注册内置事件消费者。"""
        try:
            from apps.extensions.consumers import register_builtin_consumers

            register_builtin_consumers()
        except Exception:
            logger.warning("[Extensions] 注册内置事件消费者失败", exc_info=True)
