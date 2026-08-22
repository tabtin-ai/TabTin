from __future__ import annotations

import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.services.billing.models import OrganizationStorageUsage
from apps.services.billing.tasks import (
    reconcile_organization_storage_snapshot,
    schedule_storage_snapshot_reconciliation,
)
from apps.services.billing.tests.org_test_utils import org_id_for
from apps.services.oss.models import FileRecord, FileUsage
from apps.services.oss.services.reactivate_utils import reactivate_file_usages_and_restore_storage


class StorageReconcileCompensationTests(TestCase):
    databases = {"default"}

    def test_compensation_creates_missing_snapshot_and_recalculates_active_usage(self):
        organization_id = org_id_for("storage_compensation_missing_snapshot")
        file_record = FileRecord.objects.create(
            file_name="large.bin",
            file_key=f"tests/{uuid.uuid4().hex}/large.bin",
            file_path="/tests/large.bin",
            file_size=8 * 1024 * 1024,
            file_type="other",
            mime_type="application/octet-stream",
            file_extension="bin",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=organization_id,
        )
        FileUsage.add_usage(
            file_record,
            uuid.uuid4(),
            module="tabdoc",
            context_type="document",
            context_id=str(uuid.uuid4()),
        )

        result = reconcile_organization_storage_snapshot.run(
            organization_id,
            reason="tabdoc_restore_storage",
        )

        usage = OrganizationStorageUsage.objects.get(organization_id=organization_id)
        self.assertTrue(result["corrected"])
        self.assertEqual(usage.active_storage_bytes, file_record.file_size)
        self.assertEqual(usage.active_file_count, 1)

    def test_compensation_retries_with_exponential_backoff(self):
        organization_id = org_id_for("storage_compensation_retry")
        failure = RuntimeError("temporary database failure")

        with (
            patch(
                "apps.services.billing.services.storage_service."
                "OrganizationStorageBillingService.reconcile_organization_storage",
                side_effect=failure,
            ),
            patch.object(
                reconcile_organization_storage_snapshot,
                "retry",
                side_effect=RuntimeError("retry scheduled"),
            ) as retry,
        ):
            with self.assertRaisesRegex(RuntimeError, "retry scheduled"):
                reconcile_organization_storage_snapshot.run(organization_id)

        retry.assert_called_once_with(exc=failure, countdown=30)

    def test_scheduler_enqueues_after_transaction_commit(self):
        organization_id = org_id_for("storage_compensation_on_commit")

        with patch.object(reconcile_organization_storage_snapshot, "apply_async") as apply_async:
            with self.captureOnCommitCallbacks(execute=True):
                schedule_storage_snapshot_reconciliation(
                    organization_id,
                    reason="tabdoc_archive_release",
                )

        apply_async.assert_called_once_with(
            args=[organization_id],
            kwargs={"reason": "tabdoc_archive_release"},
        )

    def test_restore_billing_failure_schedules_storage_snapshot_reconciliation(self):
        organization_id = org_id_for("storage_compensation_restore_failure")
        document_id = str(uuid.uuid4())
        file_record = FileRecord.objects.create(
            file_name="restored.bin",
            file_key=f"tests/{uuid.uuid4().hex}/restored.bin",
            file_path="/tests/restored.bin",
            file_size=4 * 1024 * 1024,
            file_type="other",
            mime_type="application/octet-stream",
            file_extension="bin",
            file_hash=uuid.uuid4().hex,
            bucket_name="test-bucket",
            status="completed",
            organization_id=organization_id,
        )
        usage = FileUsage.add_usage(
            file_record,
            uuid.uuid4(),
            module="tabdoc",
            context_type="document",
            context_id=document_id,
        )
        usage.deactivate()

        with (
            patch(
                "apps.services.billing.services.storage_service."
                "OrganizationStorageBillingService.apply_storage_delta",
                side_effect=RuntimeError("meter unavailable"),
            ),
            patch(
                "apps.services.billing.tasks.schedule_storage_snapshot_reconciliation"
            ) as schedule_reconciliation,
        ):
            result = reactivate_file_usages_and_restore_storage(
                module="tabdoc",
                context_filter={"context_id": document_id},
                organization_id=organization_id,
                biz_type="tabdoc_restore_storage",
                biz_id=document_id,
            )

        usage.refresh_from_db()
        self.assertTrue(usage.is_active)
        self.assertEqual(result.restored_count, 1)
        schedule_reconciliation.assert_called_once_with(
            organization_id,
            reason="tabdoc_restore_storage",
        )
