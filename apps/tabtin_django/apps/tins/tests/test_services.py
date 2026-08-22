"""TinService / TinInstanceService 单元测试。"""

from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import TestCase
from django.utils import timezone

from apps.tins.models import Tin, TinInstance, TinRunLog
from apps.tins.services.tin_service import TinService, TinInstanceService


def _ws() -> uuid.UUID:
    return uuid.uuid4()


def _make_tin_data(**overrides) -> dict:
    base = {
        "name": "Test Tin",
        "description": "A test tin",
        "activation_mode": "auto",
        "activation_rules": [{"type": "always"}],
        "activation_match": "any",
        "permissions": ["page_content"],
        "panel_position": "sidebar_right",
        "panel_width": 400,
        "panel_html": "<h1>Hello</h1>",
        "content_script": "console.log('hi')",
        "source": "user_created",
    }
    base.update(overrides)
    return base


class TinServiceCreateTest(TestCase):
    databases = {"default", "postgresql"}

    def test_create_tin_basic(self):
        ws = _ws()
        data = _make_tin_data()
        tin = TinService.create_tin(organization_id=ws, data=data)

        self.assertIsNotNone(tin.id)
        self.assertEqual(tin.name, "Test Tin")
        self.assertEqual(tin.status, "draft")
        self.assertEqual(tin.organization_id, ws)
        self.assertEqual(tin.panel_html, "<h1>Hello</h1>")

    def test_create_tin_manifest_generated(self):
        ws = _ws()
        data = _make_tin_data()
        tin = TinService.create_tin(organization_id=ws, data=data)

        self.assertIn("name", tin.manifest)
        self.assertEqual(tin.manifest["name"], "Test Tin")
        self.assertEqual(tin.manifest["version"], "1.0.0")
        self.assertIn("activation", tin.manifest)
        self.assertEqual(tin.manifest["activation"]["mode"], "auto")

    def test_create_tin_with_space(self):
        ws = _ws()
        space = uuid.uuid4()
        data = _make_tin_data()
        tin = TinService.create_tin(organization_id=ws, data=data, space_id=space)

        self.assertEqual(tin.space_id, space)

    def test_create_tin_with_variables_schema_dict(self):
        ws = _ws()
        data = _make_tin_data(variables_schema={
            "lang": {"type": "select", "label": "Language", "default": "en", "options": ["en", "zh"]},
        })
        tin = TinService.create_tin(organization_id=ws, data=data)

        self.assertIn("lang", tin.variables_schema)
        self.assertEqual(tin.variables_schema["lang"]["type"], "select")


class TinServiceLifecycleTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ws = _ws()
        self.tin = TinService.create_tin(organization_id=self.ws, data=_make_tin_data())

    def test_activate_tin(self):
        tin = TinService.activate_tin(self.tin)
        self.assertEqual(tin.status, "active")

    def test_disable_tin(self):
        TinService.activate_tin(self.tin)
        tin = TinService.disable_tin(self.tin)
        self.assertEqual(tin.status, "disabled")

    def test_delete_tin_cascades_instances(self):
        TinInstanceService.install_tin(
            tin=self.tin, space_id=uuid.uuid4(), organization_id=self.ws,
        )
        self.assertEqual(TinInstance.objects.filter(tin=self.tin).count(), 1)

        TinService.delete_tin(self.tin)
        self.assertEqual(TinInstance.objects.filter(tin_id=self.tin.id).count(), 0)


class TinServiceUpdateTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ws = _ws()
        self.tin = TinService.create_tin(organization_id=self.ws, data=_make_tin_data())

    def test_update_partial_fields(self):
        tin = TinService.update_tin(self.tin, {"name": "Renamed", "panel_width": 500})
        self.assertEqual(tin.name, "Renamed")
        self.assertEqual(tin.panel_width, 500)
        self.assertEqual(tin.manifest["name"], "Renamed")

    def test_update_activation_rules(self):
        new_rules = [{"type": "url_pattern", "patterns": ["*://*.example.com/*"]}]
        tin = TinService.update_tin(self.tin, {"activation_rules": new_rules})
        self.assertEqual(len(tin.activation_rules), 1)
        self.assertEqual(tin.activation_rules[0]["type"], "url_pattern")

    def test_update_no_changes(self):
        old_updated = self.tin.updated_at
        tin = TinService.update_tin(self.tin, {})
        self.assertEqual(tin.updated_at, old_updated)


class TinServiceUpdateFileTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ws = _ws()
        self.tin = TinService.create_tin(organization_id=self.ws, data=_make_tin_data())

    def test_update_panel_html(self):
        tin = TinService.update_file(self.tin, "panel_html", "<div>New</div>")
        self.assertEqual(tin.panel_html, "<div>New</div>")

    def test_update_invalid_file_type(self):
        with self.assertRaises(ValueError) as ctx:
            TinService.update_file(self.tin, "invalid_type", "content")
        self.assertIn("Invalid file_type", str(ctx.exception))

    def test_update_file_does_not_change_manifest(self):
        old_manifest = self.tin.manifest.copy()
        TinService.update_file(self.tin, "panel_html", "<div>New</div>")
        self.tin.refresh_from_db()
        self.assertEqual(self.tin.manifest, old_manifest)

    def test_update_all_valid_types(self):
        for ft in ("panel_html", "content_script", "background_script", "agent_instructions"):
            TinService.update_file(self.tin, ft, f"content for {ft}")
            self.tin.refresh_from_db()
            self.assertEqual(getattr(self.tin, ft), f"content for {ft}")


class TinServiceQueryTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ws = _ws()
        self.other_ws = _ws()
        self.tin1 = TinService.create_tin(organization_id=self.ws, data=_make_tin_data(name="Tin A"))
        self.tin2 = TinService.create_tin(organization_id=self.ws, data=_make_tin_data(name="Tin B"))
        TinService.activate_tin(self.tin1)
        self.tin3 = TinService.create_tin(organization_id=self.other_ws, data=_make_tin_data(name="Other WS"))

    def test_get_tin_in_organization(self):
        tin = TinService.get_tin(self.tin1.id, self.ws)
        self.assertIsNotNone(tin)
        self.assertEqual(tin.name, "Tin A")

    def test_get_tin_wrong_organization(self):
        tin = TinService.get_tin(self.tin1.id, self.other_ws)
        self.assertIsNone(tin)

    def test_list_tins_qs_organization_filter(self):
        qs = TinService.list_tins_qs(self.ws)
        self.assertEqual(qs.count(), 2)

    def test_list_tins_qs_status_filter(self):
        qs = TinService.list_tins_qs(self.ws, status="active")
        self.assertEqual(qs.count(), 1)
        self.assertEqual(qs.first().name, "Tin A")

    def test_list_tins_qs_space_filter(self):
        space = uuid.uuid4()
        TinService.create_tin(
            organization_id=self.ws, data=_make_tin_data(name="Scoped"),
            space_id=space,
        )
        qs = TinService.list_tins_qs(self.ws, space_id=space)
        names = set(qs.values_list("name", flat=True))
        self.assertIn("Scoped", names)
        self.assertIn("Tin A", names)


class TinInstanceServiceTest(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.ws = _ws()
        self.space = uuid.uuid4()
        self.tin = TinService.create_tin(organization_id=self.ws, data=_make_tin_data())

    def test_install_tin_creates_instance(self):
        inst = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        self.assertIsNotNone(inst.id)
        self.assertTrue(inst.is_enabled)
        self.assertFalse(inst.pinned)
        self.assertEqual(inst.organization_id, self.ws)

    def test_install_tin_idempotent(self):
        inst1 = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        inst2 = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
            pinned=True,
        )
        self.assertEqual(inst1.id, inst2.id)
        inst2.refresh_from_db()
        self.assertTrue(inst2.pinned)

    def test_update_instance(self):
        inst = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        inst = TinInstanceService.update_instance(inst, {"is_enabled": False})
        self.assertFalse(inst.is_enabled)

    def test_uninstall_deletes_instance(self):
        inst = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        TinInstanceService.uninstall(inst)
        self.assertIsNone(TinInstanceService.get_instance(inst.id))

    def test_record_activation_updates_timestamps(self):
        inst = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        self.assertIsNone(inst.last_activated_at)
        old_updated = inst.updated_at

        TinInstanceService.record_activation(inst)
        inst.refresh_from_db()

        self.assertIsNotNone(inst.last_activated_at)
        self.assertGreaterEqual(inst.updated_at, old_updated)

    def test_list_instances_qs_filter(self):
        TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        other_space = uuid.uuid4()
        TinInstanceService.install_tin(
            tin=self.tin, space_id=other_space, organization_id=self.ws,
            is_enabled=False,
        )

        qs = TinInstanceService.list_instances_qs(self.space, self.ws)
        self.assertEqual(qs.count(), 1)

        qs_all = TinInstanceService.list_instances_qs(self.space, self.ws, is_enabled=True)
        self.assertEqual(qs_all.count(), 1)

    def test_log_run(self):
        inst = TinInstanceService.install_tin(
            tin=self.tin, space_id=self.space, organization_id=self.ws,
        )
        log = TinInstanceService.log_run(
            inst, "script_run",
            input_data={"url": "https://example.com"},
            duration_ms=150,
        )
        self.assertEqual(log.action, "script_run")
        self.assertEqual(log.duration_ms, 150)
        self.assertEqual(TinRunLog.objects.filter(instance=inst).count(), 1)
