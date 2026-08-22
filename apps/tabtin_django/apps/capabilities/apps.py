from django.apps import AppConfig


class CapabilitiesConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.capabilities"
    verbose_name = "Capabilities"

    def ready(self):
        from apps.capabilities.services.tool_sync import schedule_tool_sync
        schedule_tool_sync()
