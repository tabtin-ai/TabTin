from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase

from apps.agent_memory.api import (
    get_workspace_memory_settings_api,
    list_workspace_memory_models_api,
    update_workspace_memory_settings_api,
)
from apps.agent_memory.models import WorkspaceMemorySettings
from apps.agent_memory.schemas import WorkspaceMemorySettingsUpdateRequest
from apps.agent_memory.workspace_settings import (
    WorkspaceMemoryOwner,
    WorkspaceMemorySettingsError,
)


class WorkspaceMemorySettingsApiTests(SimpleTestCase):
    def setUp(self):
        self.organization_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        self.owner = WorkspaceMemoryOwner.personal(self.user_id)
        self.request = RequestFactory().get("/")
        self.request.auth = SimpleNamespace(id=self.user_id)
        self.provider = SimpleNamespace(
            scope="user",
            display_name="我的 OpenAI",
            encrypted_api_key="secret-never-serialize",
        )
        self.model = SimpleNamespace(
            id=uuid.uuid4(),
            display_name="Kimi",
            provider=self.provider,
        )
        self.settings = SimpleNamespace(
            auto_memory_enabled=True,
            memory_model_mode=WorkspaceMemorySettings.ModelMode.EXPLICIT_MODEL,
            memory_model=self.model,
        )

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_get_returns_safe_settings_contract(self, service_class):
        service = service_class.return_value
        service.resolve_owner.return_value = self.owner
        service.get.return_value = self.settings
        service.can_update.return_value = True

        response = get_workspace_memory_settings_api(
            self.request,
            self.organization_id,
        )

        self.assertEqual(response["data"]["memory_model"]["id"], str(self.model.id))
        self.assertNotIn("encrypted_api_key", response["data"]["memory_model"])
        service.resolve_owner.assert_called_once_with(self.organization_id)

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_put_forwards_only_exact_uuid_and_mode_to_pr8c_service(self, service_class):
        service = service_class.return_value
        service.resolve_owner.return_value = self.owner
        service.update.return_value = self.settings
        service.can_update.return_value = True
        payload = WorkspaceMemorySettingsUpdateRequest(
            organization_id=self.organization_id,
            memory_model_mode="explicit_model",
            memory_model_id=str(self.model.id),
        )

        update_workspace_memory_settings_api(self.request, payload)

        service.update.assert_called_once_with(
            self.owner,
            auto_memory_enabled=None,
            memory_model_mode="explicit_model",
            memory_model_id=str(self.model.id),
        )

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_candidates_are_filtered_by_service_and_expose_no_secret(self, service_class):
        service = service_class.return_value
        service.resolve_owner.return_value = self.owner
        service.list_model_options.return_value = ([self.model], [])

        response = list_workspace_memory_models_api(
            self.request,
            self.organization_id,
        )

        self.assertEqual(response["data"]["items"][0]["id"], str(self.model.id))
        self.assertNotIn("encrypted_api_key", response["data"]["items"][0])
        service.list_model_options.assert_called_once_with(self.owner)

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_member_write_denial_is_403(self, service_class):
        service = service_class.return_value
        service.resolve_owner.return_value = WorkspaceMemoryOwner.organization(
            self.organization_id
        )
        service.update.side_effect = WorkspaceMemorySettingsError(
            "WORKSPACE_MEMORY_PERMISSION_DENIED",
            "denied",
        )
        payload = WorkspaceMemorySettingsUpdateRequest(
            organization_id=self.organization_id,
            auto_memory_enabled=True,
        )

        response = update_workspace_memory_settings_api(self.request, payload)

        self.assertEqual(response.status_code, 403)

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_put_returns_incompatible_scene_list_for_invalid_model(
        self,
        service_class,
    ):
        service = service_class.return_value
        service.resolve_owner.return_value = self.owner
        service.update.side_effect = WorkspaceMemorySettingsError(
            "MEMORY_MODEL_CAPABILITY_MISMATCH",
            "invalid model",
            incompatible_scenes=("memory_capture", "memory_compaction"),
        )
        payload = WorkspaceMemorySettingsUpdateRequest(
            organization_id=self.organization_id,
            memory_model_mode="explicit_model",
            memory_model_id=str(self.model.id),
        )

        response = update_workspace_memory_settings_api(self.request, payload)

        self.assertEqual(response.status_code, 422)
        body = json.loads(response.content)
        self.assertEqual(
            body["data"]["incompatible_scenes"],
            ["memory_capture", "memory_compaction"],
        )
