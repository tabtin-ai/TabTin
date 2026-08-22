import uuid
from types import SimpleNamespace
from unittest.mock import patch

from django.test import RequestFactory, SimpleTestCase

from apps.agent_memory.api import list_workspace_memory_models_api
from apps.agent_memory.workspace_settings import (
    WorkspaceMemoryOwner,
    WorkspaceMemorySettingsError,
)


class WorkspaceMemoryModelCatalogTests(SimpleTestCase):
    def setUp(self):
        self.organization_id = str(uuid.uuid4())
        self.user_id = str(uuid.uuid4())
        self.owner = WorkspaceMemoryOwner.organization(self.organization_id)
        self.request = RequestFactory().get("/")
        self.request.auth = SimpleNamespace(id=self.user_id)

    @patch("apps.agent_memory.api.WorkspaceMemorySettingsService")
    def test_catalog_exposes_capability_blocked_byok_without_secret(self, service_class):
        service = service_class.return_value
        service.resolve_owner.return_value = self.owner
        provider = SimpleNamespace(
            scope="organization",
            display_name="百炼 Coding Plan",
            encrypted_api_key="must-not-leak",
        )
        eligible = SimpleNamespace(
            id=uuid.uuid4(),
            display_name="GLM-4.7",
            provider=SimpleNamespace(scope="global", display_name="智谱"),
        )
        unavailable = SimpleNamespace(
            id=uuid.uuid4(),
            display_name="Qwen 3.7 Plus",
            provider=provider,
        )
        error = WorkspaceMemorySettingsError(
            "MEMORY_MODEL_CAPABILITY_MISMATCH",
            "所选模型不满足全部 Workspace Memory Scene capability",
            incompatible_scenes=("memory_capture", "task_summary"),
        )
        service.list_model_options.return_value = ([eligible], [(unavailable, error)])

        response = list_workspace_memory_models_api(
            self.request,
            self.organization_id,
        )

        self.assertEqual(response["data"]["items"][0]["id"], str(eligible.id))
        blocked = response["data"]["unavailable_items"][0]
        self.assertEqual(blocked["id"], str(unavailable.id))
        self.assertEqual(blocked["reason_code"], "MEMORY_MODEL_CAPABILITY_MISMATCH")
        self.assertEqual(
            blocked["incompatible_scenes"],
            ["memory_capture", "task_summary"],
        )
        self.assertNotIn("encrypted_api_key", blocked)
        service.list_model_options.assert_called_once_with(self.owner)
