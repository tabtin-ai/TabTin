import hashlib
import uuid
from datetime import timedelta

from django.test import TestCase
from django.utils import timezone

from apps.services.docparse.models import DocumentImportJob
from apps.services.docparse.observability import get_import_job_metrics_snapshot, job_log_extra
from apps.services.oss.models import FileRecord


def _file_record(name: str = "metrics.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"docparse-metrics/{token}/{name}",
        file_key_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        file_path=f"/tmp/{token}/{name}",
        file_size=4096,
        file_type="document",
        mime_type="application/pdf",
        file_extension="pdf",
        file_hash=hashlib.sha256(f"content-{token}".encode("utf-8")).hexdigest(),
        bucket_name="test-bucket",
        status="completed",
        organization_id="org-1",
    )


class DocParseObservabilityTests(TestCase):
    def test_job_log_extra_uses_stable_fields(self):
        job = DocumentImportJob.objects.create(
            file_record=_file_record(),
            celery_task_id="task-1",
            worker_id="worker-1",
        )

        extra = job_log_extra(job=job, page_number=3, parser_mode="pdf_child")

        self.assertEqual(extra["job_id"], str(job.id))
        self.assertEqual(extra["file_record_id"], str(job.file_record_id))
        self.assertEqual(extra["page_number"], 3)
        self.assertEqual(extra["task_id"], "task-1")
        self.assertEqual(extra["parser_mode"], "pdf_child")

    def test_import_job_metrics_snapshot_counts_status_retry_and_stuck(self):
        now = timezone.now()
        DocumentImportJob.objects.create(
            file_record=_file_record("queued.pdf"),
            status=DocumentImportJob.Status.QUEUED,
        )
        DocumentImportJob.objects.create(
            file_record=_file_record("running.pdf"),
            status=DocumentImportJob.Status.RUNNING,
            retry_count=2,
            heartbeat_at=now - timedelta(minutes=30),
            lease_expires_at=now - timedelta(minutes=5),
        )
        DocumentImportJob.objects.create(
            file_record=_file_record("ready.pdf"),
            status=DocumentImportJob.Status.READY,
            failed_pages=1,
        )

        snapshot = get_import_job_metrics_snapshot(stuck_after_seconds=60)

        self.assertEqual(snapshot["total"], 3)
        self.assertEqual(snapshot["status_counts"][DocumentImportJob.Status.QUEUED], 1)
        self.assertEqual(snapshot["status_counts"][DocumentImportJob.Status.RUNNING], 1)
        self.assertEqual(snapshot["active"], 2)
        self.assertEqual(snapshot["stuck"], 1)
        self.assertEqual(snapshot["retry_by_status"][DocumentImportJob.Status.RUNNING], 1)
