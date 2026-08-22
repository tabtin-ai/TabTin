"""#7437：TabDoc trash 在 ResourceBridge.on_trash 失败时不得返回成功。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdoc.services.document_service import DocumentService


class TestTrashDocumentRequiresBridgeSync(SimpleTestCase):
    def test_trash_document_raises_when_bridge_fails(self):
        document = MagicMock()
        document.id = uuid4()
        document.space_id = uuid4()
        document.organization_id = uuid4()
        document.status = "active"
        document.trashed_at = None

        svc = DocumentService(user=SimpleNamespace(id=uuid4()))

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "assert_document_viewable"),
            patch.object(svc, "check_document_permission", return_value=True),
            patch.object(svc, "_safe_user_for_fk", return_value=None),
            patch.object(svc, "_get_editor_id", return_value="editor"),
            patch("apps.tabdoc.services.document_service.ResourceBridge") as bridge_cls,
            patch("django.db.transaction.on_commit"),
        ):
            bridge_cls.on_trash.return_value = False
            with self.assertRaises(ValueError) as ctx:
                svc.trash_document(document)

        self.assertTrue(
            "同步" in str(ctx.exception) or "sync" in str(ctx.exception).lower(),
            str(ctx.exception),
        )
        document.trash.assert_called_once()
        bridge_cls.on_trash.assert_called_once()
