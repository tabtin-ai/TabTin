"""#7546：TabDoc trash 对已 trashed 源幂等，并仍校验 ResourceBridge.on_trash。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase
from django.utils import timezone

from apps.tabdoc.services.document_service import DocumentService


class TestTrashDocumentIdempotent(SimpleTestCase):
    def test_trash_document_idempotent_syncs_bridge_when_already_trashed(self):
        document = MagicMock()
        document.id = uuid4()
        document.space_id = uuid4()
        document.organization_id = uuid4()
        document.status = "trashed"
        document.trashed_at = timezone.now()

        svc = DocumentService(user=SimpleNamespace(id=uuid4()))

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "check_document_permission", return_value=True),
            patch.object(svc, "_safe_user_for_fk", return_value=None),
            patch.object(svc, "_get_editor_id", return_value="editor"),
            patch("apps.tabdoc.services.document_service.ResourceBridge") as bridge_cls,
        ):
            bridge_cls.on_trash.return_value = True
            result = svc.trash_document(document)

        self.assertIs(result, document)
        document.trash.assert_not_called()
        document.save.assert_not_called()
        bridge_cls.on_trash.assert_called_once()

    def test_trash_document_idempotent_raises_when_bridge_fails(self):
        document = MagicMock()
        document.id = uuid4()
        document.space_id = uuid4()
        document.organization_id = uuid4()
        document.status = "trashed"
        document.trashed_at = timezone.now()

        svc = DocumentService(user=SimpleNamespace(id=uuid4()))

        with (
            patch("django.db.transaction.Atomic.__enter__", return_value=None),
            patch("django.db.transaction.Atomic.__exit__", return_value=False),
            patch.object(svc, "check_document_permission", return_value=True),
            patch.object(svc, "_safe_user_for_fk", return_value=None),
            patch.object(svc, "_get_editor_id", return_value="editor"),
            patch("apps.tabdoc.services.document_service.ResourceBridge") as bridge_cls,
        ):
            bridge_cls.on_trash.return_value = False
            with self.assertRaises(ValueError) as ctx:
                svc.trash_document(document)

        self.assertTrue(
            "同步" in str(ctx.exception) or "sync" in str(ctx.exception).lower(),
            str(ctx.exception),
        )
