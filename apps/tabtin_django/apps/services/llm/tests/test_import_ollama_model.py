from contextlib import nullcontext
from io import StringIO
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx
from django.core.management.base import CommandError
from django.test import SimpleTestCase

from apps.services.llm.management.commands import import_ollama_model as module


class ImportOllamaModelTests(SimpleTestCase):
    def setUp(self):
        self.organization = SimpleNamespace(
            id="org", owner_id="owner", owner=SimpleNamespace(id="owner"), type="team",
        )
        self.provider = SimpleNamespace(
            id="provider", name="openai", default_base_url="http://localhost:11434/v1",
            routing_enabled=True,
        )
        self.model = SimpleNamespace(id="model", model_name="qwen3:8b", base_url=self.provider.default_base_url)
        self.options = dict(organization_id="org", model="qwen3:8b", base_url=self.provider.default_base_url,
                            provider_key="openai-ollama-local", context_window=4096,
                            max_output_tokens=2048, set_default=False, dry_run=False)
        self.command = module.Command(stdout=StringIO())
        self.metadata = {"capabilities": ["completion", "tools", "thinking"],
                         "model_info": {"qwen3.context_length": 40960}}
        self.client = MagicMock()
        self.client.__enter__.return_value.post.return_value.json.return_value = self.metadata
        replacements = {
            "Organization": MagicMock(), "LLMProvider": MagicMock(), "LLMModel": MagicMock(),
            "ensure_organization_permission_for_user": MagicMock(),
            "create_organization_provider": MagicMock(return_value={"success": True, "data": {"provider_id": "provider"}}),
            "create_organization_model": MagicMock(return_value={"success": True, "data": {"model_id": "model"}}),
            "set_organization_default_model": MagicMock(return_value={"success": True, "data": {}}),
        }
        self.mocks = replacements
        for name, value in replacements.items():
            p = patch.object(module, name, value)
            p.start()
            self.addCleanup(p.stop)
        for p in (patch.object(module.httpx, "Client", return_value=self.client),
                  patch.object(module.transaction, "atomic", side_effect=lambda **kw: nullcontext())):
            p.start()
            self.addCleanup(p.stop)
        replacements["Organization"].objects.select_related.return_value.get.return_value = self.organization
        replacements["LLMProvider"].objects.filter.return_value.first.return_value = self.provider
        replacements["LLMProvider"].objects.get.return_value = self.provider
        replacements["LLMModel"].objects.filter.return_value.first.return_value = self.model
        replacements["LLMModel"].objects.get.return_value = self.model

    def test_repeated_import_preserves_model_and_default(self):
        self.command.handle(**self.options)
        self.mocks["create_organization_provider"].assert_not_called()
        self.mocks["create_organization_model"].assert_not_called()
        self.mocks["set_organization_default_model"].assert_not_called()

    def test_personal_import_uses_user_scope_and_explicit_capabilities(self):
        self.organization.type = "personal"
        self.mocks["LLMProvider"].objects.filter.return_value.first.return_value = None
        self.mocks["LLMModel"].objects.filter.return_value.first.return_value = None
        self.command.handle(**self.options)
        provider_payload = self.mocks["create_organization_provider"].call_args.args[2]
        self.assertEqual(provider_payload.scope, "user")
        model_payload = self.mocks["create_organization_model"].call_args.args[2]
        self.assertTrue(model_payload.capabilities_config["supports_function_calling"])
        self.assertFalse(model_payload.capabilities_config["supports_vision"])
        self.assertEqual(model_payload.context_window_tokens, 4096)

    def test_team_import_uses_organization_scope(self):
        self.mocks["LLMProvider"].objects.filter.return_value.first.return_value = None
        self.command.handle(**self.options)
        self.assertEqual(self.mocks["create_organization_provider"].call_args.args[2].scope, "organization")

    def test_metadata_failure_writes_nothing(self):
        self.client.__enter__.return_value.post.side_effect = httpx.ConnectError("offline")
        with self.assertRaisesMessage(CommandError, "Cannot inspect"):
            self.command.handle(**self.options)
        self.mocks["LLMProvider"].objects.filter.assert_not_called()

    def test_dry_run_writes_nothing(self):
        self.command.handle(**{**self.options, "dry_run": True, "set_default": True})
        self.mocks["LLMProvider"].objects.filter.assert_not_called()
        self.mocks["set_organization_default_model"].assert_not_called()

    def test_existing_connection_is_not_overwritten(self):
        self.provider.default_base_url = "https://example.org/v1"
        with self.assertRaisesMessage(CommandError, "Existing provider differs"):
            self.command.handle(**self.options)
        self.mocks["create_organization_model"].assert_not_called()

    def test_context_cannot_exceed_model_capacity(self):
        with self.assertRaisesMessage(CommandError, "exceeds"):
            self.command.handle(**{**self.options, "context_window": 50000})
        self.mocks["LLMProvider"].objects.filter.assert_not_called()

    def test_embedding_only_model_is_rejected(self):
        with self.assertRaisesMessage(CommandError, "completion"):
            module.model_capabilities({"capabilities": ["embedding"]})

    def test_plain_chat_does_not_inherit_openai_tools_or_vision(self):
        caps = module.model_capabilities({"capabilities": ["completion"]})
        self.assertFalse(caps["supports_function_calling"])
        self.assertFalse(caps["supports_vision"])

    def test_api_errors_are_not_treated_as_success(self):
        with self.assertRaisesMessage(CommandError, "permission denied"):
            module.response_data({"success": False, "message": "permission denied"})
