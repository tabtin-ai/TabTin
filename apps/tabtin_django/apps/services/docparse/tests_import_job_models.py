import hashlib
import uuid

from django.db import IntegrityError, transaction
from django.test import TestCase

from apps.services.docparse.models import (
    DocumentChunk,
    DocumentImportJob,
    DocumentPage,
    ParsedDocument,
)
from apps.services.oss.models import FileRecord


def _file_record(name: str = "sample.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"docparse-tests/{token}/{name}",
        file_key_hash=hashlib.sha256(token.encode("utf-8")).hexdigest(),
        file_path=f"/tmp/{token}/{name}",
        file_size=1024,
        file_type="document",
        mime_type="application/pdf",
        file_extension="pdf",
        file_hash=hashlib.sha256(f"content-{token}".encode("utf-8")).hexdigest(),
        bucket_name="test-bucket",
        status="completed",
        organization_id="org-test",
    )


class DocumentImportJobConstraintTests(TestCase):
    def test_only_one_active_job_per_file_record_context(self):
        file_record = _file_record()
        DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-test",
            space_id="space-1",
            status=DocumentImportJob.Status.QUEUED,
        )

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                DocumentImportJob.objects.create(
                    file_record=file_record,
                    organization_id="org-test",
                    space_id="space-1",
                    status=DocumentImportJob.Status.RUNNING,
                )

    def test_active_jobs_are_scoped_by_import_context(self):
        file_record = _file_record()
        first = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-test",
            space_id="space-1",
            status=DocumentImportJob.Status.QUEUED,
        )
        second = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-test",
            space_id="space-2",
            status=DocumentImportJob.Status.QUEUED,
        )

        self.assertNotEqual(first.id, second.id)

    def test_terminal_job_allows_new_active_retry(self):
        file_record = _file_record()
        DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-test",
            space_id="space-1",
            status=DocumentImportJob.Status.FAILED,
            error_code="parse_timeout",
            error_message="worker lost",
        )

        retry = DocumentImportJob.objects.create(
            file_record=file_record,
            organization_id="org-test",
            space_id="space-1",
            status=DocumentImportJob.Status.QUEUED,
            retry_count=1,
        )

        self.assertEqual(retry.status, DocumentImportJob.Status.QUEUED)
        self.assertEqual(retry.retry_count, 1)

    def test_page_number_is_unique_per_parsed_document(self):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(file_record=file_record)
        DocumentPage.objects.create(document=parsed, page_number=1)

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                DocumentPage.objects.create(document=parsed, page_number=1)

    def test_chunk_sequence_is_unique_per_page(self):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(file_record=file_record)
        page = DocumentPage.objects.create(document=parsed, page_number=1)
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="first",
            sequence=1,
        )

        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                DocumentChunk.objects.create(
                    page=page,
                    chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
                    content="duplicate",
                    sequence=1,
                )
