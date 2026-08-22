"""
FocusSnapshot normalizer 单元特征测试（ P0 / P1）。

``manage.py test`` 可发现（SimpleTestCase）。覆盖 camel / flat 归一、
危险字段 fail-closed、限流裁剪、显式 selected_text、执行身份剥离、
跨 App 错配、openTabs type 补齐。
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

from apps.services.agent_engine.context.focus_snapshot import (  # noqa: E402
    MAX_OPEN_TABS,
    MAX_STRING_LEN,
    MAX_URL_OR_PATH_LEN,
    SERVER_FOCUS_AUTHORITY_KEY,
    build_server_focus_authority,
    normalize_focus_snapshot,
    project_focus_for_wire,
)


class FocusSnapshotNormalizerTests(SimpleTestCase):
    def test_camel_focus_preserved(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "appMeta": {
                "current_doc_id": "doc-1",
                "current_doc_title": "Title",
                "idField": "current_doc_id",
                "titleField": "current_doc_title",
            },
            "openTabs": [
                {"type": "tabdoc", "id": "doc-1", "title": "Title", "active": True},
            ],
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out["appType"], "tabdoc")
        self.assertEqual(out["spaceId"], "space-1")
        self.assertEqual(out["appMeta"]["current_doc_id"], "doc-1")
        self.assertTrue(any(t.get("active") for t in out["openTabs"]))
        self.assertEqual(out["current_app_type"], "tabdoc")
        self.assertEqual(out["current_doc_id"], "doc-1")
        self.assertEqual(out["current_space_id"], "space-1")

    def test_flat_current_fields_build_host_focus(self):
        out = normalize_focus_snapshot({
            "current_app_type": "tabdoc",
            "current_doc_id": "doc-flat",
            "current_doc_title": "Flat",
            "current_space_id": "space-flat",
            "user_time_zone": "Asia/Shanghai",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out["appType"], "tabdoc")
        self.assertEqual(out["spaceId"], "space-flat")
        self.assertEqual(out["userTimeZone"], "Asia/Shanghai")
        self.assertEqual(out["appMeta"]["current_doc_id"], "doc-flat")
        self.assertEqual(out["appMeta"].get("idField"), "current_doc_id")
        self.assertTrue(any(t.get("active") and t.get("id") == "doc-flat" for t in out["openTabs"]))

    def test_dangerous_fields_and_forged_app_meta_dropped(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "appMeta": {
                "current_doc_id": "doc-safe",
                "billing_precheck_source": "EVIL",
                "runtime_mode": "EVIL",
                "forged_body": "nope",
                "selected_text": "not-in-meta",
            },
            "spaceId": "space-1",
            "billing_precheck_source": "EVIL",
            "runtime_mode": "EVIL",
            "selected_text": "explicit",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertNotIn("billing_precheck_source", out)
        self.assertNotIn("runtime_mode", out)
        meta = out["appMeta"]
        self.assertEqual(meta["current_doc_id"], "doc-safe")
        self.assertNotIn("billing_precheck_source", meta)
        self.assertNotIn("runtime_mode", meta)
        self.assertNotIn("forged_body", meta)
        self.assertNotIn("selected_text", meta)
        self.assertEqual(out["selected_text"], "explicit")

    def test_size_limits_trim_tabs_and_strings(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "appMeta": {
                "current_doc_id": "doc-limit",
                "current_doc_title": "T" * 10_000,
                "nested_payload": {"a": {"b": {"c": "deep"}}},
            },
            "openTabs": [
                {"type": "tabdoc", "id": f"doc-{i}", "active": i == 0}
                for i in range(50)
            ],
            "spaceId": "space-limit",
        })
        self.assertIsNotNone(out)
        assert out is not None
        title = out["appMeta"]["current_doc_title"]
        self.assertLessEqual(len(title), MAX_STRING_LEN)
        self.assertNotIn("nested_payload", out["appMeta"])
        self.assertLessEqual(len(out["openTabs"]), MAX_OPEN_TABS)
        self.assertTrue(any(t.get("active") for t in out["openTabs"]))

    def test_project_focus_for_wire_omits_flat_and_non_wire_passthrough(self):
        wire = project_focus_for_wire({
            "current_app_type": "tabdoc",
            "current_doc_id": "doc-w",
            "current_space_id": "space-w",
            "selected_text": "sel",
            "workspace_snapshot": {"roots": []},
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["appType"], "tabdoc")
        self.assertEqual(wire["spaceId"], "space-w")
        self.assertNotIn("current_app_type", wire)
        self.assertNotIn("selected_text", wire)
        self.assertNotIn("workspace_snapshot", wire)

    def test_project_focus_for_wire_preserves_invocation_scope_marker(self):
        wire = project_focus_for_wire({
            "appType": "tabweb",
            "spaceId": "space-source",
            "_invoked_from": "conversation:session-source",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(
            wire.get("_invoked_from"),
            "conversation:session-source",
        )

    def test_workspace_mode_normalized_into_wire_focus(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "spaceId": "space-wm",
            "workspace_mode": "Desktop",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out["workspaceMode"], "desktop")

        wire = project_focus_for_wire({
            "appType": "tabdoc",
            "spaceId": "space-wm",
            "workspaceMode": "conversation",
            "selected_text": "keep-out-of-wire",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["workspaceMode"], "conversation")
        self.assertNotIn("selected_text", wire)
        self.assertNotIn("workspace_mode", wire)

        dropped = normalize_focus_snapshot({
            "appType": "tabdoc",
            "workspaceMode": "evil-mode",
        })
        self.assertIsNotNone(dropped)
        assert dropped is not None
        self.assertNotIn("workspaceMode", dropped)

    # ──  P1-1：客户端不得伪造执行身份 / 锚点 ─────────────────────

    def test_client_forged_identity_fields_dropped(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "spaceId": "space-1",
            "collaborationSpaceId": "forged-collab",
            "executionSpaceId": "forged-exec",
            "initiatorUserId": "forged-user",
            "executionOwnerUserId": "forged-owner",
            "collaboration_space_id": "forged-collab-snake",
            "execution_space_id": "forged-exec-snake",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out["appType"], "tabdoc")
        self.assertNotIn("collaborationSpaceId", out)
        self.assertNotIn("executionSpaceId", out)
        self.assertNotIn("initiatorUserId", out)
        self.assertNotIn("executionOwnerUserId", out)
        self.assertNotIn("collaboration_space_id", out)
        self.assertNotIn("execution_space_id", out)

        wire = project_focus_for_wire({
            "appType": "tabdoc",
            "spaceId": "space-1",
            "collaborationSpaceId": "forged-collab",
            "executionSpaceId": "forged-exec",
            "initiatorUserId": "forged-user",
            "executionOwnerUserId": "forged-owner",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertNotIn("collaborationSpaceId", wire)
        self.assertNotIn("executionSpaceId", wire)
        self.assertNotIn("initiatorUserId", wire)
        self.assertNotIn("executionOwnerUserId", wire)

    def test_server_authority_force_writes_identity_after_normalize(self):
        wire = project_focus_for_wire({
            "appType": "tabdoc",
            "spaceId": "space-1",
            # 客户端伪造——必须被丢
            "collaborationSpaceId": "client-forged",
            "executionSpaceId": "client-forged-ws",
            SERVER_FOCUS_AUTHORITY_KEY: build_server_focus_authority(
                collaboration_space_id="proj-authoritative",
                execution_space_id="ws-authoritative",
                initiator_user_id="user-authoritative",
                execution_owner_user_id="owner-authoritative",
            ),
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertEqual(wire["collaborationSpaceId"], "proj-authoritative")
        self.assertEqual(wire["executionSpaceId"], "ws-authoritative")
        self.assertEqual(wire["initiatorUserId"], "user-authoritative")
        self.assertEqual(wire["executionOwnerUserId"], "owner-authoritative")
        # 视觉 Focus 仍保留
        self.assertEqual(wire["appType"], "tabdoc")
        self.assertEqual(wire["spaceId"], "space-1")

    def test_forged_project_task_app_meta_stripped(self):
        out = normalize_focus_snapshot({
            "appType": "project_task",
            "appMeta": {
                "project_id": "forged-proj",
                "task_id": "forged-task",
                "task_run_id": "forged-run",
                "idField": "task_id",
            },
            "spaceId": "ws-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        meta = out.get("appMeta") or {}
        self.assertNotIn("project_id", meta)
        self.assertNotIn("task_id", meta)
        self.assertNotIn("task_run_id", meta)

        wire = project_focus_for_wire({
            "appType": "project_task",
            "appMeta": {
                "project_id": "forged-proj",
                "task_id": "forged-task",
                "task_run_id": "forged-run",
            },
            "spaceId": "ws-1",
            "collaborationSpaceId": "forged-collab",
        })
        self.assertIsNotNone(wire)
        assert wire is not None
        self.assertNotIn("collaborationSpaceId", wire)
        wire_meta = wire.get("appMeta") or {}
        self.assertNotIn("project_id", wire_meta)
        self.assertNotIn("task_id", wire_meta)
        self.assertNotIn("task_run_id", wire_meta)

    def test_server_authority_injects_project_task_anchors(self):
        wire = project_focus_for_wire({
            "appType": "project_task",
            "spaceId": "ws-1",
            "appMeta": {
                "project_id": "client-forged",
                "task_id": "client-forged-task",
            },
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

    def test_server_authority_keeps_visual_focus_when_injecting_anchors(self):
        """R2-1：权威锚点写入 appMeta，视觉 appType 仍为 tabdoc/chat。"""
        for visual in ("tabdoc", "chat"):
            with self.subTest(visual=visual):
                wire = project_focus_for_wire({
                    "appType": visual,
                    "spaceId": "ws-1",
                    "appMeta": {"current_doc_id": "doc-1"} if visual == "tabdoc" else None,
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
                self.assertEqual(wire["appType"], visual)
                self.assertEqual(wire["appMeta"]["project_id"], "proj-1")
                self.assertEqual(wire["appMeta"]["task_id"], "task-1")
                self.assertEqual(wire["appMeta"]["task_run_id"], "run-1")
                self.assertEqual(wire["collaborationSpaceId"], "proj-1")
                if visual == "tabdoc":
                    self.assertEqual(wire["appMeta"]["current_doc_id"], "doc-1")

    # ──  P1-6：跨 App 错配 / openTabs type / path 长度 ───────────

    def test_cross_app_active_tab_does_not_fill_wrong_resource_id(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "openTabs": [
                {"type": "tabdata", "id": "tbl-wrong", "active": True},
            ],
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertNotEqual(out.get("current_doc_id"), "tbl-wrong")
        meta = out.get("appMeta") or {}
        self.assertNotEqual(meta.get("current_doc_id"), "tbl-wrong")
        self.assertNotIn("current_table_id", out)
        self.assertNotIn("current_table_id", meta)

    def test_foreign_app_flat_fields_dropped_when_app_type_set(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "current_doc_id": "doc-ok",
            "current_table_id": "tbl-foreign",
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        self.assertEqual(out.get("current_doc_id"), "doc-ok")
        self.assertNotIn("current_table_id", out)
        self.assertNotIn("current_table_id", out.get("appMeta") or {})

    def test_open_tab_missing_type_defaults_from_app_key_or_app_type(self):
        out = normalize_focus_snapshot({
            "appType": "tabdoc",
            "openTabs": [
                {"id": "doc-1", "app_key": "tabdoc", "active": True},
                {"id": "orphan", "active": False},  # 无 type/app_key → 用外层 appType
            ],
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        tabs = out["openTabs"]
        self.assertTrue(all(isinstance(t.get("type"), str) and t["type"] for t in tabs))
        self.assertTrue(any(t.get("id") == "doc-1" and t.get("type") == "tabdoc" for t in tabs))

    def test_open_tab_without_type_dropped_when_no_default(self):
        out = normalize_focus_snapshot({
            "openTabs": [
                {"id": "x", "title": "no-type"},
            ],
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        # 无 appType 且 tab 无 type/app_key → 该 tab 被丢；spaceId 仍保留
        self.assertEqual(out.get("spaceId"), "space-1")
        self.assertFalse(out.get("openTabs"))

    def test_path_url_allows_2048_chars(self):
        long_path = "/a" + ("b" * 2000)
        self.assertGreater(len(long_path), MAX_STRING_LEN)
        self.assertLessEqual(len(long_path), MAX_URL_OR_PATH_LEN)
        out = normalize_focus_snapshot({
            "appType": "tabcode",
            "openTabs": [
                {
                    "type": "tabcode",
                    "id": "file-1",
                    "path": long_path,
                    "active": True,
                },
            ],
            "spaceId": "space-1",
        })
        self.assertIsNotNone(out)
        assert out is not None
        tab = next(t for t in out["openTabs"] if t.get("active"))
        self.assertEqual(tab["path"], long_path)
