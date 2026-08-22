"""
chat.send_message · FocusSnapshot 入口接线特征测试（ P0）。

``manage.py test`` 可发现（SimpleTestCase）。旧
``test_chat_send_message_handler.py`` 是 pytest 风格类，Django runner
扫不到——本文件补 WS 路径的可发现回归。
"""
from __future__ import annotations

import asyncio
import os
import sys
import time
import uuid
from unittest.mock import AsyncMock, MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from django.test import SimpleTestCase  # noqa: E402

from apps.services.common.ws.handlers.chat_send_message import (  # noqa: E402
    create_chat_send_message_handler,
)


def _build_envelope(*, metadata=None, app_context=None, role: str = "mobile"):
    payload: dict = {
        "session_id": "00000000-0000-0000-0000-000000000001",
        "message": "hello",
        "client_event_id": str(uuid.uuid4()),
    }
    if metadata is not None:
        payload["metadata"] = metadata
    if app_context is not None:
        payload["app_context"] = app_context
    return {
        "v": 1,
        "type": "chat.send_message",
        "request_id": "req-focus-1",
        "ts": int(time.time()),
        "device_id": "test-device",
        "role": role,
        "payload": payload,
    }


def _make_consumer(role: str = "mobile", user_id: str = "user-1"):
    consumer = MagicMock()
    consumer.role = role
    consumer.user_id = user_id
    consumer.user = MagicMock(id=user_id)
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _patch_project_task_gate(return_value=None):
    return patch(
        "apps.services.common.ws.handlers.chat_send_message._evaluate_project_task_chat_send_gate",
        return_value=return_value,
    )


class ChatSendMessageFocusSnapshotTests(SimpleTestCase):
    def _patch_resolve_session(self):
        session = MagicMock(
            id="sess-1",
            execution_agent_id=None,
            fork_copy_status=None,
            is_paused=False,
        )
        return patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=session),
        )

    def _capture_app_context(self, *, role: str = "mobile", metadata=None, app_context=None):
        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return {
                "message_id": "msg-1",
                "reply": "ok",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
            }

        consumer = _make_consumer(role=role)
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(metadata=metadata, app_context=app_context, role=role)
        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_capture,
        ):
            asyncio.run(handler(env))
        return captured.get("app_context") or {}

    def test_electron_camel_focus_preserved_as_canonical(self):
        ctx = self._capture_app_context(
            role="electron",
            app_context={
                "appType": "tabdoc",
                "appMeta": {
                    "current_doc_id": "doc-camel-1",
                    "current_doc_title": "Remote Doc",
                    "idField": "current_doc_id",
                    "titleField": "current_doc_title",
                },
                "openTabs": [
                    {
                        "type": "tabdoc",
                        "id": "doc-camel-1",
                        "title": "Remote Doc",
                        "active": True,
                        "app_key": "tabdoc",
                    },
                ],
                "spaceId": "space-camel-1",
                "userTimeZone": "Asia/Shanghai",
            },
        )
        self.assertEqual(ctx.get("appType"), "tabdoc")
        self.assertEqual(ctx.get("spaceId"), "space-camel-1")
        self.assertEqual(ctx.get("userTimeZone"), "Asia/Shanghai")
        self.assertEqual((ctx.get("appMeta") or {}).get("current_doc_id"), "doc-camel-1")
        tabs = ctx.get("openTabs") or []
        self.assertTrue(any(t.get("active") and t.get("id") == "doc-camel-1" for t in tabs))
        self.assertEqual(ctx.get("current_app_type"), "tabdoc")
        self.assertEqual(ctx.get("current_doc_id"), "doc-camel-1")
        self.assertEqual(ctx.get("current_space_id"), "space-camel-1")

    def test_mobile_flat_focus_normalized_to_host_shape(self):
        ctx = self._capture_app_context(
            role="mobile",
            app_context={
                "current_app_type": "tabdoc",
                "current_doc_id": "doc-flat-1",
                "current_doc_title": "Flat Doc",
                "current_space_id": "space-flat-1",
                "user_time_zone": "Asia/Shanghai",
            },
        )
        self.assertEqual(ctx.get("appType"), "tabdoc")
        self.assertEqual(ctx.get("spaceId"), "space-flat-1")
        self.assertEqual(ctx.get("userTimeZone"), "Asia/Shanghai")
        self.assertEqual((ctx.get("appMeta") or {}).get("current_doc_id"), "doc-flat-1")
        self.assertEqual((ctx.get("appMeta") or {}).get("current_doc_title"), "Flat Doc")
        tabs = ctx.get("openTabs") or []
        self.assertTrue(any(t.get("active") and t.get("id") == "doc-flat-1" for t in tabs))
        self.assertEqual(ctx.get("current_app_type"), "tabdoc")
        self.assertEqual(ctx.get("current_space_id"), "space-flat-1")

    def test_focus_dangerous_fields_fail_closed(self):
        ctx = self._capture_app_context(
            metadata={"runtime_mode": "EVIL", "client_locale": "zh-CN"},
            app_context={
                "appType": "tabdoc",
                "appMeta": {
                    "current_doc_id": "doc-safe",
                    "billing_precheck_source": "EVIL",
                    "runtime_mode": "EVIL",
                    "forged_secret": "nope",
                },
                "spaceId": "space-1",
                "billing_precheck_source": "EVIL",
                "runtime_mode": "EVIL",
                "selected_text": "explicit-selection",
            },
        )
        self.assertNotIn("billing_precheck_source", ctx)
        self.assertNotIn("runtime_mode", ctx)
        self.assertNotIn("_client_metadata_runtime_mode", ctx)
        meta = ctx.get("appMeta") or {}
        self.assertEqual(meta.get("current_doc_id"), "doc-safe")
        self.assertNotIn("billing_precheck_source", meta)
        self.assertNotIn("runtime_mode", meta)
        self.assertNotIn("forged_secret", meta)
        self.assertEqual(ctx.get("selected_text"), "explicit-selection")
        self.assertNotIn("selected_text", meta)
        self.assertEqual(ctx.get("_client_metadata_client_locale"), "zh-CN")

    def test_focus_size_limits_fail_closed(self):
        ctx = self._capture_app_context(
            app_context={
                "appType": "tabdoc",
                "appMeta": {
                    "current_doc_id": "doc-limit",
                    "current_doc_title": "T" * 10_000,
                    "nested_payload": {"a": {"b": {"c": {"d": "deep"}}}},
                },
                "openTabs": [
                    {"type": "tabdoc", "id": f"doc-{i}", "title": f"t{i}", "active": i == 0}
                    for i in range(50)
                ],
                "spaceId": "space-limit",
            },
        )
        meta = ctx.get("appMeta") or {}
        self.assertEqual(meta.get("current_doc_id"), "doc-limit")
        title = meta.get("current_doc_title") or ""
        self.assertIsInstance(title, str)
        self.assertLess(len(title), 10_000)
        self.assertNotIn("nested_payload", meta)
        tabs = ctx.get("openTabs") or []
        self.assertGreater(len(tabs), 0)
        self.assertLessEqual(len(tabs), 20)
        self.assertTrue(any(t.get("active") for t in tabs))

    def test_client_forged_identity_stripped_at_ws_entry(self):
        """#8571 P1-1：WS 入口剥离客户端伪造的执行身份字段。"""
        ctx = self._capture_app_context(
            role="electron",
            app_context={
                "appType": "tabdoc",
                "appMeta": {"current_doc_id": "doc-1"},
                "spaceId": "space-1",
                "collaborationSpaceId": "forged-collab",
                "executionSpaceId": "forged-exec",
                "initiatorUserId": "forged-user",
                "executionOwnerUserId": "forged-owner",
            },
        )
        self.assertEqual(ctx.get("appType"), "tabdoc")
        self.assertEqual(ctx.get("spaceId"), "space-1")
        self.assertNotIn("collaborationSpaceId", ctx)
        self.assertNotIn("executionSpaceId", ctx)
        self.assertNotIn("initiatorUserId", ctx)
        self.assertNotIn("executionOwnerUserId", ctx)
        self.assertNotIn("_server_focus_authority", ctx)

    def test_forged_project_task_anchors_stripped_at_ws_entry(self):
        ctx = self._capture_app_context(
            app_context={
                "appType": "project_task",
                "appMeta": {
                    "project_id": "forged-proj",
                    "task_id": "forged-task",
                    "task_run_id": "forged-run",
                },
                "spaceId": "ws-1",
            },
        )
        meta = ctx.get("appMeta") or {}
        self.assertNotIn("project_id", meta)
        self.assertNotIn("task_id", meta)
        self.assertNotIn("task_run_id", meta)
