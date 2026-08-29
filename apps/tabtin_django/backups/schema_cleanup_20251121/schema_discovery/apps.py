from django.apps import AppConfig


class SchemaDiscoveryConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.schema_discovery'
    verbose_name = 'Schema Discovery'
