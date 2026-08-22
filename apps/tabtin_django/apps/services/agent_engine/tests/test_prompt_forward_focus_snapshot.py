"""
PromptForward · FocusSnapshot normalizer 接线特征测试（ P0）。

锁定：mobile flat ``current_*`` 与 Electron camel Host 四件套经
``_project_app_context_for_wire`` 后，wire ``app_context`` 含等价 Focus
（``appType`` / ``appMeta`` / ``openTabs`` / ``spaceId``）。
"""
from __future__ import annotations

import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.agent_engine.services.prompt_forward_service import (  # noqa: E402
    PromptForwardService,
)


class PromptForwardFocusSnapshotTests(SimpleTestCase):
    def test_mobile_flat_current_fields_project_to_host_focus(self):
        wire = PromptForwardService._project_app_context_for_wire({
            "current_app_type": "tabdoc",
            "current_doc_id": "doc-mobile-1",
            "current_doc_title": "移动端文档",
            "current_space_id": "space-m1",
            "user_time_zone": "Asia/Shanghai",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["appType"], "tabdoc")
        self.assertEqual(wire["spaceId"], "space-m1")
        self.assertEqual(wire["userTimeZone"], "Asia/Shanghai")
        self.assertEqual(wire["appMeta"]["current_doc_id"], "doc-mobile-1")
        self.assertEqual(wire["appMeta"]["current_doc_title"], "移动端文档")
        self.assertEqual(wire["appMeta"].get("idField"), "current_doc_id")
        tabs = wire["openTabs"]
        self.assertTrue(any(t.get("active") for t in tabs))
        active = next(t for t in tabs if t.get("active"))
        self.assertEqual(active.get("type") or active.get("app_key"), "tabdoc")
        self.assertEqual(active.get("id"), "doc-mobile-1")

    def test_electron_camel_focus_projects_equivalently(self):
        wire = PromptForwardService._project_app_context_for_wire({
            "appType": "tabdoc",
            "appMeta": {
                "current_doc_id": "doc-e1",
                "current_doc_title": "Electron Doc",
                "idField": "current_doc_id",
                "titleField": "current_doc_title",
            },
            "openTabs": [
                {
                    "type": "tabdoc",
                    "id": "doc-e1",
                    "title": "Electron Doc",
                    "active": True,
                    "app_key": "tabdoc",
                },
            ],
            "spaceId": "space-e1",
            "userTimeZone": "America/Los_Angeles",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["appType"], "tabdoc")
        self.assertEqual(wire["spaceId"], "space-e1")
        self.assertEqual(wire["userTimeZone"], "America/Los_Angeles")
        self.assertEqual(wire["appMeta"]["current_doc_id"], "doc-e1")
        self.assertTrue(any(t.get("active") and t.get("id") == "doc-e1" for t in wire["openTabs"]))

    def test_mobile_and_electron_shapes_yield_equivalent_focus(self):
        mobile = PromptForwardService._project_app_context_for_wire({
            "current_app_type": "tabdata",
            "current_table_id": "tbl-1",
            "current_view_id": "view-1",
            "current_space_id": "space-eq",
        })
        electron = PromptForwardService._project_app_context_for_wire({
            "appType": "tabdata",
            "appMeta": {
                "current_table_id": "tbl-1",
                "current_view_id": "view-1",
                "idField": "current_table_id",
            },
            "openTabs": [
                {"type": "tabdata", "id": "tbl-1", "active": True, "app_key": "tabdata"},
            ],
            "spaceId": "space-eq",
        })
        self.assertIsNotNone(mobile)
        self.assertIsNotNone(electron)
        assert mobile is not None and electron is not None
        self.assertEqual(mobile["appType"], electron["appType"])
        self.assertEqual(mobile["spaceId"], electron["spaceId"])
        self.assertEqual(mobile["appMeta"]["current_table_id"], electron["appMeta"]["current_table_id"])
        self.assertEqual(
            next(t["id"] for t in mobile["openTabs"] if t.get("active")),
            next(t["id"] for t in electron["openTabs"] if t.get("active")),
        )

    def test_current_space_id_maps_to_space_id(self):
        wire = PromptForwardService._project_app_context_for_wire({
            "current_app_type": "tabdoc",
            "current_doc_id": "doc-s",
            "current_space_id": "space-from-flat",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["spaceId"], "space-from-flat")
        self.assertNotIn("current_space_id", wire)

    def test_client_app_meta_not_passthrough_raw(self):
        wire = PromptForwardService._project_app_context_for_wire({
            "appType": "tabdoc",
            "appMeta": {
                "current_doc_id": "doc-safe",
                "billing_precheck_source": "EVIL",
                "runtime_mode": "EVIL",
                "selected_text": "should-not-be-in-appMeta",
                "forged_body": "x" * 100,
            },
            "spaceId": "space-1",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        meta = wire["appMeta"]
        self.assertEqual(meta["current_doc_id"], "doc-safe")
        self.assertNotIn("billing_precheck_source", meta)
        self.assertNotIn("runtime_mode", meta)
        self.assertNotIn("selected_text", meta)
        self.assertNotIn("forged_body", meta)

    def test_dangerous_top_level_fields_dropped(self):
        wire = PromptForwardService._project_app_context_for_wire({
            "current_app_type": "tabdoc",
            "current_doc_id": "doc-1",
            "current_space_id": "space-1",
            "billing_precheck_source": "EVIL",
            "runtime_mode": "EVIL",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertNotIn("billing_precheck_source", wire)
        self.assertNotIn("runtime_mode", wire)

    def test_client_identity_and_project_task_anchors_stripped(self):
        """#8571 P1-1：客户端伪造身份 / project_task 锚点不得进 wire。"""
        wire = PromptForwardService._project_app_context_for_wire({
            "appType": "project_task",
            "appMeta": {
                "project_id": "proj-1",
                "task_id": "task-1",
                "task_run_id": "run-1",
            },
            "spaceId": "ws-1",
            "executionSpaceId": "ws-1",
            "collaborationSpaceId": "proj-1",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["appType"], "project_task")
        self.assertEqual(wire["spaceId"], "ws-1")
        self.assertNotIn("executionSpaceId", wire)
        self.assertNotIn("collaborationSpaceId", wire)
        meta = wire.get("appMeta") or {}
        self.assertNotIn("project_id", meta)
        self.assertNotIn("task_id", meta)
        self.assertNotIn("task_run_id", meta)

    def test_server_authority_lands_on_wire(self):
        """#8571 P1-1：服务端权威在 normalizer 之后强制写入 wire。"""
        from apps.services.agent_engine.context.focus_snapshot import (
            SERVER_FOCUS_AUTHORITY_KEY,
            build_server_focus_authority,
        )

        wire = PromptForwardService._project_app_context_for_wire({
            "appType": "project_task",
            "spaceId": "ws-1",
            "collaborationSpaceId": "client-forged",
            "appMeta": {"project_id": "client-forged", "task_id": "client-forged"},
            SERVER_FOCUS_AUTHORITY_KEY: build_server_focus_authority(
                collaboration_space_id="proj-1",
                execution_space_id="ws-1",
                project_id="proj-1",
                task_id="task-1",
                task_run_id="run-1",
            ),
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["collaborationSpaceId"], "proj-1")
        self.assertEqual(wire["executionSpaceId"], "ws-1")
        self.assertEqual(wire["appMeta"]["project_id"], "proj-1")
        self.assertEqual(wire["appMeta"]["task_id"], "task-1")
        self.assertEqual(wire["appMeta"]["task_run_id"], "run-1")

    def test_server_authority_with_chat_visual_focus_keeps_app_type(self):
        """R2-1：视觉 chat Focus + 权威锚点 → wire 仍为 chat，锚点在 appMeta。"""
        from apps.services.agent_engine.context.focus_snapshot import (
            SERVER_FOCUS_AUTHORITY_KEY,
            build_server_focus_authority,
        )

        wire = PromptForwardService._project_app_context_for_wire({
            "appType": "chat",
            "spaceId": "ws-1",
            SERVER_FOCUS_AUTHORITY_KEY: build_server_focus_authority(
                collaboration_space_id="proj-1",
                execution_space_id="ws-1",
                project_id="proj-1",
                task_id="task-1",
                task_run_id="run-1",
            ),
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["appType"], "chat")
        self.assertEqual(wire["appMeta"]["project_id"], "proj-1")
        self.assertEqual(wire["appMeta"]["task_id"], "task-1")
        self.assertEqual(wire["collaborationSpaceId"], "proj-1")
