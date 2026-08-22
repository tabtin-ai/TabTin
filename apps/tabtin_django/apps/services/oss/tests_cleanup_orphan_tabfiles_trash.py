"""回收站中的 tabfiles 不得被 cleanup_orphan_files 提前物理删除。"""
from datetime import timedelta
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.services.oss.models import FileRecord
from apps.services.oss.tasks import (
    _file_record_ids_retained_by_trashed_tabfiles,
    cleanup_orphan_files,
)
from apps.tabtinspace.models import ContextItem, Organization, OrganizationMember


User = get_user_model()


class CleanupOrphanTabfilesTrashTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.db_manager("default").create_user(
            username=f"orphan_trash_{uuid4().hex[:8]}",
            email=f"orphan-trash-{uuid4().hex[:8]}@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Orphan Trash Org",
            owner_id=self.user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )

    def _make_file_record(self, *, ref_count=0, days_ago=10):
        record = FileRecord.objects.create(
            file_name="scores.xlsx",
            file_key=f"tabfiles/orphan/{uuid4().hex}.xlsx",
            file_path="/tabfiles/orphan/",
            file_size=2048,
            file_type="document",
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_extension="xlsx",
            file_hash=uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
            ref_count=ref_count,
        )
        # auto_now 会覆盖普通赋值；用 update 把 updated_at 拨回宽限期之前
        FileRecord.objects.filter(id=record.id).update(
            updated_at=timezone.now() - timedelta(days=days_ago),
            ref_count=ref_count,
        )
        record.refresh_from_db()
        return record

    def test_retained_helper_detects_trashed_tabfiles(self):
        record = self._make_file_record()
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="scores.xlsx",
            status="trashed",
            trashed_at=timezone.now(),
            resource_id=str(record.id),
            metadata={},
            created_by=self.user,
            updated_by=self.user,
        )
        retained = _file_record_ids_retained_by_trashed_tabfiles([str(record.id), str(uuid4())])
        self.assertEqual(retained, {str(record.id)})

    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("django.core.cache.cache")
    def test_cleanup_skips_file_still_in_tabfiles_trash(self, mock_cache, mock_get_oss):
        mock_cache.add.return_value = True
        mock_oss = MagicMock()
        mock_oss.delete_file.return_value = {"success": True}
        mock_get_oss.return_value = mock_oss

        record = self._make_file_record(ref_count=0, days_ago=10)
        ContextItem.objects.create(
            organization_id=self.organization.id,
            item_type="tabfiles",
            title="scores.xlsx",
            status="trashed",
            trashed_at=timezone.now(),
            resource_id=str(record.id),
            metadata={},
            created_by=self.user,
            updated_by=self.user,
        )

        result = cleanup_orphan_files(grace_days=7)

        self.assertEqual(result.get("deleted_count"), 0)
        self.assertGreaterEqual(result.get("skipped_count", 0), 1)
        mock_oss.delete_file.assert_not_called()
        record.refresh_from_db()
        self.assertEqual(record.status, "completed")

    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("django.core.cache.cache")
    def test_cleanup_deletes_after_context_item_permanently_removed(
        self, mock_cache, mock_get_oss,
    ):
        mock_cache.add.return_value = True
        mock_oss = MagicMock()
        mock_oss.delete_file.return_value = {"success": True}
        mock_get_oss.return_value = mock_oss

        record = self._make_file_record(ref_count=0, days_ago=10)
        # 无 ContextItem：永久删除后应允许孤儿清理

        result = cleanup_orphan_files(grace_days=7)

        self.assertEqual(result.get("deleted_count"), 1)
        mock_oss.delete_file.assert_called_once_with(record.file_key)
        record.refresh_from_db()
        self.assertEqual(record.status, "deleted")
