import hashlib
import json
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import RequestFactory, TestCase

from apps.services.docparse.models import DocumentImportJob
from apps.services.oss.models import FileRecord
from apps.tabdoc import api as tabdoc_api
from apps.tabdoc.schemas import DocumentImportFileRequest
from apps.tabdoc.services.import_job_service import DocumentImportJobService


def _extract(response):
    if isinstance(response, tuple):
        return response[1], response[0]
    return response, 200


def _file_record(name: str = "import.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"tabdoc-import/{token}/{name}",
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


def _service() -> DocumentImportJobService:
    service = DocumentImportJobService(user=SimpleNamespace(id="user-1", pk="user-1"))
    service._ensure_space_context = MagicMock()
    service.check_space_permission = MagicMock(return_value=True)
    return service


class DocumentImportJobServiceTests(TestCase):
    @patch("apps.services.docparse.tasks.execute_document_import_job_task.apply_async")
    def test_create_job_is_idempotent_for_active_file_record_context(self, mock_apply_async):
        mock_apply_async.return_value = SimpleNamespace(id="task-1")
        file_record = _file_record()
        service = _service()

        first, first_created = service.create_job(
            organization_id="org-1",
            space_id="space-1",
            file_record_id=str(file_record.id),
        )
        second, second_created = service.create_job(
            organization_id="org-1",
            space_id="space-1",
            file_record_id=str(file_record.id),
        )

        self.assertTrue(first_created)
        self.assertFalse(second_created)
        self.assertEqual(first.id, second.id)
        self.assertEqual(first.organization_id, "org-1")
        self.assertEqual(first.space_id, "space-1")
        self.assertEqual(first.request_payload["space_id"], "space-1")
        self.assertEqual(first.result_payload, {})
        mock_apply_async.assert_called_once_with(args=[str(first.id)], queue="docparse")

    @patch("apps.services.docparse.tasks.execute_document_import_job_task.apply_async")
    def test_create_job_allows_same_file_in_different_spaces(self, mock_apply_async):
        mock_apply_async.return_value = SimpleNamespace(id="task-1")
        file_record = _file_record()
        service = _service()

        first, first_created = service.create_job(
            organization_id="org-1",
            space_id="space-1",
            file_record_id=str(file_record.id),
        )
        second, second_created = service.create_job(
            organization_id="org-1",
            space_id="space-2",
            file_record_id=str(file_record.id),
        )

        self.assertTrue(first_created)
        self.assertTrue(second_created)
        self.assertNotEqual(first.id, second.id)
        self.assertEqual(mock_apply_async.call_count, 2)

    @patch("apps.services.docparse.tasks.execute_document_import_job_task.apply_async")
    def test_retry_failed_job_creates_new_queued_job(self, mock_apply_async):
        mock_apply_async.return_value = SimpleNamespace(id="task-retry")
        file_record = _file_record()
        failed = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.FAILED,
            retry_count=2,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
        )
        service = _service()

        retry, created = service.retry_job(str(failed.id))

        self.assertTrue(created)
        self.assertEqual(retry.status, DocumentImportJob.Status.QUEUED)
        self.assertEqual(retry.retry_count, 3)
        self.assertNotEqual(retry.id, failed.id)

    def test_cancel_active_job_marks_terminal(self):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.RUNNING,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
        )
        service = _service()

        cancelled = service.cancel_job(str(job.id))

        self.assertEqual(cancelled.status, DocumentImportJob.Status.CANCELLED)
        self.assertEqual(cancelled.error_code, "cancelled")
        self.assertIsNotNone(cancelled.completed_at)

    def test_cancel_requires_editor_permission(self):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.RUNNING,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
        )
        service = _service()
        service.check_space_permission.side_effect = (
            lambda _space_id, *, required_role: required_role == "viewer"
        )

        with self.assertRaises(PermissionError):
            service.cancel_job(str(job.id))

        job.refresh_from_db()
        self.assertEqual(job.status, DocumentImportJob.Status.RUNNING)

    @patch("apps.services.docparse.tasks.execute_document_import_job_task.apply_async")
    def test_retry_requires_editor_permission(self, mock_apply_async):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.FAILED,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
        )
        service = _service()
        service.check_space_permission.side_effect = (
            lambda _space_id, *, required_role: required_role == "viewer"
        )

        with self.assertRaises(PermissionError):
            service.retry_job(str(job.id))

        mock_apply_async.assert_not_called()

    def test_status_serialization_does_not_include_result_payload(self):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.RUNNING,
            result_payload={"pm_json": {"type": "doc"}, "markdown": "large body"},
        )

        data = _service().serialize_job(job)

        self.assertNotIn("result_payload", data)
        self.assertNotIn("result_storage_key", data)
        self.assertFalse(data["result_available"])

    def test_result_serialization_filters_legacy_request_metadata(self):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.READY,
            result_payload={
                "request": {
                    "organization_id": "org-1",
                    "space_id": "space-1",
                    "file_record_id": str(file_record.id),
                },
                "markdown": "body",
                "pm_json": {"type": "doc"},
            },
        )

        data = _service().serialize_result(job)

        self.assertNotIn("request", data["result_payload"])
        self.assertEqual(data["result_payload"]["markdown"], "body")

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_result_serialization_loads_large_payload_from_oss_data_content(self, mock_get_oss):
        file_record = _file_record()
        payload = {
            "request": {
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
            "markdown": "large body",
            "plaintext": "large body",
            "pm_json": {"type": "doc"},
        }
        mock_get_oss.return_value.download_file.return_value = {
            "success": True,
            "data": {
                "content": json.dumps(payload).encode("utf-8"),
                "content_type": "application/json",
            },
        }
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.READY,
            result_storage_key="docparse/import-results/job.json",
            result_payload={
                "draft_status": "ready",
            },
        )

        data = _service().serialize_result(job)

        self.assertNotIn("request", data["result_payload"])
        self.assertEqual(data["result_payload"]["markdown"], "large body")
        self.assertEqual(data["result_payload"]["pm_json"], {"type": "doc"})

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_result_serialization_marks_oss_download_failure_omitted(self, mock_get_oss):
        file_record = _file_record()
        mock_get_oss.return_value.download_file.return_value = {
            "success": False,
            "message": "not found",
        }
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.READY,
            result_storage_key="docparse/import-results/missing.json",
        )

        data = _service().serialize_result(job)

        self.assertTrue(data["result_payload"]["omitted"])
        self.assertIn("result_storage_unavailable", data["result_payload"]["reason"])

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_result_serialization_marks_empty_oss_payload_omitted(self, mock_get_oss):
        file_record = _file_record()
        mock_get_oss.return_value.download_file.return_value = {
            "success": True,
            "data": {
                "content": b"",
                "content_type": "application/json",
            },
        }
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-1",
            status=DocumentImportJob.Status.READY,
            result_storage_key="docparse/import-results/empty.json",
        )

        data = _service().serialize_result(job)

        self.assertTrue(data["result_payload"]["omitted"])
        self.assertIn("result_storage_unavailable", data["result_payload"]["reason"])


class DocumentImportJobApiTests(TestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.user = SimpleNamespace(id="user-1", pk="user-1")

    def test_legacy_import_file_returns_accepted_job_without_exchange_service(self):
        request = self.factory.post("/api/tabdoc/import/file")
        request.auth = self.user
        service = MagicMock()
        job = SimpleNamespace(id="job-1")
        service.create_job.return_value = (job, True)
        service.serialize_job.return_value = {
            "id": "job-1",
            "status": "queued",
            "stage": "validating",
        }
        payload = DocumentImportFileRequest(
            organization_id="org-1",
            space_id="space-1",
            file_record_id="file-1",
        )

        with patch("apps.tabdoc.api._build_import_job_service", return_value=service), \
             patch("apps.tabdoc.api._build_exchange_service") as mock_exchange:
            response = tabdoc_api.import_from_file(request, payload)

        body, status = _extract(response)
        self.assertEqual(status, 202)
        self.assertTrue(body["success"])
        self.assertEqual(body["data"]["job"]["id"], "job-1")
        mock_exchange.assert_not_called()
        service.create_job.assert_called_once_with(
            organization_id="org-1",
            space_id="space-1",
            file_record_id="file-1",
        )
