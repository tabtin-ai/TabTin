from django.apps import AppConfig


class TabdocConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.tabdoc"
    label = "tabdoc"
    verbose_name = "TabDoc"

    def ready(self):
        try:
            from apps.collab.adapters.docs import DocsCollabAdapter
            from apps.collab.registry import register_adapter

            register_adapter(DocsCollabAdapter())
        except Exception:
            import logging
            logging.getLogger(__name__).warning(
                "Failed to register DocsCollabAdapter", exc_info=True
            )
