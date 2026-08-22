"""
E2E-2 / E2E-3 修复的单元测试。

E2E-2: save_from_hocuspocus 当 description_json=None 时，
       必须从 binary 实时转换，避免竞态导致 JSON 与 binary 不一致。
E2E-3: get_document 权限检查必须先于 trash 状态检查，
       restore_from_trash 端点必须独立验证文档在回收站中。
"""
from __future__ import annotations

import contextlib
import json
import uuid
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model

from apps.tabdoc.services.document_service import DocumentService

User = get_user_model()


# ── E2E-2 测试 ──


class TestSaveFromHocuspocusRaceFix(unittest.TestCase):
    """E2E-2: description_json=None 时应从 binary 转换，而不是跳过更新。"""

    def _make_doc(self, doc_id=None):
        """构造一个伪 Document 对象。"""
        doc = SimpleNamespace(
            id=doc_id or uuid.uuid4(),
            description_binary=b"old-binary",
            space_id=uuid.uuid4(),
            collab_enabled=True,
            status="active",
            trashed_at=None,
            latest_version=5,
        )
        return doc

    @staticmethod
    def _prime_doc_qs(mock_doc_qs, doc):
        """让 mock 的 Document.objects 支持 save_from_hocuspocus 的写入链：
        using().select_for_update().get()（CAS 版本比对）+ filter().update()。"""
        mock_doc_qs.using.return_value = mock_doc_qs
        mock_doc_qs.select_for_update.return_value = mock_doc_qs
        mock_doc_qs.get.return_value = SimpleNamespace(latest_version=doc.latest_version)
        mock_doc_qs.filter.return_value = mock_doc_qs
        mock_doc_qs.update.return_value = 1

    @patch("apps.tabdoc.services.document_service.Document.objects")
    @patch("apps.tabdoc.services.document_service.DocUpdate.objects")
    @patch("apps.tabdoc.services.document_service.call_live_api")
    def test_json_none_triggers_binary_conversion(self, mock_live_api, mock_docupdate_qs, mock_doc_qs):
        """当 description_json=None 时，应调用 call_live_api 从 binary 转换格式。"""
        doc = self._make_doc()
        new_blob = b"new-binary-data"

        mock_live_api.return_value = {
            "json": {"type": "doc", "content": [{"type": "paragraph"}]},
            "markdown": "# Hello",
            "plaintext": "Hello",
        }
        mock_docupdate_qs.create.return_value = SimpleNamespace(id=uuid.uuid4())
        self._prime_doc_qs(mock_doc_qs, doc)

        service = DocumentService(user=None)
        with patch.object(service, "assert_document_collab_writable"), \
             patch("apps.tabdoc.services.document_service.transaction.atomic", lambda *a, **k: contextlib.nullcontext()), \
             patch.object(User.objects, "get", side_effect=User.DoesNotExist):
            result = service.save_from_hocuspocus(
                doc,
                update_blob=new_blob,
                editor_type="agent",
                editor_id="test-agent",
                description_json=None,   # 关键：json 为 None
                description_html=None,
            )

        self.assertIsNotNone(result)
        # 验证 call_live_api 被调用（从 binary 转换）
        mock_live_api.assert_called_once()
        call_args = mock_live_api.call_args
        self.assertEqual(call_args[0][0], "/convert/binary-to-formats")

        # 验证 update 中包含 description_json
        update_call = mock_doc_qs.update.call_args
        update_kwargs = update_call[1]
        self.assertIn("description_json", update_kwargs)
        self.assertEqual(update_kwargs["description_json"], {"type": "doc", "content": [{"type": "paragraph"}]})
        self.assertEqual(update_kwargs["description_markdown"], "# Hello")
        self.assertEqual(update_kwargs["description_plaintext"], "Hello")

    @patch("apps.tabdoc.services.document_service.Document.objects")
    @patch("apps.tabdoc.services.document_service.DocUpdate.objects")
    @patch("apps.tabdoc.services.document_service.call_live_api")
    def test_json_provided_uses_directly(self, mock_live_api, mock_docupdate_qs, mock_doc_qs):
        """当 description_json 有值时，应直接使用，不调用 call_live_api。"""
        doc = self._make_doc()
        new_blob = b"new-binary-data"
        provided_json = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "Hi"}]}]}

        mock_docupdate_qs.create.return_value = SimpleNamespace(id=uuid.uuid4())
        self._prime_doc_qs(mock_doc_qs, doc)

        service = DocumentService(user=None)
        with patch.object(service, "assert_document_collab_writable"), \
             patch("apps.tabdoc.services.document_service.transaction.atomic", lambda *a, **k: contextlib.nullcontext()), \
             patch.object(User.objects, "get", side_effect=User.DoesNotExist), \
             patch("apps.tabdoc.services.markdown_exchange.pm_json_to_markdown", return_value="Hi"):
            result = service.save_from_hocuspocus(
                doc,
                update_blob=new_blob,
                editor_type="agent",
                editor_id="test-agent",
                description_json=provided_json,
            )

        self.assertIsNotNone(result)
        # 不应调用 call_live_api
        mock_live_api.assert_not_called()
        # update 应直接使用提供的 JSON
        update_kwargs = mock_doc_qs.update.call_args[1]
        self.assertEqual(update_kwargs["description_json"], provided_json)

    @patch("apps.tabdoc.services.document_service.Document.objects")
    @patch("apps.tabdoc.services.document_service.DocUpdate.objects")
    @patch("apps.tabdoc.services.document_service.call_live_api", side_effect=RuntimeError("collab-live down"))
    def test_json_none_collab_live_unavailable_fallback(self, mock_live_api, mock_docupdate_qs, mock_doc_qs):
        """当 description_json=None 且 collab-live 不可用时，应降级到 description_html。"""
        doc = self._make_doc()
        new_blob = b"new-binary-data"

        mock_docupdate_qs.create.return_value = SimpleNamespace(id=uuid.uuid4())
        self._prime_doc_qs(mock_doc_qs, doc)

        service = DocumentService(user=None)
        with patch.object(service, "assert_document_collab_writable"), \
             patch("apps.tabdoc.services.document_service.transaction.atomic", lambda *a, **k: contextlib.nullcontext()), \
             patch.object(User.objects, "get", side_effect=User.DoesNotExist):
            result = service.save_from_hocuspocus(
                doc,
                update_blob=new_blob,
                editor_type="agent",
                editor_id="test-agent",
                description_json=None,
                description_html="<p>fallback html</p>",
            )

        self.assertIsNotNone(result)
        update_kwargs = mock_doc_qs.update.call_args[1]
        # 降级时 description_json 不在 update 中（没有可靠数据）
        self.assertNotIn("description_json", update_kwargs)
        # description_markdown 应使用 html 降级值
        self.assertEqual(update_kwargs["description_markdown"], "<p>fallback html</p>")


# ── E2E-3 测试 ──


class TestGetDocumentPermissionOrderFix(unittest.TestCase):
    """E2E-3: 权限检查必须先于 trash 状态检查。"""

    def _make_service_with_user(self, has_permission=True):
        """构造一个 mock service。"""
        user = SimpleNamespace(id=uuid.uuid4())
        service = DocumentService(user=user)
        service.check_document_permission = MagicMock(return_value=has_permission)
        return service

    @patch("apps.tabdoc.services.document_service.Document.objects")
    def test_no_permission_raises_before_trash_check(self, mock_doc_qs):
        """无权限用户访问已删除文档时，应先收到权限错误，而不是 trash 错误。"""
        doc = SimpleNamespace(
            id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            trashed_at="2026-03-01T00:00:00Z",  # 已删除
            parent=None,
        )
        mock_doc_qs.select_related.return_value = mock_doc_qs
        mock_doc_qs.prefetch_related.return_value = mock_doc_qs
        mock_doc_qs.filter.return_value = mock_doc_qs
        mock_doc_qs.first.return_value = doc

        service = self._make_service_with_user(has_permission=False)

        # 关键断言：应抛出 PermissionError 而不是 ValueError("in trash")
        with self.assertRaises(PermissionError):
            service.get_document(str(doc.id), required_role="viewer")

    @patch("apps.tabdoc.services.document_service.Document.objects")
    def test_permission_ok_trashed_doc_raises_trash_error(self, mock_doc_qs):
        """有权限用户访问已删除文档（allow_trashed=False），应收到 trash 错误。"""
        doc = SimpleNamespace(
            id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            trashed_at="2026-03-01T00:00:00Z",
            parent=None,
        )
        mock_doc_qs.select_related.return_value = mock_doc_qs
        mock_doc_qs.prefetch_related.return_value = mock_doc_qs
        mock_doc_qs.filter.return_value = mock_doc_qs
        mock_doc_qs.first.return_value = doc

        service = self._make_service_with_user(has_permission=True)

        with self.assertRaises(ValueError) as ctx:
            service.get_document(str(doc.id), required_role="viewer")
        # 错误信息应关于回收站（中文消息）
        err_msg = str(ctx.exception)
        self.assertTrue("trash" in err_msg.lower() or "回收站" in err_msg, f"Unexpected error: {err_msg}")

    @patch("apps.tabdoc.services.document_service.Document.objects")
    def test_allow_trashed_bypasses_trash_check(self, mock_doc_qs):
        """allow_trashed=True 时，有权限用户可以获取已删除文档。"""
        doc = SimpleNamespace(
            id=uuid.uuid4(),
            space_id=uuid.uuid4(),
            trashed_at="2026-03-01T00:00:00Z",
            parent=None,
        )
        mock_doc_qs.select_related.return_value = mock_doc_qs
        mock_doc_qs.prefetch_related.return_value = mock_doc_qs
        mock_doc_qs.filter.return_value = mock_doc_qs
        mock_doc_qs.first.return_value = doc

        service = self._make_service_with_user(has_permission=True)
        result = service.get_document(str(doc.id), required_role="editor", allow_trashed=True)
        self.assertEqual(result.id, doc.id)


class TestRestoreFromTrashEndpointFix(unittest.TestCase):
    """E2E-3 / ：restore_from_trash 必须拒绝未在回收站的文档。"""

    @patch("apps.tabdoc.api._build_service")
    def test_restore_non_trashed_doc_returns_error(self, mock_build_service):
        """对未在回收站的文档调用 restore 应返回验证错误。"""
        from apps.tabdoc.api import restore_document_from_trash

        doc = SimpleNamespace(
            id=uuid.uuid4(),
            trashed_at=None,  # 不在回收站
            title="test",
            status="active",
        )
        mock_service = MagicMock()
        mock_service.get_trashed_document_for_personal_trash.side_effect = ValueError(
            "文档不在回收站中"
        )
        mock_build_service.return_value = mock_service

        request = SimpleNamespace(auth=SimpleNamespace(id=uuid.uuid4()))
        response = restore_document_from_trash(request, str(doc.id))

        # 应返回错误而不是调用 restore_document
        mock_service.restore_document.assert_not_called()
        self.assertEqual(response.status_code, 400)
        body = json.loads(response.content)
        self.assertFalse(body["success"])
        self.assertEqual(body["code"], "VALIDATION_ERROR")


if __name__ == "__main__":
    unittest.main()
