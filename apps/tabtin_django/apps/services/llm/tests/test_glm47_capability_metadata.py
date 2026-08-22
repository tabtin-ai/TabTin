from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.providers.model_metadata import (
    merge_authoritative_model_capabilities,
)
from apps.services.llm.registry import ProviderRegistry
from apps.services.llm.scenes.capability_check import check_model_capability_match
from apps.services.llm.scenes.registry import SCENES
from apps.services.llm.utils.capabilities import resolve_model_capabilities


def _glm47_model(*, capabilities_config):
    provider = SimpleNamespace(
        name="zhipu",
        scope="global",
        capability_domains=["chat"],
    )
    return SimpleNamespace(
        provider=provider,
        capability_domain="chat",
        context_window_tokens=200_000,
        max_output_tokens=65_536,
        max_output_tokens_resolved=65_536,
        capabilities_config=capabilities_config,
    )


class Glm47CapabilityMetadataTests(SimpleTestCase):
    def test_authoritative_declaration_contains_json_object_support(self):
        declaration = next(
            model
            for model in ProviderRegistry.get("zhipu").static_models
            if model.model_name == "glm-4.7"
        )

        self.assertTrue(declaration.supports_json_mode)
        self.assertEqual(declaration.json_modes, ("json_object",))

    def test_declared_catalog_projects_authoritative_json_capability(self):
        from apps.services.llm.services.factory import _merge_provider_declared_models

        models = []
        _merge_provider_declared_models(models)
        glm47 = next(
            item
            for item in models
            if item["id"] == "declared:zhipu:glm-4.7"
        )

        self.assertTrue(glm47["supports_json_mode"])
        self.assertTrue(glm47["resolved_capabilities"]["supports_json_mode"])
        self.assertTrue(glm47["capabilities_config"]["supports_json_mode"])
        self.assertEqual(
            glm47["capabilities_config"]["json_mode"]["modes"],
            ["json_object"],
        )

    def test_authoritative_merge_is_exact_and_preserves_existing_config(self):
        original = {
            "wire": {"stream_supported": True},
            "custom_provider_setting": {"keep": True},
        }

        merged = merge_authoritative_model_capabilities(
            provider_name="zhipu",
            provider_scope="global",
            model_name="glm-4.7",
            capabilities_config=original,
        )

        self.assertTrue(merged["supports_json_mode"])
        self.assertEqual(merged["json_mode"]["modes"], ["json_object"])
        self.assertEqual(merged["custom_provider_setting"], {"keep": True})
        self.assertEqual(original.get("supports_json_mode"), None)

        for provider_scope, provider_name, model_name in (
            ("user", "zhipu", "glm-4.7"),
            ("organization", "zhipu", "glm-4.7"),
            ("global", "openai", "glm-4.7"),
            ("global", "zhipu", "other-model"),
        ):
            with self.subTest(
                provider_scope=provider_scope,
                provider_name=provider_name,
                model_name=model_name,
            ):
                self.assertEqual(
                    merge_authoritative_model_capabilities(
                        provider_name=provider_name,
                        provider_scope=provider_scope,
                        model_name=model_name,
                        capabilities_config=original,
                    ),
                    original,
                )

    def test_glm47_resolves_json_and_passes_every_memory_scene(self):
        capabilities_config = merge_authoritative_model_capabilities(
            provider_name="zhipu",
            provider_scope="global",
            model_name="glm-4.7",
            capabilities_config={
                "wire": {"stream_supported": True},
                "tool": {"enabled": True},
                "image": {"enabled": False},
            },
        )
        model = _glm47_model(capabilities_config=capabilities_config)

        self.assertTrue(resolve_model_capabilities(model)["supports_json_mode"])
        for scene_key in (
            "task_summary",
            "memory_capture",
            "diary_distill",
            "user_portrait_distill",
            "memory_compaction",
        ):
            with self.subTest(scene_key=scene_key):
                scene = SCENES[scene_key]
                self.assertIsNone(
                    check_model_capability_match(
                        model=model,
                        capability_domain=scene.capability_domain,
                        requirements=scene.capability_requirements,
                    )
                )

    def test_missing_json_metadata_is_rejected_by_memory_capture(self):
        model = _glm47_model(
            capabilities_config={
                "wire": {"stream_supported": True},
                "tool": {"enabled": True},
                "image": {"enabled": False},
            }
        )
        scene = SCENES["memory_capture"]

        self.assertEqual(
            check_model_capability_match(
                model=model,
                capability_domain=scene.capability_domain,
                requirements=scene.capability_requirements,
            ),
            "model 不支持 JSON Mode",
        )

    def test_runtime_guard_still_rejects_missing_json_metadata(self):
        from apps.services.llm.scenes.exceptions import (
            BYOKCapabilityMismatch,
            CapabilityMismatch,
        )
        from apps.services.llm.services._runtime.byok_resolver import (
            _validate_capability,
        )

        model = _glm47_model(
            capabilities_config={
                "wire": {"stream_supported": True},
                "tool": {"enabled": True},
                "image": {"enabled": False},
            }
        )
        requirements = SCENES["memory_capture"].capability_requirements

        with self.assertRaises(BYOKCapabilityMismatch):
            _validate_capability(
                model=model,
                capability_domain="chat",
                requirements=requirements,
                scene_key="memory_capture",
            )
        with self.assertRaises(CapabilityMismatch):
            _validate_capability(
                model=model,
                capability_domain="chat",
                requirements=requirements,
                scene_key="memory_capture",
                official=True,
            )
