"""tabdoc preview_document_history view 测试（R-A2 修复回归保护）

修复背景：``apps/tabtin_django/apps/tabdoc/api.py`` 的
``preview_document_history`` view 之前在 ``format == "yjs_binary"`` 分支
catch 异常后静默设 ``markdown = ""`` + 返回 200。

后果：
- CLI 收到 ``{"markdown": ""}`` + status=0，无法区分"该版本本来就空"
  和"collab-live 不可用，版本根本没转出来"。
- agent 把"空预览"当真，继续做下一步决策。

修复：catch 后直接返回 ``503 UPSTREAM_UNAVAILABLE``，让 CLI 走非 0 退出码、
agent 能感知降级；``json_snapshot`` 分支不依赖 collab-live，继续走 200。

本文件验证：

1. yjs_binary + ``call_live_api`` 抛异常 → 503 / UPSTREAM_UNAVAILABLE
2. json_snapshot → 不受影响，仍 200 + 正确 markdown
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import MagicMock, patch

from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase


class _PreviewHistoryTestBase(SimpleTestCase):
    """preview_document_history view 是 async + run_in_agent_io_executor，
    线程池里跑 ORM。本测试为避免 SQLite + async executor 的 lock 问题，
    把 ``_build_service`` 整个替换成 ``MagicMock``，业务断言只关心 view 的
    分支行为（503 vs 200），不涉及真实 ORM。
    """

    def setUp(self):
        self.factory = RequestFactory()
        # 假 user，view 里只用 ``if not request.auth`` 判空。
        self.fake_user = MagicMock()
        self.fake_user.id = "user-1"

    def _request(self, doc_id: str = "doc-123", history_id: str = "h-1"):
        request = self.factory.get(
            f"/api/tabdoc/documents/{doc_id}/histories/{history_id}/preview",
        )
        request.auth = self.fake_user
        return request

    @staticmethod
    def _build_fake_service(resolved_value):
        """构造一个 fake service，仿照 ``DocumentService`` 的 view 调用面：
        ``get_document(...)`` + ``_resolve_history_content_by_id(...)``。
        """
        fake_doc = MagicMock(name="Document")
        service = MagicMock(name="DocumentService")
        service.get_document.return_value = fake_doc
        service._resolve_history_content_by_id.return_value = resolved_value
        return service


class PreviewHistoryYjsBinary503Tests(_PreviewHistoryTestBase):
    """R-A2：collab-live 不可用时 preview yjs_binary 应 503 而非静默 200/markdown=''。"""

    def test_preview_yjs_binary_returns_503_when_collab_live_down(self):
        from apps.tabdoc.api import preview_document_history

        request = self._request(doc_id="doc-yjs", history_id="hist-yjs")
        service = self._build_fake_service(
            {"format": "yjs_binary", "binary": b"fake-yjs-bytes"},
        )

        with patch(
            "apps.tabdoc.api._build_service", return_value=service,
        ), patch(
            "apps.services.common.live_api.call_live_api",
            side_effect=RuntimeError("collab-live socket refused"),
        ):
            response = asyncio.run(
                preview_document_history(request, "doc-yjs", "hist-yjs"),
            )

        # 503 走 error_response_with_status → JsonResponse
        self.assertIsInstance(
            response, JsonResponse,
            f"503 路径应返回 JsonResponse，实际 {type(response).__name__}",
        )
        self.assertEqual(
            response.status_code, 503,
            f"collab-live 不可用应 503，实际 {response.status_code}",
        )

        body = json.loads(response.content.decode("utf-8"))
        self.assertEqual(body.get("code"), "UPSTREAM_UNAVAILABLE")
        self.assertFalse(body.get("success", True))
        self.assertIn("collab-live", body.get("message", ""))
        # hint 必须含有可操作信息
        data = body.get("data") or {}
        self.assertIn("hint", data)
        self.assertEqual(data.get("document_id"), "doc-yjs")
        self.assertEqual(data.get("history_id"), "hist-yjs")

    def test_preview_json_snapshot_not_affected_by_a2(self):
        """json_snapshot 分支不依赖 collab-live，A2 修法不应误伤该路径。"""
        from apps.tabdoc.api import preview_document_history

        request = self._request(doc_id="doc-snap", history_id="hist-snap")
        service = self._build_fake_service(
            {
                "format": "json_snapshot",
                "description_markdown": "# Title\nbody",
            },
        )

        with patch("apps.tabdoc.api._build_service", return_value=service):
            response = asyncio.run(
                preview_document_history(request, "doc-snap", "hist-snap"),
            )

        # success_response 返回 dict（ninja 后续包成 JsonResponse）
        self.assertIsInstance(
            response, dict,
            f"json_snapshot 成功路径应返回 dict，实际 {type(response).__name__}",
        )
        self.assertTrue(response.get("success"))
        data = response.get("data") or {}
        self.assertEqual(data.get("markdown"), "# Title\nbody")
        self.assertEqual(data.get("history_id"), "hist-snap")
