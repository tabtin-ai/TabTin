from django.apps import AppConfig


class DiagnosticsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.diagnostics"
    verbose_name = "客户端诊断包"
