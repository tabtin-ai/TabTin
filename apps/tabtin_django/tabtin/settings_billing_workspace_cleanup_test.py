"""
Billing workspace cleanup 扩展覆盖测试 settings。

在最小 billing 测试 settings 的基础上，额外启用 workspace 强归属的
extensions / notification / channel_gateway 应用，用于验证删除闭环。
"""

from .settings_billing_test import *  # noqa: F401,F403

INSTALLED_APPS = [  # type: ignore[name-defined]
    *INSTALLED_APPS,  # type: ignore[name-defined]
    "apps.extensions",
    "apps.services.notification",
    "apps.channel_gateway",
    "apps.services.llm",
    "apps.services.media_generation",
    "apps.tabtinspace",
    "apps.chat.conversation",
]
