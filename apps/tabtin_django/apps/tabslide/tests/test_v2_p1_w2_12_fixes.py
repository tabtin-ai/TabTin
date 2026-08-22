"""
W2-12 回归测试：H2-04 修复验证

H2-04: push_pages 失败时的错误处理
  - push_pages: call_live_api_safe 返回 error 时记录 logger.error
  - _push_pages_to_ydoc: 检查 push_pages 返回值并记录 warning
"""

from __future__ import annotations

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

from unittest import TestCase  # noqa: E402
from unittest.mock import patch, MagicMock  # noqa: E402


_PROJECT_ID = "proj-test-w212"
_AGENT_ID = "agent-w212"


class TestAgentPushPagesErrorLogging(TestCase):
    """H2-04: push_pages 在 Y.js 推送失败时记录错误日志。"""

    @patch("apps.services.common.live_api.call_live_api")
    def test_logs_error_when_live_api_returns_error(self, mock_call):
        mock_call.side_effect = Exception("connection refused")
        from apps.tabslide.services.collab_service import SlideCollabService

        with self.assertLogs("apps.tabslide.services.collab_service", level="ERROR") as cm:
            result = SlideCollabService.push_pages(
                project_id=_PROJECT_ID,
                pages=[{"page_id": "p1", "elements": []}],
                editor_type="agent",
            )

        self.assertIn("error", result)
        log_output = "\n".join(cm.output)
        self.assertIn("Y.js sync failed", log_output)
        self.assertIn(_PROJECT_ID, log_output)

    @patch("apps.services.common.live_api.call_live_api")
    def test_no_error_log_on_success(self, mock_call):
        mock_call.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.collab_service import SlideCollabService

        with self.assertLogs("apps.tabslide.services.collab_service", level="INFO") as cm:
            result = SlideCollabService.push_pages(
                project_id=_PROJECT_ID,
                pages=[{"page_id": "p1", "elements": []}],
                editor_type="agent",
            )

        self.assertNotIn("error", result)
        log_output = "\n".join(cm.output)
        self.assertNotIn("sync failed", log_output)


class TestPushPagesToYdocChecksResult(TestCase):
    """H2-04: _push_pages_to_ydoc 检查 push_pages 返回值。"""

    @patch("apps.tabslide.services.collab_service.SlideCollabService.push_pages")
    def test_logs_warning_when_push_returns_error(self, mock_push):
        mock_push.return_value = {"error": "collab-live down", "applied": 0}
        from apps.tabslide.services.slide_service import SlideService

        project = MagicMock()
        project.id = _PROJECT_ID

        with self.assertLogs("apps.tabslide.services.slide_service", level="WARNING") as cm:
            SlideService._push_pages_to_ydoc(
                project,
                pages=[{"page_id": "p1", "elements": []}],
                source="test_w212",
            )

        log_output = "\n".join(cm.output)
        self.assertIn("Y.js page push returned error", log_output)
        self.assertIn("collab-live down", log_output)

    @patch("apps.tabslide.services.collab_service.SlideCollabService.push_pages")
    def test_no_warning_on_success(self, mock_push):
        mock_push.return_value = {"applied": 1, "total": 1}
        from apps.tabslide.services.slide_service import SlideService

        project = MagicMock()
        project.id = _PROJECT_ID

        SlideService._push_pages_to_ydoc(
            project,
            pages=[{"page_id": "p1", "elements": []}],
            source="test_w212_ok",
        )

        mock_push.assert_called_once()

    @patch("apps.tabslide.services.collab_service.SlideCollabService.push_pages")
    def test_exception_caught_and_logged(self, mock_push):
        mock_push.side_effect = RuntimeError("unexpected crash")
        from apps.tabslide.services.slide_service import SlideService

        project = MagicMock()
        project.id = _PROJECT_ID

        with self.assertLogs("apps.tabslide.services.slide_service", level="WARNING") as cm:
            SlideService._push_pages_to_ydoc(
                project,
                pages=[{"page_id": "p1", "elements": []}],
                source="test_w212_exc",
            )

        log_output = "\n".join(cm.output)
        self.assertIn("non-blocking", log_output)
