from django.apps import AppConfig


class SoundEffectsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.sound_effects"
    label = "sound_effects"
    verbose_name = "Sound Effects Services (Freesound)"
