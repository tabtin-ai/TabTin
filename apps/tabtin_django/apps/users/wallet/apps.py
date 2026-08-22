"""
钱包系统应用配置
"""

from django.apps import AppConfig


class WalletConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.users.wallet'
    verbose_name = '钱包系统'
