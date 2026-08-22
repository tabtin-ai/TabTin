"""TabDoc 回收站内嵌资源必须跟随组织套餐保留期。"""

from datetime import timedelta
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.tasks import cleanup_orphan_files
from apps.tabdoc.models import Document
from apps.tabtinspace.models import Organization, OrganizationMember, Project


User = get_user_model()


class CleanupOrphanTabdocTrashTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        suffix = uuid4().hex[:8]
        self.user = User.objects.db_manager("default").create_user(
            username=f"tabdoc_orphan_{suffix}",
            email=f"tabdoc-orphan-{suffix}@test.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="TabDoc Orphan Retention Org",
            owner_id=self.user.id,
            is_default=False,
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.user,
            role="owner",
        )
        self.project = Project.objects.create(
            organization=self.organization,
            name="TabDoc Orphan Retention Project",
        )

    def _make_trashed_document_image(
        self,
        *,
        trashed_days_ago: int,
        file_days_ago: int = 60,
    ) -> FileRecord:
        document = Document.objects.create(
            organization_id=self.organization.id,
            space_id=self.project.id,
            owner_id=self.user.id,
            created_by=self.user,
            title="trashed document with image",
            status="trashed",
            trashed_at=timezone.now() - timedelta(days=trashed_days_ago),
        )
        record = FileRecord.objects.create(
            file_name="embedded-image.png",
            file_key=f"tabdoc/images/{uuid4().hex}.png",
            file_path="tabdoc/images",
            file_size=2048,
            file_type="image",
            mime_type="image/png",
            file_extension="png",
            file_hash=uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=str(self.organization.id),
        )
        usage = FileUsage.add_usage(
            record,
            self.user.id,
            module="tabdoc",
            context_type="document",
            context_id=str(document.id),
        )
        usage.deactivate()
        FileRecord.objects.filter(id=record.id).update(
            updated_at=timezone.now() - timedelta(days=file_days_ago),
        )
        record.refresh_from_db()
        self.assertEqual(record.ref_count, 0)
        return record

    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("django.core.cache.cache")
    @patch(
        "apps.services.billing.services.entitlement_limits_service."
        "EntitlementLimitsService.get_recycle_retention_days",
        return_value=30,
    )
    def test_cleanup_retains_old_image_until_document_plan_retention_expires(
        self,
        _mock_retention,
        mock_cache,
        mock_get_oss,
    ):
        mock_cache.add.return_value = True
        mock_oss = MagicMock()
        mock_oss.delete_file.return_value = {"success": True}
        mock_get_oss.return_value = mock_oss
        record = self._make_trashed_document_image(trashed_days_ago=1)

        result = cleanup_orphan_files(grace_days=7)

        self.assertEqual(result.get("deleted_count"), 0)
        self.assertGreaterEqual(result.get("skipped_count", 0), 1)
        mock_oss.delete_file.assert_not_called()
        record.refresh_from_db()
        self.assertEqual(record.status, "completed")

    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("django.core.cache.cache")
    @patch(
        "apps.services.billing.services.entitlement_limits_service."
        "EntitlementLimitsService.get_recycle_retention_days",
        return_value=30,
    )
    def test_cleanup_deletes_image_after_document_plan_retention_expires(
        self,
        _mock_retention,
        mock_cache,
        mock_get_oss,
    ):
        mock_cache.add.return_value = True
        mock_oss = MagicMock()
        mock_oss.delete_file.return_value = {"success": True}
        mock_get_oss.return_value = mock_oss
        record = self._make_trashed_document_image(trashed_days_ago=31)

        result = cleanup_orphan_files(grace_days=7)

        self.assertEqual(result.get("deleted_count"), 1)
        mock_oss.delete_file.assert_called_once_with(record.file_key)
        record.refresh_from_db()
        self.assertEqual(record.status, "deleted")

    @patch("apps.services.oss.tasks.get_oss_service")
    @patch("django.core.cache.cache")
    @patch(
        "apps.services.billing.services.entitlement_limits_service."
        "EntitlementLimitsService.get_recycle_retention_days",
        side_effect=RuntimeError("membership unavailable"),
    )
    def test_cleanup_fails_closed_when_plan_retention_cannot_be_resolved(
        self,
        _mock_retention,
        mock_cache,
        mock_get_oss,
    ):
        mock_cache.add.return_value = True
        mock_oss = MagicMock()
        mock_oss.delete_file.return_value = {"success": True}
        mock_get_oss.return_value = mock_oss
        record = self._make_trashed_document_image(trashed_days_ago=60)

        result = cleanup_orphan_files(grace_days=7)

        self.assertEqual(result.get("deleted_count"), 0)
        self.assertGreaterEqual(result.get("skipped_count", 0), 1)
        mock_oss.delete_file.assert_not_called()
        record.refresh_from_db()
        self.assertEqual(record.status, "completed")
