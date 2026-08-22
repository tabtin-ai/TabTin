from __future__ import annotations

import json
from typing import Any

from django.core.management.base import BaseCommand
from django.db import connections

from apps.services.docparse.models import DocumentChunk, DocumentPage


def _chunk_signature(chunk: DocumentChunk) -> tuple[Any, ...]:
    metadata = chunk.metadata if isinstance(chunk.metadata, dict) else {}
    return (
        chunk.chunk_type or "",
        chunk.content or "",
        chunk.bbox_x0,
        chunk.bbox_y0,
        chunk.bbox_x1,
        chunk.bbox_y1,
        chunk.heading_level,
        json.dumps(metadata, ensure_ascii=False, sort_keys=True, default=str),
    )


def _page_keep_key(page: DocumentPage) -> tuple[int, int, str]:
    return (
        -getattr(page, "chunk_count", 0),
        -len(page.text_content or ""),
        str(page.id),
    )


def _sample(report: dict[str, Any], value: dict[str, Any], limit: int) -> None:
    if len(report["samples"]) < limit:
        report["samples"].append(value)


def build_docparse_duplicate_report(*, using: str = "default", sample_limit: int = 20) -> dict[str, Any]:
    """Build a report-only view of page/chunk duplicate cleanup decisions."""
    connection = connections[using]
    report: dict[str, Any] = {
        "database": using,
        "unique_constraints": {},
        "page_rows_before": DocumentPage.objects.using(using).count(),
        "chunk_rows_before": DocumentChunk.objects.using(using).count(),
        "duplicate_page_groups": 0,
        "duplicate_chunk_groups": 0,
        "conflicting_content_groups": 0,
        "selected_page_keeps": [],
        "selected_chunk_keeps": [],
        "estimated_deleted_pages": 0,
        "estimated_deleted_chunks": 0,
        "estimated_moved_chunks": 0,
        "samples": [],
    }
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, DocumentPage._meta.db_table)
        report["unique_constraints"]["docparse_page_document_page_uniq"] = bool(
            constraints.get("docparse_page_document_page_uniq", {}).get("unique")
        )
        constraints = connection.introspection.get_constraints(cursor, DocumentChunk._meta.db_table)
        report["unique_constraints"]["docparse_chunk_page_sequence_uniq"] = bool(
            constraints.get("docparse_chunk_page_sequence_uniq", {}).get("unique")
        )

    pages_by_id = {
        page.id: page
        for page in DocumentPage.objects.using(using).all()
    }
    chunks_by_page: dict[Any, list[DocumentChunk]] = {page_id: [] for page_id in pages_by_id}
    for chunk in DocumentChunk.objects.using(using).order_by("page_id", "sequence", "id"):
        chunks_by_page.setdefault(chunk.page_id, []).append(chunk)

    page_groups: dict[tuple[Any, int], list[DocumentPage]] = {}
    for page in pages_by_id.values():
        page_groups.setdefault((page.document_id, page.page_number), []).append(page)

    deleted_page_ids: set[Any] = set()
    deleted_chunk_ids: set[Any] = set()

    for (document_id, page_number), pages in page_groups.items():
        if len(pages) <= 1:
            continue
        for page in pages:
            page.chunk_count = len(chunks_by_page.get(page.id, []))
        pages.sort(key=_page_keep_key)
        keep = pages[0]
        report["duplicate_page_groups"] += 1
        report["estimated_deleted_pages"] += len(pages) - 1
        report["selected_page_keeps"].append({
            "document_id": str(document_id),
            "page_number": page_number,
            "keep_id": str(keep.id),
            "reason": (
                f"valid_chunks={getattr(keep, 'chunk_count', 0)} "
                f"text_chars={len(keep.text_content or '')} id={keep.id}"
            ),
        })

        keep_signatures = {_chunk_signature(chunk) for chunk in chunks_by_page.get(keep.id, [])}
        used_sequences = {chunk.sequence for chunk in chunks_by_page.get(keep.id, [])}
        next_sequence = (max(used_sequences) + 1) if used_sequences else 1
        for duplicate in pages[1:]:
            for chunk in list(chunks_by_page.get(duplicate.id, [])):
                signature = _chunk_signature(chunk)
                if signature in keep_signatures:
                    report["estimated_deleted_chunks"] += 1
                    deleted_chunk_ids.add(chunk.id)
                    continue

                target_sequence = chunk.sequence
                if target_sequence in used_sequences:
                    report["conflicting_content_groups"] += 1
                    while next_sequence in used_sequences:
                        next_sequence += 1
                    target_sequence = next_sequence
                    next_sequence += 1
                    _sample(report, {
                        "type": "page_chunk_conflict",
                        "from_page_id": str(duplicate.id),
                        "to_page_id": str(keep.id),
                        "chunk_id": str(chunk.id),
                        "old_sequence": chunk.sequence,
                        "new_sequence": target_sequence,
                    }, sample_limit)
                else:
                    _sample(report, {
                        "type": "page_chunk_move",
                        "from_page_id": str(duplicate.id),
                        "to_page_id": str(keep.id),
                        "chunk_id": str(chunk.id),
                        "sequence": target_sequence,
                    }, sample_limit)
                chunk.page_id = keep.id
                chunk.sequence = target_sequence
                chunks_by_page.setdefault(keep.id, []).append(chunk)
                keep_signatures.add(signature)
                used_sequences.add(target_sequence)
                report["estimated_moved_chunks"] += 1
            chunks_by_page.pop(duplicate.id, None)
            deleted_page_ids.add(duplicate.id)

    for page_id, chunks in list(chunks_by_page.items()):
        if page_id in deleted_page_ids:
            continue
        sequence_groups: dict[int, list[DocumentChunk]] = {}
        for chunk in chunks:
            if chunk.id in deleted_chunk_ids:
                continue
            sequence_groups.setdefault(chunk.sequence, []).append(chunk)

        for sequence, sequence_chunks in sequence_groups.items():
            sequence_chunks.sort(key=lambda chunk: str(chunk.id))
            chunks = sequence_chunks
            if len(chunks) <= 1:
                continue
            keep = chunks[0]
            keep_signature = _chunk_signature(keep)
            report["duplicate_chunk_groups"] += 1
            report["selected_chunk_keeps"].append({
                "page_id": str(page_id),
                "sequence": sequence,
                "keep_id": str(keep.id),
                "reason": "first stable id; exact matches deleted, conflicts resequenced",
            })
            used_sequences = set(sequence_groups.keys())
            next_sequence = (max(used_sequences) + 1) if used_sequences else 1
            for chunk in chunks[1:]:
                if _chunk_signature(chunk) == keep_signature:
                    report["estimated_deleted_chunks"] += 1
                    deleted_chunk_ids.add(chunk.id)
                else:
                    report["conflicting_content_groups"] += 1
                    while next_sequence in used_sequences:
                        next_sequence += 1
                    report["estimated_moved_chunks"] += 1
                    _sample(report, {
                        "type": "chunk_sequence_conflict",
                        "page_id": str(page_id),
                        "keep_id": str(keep.id),
                        "chunk_id": str(chunk.id),
                        "old_sequence": sequence,
                        "new_sequence": next_sequence,
                    }, sample_limit)
                    chunk.sequence = next_sequence
                    used_sequences.add(next_sequence)
                    next_sequence += 1

    report["estimated_page_rows_after"] = (
        report["page_rows_before"] - report["estimated_deleted_pages"]
    )
    report["estimated_chunk_rows_after"] = (
        report["chunk_rows_before"] - report["estimated_deleted_chunks"]
    )
    return report


class Command(BaseCommand):
    help = "Report docparse page/chunk duplicates before uniqueness cleanup."

    def add_arguments(self, parser):
        parser.add_argument("--database", default="default")
        parser.add_argument("--json", action="store_true", dest="as_json")
        parser.add_argument("--sample-limit", type=int, default=20)

    def handle(self, *args, **options):
        database = options["database"]
        connections[database].ensure_connection()
        report = build_docparse_duplicate_report(
            using=database,
            sample_limit=options["sample_limit"],
        )
        if options["as_json"]:
            self.stdout.write(json.dumps(report, ensure_ascii=False, sort_keys=True))
            return

        self.stdout.write("DocParse duplicate cleanup audit")
        self.stdout.write(f"database: {report['database']}")
        self.stdout.write(f"duplicate page groups: {report['duplicate_page_groups']}")
        self.stdout.write(f"duplicate chunk groups: {report['duplicate_chunk_groups']}")
        self.stdout.write(f"conflicting content groups: {report['conflicting_content_groups']}")
        self.stdout.write(f"page rows before: {report['page_rows_before']}")
        self.stdout.write(f"chunk rows before: {report['chunk_rows_before']}")
        self.stdout.write(f"estimated page rows after: {report['estimated_page_rows_after']}")
        self.stdout.write(f"estimated chunk rows after: {report['estimated_chunk_rows_after']}")
        self.stdout.write(f"estimated deleted pages: {report['estimated_deleted_pages']}")
        self.stdout.write(f"estimated deleted chunks: {report['estimated_deleted_chunks']}")
        self.stdout.write(f"estimated moved chunks: {report['estimated_moved_chunks']}")
        self.stdout.write(
            "unique constraints: "
            f"{json.dumps(report['unique_constraints'], ensure_ascii=False, sort_keys=True)}"
        )
        if report["selected_page_keeps"]:
            self.stdout.write("selected page keeps:")
            for item in report["selected_page_keeps"]:
                self.stdout.write(f"- {json.dumps(item, ensure_ascii=False, sort_keys=True)}")
        if report["selected_chunk_keeps"]:
            self.stdout.write("selected chunk keeps:")
            for item in report["selected_chunk_keeps"]:
                self.stdout.write(f"- {json.dumps(item, ensure_ascii=False, sort_keys=True)}")
        if report["samples"]:
            self.stdout.write("samples:")
            for sample in report["samples"]:
                self.stdout.write(f"- {json.dumps(sample, ensure_ascii=False, sort_keys=True)}")
