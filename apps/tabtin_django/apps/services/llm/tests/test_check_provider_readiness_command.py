import json
from io import StringIO

from django.core.management import call_command
from django.test import TestCase

from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding


class CheckProviderReadinessCommandTests(TestCase):
    def test_json_reports_scene_bindings_pointing_to_disabled_provider(self):
        provider = LLMProvider.objects.create(
            name="qwen_default_test",
            provider_key="qwen_default_test",
            display_name="Qwen Default Test",
            capability_domains=["embedding"],
            routing_enabled=False,
        )
        model = LLMModel.objects.create(
            provider=provider,
            model_name="text-embedding-v4",
            display_name="Text Embedding V4",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            capability_domain="embedding",
            context_window_tokens=8192,
            capabilities_config={"embedding_dimensions": 1024},
        )
        LLMSceneBinding.objects.create(
            scene_key="rag_search_query_test",
            display_name="RAG Search Query Test",
            capability_domain="embedding",
            primary_model=model,
            capability_requirements={"embedding_dimensions": 1024},
        )

        out = StringIO()
        call_command(
            "check_provider_readiness",
            "--format=json",
            "--no-update-gauge",
            stdout=out,
        )

        payload = json.loads(out.getvalue())
        self.assertIn(
            {
                "scene_key": "rag_search_query_test",
                "capability_domain": "embedding",
                "model": "text-embedding-v4",
                "provider": "qwen_default_test",
                "reason": "routing_disabled",
            },
            payload["unready_scene_bindings"],
        )
