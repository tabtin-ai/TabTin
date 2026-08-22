from __future__ import annotations

import json
from unittest.mock import patch

from django.test import SimpleTestCase, TestCase, override_settings

from apps.services.llm.scenes.registry import SCENES


class CommunitySceneCatalogContractTests(SimpleTestCase):
    def test_classifies_every_registered_scene_once(self):
        from apps.maintenance.community_bootstrap import build_community_scene_catalog

        catalog = build_community_scene_catalog()
        entries = catalog["scenes"]

        self.assertEqual(len(entries), len(SCENES))
        self.assertEqual(len(SCENES), 38)
        self.assertEqual({entry["scene_key"] for entry in entries}, set(SCENES))
        self.assertEqual(
            {entry["classification"] for entry in entries},
            {"core", "optional"},
        )
        self.assertTrue(
            all(entry["can_remain_unconfigured"] is True for entry in entries)
        )
        self.assertTrue(
            all(
                entry["capability_domain"]
                in {
                    "chat",
                    "embedding",
                    "vision",
                    "asr",
                    "tts",
                    "image_gen",
                    "video_gen",
                    "audio_gen",
                }
                for entry in entries
            )
        )
        self.assertTrue(all("routing_requirement" in entry for entry in entries))
        serialized = json.dumps(catalog, sort_keys=True).lower()
        for forbidden in (
            "moonshot",
            "kimi",
            "doubao",
            "api.example.com",
            "xmov.ai",
            "aliyuncs.com",
        ):
            self.assertNotIn(forbidden, serialized)


class CommunitySceneStartupValidationTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        from apps.services.llm.models import LLMSceneBinding

        LLMSceneBinding.objects.all().delete()

    @override_settings(TABTIN_EDITION="community")
    def test_zero_binding_is_legal_without_manual_seed_hint(self):
        from apps.services.llm.scenes import registry

        with (
            patch.object(registry.logger, "warning") as warning,
            patch.object(registry.logger, "info") as info,
        ):
            registry._validate_db_bindings_at_startup()

        self.assertFalse(
            any("seed_scene_bindings" in str(call) for call in warning.call_args_list)
        )
        self.assertTrue(any("合法状态" in str(call) for call in info.call_args_list))

    @override_settings(TABTIN_EDITION="community")
    def test_partial_binding_is_legal_when_its_catalog_metadata_matches(self):
        from apps.services.llm.models import LLMSceneBinding
        from apps.services.llm.scenes import registry

        spec = SCENES["summarization"]
        LLMSceneBinding.objects.create(
            scene_key=spec.scene_key,
            display_name=spec.display_name,
            description=spec.description,
            capability_domain=spec.capability_domain,
            capability_requirements=spec.capability_requirements,
            default_params=spec.default_params,
        )

        registry._validate_db_bindings_at_startup()

    @override_settings(TABTIN_EDITION="saas")
    def test_saas_zero_binding_keeps_upstream_operator_hint(self):
        from apps.services.llm.scenes import registry

        with patch.object(registry.logger, "warning") as warning:
            registry._validate_db_bindings_at_startup()

        self.assertTrue(
            any("seed_scene_bindings" in str(call) for call in warning.call_args_list)
        )
