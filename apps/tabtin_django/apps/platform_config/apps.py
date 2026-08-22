from django.apps import AppConfig


class PlatformConfigConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.platform_config"
    verbose_name = "平台公共配置"
