import logging

from django.apps import AppConfig

logger = logging.getLogger(__name__)


class TabtinspaceConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.tabtinspace'
    label = 'tabtinspace'
    verbose_name = 'Tabtin Space'

    def ready(self):
        from . import signals  # noqa: F401
        self._check_encryption_keys()

    @staticmethod
    def _check_encryption_keys():
        from django.conf import settings
        if getattr(settings, 'DEBUG', True):
            return

        enc_key = (
            getattr(settings, 'CREDENTIAL_ENCRYPTION_KEY', '')
            or getattr(settings, 'SSH_CREDENTIAL_ENCRYPTION_KEY', '')
        )
        if not enc_key:
            logger.critical(
                "CREDENTIAL_ENCRYPTION_KEY is not set! "
                "SSH credentials will use SECRET_KEY as fallback, "
                "which is unsafe for production — key rotation will cause data loss. "
                "Set CREDENTIAL_ENCRYPTION_KEY environment variable before deploying."
            )
        else:
            try:
                from cryptography.fernet import Fernet
                Fernet(enc_key.encode() if isinstance(enc_key, str) else enc_key)
            except Exception as exc:
                logger.critical(
                    "CREDENTIAL_ENCRYPTION_KEY is invalid (must be 32 url-safe base64-encoded bytes): %s",
                    exc,
                )

        if not getattr(settings, 'DAEMON_TOKEN_SECRET', ''):
            logger.critical(
                "DAEMON_TOKEN_SECRET is not set! "
                "Daemon install tokens will use SECRET_KEY as fallback, which is unsafe for production. "
                "Set this environment variable before deploying."
            )
