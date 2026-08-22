import hashlib
import json
import uuid
from io import StringIO
from types import SimpleNamespace

from django.core.management import call_command
from django.db import connection
from django.test import TestCase

from apps.services.docparse.management.commands.audit_docparse_duplicates import (
    _page_keep_key,
    build_docparse_duplicate_report,
)
from apps.services.docparse.models import DocumentChunk, DocumentPage, ParsedDocument
from apps.services.oss.models import FileRecord


def _file_record(name: str = "audit.pdf") -> FileRecord:
    token = uuid.uuid4().hex
    return FileRecord.objects.create(
        file_name=name,
        file_key=f"docparse-audit/{token}/{name}",
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


class DocParseDuplicateCleanupAuditTests(TestCase):
    def _drop_docparse_unique_constraints(self):
        with connection.cursor() as cursor:
            cursor.execute(
                "ALTER TABLE services_docparse_page "
                "DROP CONSTRAINT docparse_page_document_page_uniq"
            )
            cursor.execute(
                "ALTER TABLE services_docparse_chunk "
                "DROP CONSTRAINT docparse_chunk_page_sequence_uniq"
            )

    def test_report_command_returns_zero_for_unique_rows(self):
        file_record = _file_record()
        parsed = ParsedDocument.objects.create(file_record=file_record)
        page = DocumentPage.objects.create(
            document=parsed,
            page_number=1,
            text_content="hello",
        )
        DocumentChunk.objects.create(
            page=page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="hello",
            sequence=1,
        )
        out = StringIO()

        call_command("audit_docparse_duplicates", "--json", stdout=out)

        report = json.loads(out.getvalue())
        self.assertGreaterEqual(report["page_rows_before"], 1)
        self.assertGreaterEqual(report["chunk_rows_before"], 1)
        self.assertEqual(report["estimated_page_rows_after"], report["page_rows_before"])
        self.assertEqual(report["estimated_chunk_rows_after"], report["chunk_rows_before"])
        self.assertEqual(report["duplicate_page_groups"], 0)
        self.assertEqual(report["duplicate_chunk_groups"], 0)
        self.assertEqual(report["conflicting_content_groups"], 0)
        self.assertTrue(report["unique_constraints"]["docparse_page_document_page_uniq"])
        self.assertTrue(report["unique_constraints"]["docparse_chunk_page_sequence_uniq"])

    def test_page_keep_key_prefers_chunks_then_text_then_stable_id(self):
        richer_chunks = SimpleNamespace(id="b", chunk_count=2, text_content="")
        richer_text = SimpleNamespace(id="a", chunk_count=1, text_content="long text")
        empty = SimpleNamespace(id="c", chunk_count=0, text_content="")

        ordered = sorted([empty, richer_text, richer_chunks], key=_page_keep_key)

        self.assertEqual([item.id for item in ordered], ["b", "a", "c"])

    def test_report_simulates_page_merge_and_chunk_resequence(self):
        self._drop_docparse_unique_constraints()
        file_record = _file_record("duplicates.pdf")
        parsed = ParsedDocument.objects.create(file_record=file_record)
        keep_page = DocumentPage.objects.create(
            document=parsed,
            page_number=1,
            text_content="kept page has complete text",
        )
        duplicate_page = DocumentPage.objects.create(
            document=parsed,
            page_number=1,
            text_content="duplicate",
        )
        chunk_a = DocumentChunk.objects.create(
            page=keep_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="same",
            sequence=1,
        )
        DocumentChunk.objects.create(
            page=keep_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="anchor",
            sequence=5,
        )
        DocumentChunk.objects.create(
            page=duplicate_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content=chunk_a.content,
            sequence=9,
        )
        DocumentChunk.objects.create(
            page=duplicate_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="different",
            sequence=1,
        )
        second_page = DocumentPage.objects.create(document=parsed, page_number=2)
        DocumentChunk.objects.create(
            id=uuid.UUID("00000000-0000-0000-0000-000000000001"),
            page=second_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="dup",
            sequence=1,
        )
        DocumentChunk.objects.create(
            id=uuid.UUID("00000000-0000-0000-0000-000000000002"),
            page=second_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="dup",
            sequence=1,
        )
        DocumentChunk.objects.create(
            id=uuid.UUID("00000000-0000-0000-0000-000000000003"),
            page=second_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="conflict",
            sequence=1,
        )
        DocumentChunk.objects.create(
            id=uuid.UUID("00000000-0000-0000-0000-000000000004"),
            page=second_page,
            chunk_type=DocumentChunk.ChunkType.PARAGRAPH,
            content="unique tail",
            sequence=2,
        )

        report = build_docparse_duplicate_report()

        self.assertEqual(report["duplicate_page_groups"], 1)
        self.assertEqual(report["duplicate_chunk_groups"], 1)
        self.assertEqual(report["estimated_deleted_pages"], 1)
        self.assertEqual(report["estimated_deleted_chunks"], 2)
        self.assertEqual(report["estimated_moved_chunks"], 2)
        self.assertEqual(report["conflicting_content_groups"], 2)
        self.assertEqual(report["estimated_page_rows_after"], report["page_rows_before"] - 1)
        self.assertEqual(report["estimated_chunk_rows_after"], report["chunk_rows_before"] - 2)
        self.assertEqual(report["selected_page_keeps"][0]["keep_id"], str(keep_page.id))
        self.assertEqual(report["selected_chunk_keeps"][0]["page_id"], str(second_page.id))
