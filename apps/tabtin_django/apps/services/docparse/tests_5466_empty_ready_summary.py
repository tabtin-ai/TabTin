"""
#5466：ParsedDocument 已 ready 但 summary 为空时，/summary 不得再返回 pending。
"""

from __future__ import annotations

import uuid
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, SimpleTestCase

from apps.services.docparse.api import get_summary
from apps.services.docparse.models import ParsedDocument


class _FakeUser:
    def __init__(self, user_id=None):
        self.id = user_id or uuid.uuid4()
        self.is_active = True


class GetSummaryEmptyReadyTests(SimpleTestCase):
    def _request(self, user_id=None):
        request = RequestFactory().get("/")
        request.auth = _FakeUser(user_id=user_id)
        return request

    @patch("apps.services.docparse.api.DocParseService.parse_async")
    @patch("apps.services.docparse.api.DocParseService.get_summary", return_value="")
    @patch("apps.services.docparse.api._check_file_ownership")
    @patch("apps.services.docparse.api.ParsedDocument")
    def test_ready_empty_summary_returns_ready_not_pending(
        self,
        mock_pd_cls,
        mock_ownership,
        mock_get_summary,
        mock_parse_async,
    ):
        file_id = str(uuid.uuid4())
        user_id = str(uuid.uuid4())
        mock_ownership.return_value = (MagicMock(id=file_id), None)

        parsed = MagicMock()
        parsed.status = ParsedDocument.Status.READY
        parsed.title = ""
        parsed.total_pages = 1
        mock_pd_cls.objects.filter.return_value.first.return_value = parsed
        mock_pd_cls.Status = ParsedDocument.Status

        result = get_summary(self._request(user_id=user_id), file_id, max_tokens=2000)

        self.assertEqual(result["status"], "ready")
        self.assertEqual(result["summary"], "")
        self.assertIn("未提取到可用文本", result.get("message", ""))
        mock_parse_async.assert_not_called()

    @patch("apps.services.docparse.api.DocParseService.parse_async")
    @patch("apps.services.docparse.api.DocParseService.get_summary", return_value="")
    @patch("apps.services.docparse.api._check_file_ownership")
    @patch("apps.services.docparse.api.ParsedDocument")
    def test_missing_parsed_doc_still_triggers_pending(
        self,
        mock_pd_cls,
        mock_ownership,
        mock_get_summary,
        mock_parse_async,
    ):
        file_id = str(uuid.uuid4())
        mock_ownership.return_value = (MagicMock(id=file_id), None)
        mock_pd_cls.objects.filter.return_value.first.return_value = None
        mock_pd_cls.Status = ParsedDocument.Status

        result = get_summary(self._request(), file_id, max_tokens=2000)

        self.assertEqual(result["status"], "pending")
        mock_parse_async.assert_called_once_with(file_id)

    @patch("apps.services.docparse.api.DocParseService.parse_async")
    @patch(
        "apps.services.docparse.api.DocParseService.get_summary",
        return_value="# 标题\n\n有足够长度的正文内容用于注入 Agent 上下文。",
    )
    @patch("apps.services.docparse.api._check_file_ownership")
    @patch("apps.services.docparse.api.ParsedDocument")
    def test_ready_with_summary_still_returns_body(
        self,
        mock_pd_cls,
        mock_ownership,
        mock_get_summary,
        mock_parse_async,
    ):
        file_id = str(uuid.uuid4())
        mock_ownership.return_value = (MagicMock(id=file_id), None)
        parsed = MagicMock()
        parsed.status = ParsedDocument.Status.READY
        parsed.title = "Demo"
        parsed.total_pages = 2
        mock_pd_cls.objects.filter.return_value.first.return_value = parsed
        mock_pd_cls.Status = ParsedDocument.Status

        result = get_summary(self._request(), file_id, max_tokens=2000)

        self.assertEqual(result["status"], "ready")
        self.assertIn("有足够长度的正文", result["summary"])
        self.assertEqual(result["title"], "Demo")
        mock_parse_async.assert_not_called()
