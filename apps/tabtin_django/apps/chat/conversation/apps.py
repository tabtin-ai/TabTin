"""
Conversation子模块 Django App配置
"""

from django.apps import AppConfig


class ConversationConfig(AppConfig):
    """对话管理模块配置"""
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.chat.conversation'
    verbose_name = '对话管理'

    def ready(self):
        """应用就绪时的初始化"""
        import apps.chat.conversation.signals  # noqa: F401
