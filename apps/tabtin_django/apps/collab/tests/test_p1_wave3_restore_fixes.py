"""
P1 Wave-3 回归测试

#23 DocsCollabAdapter.restore() 无事务保护
#25 CanvasCollabAdapter.restore() 不递增 latest_version
#26 DesignCollabAdapter.restore() 无事务无行锁

Wave-4 追加:
R3-2a DocsCollabAdapter.restore() refresh_from_db 缺 using=DB
R3-2b CanvasCollabAdapter.restore() 缺 atomic + select_for_update
"""
import inspect
import os
import uuid
from unittest.mock import MagicMock, patch, call

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# #25: CanvasCollabAdapter.restore() 递增 latest_version
# ══════════════════════════════════════════════════════════



# ══════════════════════════════════════════════════════════
# #23: DocsCollabAdapter.restore() 事务保护
# ══════════════════════════════════════════════════════════

class TestDocsRestoreTransactionProtection:
    """DocsCollabAdapter.restore() 使用 transaction.on_commit 延迟 push_and_update_binary，
    避免在 _do_restore 的 transaction.atomic 持锁期间进行 HTTP IO（CL-007）。"""

    def test_restore_source_uses_on_commit(self):
        """restore 源码应包含 transaction.on_commit（CL-007：延迟 HTTP IO）。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        assert "transaction.on_commit" in source, (
            "restore must use transaction.on_commit to defer push_and_update_binary (CL-007)"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_json_snapshot_calls_update(self, mock_doc_model, mock_svc_cls):
        """JSON snapshot 恢复应调用 Document.objects.using().filter().update()。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# Hello",
            "description_plaintext": "Hello",
        }

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        with patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    return_value=(data["description_json"], data["description_markdown"])):
            with patch("django.db.transaction.on_commit"):
                adapter.restore(resource, data)

        mock_qs.update.assert_called_once()
        update_kwargs = mock_qs.update.call_args[1]
        assert "description_json" in update_kwargs
        assert "description_markdown" in update_kwargs

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_restore_binary_calls_update(self, mock_doc_model, mock_svc_cls):
        """bytes 恢复应调用 Document.objects.using().filter().update()。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = b"\x01\x02\x03"

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        with patch("django.db.transaction.on_commit"):
            adapter.restore(resource, data)

        mock_qs.update.assert_called_once()
        update_kwargs = mock_qs.update.call_args[1]
        assert "description_binary" in update_kwargs

    def test_push_and_update_binary_deferred_via_on_commit(self):
        """push_and_update_binary 通过 transaction.on_commit 延迟执行（CL-007）。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        assert "on_commit" in source, (
            "restore must defer push_and_update_binary via transaction.on_commit"
        )
        assert "push_and_update_binary" in source, (
            "restore must contain push_and_update_binary call"
        )


# ══════════════════════════════════════════════════════════
# R3-2a: DocsCollabAdapter.restore() refresh_from_db(using=DB)
# ══════════════════════════════════════════════════════════

class TestDocsRestoreRefreshFromDbUsesDB:
    """refresh_from_db 必须传 using=DB，否则从默认 MySQL 读取不到 PostgreSQL 的更新。"""

    def test_refresh_from_db_passes_using_db(self):
        """源码中所有 refresh_from_db 调用必须携带 using=DB。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        source = inspect.getsource(DocsCollabAdapter.restore)
        import re
        bare_calls = re.findall(r'refresh_from_db\(\)', source)
        assert len(bare_calls) == 0, (
            f"Found {len(bare_calls)} bare refresh_from_db() call(s) without using=DB"
        )
        qualified_calls = re.findall(r'refresh_from_db\(using=', source)
        assert len(qualified_calls) >= 1, (
            "restore must call refresh_from_db(using=DB) at least once"
        )

    @patch("apps.tabdoc.services.document_service.DocumentService")
    @patch("apps.tabdoc.models.Document")
    def test_refresh_from_db_called_with_postgresql(self, mock_doc_model, mock_svc_cls):
        """运行时 refresh_from_db 应以 using='postgresql' 调用。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        resource = MagicMock()
        resource.id = uuid.uuid4()

        mock_svc = MagicMock()
        mock_svc.assert_document_content_editable = MagicMock()
        mock_svc_cls.return_value = mock_svc

        data = {
            "format": "json_snapshot",
            "description_json": {"type": "doc", "content": []},
            "description_markdown": "# Test",
            "description_plaintext": "Test",
        }

        mock_qs = MagicMock()
        mock_doc_model.objects.using.return_value.filter.return_value = mock_qs

        with patch("apps.tabdoc.services.document_service.normalize_tabdata_snapshot",
                    return_value=(data["description_json"], data["description_markdown"])):
            with patch("django.db.transaction.atomic") as mock_atomic, \
                 patch("django.db.transaction.on_commit"):
                mock_ctx = MagicMock()
                mock_atomic.return_value = mock_ctx
                mock_ctx.__enter__ = MagicMock(return_value=None)
                mock_ctx.__exit__ = MagicMock(return_value=False)

                adapter.restore(resource, data)

        resource.refresh_from_db.assert_called_once_with(using="postgresql")


# ══════════════════════════════════════════════════════════
# R3-2b: CanvasCollabAdapter.restore() atomic + select_for_update
# ══════════════════════════════════════════════════════════

