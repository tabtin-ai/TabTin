"""TabChat Django App 配置"""

from django.apps import AppConfig


class TabchatConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tabchat"
    label = "tabchat"
    verbose_name = "TabChat"

    def ready(self):
        import apps.tabchat.lookups  # noqa: F401 — 注册 BitAnd lookup
