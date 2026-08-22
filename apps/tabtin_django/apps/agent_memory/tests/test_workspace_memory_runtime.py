from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _model(*, scope: str = "global", user_id: str = "", organization_id: str = ""):
    model_id = uuid.uuid4()
    provider = SimpleNamespace(
        scope=scope,
        user_id=user_id or None,
        organization_id=organization_id or None,
        name="openai",
        capability_domains=["chat"],
        routing_enabled=True,
        runtime_status="healthy",
        encrypted_api_key="gAAAA-server-readable" if scope != "global" else "",
        keys=[],
    )
    return SimpleNamespace(
        id=model_id,
        pk=model_id,
        provider=provider,
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


class WorkspaceMemoryRuntimeResolverTests(SimpleTestCase):
    def test_auto_memory_off_blocks_every_workspace_memory_scene(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )
        from apps.agent_memory.workspace_settings import (
            ACTIVE_WORKSPACE_MEMORY_SCENES,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as model_resolver:
            for scene_key in ACTIVE_WORKSPACE_MEMORY_SCENES:
                with self.subTest(scene_key=scene_key):
                    execution = resolve_workspace_memory_dispatch(
                        scene_key=scene_key,
                        organization_id=organization_id,
                        user_id=user_id,
                    )
                    self.assertFalse(execution.enabled)
                    self.assertEqual(execution.selected_model_id, "")

        model_resolver.assert_not_called()

    def test_task_summary_off_stops_before_model_resolution(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        official_model = _model()
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            return_value=(official_model, "global"),
        ) as model_resolver:
            execution = resolve_workspace_memory_dispatch(
                scene_key="task_summary",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertFalse(execution.enabled)
        self.assertEqual(execution.selected_model_id, "")
        model_resolver.assert_not_called()

    def test_memory_capture_off_stops_before_model_resolution(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as model_resolver:
            execution = resolve_workspace_memory_dispatch(
                scene_key="memory_capture",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertFalse(execution.enabled)
        model_resolver.assert_not_called()

    def test_disabled_workspace_stops_before_model_resolution(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=False,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as model_resolver:
            execution = resolve_workspace_memory_dispatch(
                scene_key="diary_distill",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertFalse(execution.enabled)
        self.assertEqual(execution.selected_model_id, "")
        model_resolver.assert_not_called()

    def test_official_default_is_resolved_to_exact_model_at_dispatch(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        official_model = _model()
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            return_value=(official_model, "global"),
        ) as model_resolver:
            execution = resolve_workspace_memory_dispatch(
                scene_key="diary_distill",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertTrue(execution.enabled)
        self.assertEqual(execution.selected_model_id, str(official_model.id))
        self.assertEqual(execution.model_source, "official")
        model_resolver.assert_called_once_with(
            scene_key="diary_distill",
            capability_domain="chat",
            capability_requirements={
                "requires_json_mode": True,
                "requires_vision": False,
                "requires_function_calling": False,
                "min_context_tokens": 16_000,
                "max_output_tokens": 1200,
                "latency_class": "batch",
                "cost_class": "cheap",
            },
        )

    def test_official_default_validates_only_the_current_scene_binding(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        official_model = _model()
        official_model.context_window_tokens = 32_000
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            return_value=(official_model, "global"),
        ):
            execution = resolve_workspace_memory_dispatch(
                scene_key="memory_capture",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertEqual(execution.selected_model_id, str(official_model.id))

    def test_official_binding_capability_mismatch_has_stable_error_code(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )
        from apps.services.llm.scenes.exceptions import (
            CapabilityMismatch,
            SceneOfficialBindingCapabilityMismatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="official_default",
            memory_model_id=None,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
            side_effect=CapabilityMismatch("missing json"),
        ):
            with self.assertRaises(
                SceneOfficialBindingCapabilityMismatch
            ) as caught:
                resolve_workspace_memory_dispatch(
                    scene_key="memory_capture",
                    organization_id=organization_id,
                    user_id=user_id,
                )

        self.assertEqual(
            caught.exception.error_code,
            "SCENE_OFFICIAL_BINDING_CAPABILITY_MISMATCH",
        )

    def test_explicit_personal_byok_is_frozen_by_exact_uuid(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        byok_model = _model(scope="user", user_id=user_id)
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="explicit_model",
            memory_model_id=byok_model.id,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = byok_model

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as model_resolver:
            execution = resolve_workspace_memory_dispatch(
                scene_key="memory_capture",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertTrue(execution.enabled)
        self.assertEqual(execution.selected_model_id, str(byok_model.id))
        self.assertEqual(execution.model_source, "byok")
        model_manager.select_related.return_value.get.assert_called_once_with(
            id=byok_model.id
        )
        model_resolver.assert_not_called()

    def test_worker_uses_payload_snapshot_after_setting_changes(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        model_a = _model(scope="user", user_id=user_id)
        model_b = _model(scope="user", user_id=user_id)
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        current_settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="explicit_model",
            memory_model_id=model_b.id,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (current_settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = model_a

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ):
            execution = resolve_workspace_memory_worker(
                scene_key="memory_capture",
                organization_id=organization_id,
                user_id=user_id,
                selected_model_id=str(model_a.id),
            )

        self.assertEqual(execution.selected_model_id, str(model_a.id))
        self.assertNotEqual(execution.selected_model_id, str(model_b.id))
        model_manager.select_related.return_value.get.assert_called_once_with(
            id=model_a.id
        )

    def test_task_summary_worker_rechecks_auto_memory_toggle(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        model = _model(scope="user", user_id=user_id)
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (
            SimpleNamespace(auto_memory_enabled=False),
            False,
        )
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = model

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ):
            execution = resolve_workspace_memory_worker(
                scene_key="task_summary",
                organization_id=organization_id,
                user_id=user_id,
                selected_model_id=str(model.id),
            )

        self.assertFalse(execution.enabled)
        self.assertEqual(execution.selected_model_id, "")
        settings_manager.get_or_create.assert_called_once()
        model_manager.select_related.assert_not_called()

    def test_explicit_organization_byok_is_frozen_by_exact_uuid(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_dispatch,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        org_model = _model(
            scope="organization",
            organization_id=organization_id,
        )
        organization = SimpleNamespace(
            id=organization_id,
            type="team",
            owner_id=str(uuid.uuid4()),
        )
        settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode="explicit_model",
            memory_model_id=org_model.id,
        )
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = org_model

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ):
            execution = resolve_workspace_memory_dispatch(
                scene_key="task_summary",
                organization_id=organization_id,
                user_id=user_id,
            )

        self.assertEqual(execution.selected_model_id, str(org_model.id))
        self.assertEqual(execution.workspace_scope, "organization")
        self.assertEqual(execution.model_source, "byok")

    def test_worker_revalidates_scope_and_blocks_cross_workspace_model(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )
        from apps.services.llm.scenes.exceptions import (
            WorkspaceMemoryModelUnavailable,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        org_byok = _model(scope="organization", organization_id=str(uuid.uuid4()))
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(auto_memory_enabled=True)
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = org_byok

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ):
            with self.assertRaises(WorkspaceMemoryModelUnavailable):
                resolve_workspace_memory_worker(
                    scene_key="task_summary",
                    organization_id=organization_id,
                    user_id=user_id,
                    selected_model_id=str(org_byok.id),
                )

    def test_worker_blocks_deleted_snapshot_without_name_fallback(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )
        from apps.services.llm.models import LLMModel
        from apps.services.llm.scenes.exceptions import (
            WorkspaceMemoryModelUnavailable,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        deleted_model_id = uuid.uuid4()
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(auto_memory_enabled=True)
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.side_effect = LLMModel.DoesNotExist

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as official_resolver:
            with self.assertRaises(WorkspaceMemoryModelUnavailable):
                resolve_workspace_memory_worker(
                    scene_key="memory_capture",
                    organization_id=organization_id,
                    user_id=user_id,
                    selected_model_id=str(deleted_model_id),
                )

        official_resolver.assert_not_called()

    def test_worker_blocks_persisted_device_only_snapshot(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )
        from apps.services.llm.scenes.exceptions import (
            BackgroundModelNotServerExecutable,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        local_model = _model()
        local_model.capabilities_config = {
            "execution_location": "device",
            "credential_location": "device",
        }
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(auto_memory_enabled=True)
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = local_model

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as official_resolver:
            with self.assertRaises(BackgroundModelNotServerExecutable):
                resolve_workspace_memory_worker(
                    scene_key="diary_distill",
                    organization_id=organization_id,
                    user_id=user_id,
                    selected_model_id=str(local_model.id),
                )

        official_resolver.assert_not_called()

    def test_worker_blocks_disabled_snapshot_without_official_fallback(self):
        from apps.agent_memory.workspace_memory_execution import (
            resolve_workspace_memory_worker,
        )
        from apps.services.llm.scenes.exceptions import (
            BackgroundModelNotServerExecutable,
        )

        user_id = str(uuid.uuid4())
        organization_id = str(uuid.uuid4())
        disabled_model = _model(scope="user", user_id=user_id)
        disabled_model.wave_status = "disabled"
        organization = SimpleNamespace(
            id=organization_id,
            type="personal",
            owner_id=user_id,
        )
        settings = SimpleNamespace(auto_memory_enabled=True)
        organization_manager = MagicMock()
        organization_manager.only.return_value.get.return_value = organization
        settings_manager = MagicMock()
        settings_manager.get_or_create.return_value = (settings, False)
        model_manager = MagicMock()
        model_manager.select_related.return_value.get.return_value = disabled_model

        with patch(
            "apps.tabtinspace.models.Organization.objects",
            organization_manager,
        ), patch(
            "apps.agent_memory.models.WorkspaceMemorySettings.objects",
            settings_manager,
        ), patch(
            "apps.services.llm.models.LLMModel.objects",
            model_manager,
        ), patch(
            "apps.services.llm.services._runtime.model_resolver.resolve_model",
        ) as official_resolver:
            with self.assertRaises(BackgroundModelNotServerExecutable):
                resolve_workspace_memory_worker(
                    scene_key="memory_compaction",
                    organization_id=organization_id,
                    user_id=user_id,
                    selected_model_id=str(disabled_model.id),
                )

        official_resolver.assert_not_called()
