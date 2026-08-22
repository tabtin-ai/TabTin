from django.apps import AppConfig


class MaintenanceConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.maintenance'
    verbose_name = '系统维护'

    def ready(self):
        import apps.maintenance.signals  # noqa: F401
