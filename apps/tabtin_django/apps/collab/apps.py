import logging
import threading

from django.apps import AppConfig

from apps.services.startup_jobs import should_skip_startup_background_jobs

logger = logging.getLogger("collab.apps")


class CollabConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.collab"
    label = "collab"
    verbose_name = "Collab"

    def ready(self):
        if should_skip_startup_background_jobs():
            logger.debug("Collab adapter completeness check skipped for management command")
            return

        timer = threading.Timer(5.0, self._check_adapter_completeness)
        timer.daemon = True
        timer.start()

    @staticmethod
    def _check_adapter_completeness():
        try:
            from django.core.cache import cache
            if not cache.add("startup:collab_adapter_check", "1", timeout=60):
                return
        except Exception:
            pass

        from .constants import ADAPTER_RESOURCE_TYPES
        from .registry import list_registered_types

        registered = set(list_registered_types())
        expected = set(ADAPTER_RESOURCE_TYPES)
        missing = expected - registered

        if missing:
            logger.error(
                "CC-018: Collab adapter registration incomplete! "
                "Missing adapters for: %s. "
                "Registered: %s. "
                "These modules will have NO version history or collaboration support.",
                sorted(missing), sorted(registered),
            )
        else:
            logger.info(
                "Collab adapter registration complete: %s",
                sorted(registered),
            )
