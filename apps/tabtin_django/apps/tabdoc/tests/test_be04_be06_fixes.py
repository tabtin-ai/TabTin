"""
BE-04 / BE-06 修复验证测试

- BE-04: archive_document 事务原子性
- BE-06: merge_updates 中 description_markdown 字段取值修正
"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, PropertyMock


# ---------------------------------------------------------------------------
# BE-04: archive_document 应使用 @transaction.atomic(using="postgresql")
# ---------------------------------------------------------------------------

class TestArchiveDocumentTransaction(unittest.TestCase):
    """验证 archive_document 被 @transaction.atomic(using="postgresql") 装饰。"""

    def test_archive_document_has_transaction_atomic_decorator(self):
        """BE-04: archive_document 必须有 @transaction.atomic 装饰器。"""
        from apps.tabdoc.services.document_service import DocumentService

        method = DocumentService.archive_document

        # Django transaction.atomic 装饰的函数会被包装，
        # 检查 _wrapper_name 或 __wrapped__ 属性
        # 或检查函数是否被 Atomic 包装
        from django.db import transaction

        # 检查方法源码中是否包含 transaction.atomic
        import inspect
        source = inspect.getsource(DocumentService)
        # 找到 archive_document 定义前的装饰器
        lines = source.split("\n")
        found_decorator = False
        for i, line in enumerate(lines):
            if "def archive_document" in line:
                # 检查前面几行是否有 @transaction.atomic
                for j in range(max(0, i - 3), i):
                    if "@transaction.atomic" in lines[j] and "postgresql" in lines[j]:
                        found_decorator = True
                break
        self.assertTrue(
            found_decorator,
            "archive_document 缺少 @transaction.atomic(using='postgresql') 装饰器"
        )

    def test_archive_rolls_back_on_bridge_failure(self):
        """BE-04: ResourceBridge.on_archive 失败时，document.save 应被回滚。"""
        from apps.tabdoc.services.document_service import DocumentService

        mock_doc = MagicMock()
        mock_doc.status = "active"
        mock_doc.id = "doc-test-be04"

        service = DocumentService(user=MagicMock())

        with patch.object(service, "assert_document_viewable"):
            with patch.object(service, "check_document_permission", return_value=True):
                with patch.object(service, "_safe_user_for_fk", return_value=None):
                    with patch(
                        "apps.tabdoc.services.document_service.ResourceBridge.on_archive",
                        side_effect=RuntimeError("bridge failed"),
                    ):
                        with self.assertRaises(RuntimeError):
                            service.archive_document(mock_doc)

        # 事务回滚后 save 的效果应被撤销 —— 由 @transaction.atomic 保证
        # 这里验证 on_archive 失败确实抛出异常而非静默吞噬
        # 数据库级回滚在集成测试中验证更可靠


# ---------------------------------------------------------------------------
# BE-06: merge_updates 应使用 formats.get("markdown") 而非 formats.get("html")
# ---------------------------------------------------------------------------

class TestMergeUpdatesMarkdownField(unittest.TestCase):
    """验证 merge_updates 使用正确的 formats key 写入 description_markdown。"""

    def _make_service(self):
        from apps.tabdoc.services.document_service import DocumentService
        return DocumentService(user=None)

    def test_merge_updates_uses_markdown_key(self):
        """BE-06: merge_updates 应取 formats['markdown'] 而非 formats['html']。"""
        service = self._make_service()

        fake_update = SimpleNamespace(
            id="upd-1",
            blob=b"\x01\x02\x03",
            editor_type="user",
            editor_id="user-1",
            created_at=None,
        )
        mock_doc = MagicMock()
        mock_doc.id = "doc-be06"
        mock_doc.updates.order_by.return_value = [fake_update]

        formats_response = {
            "html": "<p>Hello World</p>",
            "markdown": "Hello World",
            "json": {"type": "doc", "content": []},
            "plaintext": "Hello World",
        }

        with patch(
            "apps.tabdoc.services.document_service.call_live_api",
            return_value=formats_response,
        ):
            with patch(
                "apps.tabdoc.services.document_service.DocUpdate"
            ) as MockDocUpdate:
                filter_mock = MagicMock()
                MockDocUpdate.objects.filter.return_value = filter_mock
                with patch(
                    "apps.tabdoc.services.document_service.Document"
                ) as MockDocument:
                    filter_update_mock = MagicMock()
                    MockDocument.objects.filter.return_value = filter_update_mock

                    result = service.merge_updates(mock_doc)

        self.assertTrue(result)

        # 验证 update 调用时 description_markdown 使用了 markdown key 的值
        filter_update_mock.update.assert_called_once()
        call_kwargs = filter_update_mock.update.call_args
        self.assertEqual(
            call_kwargs.kwargs.get("description_markdown")
            or call_kwargs[1].get("description_markdown"),
            "Hello World",
            "description_markdown 应使用 formats['markdown'] 而非 formats['html']",
        )
        # 确保不是 HTML 值
        md_val = (
            call_kwargs.kwargs.get("description_markdown")
            or call_kwargs[1].get("description_markdown")
        )
        self.assertNotEqual(
            md_val,
            "<p>Hello World</p>",
            "description_markdown 不应存储 HTML 内容",
        )

    def test_merge_updates_markdown_key_missing_falls_back_to_empty(self):
        """当 formats 无 markdown key 时，应 fallback 为空字符串而非 HTML。"""
        service = self._make_service()

        fake_update = SimpleNamespace(
            id="upd-2",
            blob=b"\x01",
            editor_type="agent",
            editor_id="agent-1",
            created_at=None,
        )
        mock_doc = MagicMock()
        mock_doc.id = "doc-be06-2"
        mock_doc.updates.order_by.return_value = [fake_update]

        # 模拟旧版 collab-live 不返回 markdown key
        formats_response = {
            "html": "<p>Fallback</p>",
            "json": {},
            "plaintext": "Fallback",
        }

        with patch(
            "apps.tabdoc.services.document_service.call_live_api",
            return_value=formats_response,
        ):
            with patch(
                "apps.tabdoc.services.document_service.DocUpdate"
            ) as MockDocUpdate:
                MockDocUpdate.objects.filter.return_value = MagicMock()
                with patch(
                    "apps.tabdoc.services.document_service.Document"
                ) as MockDocument:
                    filter_mock = MagicMock()
                    MockDocument.objects.filter.return_value = filter_mock

                    service.merge_updates(mock_doc)

        call_kwargs = filter_mock.update.call_args
        md_val = (
            call_kwargs.kwargs.get("description_markdown")
            or call_kwargs[1].get("description_markdown")
        )
        self.assertEqual(md_val, "", "无 markdown key 时应 fallback 为空字符串")


if __name__ == "__main__":
    unittest.main()
