"""provision_dev_agent_ready：旧 LLM 密文不可解密时不应崩溃。"""

from cryptography.fernet import Fernet
from django.test import SimpleTestCase, override_settings

from apps.maintenance.management.commands.provision_dev_agent_ready import (
    Command,
)
from apps.services.llm.models import LLMProvider


class ProvisionDevAgentReadyCredentialTests(SimpleTestCase):
    def test_read_current_api_key_returns_empty_when_credential_unreadable(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        stale_encrypted = Fernet(stored_key).encrypt(b'sk-stale-moonshot').decode()
        provider = LLMProvider(
            name='moonshot',
            provider_key='moonshot',
            display_name='Moonshot / Kimi',
            capability_domains=['chat'],
            encrypted_api_key=stale_encrypted,
        )

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            current_key, unreadable = Command._read_current_api_key(provider)

        self.assertEqual(current_key, '')
        self.assertTrue(unreadable)

    def test_read_current_api_key_works_for_volcengine_provider(self):
        stored_key = Fernet.generate_key()
        runtime_key = Fernet.generate_key()
        stale_encrypted = Fernet(stored_key).encrypt(b'ark-stale-key').decode()
        provider = LLMProvider(
            name='volcengine',
            provider_key='volcengine',
            display_name='火山引擎 / 豆包',
            capability_domains=['chat'],
            encrypted_api_key=stale_encrypted,
        )

        with override_settings(CREDENTIAL_ENCRYPTION_KEY=runtime_key.decode()):
            current_key, unreadable = Command._read_current_api_key(provider)

        self.assertEqual(current_key, '')
        self.assertTrue(unreadable)
