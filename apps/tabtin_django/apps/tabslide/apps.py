from django.apps import AppConfig


class TabslideConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tabslide"
    label = "tabslide"
    verbose_name = "TabSlide"

    def ready(self):
        try:
            from apps.collab.adapters.slide import SlideCollabAdapter
            from apps.collab.registry import register_adapter

            register_adapter(SlideCollabAdapter())
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to register SlideCollabAdapter", exc_info=True
            )
