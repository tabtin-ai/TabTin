"""
用户认证应用配置
"""

from django.apps import AppConfig


class AuthConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.users.auth'
    label = 'users_auth'  # 设置唯一的应用标签
    verbose_name = '用户认证'

    def ready(self):
        """应用启动时的初始化操作"""
        # 导入信号处理器
        try:
            from . import signals
        except ImportError:
            pass
