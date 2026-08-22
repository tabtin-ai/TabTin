"""
Wave 5 场景验证修复回归测试

SP0-06: render_slide_preview 使用 _run_async_safe 替代 asyncio.get_event_loop()
SP1-11 / XC-04: run_post_save_hooks 新增 WebSocket 推送
"""

from __future__ import annotations

import ast
import textwrap
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch, MagicMock


_BASE = Path(__file__).resolve().parent.parent


# ============================================================================
# SP0-06: render_slide_preview 不再使用 asyncio.get_event_loop()
# ============================================================================


class RenderSlidePreviewAsyncSafeTests(TestCase):
    """SP0-06: render_slide_preview 必须使用 _run_async_safe 而非 get_event_loop。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        svc_path = _BASE / "services" / "preview_service.py"
        cls._source = svc_path.read_text(encoding="utf-8")

    def _get_function_body(self, func_name: str) -> str:
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == func_name:
                body = ast.get_source_segment(self._source, node)
                return body or ""
        self.fail(f"Function {func_name} not found in preview_service.py")

    def test_render_slide_preview_uses_run_async_safe(self):
        body = self._get_function_body("render_slide_preview")
        self.assertIn("_run_async_safe", body)

    def test_render_slide_preview_no_get_event_loop(self):
        body = self._get_function_body("render_slide_preview")
        self.assertNotIn("get_event_loop", body)

    def test_render_slide_preview_safe_uses_run_async_safe(self):
        body = self._get_function_body("render_slide_preview_safe")
        self.assertIn("_run_async_safe", body)

    def test_render_slide_preview_safe_no_get_event_loop(self):
        body = self._get_function_body("render_slide_preview_safe")
        self.assertNotIn("get_event_loop", body)

    def test_run_visual_lint_no_get_event_loop(self):
        body = self._get_function_body("run_visual_lint")
        self.assertNotIn("get_event_loop", body)

    def test_run_visual_lint_batch_no_get_event_loop(self):
        body = self._get_function_body("run_visual_lint_batch")
        self.assertNotIn("get_event_loop", body)

    def test_run_async_safe_exists(self):
        """_run_async_safe helper must exist in preview_service.py."""
        self.assertIn("def _run_async_safe(", self._source)

    def test_run_async_safe_uses_get_running_loop(self):
        """_run_async_safe should use get_running_loop (not get_event_loop)."""
        body = self._get_function_body("_run_async_safe")
        self.assertIn("get_running_loop", body)


# ============================================================================
# SP1-11 / XC-04: post_save WebSocket 推送
# ============================================================================


class PostSaveWsPushTests(TestCase):
    """XC-04/SP1-11: run_post_save_hooks 必须包含 WebSocket 推送步骤。"""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._source = (_BASE / "post_save.py").read_text(encoding="utf-8")

    def test_post_save_has_ws_push_function(self):
        self.assertIn("def _push_ws_change_notification(", self._source)

    def test_post_save_calls_ws_push(self):
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_post_save_hooks":
                body = ast.get_source_segment(self._source, node) or ""
                self.assertIn(
                    "_push_ws_change_notification",
                    body,
                    "run_post_save_hooks should call _push_ws_change_notification",
                )
                return
        self.fail("run_post_save_hooks not found")

    def test_ws_push_uses_publish_ws_event(self):
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_push_ws_change_notification":
                body = ast.get_source_segment(self._source, node) or ""
                self.assertIn("publish_ws_event", body)
                return
        self.fail("_push_ws_change_notification not found")

    def test_ws_push_topic_includes_project_id(self):
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "_push_ws_change_notification":
                body = ast.get_source_segment(self._source, node) or ""
                self.assertIn("slide.events.", body)
                self.assertIn("project_id", body)
                return
        self.fail("_push_ws_change_notification not found")

    def test_run_post_save_calls_ws_push(self):
        """run_post_save_hooks must invoke _push_ws_change_notification."""
        tree = ast.parse(self._source)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef) and node.name == "run_post_save_hooks":
                body = ast.get_source_segment(self._source, node) or ""
                self.assertIn("_push_ws_change_notification", body)
                self.assertIn("version=version", body)
                self.assertIn("pages_affected=pages_affected", body)
                return
        self.fail("run_post_save_hooks not found")


# ============================================================================
# WS protocol: slide.events topic registered (source-level check)
# ============================================================================


class SlideEventsTopicTests(TestCase):
    """slide.events topic must be registered in TOPIC_CAPABILITIES."""

    def test_topic_capabilities_includes_slide_events(self):
        protocol_path = (
            _BASE.parent / "services" / "common" / "ws" / "protocol.py"
        )
        source = protocol_path.read_text(encoding="utf-8")
        self.assertIn('"slide.events"', source)
