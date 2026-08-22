"""提交信息生成的计费策略与模型参数回归测试。"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, TestCase


class CommitMessageSamplingTests(TestCase):
    def test_unified_call_uses_model_default_sampling(self):
        """提交信息不能强制发送受模型约束的采样参数。"""
        from apps.services.llm.scenes.types import (
            FallbackPolicy,
            ModelSource,
            ScenePayer,
        )
        from apps.services.llm.services._runtime.byok_resolver import (
            ResolvedSceneExecution,
        )
        from apps.services.llm.services._runtime.invocation import SceneInvocationContext
        from apps.services.llm.services.chat import unified_llm_call

        model = SimpleNamespace(
            id="model-commit-message",
            model_name="preprod-commit-model",
            provider_id="provider-commit-message",
            provider=SimpleNamespace(name="preprod-provider"),
        )
        service = SimpleNamespace(
            chat=MagicMock(
                return_value={
                    "success": True,
                    "content": "fix(tabcode): generate commit message",
                    "usage": {
                        "prompt_tokens": 10,
                        "completion_tokens": 5,
                        "total_tokens": 15,
                    },
                    "cost": {"input": "0", "output": "0", "total": "0"},
                    "finish_reason": "stop",
                }
            )
        )
        invocation = SceneInvocationContext.legacy(
            scene_key="commit_message_generation",
            execution_key="commit_message_generation",
            organization_id="org-1",
            user_id="user-1",
        )
        execution = ResolvedSceneExecution(
            payer=ScenePayer.USER,
            model_source=ModelSource.OFFICIAL,
            fallback_policy=FallbackPolicy.PRESERVE_SELECTED_SOURCE,
            source_locked=True,
            model=model,
            provider_scope="global",
        )

        with (
            patch(
                "apps.services.llm.services._runtime.invocation."
                "prepare_scene_invocation",
                return_value=invocation,
            ),
            patch(
                "apps.services.llm.scenes.policy.resolve_runtime_scene_payer",
                return_value=ScenePayer.USER,
            ),
            patch(
                "apps.services.llm.services._runtime.byok_resolver."
                "resolve_scene_execution",
                return_value=execution,
            ),
            patch(
                "apps.services.llm.services.chat._select_billable_model",
                return_value=(model, "global"),
            ),
            patch(
                "apps.services.llm.scenes.shadow."
                "resolve_and_record_scene_policy_shadow",
            ),
            patch(
                "apps.services.llm.services.factory.get_llm_service",
                return_value=service,
            ) as mock_get_service,
            patch(
                "apps.services.llm.services._runtime.usage_recorder.record_usage_fact",
                return_value=SimpleNamespace(id="usage-fact-1"),
            ),
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
                scene_key="commit_message_generation",
                variables={
                    "files": ["apps/foo.py"],
                    "diff_excerpt": "diff --git a/apps/foo.py",
                    "truncated": False,
                },
                user_id="user-1",
                organization_id="org-1",
                request_id="commit-message-temperature",
            )

        self.assertEqual(result.content, "fix(tabcode): generate commit message")
        mock_get_service.assert_called_once_with(model_id="model-commit-message")
        self.assertNotIn("temperature", service.chat.call_args.kwargs)
        self.assertTrue(
            service.chat.call_args.kwargs["use_model_default_sampling"]
        )


class CommitMessagePolicyTests(SimpleTestCase):
    def test_scene_requires_user_funding_and_preserves_selected_source(self):
        from apps.services.llm.scenes.policy import ScenePolicyResolver
        from apps.services.llm.scenes.types import (
            FallbackPolicy,
            FundingPolicy,
            ModelSource,
            ScenePayer,
        )

        policy = ScenePolicyResolver.resolve("commit_message_generation")

        self.assertEqual(policy.payer, ScenePayer.USER)
        self.assertEqual(
            policy.allowed_model_sources,
            frozenset({ModelSource.OFFICIAL, ModelSource.BYOK}),
        )
        self.assertEqual(policy.funding_policy, FundingPolicy.EXISTING_USER_FUNDING)
        self.assertEqual(
            policy.fallback_policy,
            FallbackPolicy.PRESERVE_SELECTED_SOURCE,
        )
