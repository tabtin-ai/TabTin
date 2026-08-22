from __future__ import annotations

import inspect
import uuid
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase
from pydantic import ValidationError

from apps.services.docparse.model_selection import (
    MODEL_SELECTION_SOURCE_EXPLICIT,
    MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT,
    build_model_selection_snapshot,
    build_document_page_vision_invocation,
    resolve_model_selection_snapshot,
)
from apps.services.docparse.models import DocumentImportJob, ParsedDocument
from apps.services.docparse.service import DocParseService
from apps.services.docparse.service import requeue_stale_import_jobs
from apps.services.docparse.tasks import parse_document_task
from apps.services.docparse.parsers.vision_parser import VisionParser
from apps.tabdoc.schemas import DocumentImportJobCreateRequest
from apps.tabdoc import api as tabdoc_api
from apps.tabdoc.services.import_job_service import DocumentImportJobService


class DocumentVisionModelSelectionTests(SimpleTestCase):
    def test_legacy_payload_resolves_to_official_default(self):
        selection = resolve_model_selection_snapshot({"vision_model": "provider/model-name"})

        self.assertIsNone(selection.selected_model_id)
        self.assertEqual(selection.source, MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT)

    def test_explicit_model_is_stored_as_canonical_uuid(self):
        model_id = uuid.uuid4()

        snapshot = build_model_selection_snapshot(model_id)
        selection = resolve_model_selection_snapshot(snapshot)

        self.assertEqual(snapshot, {
            "selected_model_id": str(model_id),
            "model_selection_source": MODEL_SELECTION_SOURCE_EXPLICIT,
        })
        self.assertEqual(selection.selected_model_id, str(model_id))
        self.assertEqual(selection.source, MODEL_SELECTION_SOURCE_EXPLICIT)

    def test_non_uuid_model_is_rejected_without_name_lookup(self):
        with self.assertRaisesRegex(ValueError, "selected_model_id.*UUID"):
            build_model_selection_snapshot("qwen/qwen3-vl-plus")

    def test_http_contract_rejects_non_uuid_selected_model(self):
        with self.assertRaises(ValidationError):
            DocumentImportJobCreateRequest(
                organization_id="org-1",
                file_record_id="file-1",
                selected_model_id="provider/model-name",
            )


class DocumentImportJobModelSnapshotTests(SimpleTestCase):
    def setUp(self):
        self.service = DocumentImportJobService(
            user=SimpleNamespace(id="user-1", pk="user-1"),
        )
        self.service.check_organization_permission = MagicMock(return_value=True)
        self.file_record = SimpleNamespace(
            id=uuid.uuid4(),
            status="completed",
            file_size=1024,
        )
        self.service._get_file_record = MagicMock(return_value=self.file_record)
        self.service._dispatch_job = MagicMock()

    def test_old_request_is_snapshotted_as_official_default(self):
        self.service._get_active_job = MagicMock(return_value=None)
        created_job = SimpleNamespace(id=uuid.uuid4())

        with patch(
            "apps.tabdoc.services.import_job_service.transaction.atomic",
            return_value=nullcontext(),
        ), patch(
            "apps.tabdoc.services.import_job_service.DocumentImportJob.objects.create",
            return_value=created_job,
        ) as create:
            job, created = self.service.create_job(
                organization_id="org-1",
                file_record_id=str(self.file_record.id),
            )

        self.assertTrue(created)
        self.assertIs(job, created_job)
        payload = create.call_args.kwargs["request_payload"]
        self.assertEqual(
            payload["model_selection_source"],
            MODEL_SELECTION_SOURCE_OFFICIAL_DEFAULT,
        )
        self.assertNotIn("selected_model_id", payload)

    def test_explicit_uuid_is_snapshotted_at_job_creation(self):
        self.service._get_active_job = MagicMock(return_value=None)
        created_job = SimpleNamespace(id=uuid.uuid4())
        selected_model_id = uuid.uuid4()

        with patch(
            "apps.tabdoc.services.import_job_service.transaction.atomic",
            return_value=nullcontext(),
        ), patch(
            "apps.tabdoc.services.import_job_service.DocumentImportJob.objects.create",
            return_value=created_job,
        ) as create:
            self.service.create_job(
                organization_id="org-1",
                file_record_id=str(self.file_record.id),
                selected_model_id=selected_model_id,
            )

        payload = create.call_args.kwargs["request_payload"]
        self.assertEqual(payload["selected_model_id"], str(selected_model_id))
        self.assertEqual(payload["model_selection_source"], MODEL_SELECTION_SOURCE_EXPLICIT)

    def test_active_job_rejects_a_different_model(self):
        first_model_id = uuid.uuid4()
        active_job = SimpleNamespace(
            request_payload=build_model_selection_snapshot(first_model_id),
        )
        self.service._get_active_job = MagicMock(return_value=active_job)

        with self.assertRaisesRegex(ValueError, "不能更改 selected_model_id"):
            self.service.create_job(
                organization_id="org-1",
                file_record_id=str(self.file_record.id),
                selected_model_id=uuid.uuid4(),
            )

    def test_user_retry_is_a_new_official_default_operation(self):
        old_model_id = uuid.uuid4()
        failed_job = SimpleNamespace(
            id=uuid.uuid4(),
            status=DocumentImportJob.Status.FAILED,
            retry_count=1,
            organization_id="org-1",
            space_id="",
            file_record_id=self.file_record.id,
            request_payload={
                "organization_id": "org-1",
                "space_id": "",
                "file_record_id": str(self.file_record.id),
                **build_model_selection_snapshot(old_model_id),
            },
        )
        new_job = SimpleNamespace(
            id=uuid.uuid4(),
            retry_count=0,
            save=MagicMock(),
        )
        self.service.get_job = MagicMock(return_value=failed_job)
        self.service._assert_job_access = MagicMock()
        self.service.create_job = MagicMock(return_value=(new_job, True))

        retried, created = self.service.retry_job(str(failed_job.id))

        self.assertTrue(created)
        self.assertNotEqual(retried.id, failed_job.id)
        self.service.create_job.assert_called_once_with(
            organization_id="org-1",
            space_id=None,
            file_record_id=str(self.file_record.id),
        )


class DocumentImportJobHttpCompatibilityTests(SimpleTestCase):
    @patch("apps.tabdoc.api._build_import_job_service")
    def test_old_http_request_keeps_legacy_service_call_shape(self, build_service):
        service = MagicMock()
        service.create_job.return_value = (SimpleNamespace(id="job-1"), True)
        service.serialize_job.return_value = {"id": "job-1", "status": "queued"}
        build_service.return_value = service
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        payload = DocumentImportJobCreateRequest(
            organization_id="org-1",
            file_record_id="file-1",
        )

        response = tabdoc_api.create_import_job(request, payload)

        self.assertEqual(response[0], 202)
        service.create_job.assert_called_once_with(
            organization_id="org-1",
            file_record_id="file-1",
        )

    @patch("apps.tabdoc.api._build_import_job_service")
    def test_explicit_http_uuid_reaches_job_service(self, build_service):
        selected_model_id = uuid.uuid4()
        service = MagicMock()
        service.create_job.return_value = (SimpleNamespace(id="job-1"), True)
        service.serialize_job.return_value = {"id": "job-1", "status": "queued"}
        build_service.return_value = service
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        payload = DocumentImportJobCreateRequest(
            organization_id="org-1",
            file_record_id="file-1",
            selected_model_id=selected_model_id,
        )

        response = tabdoc_api.create_import_job(request, payload)

        self.assertEqual(response[0], 202)
        service.create_job.assert_called_once_with(
            organization_id="org-1",
            file_record_id="file-1",
            selected_model_id=selected_model_id,
        )


class DocumentImportJobWorkerSelectionTests(SimpleTestCase):
    @patch("apps.services.docparse.service._finish_import_job")
    @patch("apps.services.docparse.service.DocParseService.execute")
    @patch("apps.services.docparse.service._claim_import_job")
    def test_worker_restores_explicit_model_from_job_snapshot(
        self,
        claim_job,
        execute,
        finish_job,
    ):
        selected_model_id = uuid.uuid4()
        job = SimpleNamespace(
            id=uuid.uuid4(),
            file_record_id=uuid.uuid4(),
            status=DocumentImportJob.Status.QUEUED,
            request_payload=build_model_selection_snapshot(selected_model_id),
        )
        parsed = SimpleNamespace(status=ParsedDocument.Status.READY)
        claim_job.return_value = job
        execute.return_value = parsed
        finish_job.return_value = job

        DocParseService.execute_import_job(str(job.id), task_id="task-1")

        execute.assert_called_once_with(
            str(job.file_record_id),
            import_job_id=str(job.id),
            import_job_task_id="task-1",
            selected_model_id=str(selected_model_id),
        )

    @patch("apps.services.docparse.service._finish_import_job")
    @patch("apps.services.docparse.service.DocParseService.execute")
    @patch("apps.services.docparse.service._claim_import_job")
    def test_worker_treats_legacy_job_as_official_default(
        self,
        claim_job,
        execute,
        finish_job,
    ):
        job = SimpleNamespace(
            id=uuid.uuid4(),
            file_record_id=uuid.uuid4(),
            status=DocumentImportJob.Status.QUEUED,
            request_payload={"organization_id": "org-1"},
        )
        parsed = SimpleNamespace(status=ParsedDocument.Status.READY)
        claim_job.return_value = job
        execute.return_value = parsed
        finish_job.return_value = job

        DocParseService.execute_import_job(str(job.id), task_id="task-legacy")

        execute.assert_called_once_with(
            str(job.file_record_id),
            import_job_id=str(job.id),
            import_job_task_id="task-legacy",
        )

    @patch("apps.services.docparse.service._fail_import_job")
    @patch("apps.services.docparse.service.DocParseService.execute")
    @patch("apps.services.docparse.service._claim_import_job")
    def test_malformed_job_selection_fails_closed(self, claim_job, execute, fail_job):
        job = SimpleNamespace(
            id=uuid.uuid4(),
            file_record_id=uuid.uuid4(),
            status=DocumentImportJob.Status.QUEUED,
            request_payload={
                "model_selection_source": MODEL_SELECTION_SOURCE_EXPLICIT,
                "selected_model_id": "provider/model-name",
            },
            result_payload={},
        )
        claim_job.return_value = job

        with self.assertRaisesRegex(ValueError, "selected_model_id.*UUID"):
            DocParseService.execute_import_job(str(job.id), task_id="task-invalid")

        execute.assert_not_called()
        fail_job.assert_called_once()


class DocumentImportJobWatchdogSelectionTests(SimpleTestCase):
    @patch("apps.services.docparse.tasks.execute_document_import_job_task.apply_async")
    @patch("apps.services.docparse.service.transaction.atomic", return_value=nullcontext())
    @patch("apps.services.docparse.service.DocumentImportJob.objects")
    def test_watchdog_requeues_only_job_id_without_mutating_snapshot(
        self,
        objects,
        _atomic,
        apply_async,
    ):
        job_id = uuid.uuid4()
        selected_model_id = uuid.uuid4()
        request_payload = build_model_selection_snapshot(selected_model_id)
        job = SimpleNamespace(
            id=job_id,
            status=DocumentImportJob.Status.RUNNING,
            lease_expires_at=None,
            error_code="lease_expired",
            error_message="",
            retry_count=0,
            celery_task_id="old-task",
            heartbeat_at=None,
            request_payload=request_payload,
            save=MagicMock(),
        )
        candidate_query = MagicMock()
        objects.filter.return_value = candidate_query
        candidate_query.order_by.return_value.__getitem__.return_value.values_list.return_value = [job_id]
        objects.select_for_update.return_value.get.return_value = job
        apply_async.return_value = SimpleNamespace(id="new-task")

        result = requeue_stale_import_jobs(limit=1)

        self.assertEqual(result["requeued"], 1)
        self.assertIs(job.request_payload, request_payload)
        self.assertNotIn("request_payload", job.save.call_args.kwargs["update_fields"])
        apply_async.assert_called_once_with(args=[str(job_id)], queue="docparse")


class DocumentVisionRuntimePropagationTests(SimpleTestCase):
    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_legacy_celery_task_can_explicitly_forward_model_uuid(self, execute):
        selected_model_id = uuid.uuid4()
        execute.return_value = SimpleNamespace(
            status=ParsedDocument.Status.READY,
            total_pages=1,
            parse_method="vision",
        )

        parse_document_task.run(
            "file-1",
            selected_model_id=str(selected_model_id),
        )

        execute.assert_called_once_with(
            "file-1",
            force=False,
            vision_model="",
            selected_model_id=str(selected_model_id),
        )

    @patch("apps.services.llm.services.vision.parse")
    @patch("apps.services.docparse.service.get_vlm_semaphore")
    def test_vision_parser_forwards_only_explicit_uuid(
        self,
        get_semaphore,
        vision_parse,
    ):
        selected_model_id = uuid.uuid4()
        get_semaphore.return_value = SimpleNamespace(
            acquire=MagicMock(return_value=True),
            release=MagicMock(),
        )
        vision_parse.return_value = SimpleNamespace(content={"blocks": [{"type": "paragraph"}]})
        parser = VisionParser(
            model="legacy/provider-name",
            user_id="user-1",
            organization_id="org-1",
            selected_model_id=selected_model_id,
        )

        parser._call_api("/9j/mock")

        self.assertEqual(
            vision_parse.call_args.kwargs["selected_model_id"],
            str(selected_model_id),
        )

    @patch("apps.services.llm.services.vision.parse")
    @patch("apps.services.docparse.service.get_vlm_semaphore")
    def test_legacy_vision_model_never_becomes_selected_model_id(
        self,
        get_semaphore,
        vision_parse,
    ):
        get_semaphore.return_value = SimpleNamespace(
            acquire=MagicMock(return_value=True),
            release=MagicMock(),
        )
        vision_parse.return_value = SimpleNamespace(content={"blocks": [{"type": "paragraph"}]})
        parser = VisionParser(
            model="qwen/qwen3-vl-plus",
            user_id="user-1",
            organization_id="org-1",
        )

        parser._call_api("/9j/mock")

        self.assertIsNone(vision_parse.call_args.kwargs["selected_model_id"])


class DocumentVisionStableInvocationContractTests(SimpleTestCase):
    def test_watchdog_redelivery_keeps_identity_and_user_retry_gets_new_identity(self):
        selected_model_id = uuid.uuid4()
        first_job_id = uuid.uuid4()
        common = {
            "page_number": 7,
            "parser_version": "docparse-job-v1",
            "organization_id": "org-1",
            "user_id": "user-1",
            "selected_model_id": selected_model_id,
        }

        first = build_document_page_vision_invocation(job_id=first_job_id, **common)
        redelivery = build_document_page_vision_invocation(job_id=first_job_id, **common)
        explicit_retry = build_document_page_vision_invocation(job_id=uuid.uuid4(), **common)

        self.assertEqual(first.invocation_id, redelivery.invocation_id)
        self.assertNotEqual(first.invocation_id, explicit_retry.invocation_id)
        self.assertEqual(first.selected_model_id, str(selected_model_id))


class StreamingPdfVisionIsolationContractTests(SimpleTestCase):
    @patch("apps.services.docparse.parsers.pdf_parser.PDFParser")
    @patch("pdfplumber.open")
    @patch("fitz.open")
    def test_pdf_native_child_never_receives_selected_model_or_vision_access(
        self,
        fitz_open,
        pdfplumber_open,
        parser_class,
    ):
        from apps.services.docparse.pdf_subprocess import (
            _parse_pages,
            parse_pdf_page_batch_in_subprocess,
        )

        self.assertNotIn(
            "selected_model_id",
            inspect.signature(parse_pdf_page_batch_in_subprocess).parameters,
        )
        fake_page = MagicMock()
        fake_page.rect.width = 612
        fake_page.rect.height = 792
        fake_document = MagicMock()
        fake_document.__getitem__.return_value = fake_page
        fitz_open.return_value = fake_document
        fake_pdf = MagicMock()
        fake_pdf.pages = [MagicMock()]
        pdfplumber_open.return_value = fake_pdf
        parser = MagicMock()
        parser.parse_page.return_value = []
        parser_class.return_value = parser

        _parse_pages(
            file_path="/fake/scanned.pdf",
            page_numbers=[1],
            vision_model="legacy/vision-name",
            user_id="user-1",
            organization_id="org-1",
        )

        self.assertEqual(parser.parse_page.call_args.args[3], "")
