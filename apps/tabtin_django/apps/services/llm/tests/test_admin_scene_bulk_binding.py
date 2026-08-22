from unittest.mock import patch

from django.test import TestCase
from ninja.testing import TestClient

from apps.services.llm.models import LLMModel, LLMProvider, LLMSceneBinding
from apps.services.llm.scenes.registry import get_scene_spec


class AdminSceneBulkBindingTest(TestCase):
    def setUp(self):
        self.provider = LLMProvider.objects.create(
            name="bulk-binding-test",
            provider_key="bulk-binding-test",
            display_name="Bulk Binding Test",
            capability_domains=["chat", "vision", "image_gen"],
            scope="global",
        )
        self.chat_model_before = self._create_model(
            "chat-before",
            "chat",
            context_window_tokens=16_000,
        )
        self.chat_model_after = self._create_model(
            "chat-after",
            "chat",
            context_window_tokens=16_000,
        )
        self.vision_model_before = self._create_model(
            "vision-before",
            "vision",
            context_window_tokens=32_000,
            max_output_tokens=8192,
            capabilities_config={"supports_json_mode": True},
        )
        self.vision_model_after = self._create_model(
            "vision-after",
            "vision",
            context_window_tokens=32_000,
            max_output_tokens=8192,
            capabilities_config={"supports_json_mode": True},
        )
        self.chat_binding = self._create_binding(
            "title_generation",
            self.chat_model_before,
            default_params={"temperature": 0.25},
            timeout_sec=31,
            fallback_models=[{"model_name": "chat-fallback"}],
        )
        self.vision_binding = self._create_binding(
            "vision_parse_document",
            self.vision_model_before,
            default_params={"image_detail": "high"},
            timeout_sec=121,
            fallback_models=[{"model_name": "vision-fallback"}],
        )

    def _create_model(
        self,
        model_name,
        capability_domain,
        *,
        context_window_tokens,
        max_output_tokens=None,
        capabilities_config=None,
    ):
        return LLMModel.objects.create(
            provider=self.provider,
            model_name=model_name,
            display_name=model_name,
            base_url="https://relay.example.com/v1",
            capability_domain=capability_domain,
            context_window_tokens=context_window_tokens,
            max_output_tokens=max_output_tokens,
            capabilities_config=capabilities_config or {},
            wave_status="ready",
        )

    def _create_binding(
        self,
        scene_key,
        primary_model,
        *,
        default_params,
        timeout_sec,
        fallback_models,
    ):
        spec = get_scene_spec(scene_key)
        binding, _ = LLMSceneBinding.objects.update_or_create(
            scene_key=scene_key,
            defaults={
                "display_name": spec.display_name,
                "description": spec.description,
                "capability_domain": spec.capability_domain,
                "capability_requirements": spec.capability_requirements,
                "primary_model": primary_model,
                "default_params": default_params,
                "timeout_sec": timeout_sec,
                "fallback_models": fallback_models,
            },
        )
        return binding

    def test_updates_mixed_domains_without_overwriting_other_binding_fields(self):
        from apps.services.llm.admin.scene_binding_service import (
            bulk_update_primary_models,
        )

        result = bulk_update_primary_models(
            updates=[
                {
                    "scene_key": "title_generation",
                    "primary_model_id": str(self.chat_model_after.id),
                },
                {
                    "scene_key": "vision_parse_document",
                    "primary_model_id": str(self.vision_model_after.id),
                },
            ],
            operator_id="staff-1",
            operator_username="admin",
        )

        self.chat_binding.refresh_from_db()
        self.vision_binding.refresh_from_db()
        self.assertEqual(result["updated_count"], 2)
        self.assertEqual(
            result["scene_keys"],
            ["title_generation", "vision_parse_document"],
        )
        self.assertEqual(self.chat_binding.primary_model_id, self.chat_model_after.id)
        self.assertEqual(self.chat_binding.default_params, {"temperature": 0.25})
        self.assertEqual(self.chat_binding.timeout_sec, 31)
        self.assertEqual(
            self.chat_binding.fallback_models,
            [{"model_name": "chat-fallback"}],
        )
        self.assertEqual(self.vision_binding.primary_model_id, self.vision_model_after.id)
        self.assertEqual(self.vision_binding.default_params, {"image_detail": "high"})
        self.assertEqual(self.vision_binding.timeout_sec, 121)
        self.assertEqual(
            self.vision_binding.fallback_models,
            [{"model_name": "vision-fallback"}],
        )

    def test_rejects_the_whole_batch_when_one_model_domain_is_incompatible(self):
        from apps.services.llm.admin.scene_binding_service import (
            BulkSceneBindingError,
            bulk_update_primary_models,
        )

        with self.assertRaises(BulkSceneBindingError) as raised:
            bulk_update_primary_models(
                updates=[
                    {
                        "scene_key": "title_generation",
                        "primary_model_id": str(self.chat_model_after.id),
                    },
                    {
                        "scene_key": "vision_parse_document",
                        "primary_model_id": str(self.chat_model_after.id),
                    },
                ],
                operator_id="staff-1",
                operator_username="admin",
            )

        self.chat_binding.refresh_from_db()
        self.vision_binding.refresh_from_db()
        self.assertEqual(raised.exception.code, "MODEL_CAPABILITY_MISMATCH")
        self.assertEqual(self.chat_binding.primary_model_id, self.chat_model_before.id)
        self.assertEqual(self.vision_binding.primary_model_id, self.vision_model_before.id)

    def test_rejects_duplicate_scene_keys(self):
        from apps.services.llm.admin.scene_binding_service import (
            BulkSceneBindingError,
            bulk_update_primary_models,
        )

        duplicate_update = {
            "scene_key": "title_generation",
            "primary_model_id": str(self.chat_model_after.id),
        }
        with self.assertRaises(BulkSceneBindingError) as raised:
            bulk_update_primary_models(
                updates=[duplicate_update, duplicate_update],
                operator_id="staff-1",
                operator_username="admin",
            )

        self.assertEqual(raised.exception.code, "DUPLICATE_SCENE")

    def test_rejects_malformed_model_id_with_a_stable_error(self):
        from apps.services.llm.admin.scene_binding_service import (
            BulkSceneBindingError,
            bulk_update_primary_models,
        )

        with self.assertRaises(BulkSceneBindingError) as raised:
            bulk_update_primary_models(
                updates=[
                    {
                        "scene_key": "title_generation",
                        "primary_model_id": "not-a-uuid",
                    }
                ],
                operator_id="staff-1",
                operator_username="admin",
            )

        self.assertEqual(raised.exception.code, "INVALID_MODEL_ID")

    def test_candidates_exclude_models_incompatible_with_a_selected_scene(self):
        from apps.services.llm.admin.scene_binding_service import (
            list_compatible_models_by_domain,
        )

        compatible_model = self._create_model(
            "image-compatible",
            "image_gen",
            context_window_tokens=0,
            capabilities_config={
                "media_gen": {
                    "supports_seed": True,
                    "supported_sizes": ["1024*1024", "1280*720", "720*1280"],
                    "max_n_per_request": 4,
                    "max_prompt_chars": 1500,
                }
            },
        )
        incompatible_model = self._create_model(
            "image-incompatible",
            "image_gen",
            context_window_tokens=0,
            capabilities_config={
                "media_gen": {
                    "supports_seed": True,
                    "supported_sizes": ["1024*1024"],
                    "max_n_per_request": 4,
                    "max_prompt_chars": 1500,
                }
            },
        )

        result = list_compatible_models_by_domain(
            scene_keys=["media_image_generate"],
        )

        self.assertEqual(len(result["groups"]), 1)
        group = result["groups"][0]
        self.assertEqual(group["capability_domain"], "image_gen")
        self.assertEqual(group["scene_keys"], ["media_image_generate"])
        candidate_ids = {candidate["id"] for candidate in group["models"]}
        self.assertIn(str(compatible_model.id), candidate_ids)
        self.assertNotIn(str(incompatible_model.id), candidate_ids)

    @patch("apps.users.auth.permissions.StaffAuth.authenticate")
    def test_candidates_endpoint_returns_models_compatible_with_all_selected_scenes(
        self,
        authenticate,
    ):
        authenticate.return_value.id = "staff-1"
        authenticate.return_value.username = "admin"

        from apps.services.llm.admin.scenes_router import router

        response = TestClient(router).post(
            "/admin/scenes/bindings/bulk/candidates",
            json={"scene_keys": ["title_generation"]},
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["groups"][0]["capability_domain"], "chat")
        candidate_ids = {
            candidate["id"] for candidate in body["data"]["groups"][0]["models"]
        }
        self.assertIn(str(self.chat_model_after.id), candidate_ids)

    @patch("apps.users.auth.permissions.StaffAuth.authenticate")
    def test_bulk_endpoint_returns_a_readable_capability_error(self, authenticate):
        authenticate.return_value.id = "staff-1"
        authenticate.return_value.username = "admin"

        from apps.services.llm.admin.scenes_router import router

        response = TestClient(router).patch(
            "/admin/scenes/bindings/bulk",
            json={
                "bindings": [
                    {
                        "scene_key": "vision_parse_document",
                        "primary_model_id": str(self.chat_model_after.id),
                    }
                ]
            },
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 422)
        detail = response.json()["detail"]
        self.assertIsInstance(detail, str)
        self.assertIn("MODEL_CAPABILITY_MISMATCH", detail)
        self.assertIn("vision_parse_document", detail)

    @patch("apps.users.auth.permissions.StaffAuth.authenticate")
    def test_bulk_endpoint_keeps_the_existing_success_envelope(self, authenticate):
        authenticate.return_value.id = "staff-1"
        authenticate.return_value.username = "admin"

        from apps.services.llm.admin.scenes_router import router

        response = TestClient(router).patch(
            "/admin/scenes/bindings/bulk",
            json={
                "bindings": [
                    {
                        "scene_key": "title_generation",
                        "primary_model_id": str(self.chat_model_after.id),
                    },
                    {
                        "scene_key": "vision_parse_document",
                        "primary_model_id": str(self.vision_model_after.id),
                    },
                ]
            },
            headers={"Authorization": "Bearer test-token"},
        )

        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertTrue(body["success"])
        self.assertEqual(body["code"], "SUCCESS")
        self.assertEqual(
            body["data"],
            {
                "updated_count": 2,
                "scene_keys": ["title_generation", "vision_parse_document"],
            },
        )
