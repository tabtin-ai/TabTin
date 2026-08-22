"""
DOC-001 回归测试 — push_and_update_binary 不再直接写 description_binary

根因：markdownToUpdateBinary 创建全新 Y.Doc（clock 从 0 开始），
直接写入 DB 的 description_binary 与 Hocuspocus 内存 Y.Doc 的 clock
不兼容，导致下次 fetch 时 CRDT 合并产生内容重复或乱序。

修复：push_and_update_binary 仅推送到 Hocuspocus，description_binary
由 Hocuspocus onStoreDocument → save_from_hocuspocus 回写。

push_and_update_binary 改走 /collab/apply-ops 的 xml.fragment.replace
（Y 层 fragment 清空+重插，真 replace）。
DOC-001 不直接写 binary 的不变量保持不变。
"""
from __future__ import annotations

import inspect
import os
import unittest
from unittest.mock import patch, MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django
django.setup()


class TestDOC001NoBinaryWriteInPush(unittest.TestCase):
    """push_and_update_binary 不应直接写入 description_binary 到 DB。"""

    def test_source_has_no_description_binary_update(self):
        """源码中不应出现 description_binary= 赋值（DB update 调用）。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.push_and_update_binary)

        self.assertNotIn(
            "description_binary=",
            src,
            "push_and_update_binary 不应直接写入 description_binary，"
            "应由 Hocuspocus save_from_hocuspocus 回写",
        )

    def test_source_has_no_filter_update_pattern(self):
        """不应存在 Document.objects.filter(...).update(description_binary=...) 模式。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.push_and_update_binary)

        self.assertNotIn(
            "Document.objects.filter",
            src,
            "push_and_update_binary 不应执行 Document ORM 写操作",
        )

    def test_source_replaces_via_hocuspocus(self):
        """必须保留对 collab-live apply-ops replace command 的调用。"""
        from apps.tabdoc.services.document_service import DocumentService
        src = inspect.getsource(DocumentService.push_and_update_binary)
        replace_src = inspect.getsource(DocumentService._replace_in_hocuspocus)

        self.assertIn(
            "_replace_in_hocuspocus",
            src,
            "push_and_update_binary 必须通过 _replace_in_hocuspocus 推送到 Hocuspocus",
        )
        self.assertIn(
            "xml.fragment.replace",
            replace_src,
            "_replace_in_hocuspocus 必须调用 xml.fragment.replace（整篇替换语义）",
        )
        self.assertNotIn(
            "/docs/replace-content",
            replace_src,
            "_replace_in_hocuspocus 不应再调用已移除的 /docs/replace-content",
        )

    @patch("apps.tabdoc.services.document_service.call_live_api")
    @patch("apps.collab.apply_ops.CollabApplyOpsService.apply_docs_ops")
    def test_push_calls_hocuspocus_only(self, mock_apply_docs_ops, mock_call_live_api):
        """push_and_update_binary 应调用 xml.fragment.replace 推送，但不写 DB。"""
        from apps.tabdoc.services.document_service import DocumentService

        mock_call_live_api.return_value = {"update_b64": "dGVzdA=="}
        mock_apply_docs_ops.return_value = {"status": "ok"}

        mock_document = MagicMock()
        mock_document.id = "test-doc-001"
        mock_document.latest_version = 5

        pm_json = {"type": "doc", "content": [{"type": "paragraph"}]}

        DocumentService.push_and_update_binary(
            mock_document, pm_json, agent_id="test-agent", editor_type="agent",
        )

        mock_apply_docs_ops.assert_called_once()
        call_kwargs = mock_apply_docs_ops.call_args.kwargs
        self.assertEqual(call_kwargs["document_id"], "test-doc-001")
        self.assertEqual(call_kwargs["ops"][0]["op"], "xml.fragment.replace")
        self.assertEqual(call_kwargs["ops"][0]["fragment"], "default")
        self.assertEqual(call_kwargs["editor_id"], "test-agent")
        self.assertEqual(call_kwargs["editor_type"], "agent")
        mock_call_live_api.assert_called_once()
        self.assertEqual(
            mock_call_live_api.call_args.args[0],
            "/convert/pm-json-to-update",
        )

    @patch("apps.tabdoc.services.document_service.call_live_api")
    @patch("apps.collab.apply_ops.CollabApplyOpsService.apply_docs_ops")
    def test_push_falls_back_to_markdown_conversion(self, mock_apply_docs_ops, mock_call_live_api):
        """旧 collab-live 未提供 pm-json-to-update 时，保留 Markdown fallback。"""
        from apps.tabdoc.services.document_service import DocumentService

        mock_call_live_api.side_effect = [
            RuntimeError("not found"),
            {"update_b64": "dGVzdA=="},
        ]
        mock_apply_docs_ops.return_value = {"status": "ok"}

        mock_document = MagicMock()
        mock_document.id = "test-doc-fallback"
        mock_document.latest_version = 5

        pm_json = {"type": "doc", "content": [{"type": "paragraph"}]}

        with patch(
            "apps.tabdoc.services.markdown_exchange.pm_json_to_markdown",
            return_value="# replaced",
        ):
            DocumentService.push_and_update_binary(
                mock_document, pm_json, agent_id="test-agent", editor_type="agent",
            )

        self.assertEqual(mock_call_live_api.call_count, 2)
        self.assertEqual(mock_call_live_api.call_args_list[0].args[0], "/convert/pm-json-to-update")
        self.assertEqual(mock_call_live_api.call_args_list[1].args[0], "/convert/markdown-to-update")
        mock_apply_docs_ops.assert_called_once()

    @patch("apps.tabdoc.services.document_service.call_live_api")
    @patch("apps.collab.apply_ops.CollabApplyOpsService.apply_docs_ops")
    def test_push_failure_does_not_write_binary(self, mock_apply_docs_ops, mock_call_live_api):
        """Hocuspocus replace 失败时不应写 description_binary（非阻塞吞掉异常）。"""
        from apps.tabdoc.services.document_service import DocumentService

        mock_call_live_api.return_value = {"update_b64": "dGVzdA=="}
        mock_apply_docs_ops.return_value = {"status": "error", "message": "collab-live 不可达"}

        mock_document = MagicMock()
        mock_document.id = "test-doc-002"
        mock_document.latest_version = 3

        pm_json = {"type": "doc", "content": [{"type": "paragraph"}]}

        with patch(
            "apps.tabdoc.services.markdown_exchange.pm_json_to_markdown",
            return_value="# replaced",
        ):
            DocumentService.push_and_update_binary(
                mock_document, pm_json, agent_id="test-agent", editor_type="agent",
            )

    def test_docstring_mentions_doc001(self):
        """docstring 应包含 DOC-001 标记，方便追溯。"""
        from apps.tabdoc.services.document_service import DocumentService
        docstring = DocumentService.push_and_update_binary.__doc__ or ""
        self.assertIn("DOC-001", docstring)


if __name__ == "__main__":
    unittest.main()
