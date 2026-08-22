from __future__ import annotations

from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.tabdoc.models import Document, DocumentRecoveryDraft, DocumentVersion
from apps.tabdoc.services import ConflictError
from apps.tabdoc.services.document_service import DocumentService


User = get_user_model()


def _pm_json(text: str) -> dict:
    return {
        "type": "doc",
        "content": [{
            "type": "paragraph",
            "attrs": {"blockId": "blk-recovery"},
            "content": [{"type": "text", "text": text}],
        }],
    }


class RecoveryDraftServiceTests(TestCase):
    """Recovery data stays non-canonical until the user explicitly restores it."""

    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            username="recovery-editor",
            email="recovery-editor@example.com",
            password="x",
        )
        self.document = Document.objects.create(
            organization_id=uuid4(),
            space_id=uuid4(),
            owner_id=self.user.id,
            created_by=self.user,
            updated_by=self.user,
            title="Recovery draft test",
            description_json=_pm_json("cloud v1"),
            description_markdown="cloud v1",
            description_plaintext="cloud v1",
            latest_version=1,
        )
        self.service = DocumentService(user=self.user)

    def _create_recovery(self):
        return self.service.create_recovery_draft(
            self.document,
            base_version=1,
            content_pm_json=_pm_json("local unsaved"),
            content_markdown="local unsaved",
            content_plaintext="local unsaved",
        )

    def test_create_preserves_draft_without_changing_document_or_history(self):
        history_before = DocumentVersion.objects.filter(document=self.document).count()

        recovery = self._create_recovery()

        self.document.refresh_from_db()
        self.assertEqual(self.document.latest_version, 1)
        self.assertEqual(self.document.description_markdown, "cloud v1")
        self.assertEqual(
            DocumentVersion.objects.filter(document=self.document).count(),
            history_before,
        )
        self.assertEqual(recovery.status, DocumentRecoveryDraft.STATUS_ACTIVE)
        self.assertEqual(recovery.content_markdown, "local unsaved")
        self.assertEqual(recovery.creator_id, self.user.id)

    def test_restore_requires_current_version_and_keeps_draft_active_on_conflict(self):
        recovery = self._create_recovery()
        Document.objects.filter(id=self.document.id).update(
            latest_version=2,
            description_json=_pm_json("cloud v2"),
            description_markdown="cloud v2",
            description_plaintext="cloud v2",
        )
        self.document.refresh_from_db()

        with self.assertRaises(ConflictError):
            self.service.restore_recovery_draft(
                self.document,
                str(recovery.id),
                base_version=1,
                base_updated_at=None,
            )

        recovery.refresh_from_db()
        self.document.refresh_from_db()
        self.assertEqual(recovery.status, DocumentRecoveryDraft.STATUS_ACTIVE)
        self.assertEqual(self.document.description_markdown, "cloud v2")
        self.assertEqual(self.document.latest_version, 2)

    def test_explicit_restore_promotes_draft_once_through_normal_save_path(self):
        recovery = self._create_recovery()
        history_before = DocumentVersion.objects.filter(document=self.document).count()

        with patch.object(self.service, "check_document_permission", return_value=True), \
             patch.object(self.service, "assert_document_content_editable"), \
             patch.object(self.service, "_update_search_vector"), \
             patch.object(self.service, "push_and_update_binary"), \
             patch.object(self.service, "_create_fallback_version_history") as history_mock, \
             patch.object(self.service, "_mark_vh_synced_for_onstore"), \
             patch.object(self.service, "_mark_version_synced_for_onstore"), \
             patch("apps.tabdoc.services.document_service.ResourceBridge.on_update"):
            updated = self.service.restore_recovery_draft(
                self.document,
                str(recovery.id),
                base_version=1,
                base_updated_at=None,
            )

        recovery.refresh_from_db()
        updated.refresh_from_db()
        self.assertEqual(updated.latest_version, 2)
        self.assertEqual(updated.description_markdown, "local unsaved")
        self.assertEqual(recovery.status, DocumentRecoveryDraft.STATUS_RESTORED)
        self.assertIsNotNone(recovery.restored_at)
        self.assertEqual(
            DocumentVersion.objects.filter(document=self.document).count(),
            history_before,
        )
        history_mock.assert_called_once()
