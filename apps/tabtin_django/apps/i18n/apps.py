"""
I18n App 配置
"""

from django.apps import AppConfig


class I18nConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.i18n'
    verbose_name = '国际化管理'

    def ready(self):
        """应用启动时初始化"""
        # 导入信号处理器
        pass

