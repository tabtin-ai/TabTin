import hashlib
import inspect
import uuid
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import TestCase
from django.utils import timezone

from apps.services.docparse import api as docparse_api
from apps.services.docparse.models import DocumentChunk, DocumentImportJob, DocumentPage, ParsedDocument
from apps.services.docparse.parsers.base import ChunkResult, PageResult
from apps.services.docparse.service import (
    DocParseService,
    _build_tabdoc_import_draft,
    _finish_import_job,
    _heartbeat_import_job,
    _persist_one_page,
    requeue_stale_import_jobs,
)
from apps.services.docparse.tasks import execute_document_import_job_task
from apps.services.oss.models import FileRecord


def _file_record(name: str = "queued.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"docparse-execute/{token}/{name}",
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


class DocParseExecutionBoundaryTests(TestCase):
    def test_parse_signature_no_longer_exposes_auto_async(self):
        params = inspect.signature(DocParseService.parse).parameters
        self.assertNotIn("auto_async", params)

    @patch("apps.services.docparse.api.DocParseService.enqueue")
    @patch("apps.services.docparse.api.DocParseService.parse")
    @patch("apps.services.docparse.api._check_file_ownership")
    def test_trigger_parse_rejects_sync_mode(self, mock_ownership, mock_parse, mock_enqueue):
        request = SimpleNamespace(auth=SimpleNamespace(id="user-1"))
        mock_ownership.return_value = (SimpleNamespace(id="file-1"), None)

        result = docparse_api.trigger_parse(request, "file-1", async_mode=False)

        self.assertEqual(result["code"], "sync_parse_disabled")
        mock_parse.assert_not_called()
        mock_enqueue.assert_not_called()

    @patch("apps.services.docparse.service.DocParseService.execute_import_job")
    def test_import_job_task_calls_worker_executor(self, mock_execute_import_job):
        job = SimpleNamespace(id="job-1", status="running")
        mock_execute_import_job.return_value = job

        result = execute_document_import_job_task.run("job-1")

        self.assertEqual(result, {"status": "running", "job_id": "job-1"})
        mock_execute_import_job.assert_called_once()

    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_execute_import_job_claims_and_marks_ready_until_draft_builder(self, mock_execute):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Parsed title",
            total_pages=2,
            parsed_pages=2,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.HEADING,
            content="Parsed title",
            sequence=1,
            heading_level=1,
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="Body text",
            sequence=2,
        )
        mock_execute.return_value = parsed
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.QUEUED,
            result_payload={
                "request": {
                    "organization_id": "org-1",
                    "space_id": "space-1",
                    "file_record_id": str(file_record.id),
                }
            },
        )

        updated = DocParseService.execute_import_job(
            str(job.id),
            task_id="task-1",
            worker_id="worker-1",
        )

        self.assertEqual(updated.parsed_document_id, parsed.id)
        self.assertEqual(updated.processed_pages, 2)
        self.assertEqual(updated.stage, DocumentImportJob.Stage.BUILDING_DRAFT)
        self.assertEqual(updated.status, DocumentImportJob.Status.READY)
        self.assertEqual(updated.error_code, "")
        self.assertEqual(updated.result_payload["draft_status"], "ready")
        self.assertEqual(updated.result_payload["title"], "Parsed title")
        self.assertIn("Body text", updated.result_payload["markdown"])
        self.assertEqual(updated.result_payload["pm_json"]["type"], "doc")
        mock_execute.assert_called_once_with(
            str(file_record.id),
            import_job_id=str(job.id),
            import_job_task_id="task-1",
        )

    @patch(
        "apps.services.docparse.service._build_tabdoc_import_draft",
        side_effect=RuntimeError("draft construction failed"),
    )
    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_execute_import_job_marks_failed_when_draft_construction_fails(
        self,
        mock_execute,
        _mock_build_draft,
    ):
        file_record = _file_record("broken-draft.docx")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Parsed title",
            total_pages=1,
            parsed_pages=1,
        )
        mock_execute.return_value = parsed
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.QUEUED,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
            },
        )

        with self.assertRaisesRegex(RuntimeError, "draft construction failed"):
            DocParseService.execute_import_job(
                str(job.id),
                task_id="task-draft-failure",
                worker_id="worker-1",
            )

        job.refresh_from_db()
        self.assertEqual(job.status, DocumentImportJob.Status.FAILED)
        self.assertEqual(job.stage, DocumentImportJob.Stage.BUILDING_DRAFT)
        self.assertEqual(job.error_code, "draft_build_failed")
        self.assertIn("draft construction failed", job.error_message)
        self.assertIsNotNone(job.completed_at)
        self.assertIsNone(job.lease_expires_at)

    @patch("apps.services.oss.models.FileUsage.add_usage")
    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.services.factory.get_oss_service")
    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_execute_import_job_preserves_imported_image_in_draft(
        self,
        mock_execute,
        mock_get_oss_service,
        mock_register_uploaded_file,
        mock_add_usage,
    ):
        file_record = _file_record("image.png")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Imported image",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.IMAGE,
            content="Imported image",
            sequence=1,
            metadata={
                "image_b64": "cG5nLWJ5dGVz",
                "content_type": "image/png",
                "image_hash": "img-hash",
                "width": 320,
                "height": 180,
            },
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.IMAGE,
            content="Second image",
            sequence=2,
            metadata={
                "image_b64": "cG5nLTI=",
                "content_type": "image/png",
                "image_hash": "img-hash-2",
            },
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.IMAGE,
            content="![Existing image](https://assets.example.com/docparse/images/existing.png)",
            sequence=3,
            metadata={},
        )
        mock_execute.return_value = parsed
        first_image_id = uuid.uuid4()
        second_image_id = uuid.uuid4()
        mock_register_uploaded_file.side_effect = [
            SimpleNamespace(id=first_image_id),
            SimpleNamespace(id=second_image_id),
        ]
        oss_service = SimpleNamespace(
            config={"access_mode": "private"},
            upload_bytes=MagicMock(return_value=""),
            set_object_private=MagicMock(return_value=True),
        )
        mock_get_oss_service.return_value = oss_service
        requester_id = uuid.uuid4()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            requested_by_id=str(requester_id),
            status=DocumentImportJob.Status.QUEUED,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-1",
                "file_record_id": str(file_record.id),
                "user_id": str(requester_id),
            },
        )

        updated = DocParseService.execute_import_job(
            str(job.id),
            task_id="task-image",
            worker_id="worker-image",
        )

        self.assertEqual(updated.status, DocumentImportJob.Status.READY)
        self.assertIn("<img", updated.result_payload["markdown"])
        self.assertIn(f'src="tabtin-file://asset/{first_image_id}"', updated.result_payload["markdown"])
        self.assertIn('width="320"', updated.result_payload["markdown"])
        self.assertIn('height="180"', updated.result_payload["markdown"])
        self.assertIn(
            f"![Second image](tabtin-file://asset/{second_image_id})",
            updated.result_payload["markdown"],
        )
        self.assertIn(
            "![Existing image](https://assets.example.com/docparse/images/existing.png)",
            updated.result_payload["markdown"],
        )
        self.assertEqual(updated.result_payload["uploaded_images"], 3)
        self.assertEqual(updated.result_payload["skipped_images"], 0)
        self.assertIn("Imported image", updated.result_payload["plaintext"])
        image_nodes = []

        def collect_image_nodes(node):
            if isinstance(node, dict):
                if node.get("type") == "image":
                    image_nodes.append(node)
                for child in node.get("content", []) or []:
                    collect_image_nodes(child)
            elif isinstance(node, list):
                for child in node:
                    collect_image_nodes(child)

        self.assertEqual(updated.result_payload["pm_json"]["type"], "doc")
        collect_image_nodes(updated.result_payload["pm_json"])
        self.assertEqual(len(image_nodes), 3)
        image_attrs = [node.get("attrs", {}) for node in image_nodes]
        self.assertIn(str(first_image_id), [attrs.get("fileId") for attrs in image_attrs])
        self.assertIn(str(second_image_id), [attrs.get("fileId") for attrs in image_attrs])
        self.assertIn("Imported image", [attrs.get("alt") for attrs in image_attrs])
        sized_attrs = next(attrs for attrs in image_attrs if attrs.get("fileId") == str(first_image_id))
        self.assertEqual(sized_attrs.get("src"), "")
        self.assertEqual(sized_attrs.get("width"), 320)
        self.assertEqual(sized_attrs.get("height"), 180)
        self.assertEqual(oss_service.set_object_private.call_count, 2)
        self.assertEqual(mock_register_uploaded_file.call_count, 2)
        self.assertEqual(mock_add_usage.call_count, 2)
        for call in mock_register_uploaded_file.call_args_list:
            self.assertFalse(call.kwargs["is_public"])
            self.assertEqual(call.kwargs["context_type"], "document_import_job")

    @patch("apps.services.oss.models.FileUsage.add_usage")
    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_import_draft_recovers_pdf_text_layer_rich_blocks(
        self,
        mock_get_oss_service,
        mock_register_uploaded_file,
        _mock_add_usage,
    ):
        file_record = _file_record("rich.pdf")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Rich PDF",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.HEADING,
            content="H1 Document title style / 一级标题",
            sequence=1,
            heading_level=1,
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="[typescript]\nconst styles = ['heading', 'list', 'table', 'code']\nconsole.log(styles.join(', '))",
            sequence=2,
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="☐ Unchecked task item\n☑ Checked task item",
            sequence=3,
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content=(
                'Resizable image below:\n<img\nsrc="data:image/png;base64,cG5nLWJ5dGVz"\n'
                'alt="Embedded probe image" width="320" height="180">'
            ),
            sequence=4,
        )
        oss_service = SimpleNamespace(
            config={"access_mode": "private"},
            upload_bytes=MagicMock(return_value=""),
            set_object_private=MagicMock(return_value=True),
        )
        mock_get_oss_service.return_value = oss_service
        mock_register_uploaded_file.return_value = SimpleNamespace(id=uuid.uuid4())
        import_job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id=str(uuid.uuid4()),
            requested_by_id=str(uuid.uuid4()),
            status=DocumentImportJob.Status.RUNNING,
        )

        draft = _build_tabdoc_import_draft(parsed, import_job=import_job)

        self.assertIn("# H1 Document title style / 一级标题", draft["markdown"])
        self.assertIn("```typescript", draft["markdown"])
        self.assertIn("- [ ] Unchecked task item", draft["markdown"])
        self.assertIn("<img", draft["markdown"])
        self.assertIn('width="320"', draft["markdown"])
        self.assertIn('height="180"', draft["markdown"])
        self.assertEqual(draft["uploaded_images"], 1)

        node_types: list[str] = []
        image_attrs: list[dict] = []

        def collect_node_types(node):
            if isinstance(node, dict):
                if node.get("type"):
                    node_types.append(node["type"])
                if node.get("type") == "image":
                    image_attrs.append(node.get("attrs", {}))
                for child in node.get("content", []) or []:
                    collect_node_types(child)
            elif isinstance(node, list):
                for child in node:
                    collect_node_types(child)

        collect_node_types(draft["pm_json"])
        self.assertIn("heading", node_types)
        self.assertIn("codeBlock", node_types)
        self.assertIn("taskList", node_types)
        self.assertIn("image", node_types)
        self.assertEqual(image_attrs[0].get("width"), 320)
        self.assertEqual(image_attrs[0].get("height"), 180)

    def test_import_draft_splits_pdf_plain_text_lines_into_blocks(self):
        file_record = _file_record("plain-lines.pdf")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Plain lines PDF",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content=(
                "Plain text, bold, italic\n"
                "Line one Line two after hard break\n"
                "[typescript] const styles = ['heading', 'list']\n"
                "Bullet item level 1\n"
                "Ordered item starting at 3"
            ),
            sequence=1,
            metadata={"source": "text_layer"},
        )

        draft = _build_tabdoc_import_draft(parsed)

        self.assertIn(
            "Plain text, bold, italic\n\nLine one Line two after hard break",
            draft["markdown"],
        )
        paragraphs = [
            node for node in draft["pm_json"].get("content", [])
            if node.get("type") == "paragraph"
        ]
        paragraph_texts = [
            "".join(
                child.get("text", "")
                for child in paragraph.get("content", [])
                if child.get("type") == "text"
            )
            for paragraph in paragraphs
        ]
        self.assertEqual(paragraph_texts, [
            "Plain text, bold, italic",
            "Line one Line two after hard break",
            "Bullet item level 1",
            "Ordered item starting at 3",
        ])
        node_types = [
            node.get("type")
            for node in draft["pm_json"].get("content", [])
        ]
        self.assertIn("codeBlock", node_types)

    def test_import_draft_preserves_fallback_markdown_table_lines(self):
        file_record = _file_record("fallback-table.pdf")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="Fallback table PDF",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="| Header A | Header B |\n| --- | --- |\n| A | B |",
            sequence=1,
            metadata={"source": "text_layer"},
        )

        draft = _build_tabdoc_import_draft(parsed)

        self.assertIn("| Header A | Header B |\n| --- | --- |\n| A | B |", draft["markdown"])
        node_types = [
            node.get("type")
            for node in draft["pm_json"].get("content", [])
        ]
        self.assertIn("table", node_types)

    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_import_draft_rejects_pdf_text_layer_svg_data_image(self, mock_get_oss_service):
        file_record = _file_record("svg-image.pdf")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="SVG image PDF",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content=(
                'Image below:\n<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" '
                'alt="SVG probe" width="320" height="180">'
            ),
            sequence=1,
        )

        draft = _build_tabdoc_import_draft(parsed)

        mock_get_oss_service.assert_not_called()
        self.assertEqual(draft["uploaded_images"], 0)
        self.assertEqual(draft["skipped_images"], 1)
        self.assertNotIn("<img", draft["markdown"])
        self.assertIn("[SVG probe]", draft["markdown"])

    @patch("apps.services.oss.models.FileUsage.add_usage")
    @patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file")
    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_import_draft_normalizes_pdf_text_layer_jpg_data_image(
        self,
        mock_get_oss_service,
        mock_register_uploaded_file,
        _mock_add_usage,
    ):
        file_record = _file_record("jpg-image.pdf")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            title="JPG image PDF",
            total_pages=1,
            parsed_pages=1,
        )
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content=(
                'Image below:\n<img src="data:image/jpg;base64,anBnLWJ5dGVz" '
                'alt="JPG probe" width="320" height="180">'
            ),
            sequence=1,
        )
        oss_service = SimpleNamespace(
            config={"access_mode": "private"},
            upload_bytes=MagicMock(return_value=""),
            set_object_private=MagicMock(return_value=True),
        )
        mock_get_oss_service.return_value = oss_service
        mock_register_uploaded_file.return_value = SimpleNamespace(id=uuid.uuid4())
        import_job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id=str(uuid.uuid4()),
            requested_by_id=str(uuid.uuid4()),
            status=DocumentImportJob.Status.RUNNING,
        )

        draft = _build_tabdoc_import_draft(parsed, import_job=import_job)

        self.assertEqual(draft["uploaded_images"], 1)
        upload_args, upload_kwargs = oss_service.upload_bytes.call_args
        self.assertTrue(upload_args[1].endswith(".jpg"))
        self.assertEqual(upload_kwargs["content_type"], "image/jpeg")
        self.assertIn("<img", draft["markdown"])
        self.assertIn('alt="JPG probe"', draft["markdown"])

    @patch("apps.services.docparse.service._IMPORT_RESULT_INLINE_BYTES", 1)
    @patch("apps.services.docparse.service._build_tabdoc_import_draft")
    @patch("apps.services.oss.services.factory.get_oss_service")
    def test_old_worker_cleans_unique_result_when_owner_changes_during_upload(
        self,
        mock_get_oss_service,
        mock_build_draft,
    ):
        file_record = _file_record("large.docx")
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            total_pages=1,
            parsed_pages=1,
        )
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RUNNING,
            celery_task_id="old-task",
        )
        mock_build_draft.return_value = {
            "pm_json": {"type": "doc", "content": []},
            "markdown": "large result",
        }
        oss_service = MagicMock()

        def replace_owner(_payload, _storage_key, **_kwargs):
            DocumentImportJob.objects.filter(id=job.id).update(celery_task_id="new-task")

        oss_service.upload_bytes.side_effect = replace_owner
        mock_get_oss_service.return_value = oss_service

        updated = _finish_import_job(job.id, parsed, task_id="old-task")

        job.refresh_from_db()
        uploaded_key = oss_service.upload_bytes.call_args.args[1]
        self.assertEqual(updated.celery_task_id, "new-task")
        self.assertEqual(job.celery_task_id, "new-task")
        self.assertEqual(job.result_storage_key, "")
        self.assertTrue(uploaded_key.startswith(f"docparse/import-results/{job.id}/"))
        self.assertNotEqual(uploaded_key, f"docparse/import-results/{job.id}.json")
        oss_service.delete_file.assert_called_once_with(uploaded_key)

    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_execute_import_job_defers_when_shared_parse_is_in_progress(self, mock_execute):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.PARSING,
            total_pages=8,
            parsed_pages=3,
        )
        mock_execute.return_value = parsed
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-1",
            space_id="space-2",
            status=DocumentImportJob.Status.QUEUED,
            request_payload={
                "organization_id": "org-1",
                "space_id": "space-2",
                "file_record_id": str(file_record.id),
            },
        )

        updated = DocParseService.execute_import_job(
            str(job.id),
            task_id="task-1",
            worker_id="worker-1",
        )

        self.assertEqual(updated.status, DocumentImportJob.Status.RETRYING)
        self.assertEqual(updated.parsed_document_id, parsed.id)
        self.assertEqual(updated.processed_pages, 3)
        self.assertEqual(updated.error_code, "shared_parse_in_progress")
        self.assertIsNotNone(updated.lease_expires_at)
        self.assertIsNone(updated.completed_at)

    @patch("apps.services.docparse.service.DocParseService.execute")
    def test_execute_import_job_skips_duplicate_active_lease(self, mock_execute):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RUNNING,
            celery_task_id="active-task",
            heartbeat_at=timezone.now(),
            lease_expires_at=timezone.now() + timedelta(minutes=5),
        )

        updated = DocParseService.execute_import_job(
            str(job.id),
            task_id="duplicate-task",
            worker_id="worker-2",
        )

        self.assertEqual(updated.status, DocumentImportJob.Status.RUNNING)
        self.assertEqual(updated.celery_task_id, "active-task")
        mock_execute.assert_not_called()

    @patch("apps.services.docparse.tasks.execute_document_import_job_task")
    def test_watchdog_requeues_expired_running_job(self, mock_task):
        mock_task.apply_async.return_value = SimpleNamespace(id="retry-task")
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RUNNING,
            retry_count=0,
            lease_expires_at=timezone.now() - timedelta(minutes=1),
        )

        result = requeue_stale_import_jobs()

        job.refresh_from_db()
        self.assertEqual(result["requeued"], 1)
        self.assertEqual(job.status, DocumentImportJob.Status.RETRYING)
        self.assertEqual(job.retry_count, 1)
        self.assertEqual(job.celery_task_id, "retry-task")

    @patch("apps.services.docparse.tasks.execute_document_import_job_task")
    def test_watchdog_requeues_shared_parse_wait_without_retry_budget(self, mock_task):
        mock_task.apply_async.return_value = SimpleNamespace(id="retry-task")
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.PARSING,
            total_pages=10,
            parsed_pages=4,
        )
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RETRYING,
            parsed_document=parsed,
            retry_count=3,
            error_code="shared_parse_in_progress",
            lease_expires_at=timezone.now() - timedelta(minutes=1),
        )

        result = requeue_stale_import_jobs()

        job.refresh_from_db()
        self.assertEqual(result["requeued"], 1)
        self.assertEqual(result["failed"], 0)
        self.assertEqual(job.status, DocumentImportJob.Status.RETRYING)
        self.assertEqual(job.retry_count, 3)
        self.assertEqual(job.error_code, "shared_parse_in_progress")
        self.assertEqual(job.celery_task_id, "retry-task")

    @patch("apps.services.docparse.tasks.execute_document_import_job_task")
    def test_old_worker_cannot_finish_after_watchdog_requeue(self, mock_task):
        mock_task.apply_async.return_value = SimpleNamespace(id="new-task")
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            total_pages=1,
            parsed_pages=1,
        )
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RUNNING,
            celery_task_id="old-task",
            retry_count=0,
            lease_expires_at=timezone.now() - timedelta(minutes=1),
        )

        requeue_stale_import_jobs()
        _finish_import_job(job.id, parsed, task_id="old-task")

        job.refresh_from_db()
        self.assertEqual(job.status, DocumentImportJob.Status.RETRYING)
        self.assertEqual(job.celery_task_id, "new-task")
        self.assertIsNone(job.parsed_document_id)

    def test_old_worker_cannot_heartbeat_new_lease_owner(self):
        file_record = _file_record()
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RUNNING,
            celery_task_id="new-task",
            processed_pages=0,
            lease_expires_at=timezone.now() + timedelta(minutes=5),
        )

        updated = _heartbeat_import_job(
            str(job.id),
            task_id="old-task",
            processed_pages=9,
        )

        job.refresh_from_db()
        self.assertFalse(updated)
        self.assertEqual(job.processed_pages, 0)

    def test_old_worker_cannot_finish_during_watchdog_owner_gap(self):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(
            file_record=file_record,
            status=ParsedDocument.Status.READY,
            total_pages=1,
            parsed_pages=1,
        )
        job = DocumentImportJob.objects.create(
            file_record=file_record,
            status=DocumentImportJob.Status.RETRYING,
            celery_task_id="",
            retry_count=1,
            lease_expires_at=None,
        )

        _finish_import_job(job.id, parsed, task_id="old-task")

        job.refresh_from_db()
        self.assertEqual(job.status, DocumentImportJob.Status.RETRYING)
        self.assertIsNone(job.parsed_document_id)

    def test_persist_one_page_upserts_without_duplicate_chunks(self):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(file_record=file_record)
        first = PageResult(
            page_number=1,
            width=100,
            height=200,
            chunks=[
                ChunkResult("paragraph", "old", 1),
                ChunkResult("paragraph", "stale", 2),
            ],
            text_content="old\nstale",
        )
        second = PageResult(
            page_number=1,
            width=300,
            height=400,
            chunks=[ChunkResult("paragraph", "new", 1)],
            text_content="new",
        )

        with self.captureOnCommitCallbacks(execute=True):
            _persist_one_page(parsed, first)
            _persist_one_page(parsed, second)

        page = DocumentPage.objects.get(document=parsed, page_number=1)
        chunks = list(DocumentChunk.objects.filter(page=page).order_by("sequence"))
        self.assertEqual(page.width, 300)
        self.assertEqual([chunk.content for chunk in chunks], ["new"])
