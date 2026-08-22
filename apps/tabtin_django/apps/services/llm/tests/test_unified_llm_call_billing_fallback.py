from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.scenes.exceptions import BudgetExceeded


def _model(model_id: str, model_name: str):
    return SimpleNamespace(
        id=model_id,
        model_name=model_name,
        provider_id=f"provider-{model_id}",
        provider=SimpleNamespace(name=f"provider-{model_id}"),
    )


def _rendered_prompt():
    return SimpleNamespace(
        system="Name the task",
        user="用户说：帮我写上线计划",
        default_params={"max_tokens": 20, "temperature": 0.1},
        bundle=SimpleNamespace(version_hash="bundle-v1"),
    )


class UnifiedLlmCallBillingFallbackTests(SimpleTestCase):
    def test_primary_billing_block_uses_first_billable_fallback_model(self):
        from apps.services.llm.services.chat import unified_llm_call

        primary = _model("model-kimi", "kimi-k2.6")
        fallback = _model("model-doubao", "doubao-seed-evolving")
        service = SimpleNamespace(
            chat=lambda **kwargs: {
                "success": True,
                "content": "上线计划",
                "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
                "cost": {"input": "0.01", "output": "0.02", "total": "0.03"},
                "finish_reason": "stop",
            }
        )
        billing_calls: list[tuple[str, bool]] = []

        def fake_check_billing(**kwargs):
            model_id = kwargs["model_id"]
            billing_calls.append((model_id, kwargs["perform_side_effects"]))
            if model_id == "model-kimi":
                raise BudgetExceeded("primary insufficient", scene_key="memo_generation")

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context."
                "build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(primary, "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver."
                "iter_ready_fallback_models",
                return_value=[(fallback, "global")],
            ),
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=_rendered_prompt(),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing",
                side_effect=fake_check_billing,
            ),
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=service,
            ) as mock_service,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="fact-1"),
            ) as mock_record,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
            ),
            patch(
                "apps.services.llm.services._runtime.result_validator."
                "validate_chat_result",
            ),
        ):
            result = unified_llm_call(
                scene_key="memo_generation",
                variables={"messages": [{"role": "user", "content": "帮我写上线计划"}]},
                user_id="user-1",
                organization_id="org-1",
                request_id="req-1",
            )

        self.assertEqual(result.content, "上线计划")
        self.assertEqual(result.telemetry.cost_status, "platform_paid")
        mock_service.assert_called_once_with(model_id="model-doubao")
        usage = mock_record.call_args.kwargs
        self.assertEqual(usage["cost_status"], "platform_paid")
        self.assertEqual(usage["payer"], "user")
        self.assertEqual(usage["model_source"], "official")
        self.assertEqual(
            billing_calls,
            [
                ("model-kimi", True),
                ("model-doubao", True),
            ],
        )

    def test_title_generation_platform_payer_skips_user_billing_precheck(self):
        from apps.services.llm.services.chat import unified_llm_call

        primary = _model("model-kimi", "kimi-k2.6")
        service = SimpleNamespace(
            chat=lambda **kwargs: {
                "success": True,
                "content": "上线计划",
                "usage": {"prompt_tokens": 10, "completion_tokens": 3, "total_tokens": 13},
                "cost": {"input": "0.01", "output": "0.02", "total": "0.03"},
                "finish_reason": "stop",
            }
        )

        with (
            patch(
                "apps.services.llm.services._runtime.scene_call_context."
                "build_scene_call_context",
                return_value=SimpleNamespace(
                    scene_spec=SimpleNamespace(capability_requirements={})
                ),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver.resolve_model",
                return_value=(primary, "global"),
            ),
            patch(
                "apps.services.llm.services._runtime.model_resolver."
                "iter_ready_fallback_models",
            ) as mock_fallbacks,
            patch(
                "apps.services.llm.prompts.registry.PromptRegistry.render",
                return_value=_rendered_prompt(),
            ),
            patch(
                "apps.services.llm.services._runtime.billing_precheck.check_billing",
            ) as mock_check_billing,
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=service,
            ) as mock_service,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="fact-1"),
            ) as mock_record,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.mark_usage_result",
            ),
            patch(
                "apps.services.llm.services._runtime.usage_recorder.settle_usage_fact",
            ),
            patch(
                "apps.services.llm.services._runtime.result_validator."
                "validate_chat_result",
            ),
        ):
            result = unified_llm_call(
                scene_key="title_generation",
                variables={"messages": [{"role": "user", "content": "帮我写上线计划"}]},
                user_id="user-1",
                organization_id="org-1",
                request_id="req-title",
            )

        self.assertEqual(result.telemetry.cost_status, "n_a")
        mock_check_billing.assert_not_called()
        mock_fallbacks.assert_not_called()
        mock_service.assert_called_once_with(model_id="model-kimi")
        self.assertEqual(mock_record.call_args.kwargs["cost_status"], "n_a")

    def test_primary_billing_block_without_billable_fallback_keeps_blocking(self):
        from apps.services.llm.services.chat import _select_billable_model

        primary = _model("model-kimi", "kimi-k2.6")
        fallback = _model("model-doubao", "doubao-seed-evolving")

        def fake_check_billing(**kwargs):
            raise BudgetExceeded(
                f"{kwargs['model_id']} insufficient",
                scene_key="title_generation",
            )

        with patch(
            "apps.services.llm.services._runtime.billing_precheck.check_billing",
            side_effect=fake_check_billing,
        ):
            with self.assertRaises(BudgetExceeded) as ctx:
                _select_billable_model(
                    scene_key="title_generation",
                    organization_id="org-1",
                    user_id="user-1",
                    estimated_tokens=100,
                    request_id="req-1",
                    primary_model=primary,
                    primary_scope="global",
                    fallback_models=[(fallback, "global")],
                )

        self.assertIn("model-doubao", str(ctx.exception))


class ModelResolverFallbackCapabilityTests(SimpleTestCase):
    def test_byok_fallback_is_excluded_from_user_official_path(self):
        from apps.services.llm.services._runtime.model_resolver import (
            _iter_fallback_chain,
        )

        binding = SimpleNamespace(fallback_models=[{"model_id": "model-byok"}])
        fallback = _model("model-byok", "organization-byok")
        fallback.provider.scope = "organization"
        manager = MagicMock()
        manager.select_related.return_value.get.return_value = fallback

        with patch("apps.services.llm.models.LLMModel.objects", manager):
            models = list(
                _iter_fallback_chain(
                    binding,
                    scene_key="summarization",
                    capability_domain="chat",
                    capability_requirements={},
                )
            )

        self.assertEqual(models, [])

    def test_ready_fallback_is_skipped_when_capability_requirements_do_not_match(self):
        from apps.services.llm.services._runtime.model_resolver import _iter_fallback_chain

        binding = SimpleNamespace(fallback_models=[{"model_id": "model-small"}])
        fallback = _model("model-small", "small-chat")
        fallback.provider.scope = "global"
        fallback.provider.runtime_status = "healthy"
        fallback.provider.routing_enabled = True
        fallback.provider.provider_key = "test-provider"
        fallback.provider.capability_domains = ["chat"]
        fallback.provider.api_key = "sk-test"
        fallback.base_url = "https://example.test/v1"
        fallback.context_window_tokens = 100
        fallback.capabilities_config = {}

        manager = MagicMock()
        manager.select_related.return_value.get.return_value = fallback

        with patch("apps.services.llm.models.LLMModel.objects", manager):
            models = list(
                _iter_fallback_chain(
                    binding,
                    scene_key="title_generation",
                    capability_domain="chat",
                    capability_requirements={"min_context_tokens": 1000},
                )
            )

        self.assertEqual(models, [])
