from django.test import TestCase

from apps.services.llm.api_admin_providers import _delete_provider_models
from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding


class AdminProviderDeleteTest(TestCase):
    def test_force_delete_removes_unreferenced_models_before_provider(self):
        provider = LLMProvider.objects.create(
            name="qwen",
            provider_key="qwen-delete-test",
            display_name="Qwen Delete Test",
            capability_domains=["chat"],
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="qwen-delete-test",
            display_name="Qwen Delete Test",
            base_url="https://relay.example.com/v1",
            capability_domain="chat",
            context_window_tokens=8192,
        )

        result = _delete_provider_models(provider=provider, model_ids=[model.id])

        self.assertEqual(result["deleted_models"], 1)
        self.assertFalse(LLMModel.objects.filter(id=model.id).exists())
        self.assertTrue(LLMProvider.objects.filter(id=provider.id).exists())

    def test_force_delete_keeps_models_that_are_still_used_by_scenes(self):
        provider = LLMProvider.objects.create(
            name="qwen",
            provider_key="qwen-in-use-test",
            display_name="Qwen In Use Test",
            capability_domains=["chat"],
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="qwen-in-use-test",
            display_name="Qwen In Use Test",
            base_url="https://relay.example.com/v1",
            capability_domain="chat",
            context_window_tokens=8192,
        )
        LLMSceneBinding.objects.create(
            scene_key="provider_delete_test",
            display_name="Provider Delete Test",
            capability_domain="chat",
            primary_model=model,
        )

        result = _delete_provider_models(provider=provider, model_ids=[model.id])

        self.assertEqual(result["deleted_models"], 0)
        self.assertEqual(result["referencing_bindings"][0]["scene_key"], "provider_delete_test")
        self.assertTrue(LLMModel.objects.filter(id=model.id).exists())
