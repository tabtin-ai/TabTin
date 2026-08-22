from django.apps import AppConfig


class MusicConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.music"
    label = "music"
    verbose_name = "Music Services (BGM Generation)"
