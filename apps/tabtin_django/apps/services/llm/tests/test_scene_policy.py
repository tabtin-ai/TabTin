from django.test import SimpleTestCase


class ScenePolicyResolverTests(SimpleTestCase):
    def test_title_generation_resolves_platform_official_policy(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            FundingPolicy,
            ModelSource,
            ScenePayer,
            ScenePolicyResolver,
        )

        resolved = ScenePolicyResolver.resolve("title_generation")

        self.assertTrue(resolved.enabled)
        self.assertEqual(resolved.payer, ScenePayer.PLATFORM)
        self.assertEqual(resolved.allowed_model_sources, frozenset({ModelSource.OFFICIAL}))
        self.assertEqual(resolved.funding_policy, FundingPolicy.NONE)
        self.assertEqual(resolved.fallback_policy, FallbackPolicy.OFFICIAL_BINDING_ONLY)
        self.assertEqual(resolved.execution_key, "title_generation")
        self.assertEqual(resolved.policy_version, "ai_scene_policy_v1")

    def test_managed_scene_policy_snapshot_is_complete(self):
        from apps.services.llm.scenes.policy import (
            PAYER_POLICY_MANAGED_SCENE_KEYS,
            ScenePolicyRegistry,
        )

        snapshot = {
            policy.scene_key: (
                policy.enabled_default,
                policy.payer.value,
                tuple(sorted(source.value for source in policy.allowed_model_sources)),
                policy.funding_policy.value,
                policy.fallback_policy.value,
                policy.execution_key,
            )
            for policy in ScenePolicyRegistry.configured()
        }

        self.assertEqual(
            snapshot,
            {
                "_main_chat": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "_main_chat"),
                "title_generation": (True, "platform", ("official",), "none", "official_binding_only", "title_generation"),
                "commit_message_generation": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "commit_message_generation"),
                "checkpoint_intent_summary": (True, "platform", ("official",), "none", "official_binding_only", "checkpoint_summary"),
                "checkpoint_decision_summary": (True, "platform", ("official",), "none", "official_binding_only", "checkpoint_summary"),
                "tool_risk_classify": (True, "platform", ("official",), "none", "official_binding_only", "tool_risk_classify"),
                "summarization": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "summarization"),
                "task_summary": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "task_summary"),
                "user_portrait_distill": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "user_portrait_distill"),
                "memory_capture": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "memory_capture"),
                "memory_flush": (False, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "memory_flush"),
                "diary_distill": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "diary_distill"),
                "memory_compaction": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "memory_compaction"),
                "vision_parse_document": (True, "user", ("byok", "official"), "existing_user_funding", "preserve_selected_source", "vision_parse_document"),
                "media_image_generate": (True, "user", ("official",), "existing_user_funding", "official_binding_only", "media_image_generate"),
                "tts_synthesize_stream": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "tts_synthesize_stream"),
                "tts_synthesize_http": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "tts_synthesize_http"),
                "asr_realtime_stream": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "asr_realtime_stream"),
                "asr_recognize_flash": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "asr_recognize_flash"),
                "asr_transcribe_standard": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "asr_transcribe_standard"),
                "media_video_generate": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "media_video_generate"),
                "media_bgm_generate": (False, "user", ("official",), "existing_user_funding", "official_binding_only", "media_bgm_generate"),
            },
        )
        self.assertEqual(
            PAYER_POLICY_MANAGED_SCENE_KEYS | {"_main_chat"},
            frozenset(snapshot),
        )

    def test_unknown_scene_fails_closed(self):
        from apps.services.llm.scenes.policy import (
            ScenePolicyResolver,
            UnknownScenePolicyError,
        )

        with self.assertRaises(UnknownScenePolicyError):
            ScenePolicyResolver.resolve("not_registered")

    def test_main_chat_has_user_selectable_byok_policy(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            ModelSource,
            ScenePayer,
            ScenePolicyResolver,
        )

        policy = ScenePolicyResolver.resolve("_main_chat")

        self.assertEqual(policy.payer, ScenePayer.USER)
        self.assertEqual(
            policy.allowed_model_sources,
            frozenset({ModelSource.OFFICIAL, ModelSource.BYOK}),
        )
        self.assertEqual(
            policy.fallback_policy,
            FallbackPolicy.PRESERVE_SELECTED_SOURCE,
        )

    def test_model_source_mapping_is_centralized(self):
        from apps.services.llm.scenes.policy import ModelSource

        self.assertEqual(ModelSource.from_provider_scope("global"), ModelSource.OFFICIAL)
        self.assertEqual(ModelSource.from_provider_scope("organization"), ModelSource.BYOK)
        self.assertEqual(ModelSource.from_provider_scope("user"), ModelSource.BYOK)
        self.assertIsNone(ModelSource.from_provider_scope(None))
        self.assertIsNone(ModelSource.from_provider_scope("unexpected"))

    def test_invalid_policy_values_fail_during_contract_construction(self):
        from apps.services.llm.scenes.policy import (
            FallbackPolicy,
            FundingPolicy,
            ModelSource,
            ScenePayer,
            ScenePolicy,
        )

        with self.assertRaises(TypeError):
            ScenePolicy(
                scene_key="invalid",
                enabled_default=True,
                payer="platform",  # type: ignore[arg-type]
                allowed_model_sources=frozenset({ModelSource.OFFICIAL}),
                funding_policy=FundingPolicy.NONE,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="invalid",
            )

        with self.assertRaises(TypeError):
            ScenePolicy(
                scene_key="invalid",
                enabled_default=True,
                payer=ScenePayer.PLATFORM,
                allowed_model_sources=frozenset({"official"}),  # type: ignore[arg-type]
                funding_policy=FundingPolicy.NONE,
                fallback_policy=FallbackPolicy.OFFICIAL_BINDING_ONLY,
                execution_key="invalid",
            )
