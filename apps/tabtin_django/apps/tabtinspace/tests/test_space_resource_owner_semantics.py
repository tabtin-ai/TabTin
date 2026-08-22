"""Space 作为本地执行现场后的资源归属回归测试。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.conf import settings
from django.test import SimpleTestCase
from unittest import skipUnless

from apps.services.common.base_models import ContextSyncMixin
from apps.tabtinspace.services.resource_bridge import ResourceBridge
from apps.tabtinspace.services.organization_service import _get_organization_resource_models


def _app_installed(module_name: str) -> bool:
    return any(
        app == module_name or app.startswith(f"{module_name}.")
        for app in settings.INSTALLED_APPS
    )


class TeamOnlyResource(ContextSyncMixin):
    """不带 Space 上下文的团队资源桩。"""

    id = uuid4()
    organization_id = uuid4()
    space_id = None
    updated_at = None

    def get_context_type(self) -> str:
        return "team_only"

    def get_context_title(self) -> str:
        return "Team resource"


class SpaceResourceOwnerSemanticsTests(SimpleTestCase):
    @skipUnless(
        all(
            _app_installed(app)
            for app in [
                "apps.tabdata",
                "apps.tabdoc",
                "apps.tabslide",
                "apps.tabmemo",
                "apps.tins",
            ]
        ),
        "完整资源注册表测试需要完整 app settings",
    )
    def test_cloud_resources_are_not_registered_as_space_owned(self):
        """Table/Doc/Slide 等云资源不能再通过 Space 删除链路清理。"""
        bindings = {binding.model.__name__: binding for binding in _get_organization_resource_models()}

        for model_name in [
            "Table",
            "Document",
            "SlideProject",
            "Memo",
            "TableWebhook",
            "Tin",
            "TinInstance",
        ]:
            self.assertIn(model_name, bindings)
            self.assertIsNone(bindings[model_name].as_field, model_name)
            self.assertEqual(bindings[model_name].ws_field, "organization_id", model_name)

        self.assertNotIn("DbReadOnlyConnection", bindings)
        self.assertEqual(bindings["ContextItem"].as_field, "workspace_id")
        self.assertEqual(bindings["SpaceCheckpoint"].as_field, "space_id")

    def test_resource_bridge_creates_context_item_for_org_only_resource(self):
        """#6603：无 space_id 但有 organization_id 时同步 org-only ContextItem。"""
        resource = TeamOnlyResource()
        fake_item = SimpleNamespace(id=uuid4())

        with patch.object(ResourceBridge, "_create_context_item", return_value=fake_item) as create_context_item, \
             patch.object(ResourceBridge, "_update_search_vector") as update_search_vector, \
             patch.object(ResourceBridge, "_emit_signal") as emit_signal, \
             patch.object(ResourceBridge, "_push_ws") as push_ws:
            result = ResourceBridge.on_create(resource, user=SimpleNamespace(id=uuid4()))

        self.assertIs(result, fake_item)
        create_context_item.assert_called_once()
        update_search_vector.assert_called_once_with(fake_item.id)
        emit_signal.assert_called_once()
        push_ws.assert_called_once()

    def test_resource_bridge_skips_context_item_without_host(self):
        """既无 space_id 也无 organization_id 时跳过 ContextItem，仍发生生命周期事件。"""
        resource = TeamOnlyResource()
        resource.organization_id = None

        with patch.object(ResourceBridge, "_create_context_item") as create_context_item, \
             patch.object(ResourceBridge, "_update_search_vector") as update_search_vector, \
             patch.object(ResourceBridge, "_emit_signal") as emit_signal, \
             patch.object(ResourceBridge, "_push_ws") as push_ws:
            result = ResourceBridge.on_create(resource, user=SimpleNamespace(id=uuid4()))

        self.assertIsNone(result)
        create_context_item.assert_not_called()
        update_search_vector.assert_not_called()
        emit_signal.assert_called_once()
        push_ws.assert_called_once()
