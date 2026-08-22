"""Admin trash/restore：legacy item_type=document 与 tabdoc ResourceBridge 对齐。"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import RequestFactory, SimpleTestCase
from django.utils import timezone

from apps.tabtinspace.admin_api import (
    AdminSensitiveReasonRequest,
    _canonicalize_context_item_type_for_bridge,
    admin_restore_trashed_resource,
    admin_trash_active_resource,
)


class CanonicalizeLegacyDocumentTypeTests(SimpleTestCase):
    def test_document_rewritten_to_tabdoc(self):
        ci = SimpleNamespace(item_type="document", save=MagicMock())
        self.assertEqual(_canonicalize_context_item_type_for_bridge(ci), "tabdoc")
        self.assertEqual(ci.item_type, "tabdoc")
        ci.save.assert_called_once_with(update_fields=["item_type", "updated_at"])

    def test_tabdoc_unchanged(self):
        ci = SimpleNamespace(item_type="tabdoc", save=MagicMock())
        self.assertEqual(_canonicalize_context_item_type_for_bridge(ci), "tabdoc")
        ci.save.assert_not_called()


class AdminLegacyDocumentTrashRestoreTests(SimpleTestCase):
    def setUp(self) -> None:
        self.rf = RequestFactory()
        self.auth = SimpleNamespace(id=uuid4(), is_staff=True, is_superuser=True)
        self.ci_id = uuid4()
        self.resource_id = uuid4()
        self.space_id = uuid4()

    def _ci(self, *, item_type: str, trashed: bool):
        now = timezone.now()
        ci = SimpleNamespace(
            id=self.ci_id,
            title="legacy-doc",
            item_type=item_type,
            resource_id=str(self.resource_id),
            space_id=self.space_id,
            space=SimpleNamespace(id=self.space_id),
            status="trashed" if trashed else "active",
            trashed_at=now if trashed else None,
            trashed_by=self.auth.id if trashed else None,
            previous_status="active",
            is_archived=trashed,
            created_at=now,
            updated_at=now,
            metadata={},
            save=MagicMock(),
        )
        return ci

    def _doc(self, *, trashed: bool):
        now = timezone.now()
        doc = SimpleNamespace(
            id=self.resource_id,
            trashed_at=now if trashed else None,
            status="trashed" if trashed else "active",
            updated_by=None,
            trash=MagicMock(),
            restore_from_trash=MagicMock(),
            save=MagicMock(),
        )
        return doc

    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_trash")
    @patch("apps.tabdoc.models.Document.objects")
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_trash_legacy_document_normalizes_then_bridges(
        self,
        context_objects,
        document_objects,
        on_trash,
        _sensitive,
        _action,
    ):
        ci = self._ci(item_type="document", trashed=False)
        context_objects.select_related.return_value.filter.return_value.exclude.return_value.first.return_value = ci
        doc = self._doc(trashed=False)
        document_objects.get.return_value = doc

        request = self.rf.post(f"/api/auth/admin/resources/{self.ci_id}/trash")
        request.auth = self.auth
        resp = admin_trash_active_resource(
            request,
            self.ci_id,
            AdminSensitiveReasonRequest(reason="ops trash legacy doc", ticket_id="T-LEGACY"),
        )

        self.assertTrue(resp["success"])
        self.assertEqual(ci.item_type, "tabdoc")
        ci.save.assert_called_with(update_fields=["item_type", "updated_at"])
        doc.trash.assert_called_once()
        on_trash.assert_called_once_with(doc, user=self.auth)

    @patch("apps.tabtinspace.admin_api.transaction.atomic")
    @patch("apps.tabtinspace.admin_api._record_admin_action")
    @patch("apps.tabtinspace.admin_api.record_admin_sensitive_action")
    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.on_restore")
    @patch("apps.tabtinspace.services.resource_bridge.ResourceBridge.check_restore_quota")
    @patch("apps.tabdoc.models.Document.objects")
    @patch("apps.tabtinspace.admin_api.ContextItem.objects")
    def test_restore_legacy_document_normalizes_then_bridges(
        self,
        context_objects,
        document_objects,
        check_quota,
        on_restore,
        _sensitive,
        _action,
        atomic_mock,
    ):
        atomic_mock.return_value.__enter__ = MagicMock(return_value=None)
        atomic_mock.return_value.__exit__ = MagicMock(return_value=False)
        ci = self._ci(item_type="document", trashed=True)
        context_objects.select_related.return_value.filter.return_value.first.return_value = ci
        doc = self._doc(trashed=True)
        document_objects.get.return_value = doc

        request = self.rf.post(f"/api/auth/admin/trash/resources/{self.ci_id}/restore")
        request.auth = self.auth
        resp = admin_restore_trashed_resource(
            request,
            self.ci_id,
            AdminSensitiveReasonRequest(reason="ops restore legacy doc", ticket_id="T-LEGACY"),
        )

        self.assertTrue(resp["success"])
        self.assertEqual(ci.item_type, "tabdoc")
        ci.save.assert_called_with(update_fields=["item_type", "updated_at"])
        check_quota.assert_called_once_with(doc)
        doc.restore_from_trash.assert_called_once_with(save=False)
        on_restore.assert_called_once_with(doc, user=self.auth)
