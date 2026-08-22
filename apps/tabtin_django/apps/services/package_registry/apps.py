from django.apps import AppConfig


class PackageRegistryConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.package_registry"
    label = "package_registry"
    verbose_name = "Package Registry"
