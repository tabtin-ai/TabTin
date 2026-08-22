"""ISSUE-C Phase 1: save_content 写入后应通知 collab-live（与 save_from_agent 对齐）。"""
from __future__ import annotations

import os
import unittest
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")
import django

django.setup()


class TestSaveContentCollabNotify(unittest.TestCase):
    def _run_save_content_with_markdown_change(self, *, mock_invalidate):
        from django.utils import timezone
        from apps.tabdoc.services.document_service import DocumentService

        service = DocumentService(user=MagicMock(id="user-1"))
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-c-1",
            latest_version=2,
            title="标题",
            description_markdown="旧正文",
            updated_at=updated_at,
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.filter.return_value = update_qs
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        with patch.object(service, "push_and_update_binary", return_value=None):
                            with patch(
                                "apps.collab.api._invalidate_or_force_close",
                                mock_invalidate,
                            ):
                                service.save_content(
                                    document,
                                    base_version=2,
                                    content_pm_json={"type": "doc", "content": []},
                                    content_markdown="新正文",
                                    content_plaintext="新正文",
                                )
        return document

    def test_save_content_calls_invalidate_when_markdown_changes(self):
        mock_invalidate = MagicMock(return_value={"invalidated": True, "force_closed": False})
        document = self._run_save_content_with_markdown_change(mock_invalidate=mock_invalidate)
        mock_invalidate.assert_called_once_with("docs", "doc-c-1", 3)
        self.assertEqual(document.latest_version, 3)

    def test_save_content_skips_invalidate_when_markdown_unchanged(self):
        from django.utils import timezone
        from apps.tabdoc.services.document_service import DocumentService

        service = DocumentService(user=MagicMock(id="user-1"))
        service.check_document_permission = MagicMock(return_value=True)
        updated_at = timezone.now()
        document = SimpleNamespace(
            id="doc-c-2",
            latest_version=2,
            title="旧标题",
            description_markdown="同正文",
            updated_at=updated_at,
            status="active",
            refresh_from_db=MagicMock(),
            updated_by=None,
        )
        update_qs = MagicMock()
        update_qs.filter.return_value = update_qs
        update_qs.update.return_value = 1

        with patch("apps.tabdoc.services.document_service.transaction.atomic", return_value=nullcontext()):
            with patch("apps.tabdoc.services.document_service.Document.objects.filter", return_value=update_qs):
                with patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
                    with patch.object(service, "_update_search_vector"):
                        with patch(
                            "apps.collab.api._invalidate_or_force_close",
                        ) as mock_invalidate:
                            service.save_content(
                                document,
                                base_version=2,
                                title="新标题",
                                content_pm_json={"type": "doc", "content": []},
                                content_markdown="同正文",
                                content_plaintext="同正文",
                            )
        mock_invalidate.assert_not_called()


if __name__ == "__main__":
    unittest.main()
