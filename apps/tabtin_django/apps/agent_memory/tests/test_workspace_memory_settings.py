from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.core.exceptions import ValidationError
from django.test import SimpleTestCase

from apps.agent_memory.models import WorkspaceMemorySettings
from apps.agent_memory.workspace_settings import (
    WorkspaceMemoryOwner,
    WorkspaceMemorySettingsAccessPolicy,
    WorkspaceMemorySettingsError,
    get_workspace_memory_model_incompatible_scenes,
    is_server_async_executable,
    validate_workspace_memory_scene_model,
    validate_workspace_memory_model,
)


def _provider(
    *,
    scope: str,
    user_id: str = "",
    organization_id: str = "",
    provider_key: str = "openai",
    encrypted_api_key: str = "gAAAA-server-readable",
):
    return SimpleNamespace(
        scope=scope,
        user_id=user_id or None,
        organization_id=organization_id or None,
        name="openai",
        provider_key=provider_key,
        capability_domains=["chat"],
        routing_enabled=True,
        runtime_status="healthy",
        encrypted_api_key=encrypted_api_key,
        keys=[],
    )


def _model(*, provider, name: str = "Kimi", model_id: str | None = None):
    exact_model_id = model_id or str(uuid.uuid4())
    return SimpleNamespace(
        id=exact_model_id,
        pk=exact_model_id,
        provider=provider,
        display_name=name,
        model_name=name,
        capability_domain="chat",
        wave_status="ready",
        base_url="https://example.com/v1",
        context_window_tokens=200_000,
        max_output_tokens=65_536,
        max_output_tokens_resolved=65_536,
        capabilities_config={
            "wire": {"stream_supported": True},
            "tool": {"enabled": True},
            "image": {"enabled": False},
            "json_mode": {"modes": ["json_object"]},
            "supports_streaming": True,
            "supports_function_calling": True,
            "supports_vision": False,
            "supports_json_mode": True,
        },
    )


class WorkspaceMemorySettingsModelContractTests(SimpleTestCase):
    def test_scope_and_mode_constraints_are_declared(self):
        names = {
            constraint.name
            for constraint in WorkspaceMemorySettings._meta.constraints
        }
        self.assertIn("wm_settings_owner_scope_xor", names)
        self.assertIn("wm_settings_model_mode_shape", names)
        self.assertIn("wm_settings_personal_user_uniq", names)
        self.assertIn("wm_settings_organization_uniq", names)

    def test_new_settings_default_off_with_official_default_mode(self):
        self.assertFalse(
            WorkspaceMemorySettings._meta.get_field(
                "auto_memory_enabled"
            ).get_default()
        )
        self.assertEqual(
            WorkspaceMemorySettings._meta.get_field("memory_model_mode").get_default(),
            WorkspaceMemorySettings.ModelMode.OFFICIAL_DEFAULT,
        )

    def test_personal_scope_rejects_organization_or_missing_user(self):
        settings = WorkspaceMemorySettings(
            scope=WorkspaceMemorySettings.Scope.PERSONAL,
            user_id=None,
            organization_id=uuid.uuid4(),
        )
        with self.assertRaises(ValidationError):
            settings.clean()

    def test_explicit_mode_requires_exact_model_fk(self):
        settings = WorkspaceMemorySettings(
            scope=WorkspaceMemorySettings.Scope.PERSONAL,
            user_id=uuid.uuid4(),
            memory_model_mode=WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL,
            memory_model_id=None,
        )
        with self.assertRaises(ValidationError):
            settings.clean()


class WorkspaceMemoryModelEligibilityTests(SimpleTestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.other_user_id = str(uuid.uuid4())
        self.org_a_id = str(uuid.uuid4())
        self.org_b_id = str(uuid.uuid4())
        self.personal = WorkspaceMemoryOwner.personal(self.user_id)
        self.org_a = WorkspaceMemoryOwner.organization(self.org_a_id)

    def test_personal_allows_global_and_same_user_byok(self):
        validate_workspace_memory_model(
            self.personal,
            _model(provider=_provider(scope="global", encrypted_api_key="")),
        )
        validate_workspace_memory_model(
            self.personal,
            _model(provider=_provider(scope="user", user_id=self.user_id)),
        )

    def test_personal_blocks_other_user_and_any_organization_byok(self):
        for provider in (
            _provider(scope="user", user_id=self.other_user_id),
            _provider(scope="organization", organization_id=self.org_a_id),
        ):
            with self.assertRaises(WorkspaceMemorySettingsError):
                validate_workspace_memory_model(
                    self.personal,
                    _model(provider=provider),
                )

    def test_organization_allows_global_and_same_organization_byok(self):
        validate_workspace_memory_model(
            self.org_a,
            _model(provider=_provider(scope="global", encrypted_api_key="")),
        )
        validate_workspace_memory_model(
            self.org_a,
            _model(
                provider=_provider(
                    scope="organization",
                    organization_id=self.org_a_id,
                )
            ),
        )

    def test_organization_blocks_user_and_other_organization_byok(self):
        for provider in (
            _provider(scope="user", user_id=self.user_id),
            _provider(scope="organization", organization_id=self.org_b_id),
        ):
            with self.assertRaises(WorkspaceMemorySettingsError):
                validate_workspace_memory_model(
                    self.org_a,
                    _model(provider=provider),
                )

    def test_same_name_models_are_isolated_by_exact_model_and_owner(self):
        official = _model(provider=_provider(scope="global"), name="Kimi")
        personal = _model(
            provider=_provider(scope="user", user_id=self.user_id),
            name="Kimi",
        )
        org_a = _model(
            provider=_provider(scope="organization", organization_id=self.org_a_id),
            name="Kimi",
        )
        org_b = _model(
            provider=_provider(scope="organization", organization_id=self.org_b_id),
            name="Kimi",
        )

        validate_workspace_memory_model(self.personal, official)
        validate_workspace_memory_model(self.personal, personal)
        validate_workspace_memory_model(self.org_a, org_a)
        with self.assertRaises(WorkspaceMemorySettingsError):
            validate_workspace_memory_model(self.org_a, org_b)

    def test_codex_local_catalog_model_is_not_server_async_executable(self):
        local_codex = SimpleNamespace(
            id="gpt-5.6-sol",
            pk=None,
            provider=SimpleNamespace(
                scope="user",
                user_id=self.user_id,
                name="codex",
                provider_key="openai-codex",
                capability_domains=["chat"],
                routing_enabled=True,
                runtime_status="healthy",
                encrypted_api_key="",
                keys=[],
            ),
            capability_domain="chat",
            wave_status="ready",
            capabilities_config={"credential_location": "device"},
        )
        self.assertFalse(is_server_async_executable(local_codex))
        with self.assertRaises(WorkspaceMemorySettingsError) as caught:
            validate_workspace_memory_model(self.personal, local_codex)
        self.assertEqual(caught.exception.code, "BACKGROUND_MODEL_NOT_SERVER_EXECUTABLE")

    def test_persisted_device_credential_model_is_still_not_server_executable(self):
        local_model = _model(provider=_provider(scope="global"))
        local_model.capabilities_config = {
            "execution_location": "device",
            "credential_location": "device",
        }
        self.assertFalse(is_server_async_executable(local_model))

    def test_glm47_satisfies_all_active_workspace_memory_scenes(self):
        glm47 = _model(
            provider=_provider(scope="global", encrypted_api_key=""),
            name="glm-4.7",
        )

        self.assertEqual(
            get_workspace_memory_model_incompatible_scenes(glm47),
            {},
        )
        validate_workspace_memory_model(self.personal, glm47)

    def test_missing_json_metadata_rejects_all_json_memory_scenes(self):
        model = _model(provider=_provider(scope="global", encrypted_api_key=""))
        model.capabilities_config["supports_json_mode"] = False
        model.capabilities_config["json_mode"] = {"modes": []}

        with self.assertRaises(WorkspaceMemorySettingsError) as caught:
            validate_workspace_memory_model(self.personal, model)

        self.assertEqual(caught.exception.code, "MEMORY_MODEL_CAPABILITY_MISMATCH")
        self.assertEqual(
            caught.exception.incompatible_scenes,
            (
                "task_summary",
                "memory_capture",
                "diary_distill",
                "memory_compaction",
            ),
        )

    def test_per_scene_validation_does_not_require_one_official_model_for_all_scenes(self):
        memory_capture_model = _model(
            provider=_provider(scope="global", encrypted_api_key="")
        )
        memory_capture_model.context_window_tokens = 32_000

        validate_workspace_memory_scene_model(
            self.personal,
            memory_capture_model,
            "memory_capture",
        )
        with self.assertRaises(WorkspaceMemorySettingsError) as caught:
            validate_workspace_memory_model(self.personal, memory_capture_model)
        self.assertEqual(caught.exception.incompatible_scenes, ("user_portrait_distill",))


class WorkspaceMemorySettingsPermissionTests(SimpleTestCase):
    def test_personal_is_readable_and_writable_only_by_same_user(self):
        user_id = str(uuid.uuid4())
        other_id = str(uuid.uuid4())
        self.assertTrue(
            WorkspaceMemorySettingsAccessPolicy.can_read_personal(user_id, user_id)
        )
        self.assertTrue(
            WorkspaceMemorySettingsAccessPolicy.can_update_personal(user_id, user_id)
        )
        self.assertFalse(
            WorkspaceMemorySettingsAccessPolicy.can_read_personal(other_id, user_id)
        )
        self.assertFalse(
            WorkspaceMemorySettingsAccessPolicy.can_update_personal(other_id, user_id)
        )

    def test_organization_owner_can_update_but_admin_and_member_are_read_only(self):
        owner_id = str(uuid.uuid4())
        member_id = str(uuid.uuid4())
        self.assertTrue(
            WorkspaceMemorySettingsAccessPolicy.can_update_organization(
                actor_user_id=owner_id,
                organization_owner_id=owner_id,
                member_role="owner",
            )
        )
        for role in ("admin", "editor", "viewer"):
            self.assertFalse(
                WorkspaceMemorySettingsAccessPolicy.can_update_organization(
                    actor_user_id=member_id,
                    organization_owner_id=owner_id,
                    member_role=role,
                )
            )
            self.assertTrue(
                WorkspaceMemorySettingsAccessPolicy.can_read_organization(
                    actor_user_id=member_id,
                    organization_owner_id=owner_id,
                    member_role=role,
                )
            )


class WorkspaceMemorySettingsClientContractTests(SimpleTestCase):
    def setUp(self):
        self.user_id = str(uuid.uuid4())
        self.org_id = str(uuid.uuid4())

    def test_candidate_projection_contains_no_credentials(self):
        from apps.agent_memory.workspace_settings import serialize_memory_model

        model = _model(
            provider=_provider(scope="user", user_id=self.user_id),
            name="My Kimi",
        )
        model.provider.display_name = "My OpenAI"

        self.assertEqual(
            serialize_memory_model(model),
            {
                "id": str(model.id),
                "display_name": "My Kimi",
                "provider_scope": "user",
                "provider_display_name": "My OpenAI",
            },
        )

    @patch("apps.agent_memory.workspace_settings.LLMModel")
    def test_personal_candidates_keep_only_official_and_same_user_byok(
        self,
        llm_model,
    ):
        from apps.agent_memory.workspace_settings import list_workspace_memory_models

        models = [
            _model(provider=_provider(scope="global", encrypted_api_key="")),
            _model(provider=_provider(scope="user", user_id=self.user_id)),
            _model(provider=_provider(scope="user", user_id=str(uuid.uuid4()))),
            _model(provider=_provider(scope="organization", organization_id=self.org_id)),
        ]
        local = _model(provider=_provider(scope="user", user_id=self.user_id))
        local.capabilities_config = {"credential_location": "device"}
        models.append(local)
        llm_model.objects.select_related.return_value.filter.return_value = models

        candidates = list_workspace_memory_models(
            WorkspaceMemoryOwner.personal(self.user_id)
        )

        self.assertEqual(candidates, models[:2])

    @patch("apps.agent_memory.workspace_settings.LLMModel")
    def test_candidates_exclude_model_missing_memory_scene_capability(self, llm_model):
        from apps.agent_memory.workspace_settings import list_workspace_memory_models

        valid = _model(provider=_provider(scope="global", encrypted_api_key=""))
        missing_json = _model(provider=_provider(scope="global", encrypted_api_key=""))
        missing_json.capabilities_config["supports_json_mode"] = False
        missing_json.capabilities_config["json_mode"] = {"modes": []}
        llm_model.objects.select_related.return_value.filter.return_value = [
            valid,
            missing_json,
        ]

        candidates = list_workspace_memory_models(
            WorkspaceMemoryOwner.personal(self.user_id)
        )

        self.assertEqual(candidates, [valid])

    def test_toggle_off_preserves_explicit_model_without_revalidating_it(self):
        from apps.agent_memory.workspace_settings import WorkspaceMemorySettingsService

        owner = WorkspaceMemoryOwner.personal(self.user_id)
        current = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode=WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL,
            memory_model_id=uuid.uuid4(),
            memory_model=SimpleNamespace(id=uuid.uuid4()),
            updated_by_id=None,
            clean=Mock(),
            save=Mock(),
        )
        service = WorkspaceMemorySettingsService(SimpleNamespace(id=self.user_id))

        with (
            patch.object(service, "_assert_permission"),
            patch.object(service, "_load_exact_model") as load_exact_model,
            patch.object(
                WorkspaceMemorySettings.objects,
                "select_for_update",
            ) as select_for_update,
        ):
            select_for_update.return_value.filter.return_value.first.return_value = current
            result = WorkspaceMemorySettingsService.update.__wrapped__(
                service,
                owner,
                auto_memory_enabled=False,
            )

        self.assertIs(result, current)
        self.assertFalse(current.auto_memory_enabled)
        load_exact_model.assert_not_called()
        current.save.assert_called_once()

    def test_toggle_on_revalidates_existing_explicit_model(self):
        from apps.agent_memory.workspace_settings import WorkspaceMemorySettingsService

        owner = WorkspaceMemoryOwner.personal(self.user_id)
        current = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode=WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL,
            memory_model_id=uuid.uuid4(),
            memory_model=SimpleNamespace(id=uuid.uuid4()),
            updated_by_id=None,
            clean=Mock(),
            save=Mock(),
        )
        service = WorkspaceMemorySettingsService(SimpleNamespace(id=self.user_id))
        invalid_model = _model(
            provider=_provider(scope="user", user_id=str(uuid.uuid4()))
        )

        with (
            patch.object(service, "_assert_permission"),
            patch.object(service, "_load_exact_model", return_value=invalid_model),
            patch.object(
                WorkspaceMemorySettings.objects,
                "select_for_update",
            ) as select_for_update,
        ):
            select_for_update.return_value.filter.return_value.first.return_value = current
            with self.assertRaises(WorkspaceMemorySettingsError):
                WorkspaceMemorySettingsService.update.__wrapped__(
                    service,
                    owner,
                    auto_memory_enabled=True,
                )

        current.save.assert_not_called()

    def test_direct_explicit_uuid_save_rejects_incompatible_model(self):
        from apps.agent_memory.workspace_settings import WorkspaceMemorySettingsService

        owner = WorkspaceMemoryOwner.personal(self.user_id)
        invalid_model = _model(provider=_provider(scope="global", encrypted_api_key=""))
        invalid_model.capabilities_config["supports_json_mode"] = False
        invalid_model.capabilities_config["json_mode"] = {"modes": []}
        current = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode=WorkspaceMemorySettings.ModelMode.OFFICIAL_DEFAULT,
            memory_model_id=None,
            memory_model=None,
            updated_by_id=None,
            clean=Mock(),
            save=Mock(),
        )
        service = WorkspaceMemorySettingsService(SimpleNamespace(id=self.user_id))

        with (
            patch.object(service, "_assert_permission"),
            patch.object(service, "_load_exact_model", return_value=invalid_model),
            patch.object(
                WorkspaceMemorySettings.objects,
                "select_for_update",
            ) as select_for_update,
        ):
            select_for_update.return_value.filter.return_value.first.return_value = current
            with self.assertRaises(WorkspaceMemorySettingsError) as caught:
                WorkspaceMemorySettingsService.update.__wrapped__(
                    service,
                    owner,
                    memory_model_mode=WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL,
                    memory_model_id=invalid_model.id,
                )

        self.assertEqual(caught.exception.code, "MEMORY_MODEL_CAPABILITY_MISMATCH")
        self.assertIn("memory_capture", caught.exception.incompatible_scenes)
        current.save.assert_not_called()

    @patch("apps.agent_memory.workspace_settings.LLMModel")
    def test_organization_candidates_keep_only_official_and_same_org_byok(
        self,
        llm_model,
    ):
        from apps.agent_memory.workspace_settings import list_workspace_memory_models

        models = [
            _model(provider=_provider(scope="global", encrypted_api_key="")),
            _model(provider=_provider(scope="organization", organization_id=self.org_id)),
            _model(
                provider=_provider(
                    scope="organization",
                    organization_id=str(uuid.uuid4()),
                )
            ),
            _model(provider=_provider(scope="user", user_id=self.user_id)),
        ]
        llm_model.objects.select_related.return_value.filter.return_value = models

        candidates = list_workspace_memory_models(
            WorkspaceMemoryOwner.organization(self.org_id)
        )

        self.assertEqual(candidates, models[:2])
