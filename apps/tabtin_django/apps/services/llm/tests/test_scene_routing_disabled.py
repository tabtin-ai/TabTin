from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, patch


class SceneRoutingDisabledResolverTests(TestCase):
    @staticmethod
    def _binding(*, primary_enabled: bool, fallback_models=None):
        provider = SimpleNamespace(
            scope="global",
            routing_enabled=primary_enabled,
            runtime_status="healthy",
            provider_key="qwen_default",
        )
        return SimpleNamespace(
            primary_model=SimpleNamespace(provider=provider),
            fallback_models=fallback_models or [],
        )

    @patch(
        "apps.services.llm.services._runtime.model_resolver._try_fallback_chain",
        return_value=None,
    )
    @patch(
        "apps.services.llm.services._runtime.model_resolver._check_provider_readiness",
        return_value="routing disabled",
    )
    @patch("apps.services.llm.models.LLMSceneBinding.objects.select_related")
    def test_all_configured_routes_disabled_has_distinct_exception(
        self, select_related, _check_readiness, _fallback,
    ):
        from apps.services.llm.scenes.exceptions import SceneRoutingDisabled
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        select_related.return_value.get.return_value = self._binding(
            primary_enabled=False,
        )

        with self.assertRaises(SceneRoutingDisabled):
            resolve_model(
                scene_key="rag_index_record",
                capability_domain="embedding",
            )

    @patch(
        "apps.services.llm.services._runtime.model_resolver._try_fallback_chain",
        return_value=None,
    )
    @patch(
        "apps.services.llm.services._runtime.model_resolver._check_provider_readiness",
        return_value="placeholder credential",
    )
    @patch("apps.services.llm.models.LLMSceneBinding.objects.select_related")
    def test_enabled_but_broken_provider_remains_real_failure(
        self, select_related, _check_readiness, _fallback,
    ):
        from apps.services.llm.scenes.exceptions import (
            NoProviderHealthy,
            SceneRoutingDisabled,
        )
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        select_related.return_value.get.return_value = self._binding(
            primary_enabled=True,
        )

        with self.assertRaises(NoProviderHealthy) as raised:
            resolve_model(
                scene_key="rag_index_record",
                capability_domain="embedding",
            )

        self.assertNotIsInstance(raised.exception, SceneRoutingDisabled)

    @patch(
        "apps.services.llm.services._runtime.model_resolver._try_fallback_chain",
    )
    @patch(
        "apps.services.llm.services._runtime.model_resolver._check_provider_readiness",
        return_value="routing disabled",
    )
    @patch("apps.services.llm.models.LLMSceneBinding.objects.select_related")
    def test_ready_fallback_is_still_used(
        self, select_related, _check_readiness, fallback,
    ):
        from apps.services.llm.services._runtime.model_resolver import resolve_model

        fallback_model = MagicMock()
        fallback.return_value = fallback_model
        select_related.return_value.get.return_value = self._binding(
            primary_enabled=False,
            fallback_models=[{"model_id": "fallback-id"}],
        )

        model, scope = resolve_model(
            scene_key="rag_index_record",
            capability_domain="embedding",
        )

        self.assertIs(model, fallback_model)
        self.assertEqual(scope, "global")
