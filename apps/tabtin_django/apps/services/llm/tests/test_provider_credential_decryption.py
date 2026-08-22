from types import SimpleNamespace
from unittest.mock import patch

from cryptography.fernet import Fernet
from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from apps.services.llm.api_admin_providers import _serialize_admin_key
from apps.services.llm.api_admin_utils import _serialize_provider
from apps.services.llm.models import (
    LLMCredentialDecryptionError,
    LLMProvider,
    LLMProviderKey,
)
from apps.services.llm.services.proxy_service import ProxyError, build_upstream_config


class LLMProviderCredentialDecryptionTests(SimpleTestCase):
    def test_provider_api_key_fails_fast_when_fernet_token_uses_wrong_key(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        encrypted = Fernet(stored_key).encrypt(b"sk-live-moonshot").decode()
        provider = LLMProvider(
            name="moonshot",
            provider_key="moonshot",
            display_name="Moonshot / Kimi",
            capability_domains=["chat"],
            encrypted_api_key=encrypted,
        )

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            with self.assertRaises(LLMCredentialDecryptionError):
                _ = provider.api_key

    def test_provider_key_api_key_fails_fast_when_fernet_token_uses_wrong_key(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        encrypted = Fernet(stored_key).encrypt(b"sk-live-moonshot").decode()
        key = LLMProviderKey(
            label="primary",
            encrypted_api_key=encrypted,
        )

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            with self.assertRaises(LLMCredentialDecryptionError):
                _ = key.api_key

    def test_plaintext_legacy_api_key_is_still_readable(self):
        provider = LLMProvider(
            name="moonshot",
            provider_key="moonshot",
            display_name="Moonshot / Kimi",
            capability_domains=["chat"],
            encrypted_api_key="sk-legacy-plaintext",
        )

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=Fernet.generate_key().decode()):
            self.assertEqual(provider.api_key, "sk-legacy-plaintext")

    def test_proxy_config_reports_credential_decryption_failure_before_upstream_call(self):
        model = SimpleNamespace(id="810581c1-98e0-4c1b-810a-e4e7efdac5e7")

        with patch(
            "apps.services.llm.litellm_config.build_litellm_config",
            side_effect=LLMCredentialDecryptionError("cannot decrypt"),
        ):
            with self.assertRaises(ProxyError) as ctx:
                build_upstream_config(model)

        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual(ctx.exception.error_code, "credential_decryption_failed")

    def test_admin_provider_serializer_does_not_crash_on_unreadable_key(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        encrypted = Fernet(stored_key).encrypt(b"sk-live-moonshot").decode()
        provider = LLMProvider(
            name="moonshot",
            provider_key="moonshot",
            display_name="Moonshot / Kimi",
            capability_domains=["chat"],
            encrypted_api_key=encrypted,
        )
        provider.id = "9550bd1b-c420-4265-8dd0-6ab775370e57"
        provider.model_count = 0
        provider.created_at = timezone.now()
        provider.updated_at = timezone.now()

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            data = _serialize_provider(provider)

        self.assertEqual(data["api_key_status"], "credential_decryption_failed")
        self.assertEqual(data["api_key_masked"], "无法解密，请重新录入")

    def test_admin_provider_key_serializer_does_not_crash_on_unreadable_key(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        encrypted = Fernet(stored_key).encrypt(b"sk-live-moonshot").decode()
        key = LLMProviderKey(
            label="primary",
            encrypted_api_key=encrypted,
        )
        key.id = "11111111-1111-1111-1111-111111111111"
        key.provider_id = "9550bd1b-c420-4265-8dd0-6ab775370e57"
        key.created_at = timezone.now()

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            data = _serialize_admin_key(key)

        self.assertEqual(data["api_key_status"], "credential_decryption_failed")
        self.assertEqual(data["api_key_preview"], "无法解密，请重新录入")
