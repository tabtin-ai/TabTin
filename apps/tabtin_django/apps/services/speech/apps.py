from django.apps import AppConfig


class SpeechConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.services.speech"
    label = "speech"
    verbose_name = "Speech Services (ASR/TTS)"
