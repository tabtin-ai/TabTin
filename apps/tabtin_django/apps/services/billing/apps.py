from django.apps import AppConfig


class BillingConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.billing"
    verbose_name = "计费中心"

    def ready(self):
        try:
            from .signals import register_signals
            register_signals()
        except Exception:
            pass

