"""Channel Gateway Django App 配置.

W6 (2026-05-04): channel adapters no longer expose ``send_message`` /
``send_media`` BaseTools to ``ToolHub`` — the LLM tool SSoT lives in the TS
runtime. Outbound messaging is now driven directly by adapter coroutines via
the channel HTTP API and signal handlers, so no tool registration is needed
on the Python side.
"""

import importlib
import logging
import os

from django.apps import AppConfig

from tabtin.startup_policy import StartupCapability, resolve_startup_policy

logger = logging.getLogger(__name__)

ADAPTER_MAP = {
    'telegram': ('apps.channel_gateway.adapters.telegram', 'TelegramAdapter'),
    'feishu': ('apps.channel_gateway.adapters.feishu', 'FeishuAdapter'),
    'slack': ('apps.channel_gateway.adapters.slack', 'SlackAdapter'),
    'discord': ('apps.channel_gateway.adapters.discord', 'DiscordAdapter'),
    'whatsapp': ('apps.channel_gateway.adapters.whatsapp', 'WhatsAppAdapter'),
    'line': ('apps.channel_gateway.adapters.line', 'LineAdapter'),
    'dingtalk': ('apps.channel_gateway.adapters.dingtalk', 'DingTalkAdapter'),
    'googlechat': ('apps.channel_gateway.adapters.googlechat', 'GoogleChatAdapter'),
    'msteams': ('apps.channel_gateway.adapters.msteams', 'MSTeamsAdapter'),
    'mattermost': ('apps.channel_gateway.adapters.mattermost', 'MattermostAdapter'),
    'wechat_work': ('apps.channel_gateway.adapters.wechat_work', 'WeChatWorkAdapter'),
    'weixin_personal': ('apps.channel_gateway.adapters.weixin_personal', 'WeixinPersonalAdapter'),
}


class ChannelGatewayConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.channel_gateway'
    verbose_name = 'Channel Gateway'

    def ready(self):
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        channels = self._get_configured_channels()
        registered = 0
        for channel_key in channels:
            entry = ADAPTER_MAP.get(channel_key)
            if entry is None:
                logger.warning(
                    "[ChannelGateway] 未知渠道 key: %s，跳过。可用值: %s",
                    channel_key, ', '.join(sorted(ADAPTER_MAP.keys())),
                )
                continue
            module_path, class_name = entry
            try:
                mod = importlib.import_module(module_path)
                adapter_cls = getattr(mod, class_name)
                ChannelAdapterRegistry.register(adapter_cls())
                registered += 1
            except Exception:
                logger.warning("[ChannelGateway] %s adapter 注册失败", channel_key, exc_info=True)

        logger.info("[ChannelGateway] 已注册 %d/%d 个渠道 adapter", registered, len(channels))

    @staticmethod
    def _get_configured_channels():
        """Read TABTIN_CHANNELS env var; default to registering every adapter."""
        env_val = os.getenv('TABTIN_CHANNELS', '').strip()
        policy = resolve_startup_policy(os.environ)
        if not policy.allows(
            StartupCapability.EXTERNAL_CHANNELS,
            explicitly_configured=bool(env_val),
        ):
            return []
        if not env_val:
            return list(ADAPTER_MAP.keys())
        return [ch.strip() for ch in env_val.split(',') if ch.strip()]
