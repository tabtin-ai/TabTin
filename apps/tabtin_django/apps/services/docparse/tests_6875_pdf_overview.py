from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.services.docparse.api import _select_overview_chunks, get_content
from apps.services.docparse.models import ParsedDocument


def _chunk(page: int, content: str, chunk_type: str = "paragraph"):
    return SimpleNamespace(
        page=SimpleNamespace(page_number=page),
        content=content,
        chunk_type=chunk_type,
        heading_level=1 if chunk_type == "heading" else None,
    )


def test_overview_covers_every_page_for_normal_document():
    chunks = [
        item
        for page in range(1, 24)
        for item in (
            _chunk(page, f"Section {page}", "heading"),
            _chunk(page, f"Important content from page {page}."),
        )
    ]

    selected, coverage_pages = _select_overview_chunks(chunks)

    assert coverage_pages == list(range(1, 24))
    assert {chunk.page.page_number for chunk in selected} == set(range(1, 24))


def test_overview_samples_front_middle_and_end_for_long_document():
    chunks = [_chunk(page, f"Page {page} content") for page in range(1, 101)]

    selected, coverage_pages = _select_overview_chunks(chunks, max_pages=40)

    assert len(coverage_pages) == 40
    assert coverage_pages[0] == 1
    assert coverage_pages[-1] == 100
    assert any(45 <= page <= 55 for page in coverage_pages)
    assert {chunk.page.page_number for chunk in selected} == set(coverage_pages)


@patch("apps.services.docparse.api._check_file_ownership")
@patch("apps.services.docparse.api.DocParseService.get_chunks")
@patch("apps.services.docparse.api.ParsedDocument.objects.filter")
def test_content_overview_keeps_page_and_chunk_counts_separate(
    filter_mock,
    get_chunks_mock,
    ownership_mock,
):
    ownership_mock.return_value = (SimpleNamespace(), None)
    parsed = SimpleNamespace(
        status=ParsedDocument.Status.READY,
        total_pages=23,
        parsed_pages=23,
    )
    filter_mock.return_value.first.return_value = parsed
    get_chunks_mock.return_value = [
        _chunk(page, f"Page {page} content")
        for page in range(1, 24)
    ]

    result = get_content(MagicMock(), "file-1", mode="overview")

    assert result["mode"] == "overview"
    assert result["total_pages"] == 23
    assert result["total_chunks"] == 23
    assert result["coverage_pages"] == list(range(1, 24))
    assert result["has_more"] is False


@patch("apps.services.docparse.api._check_file_ownership")
@patch("apps.services.docparse.api.DocParseService.get_chunks")
@patch("apps.services.docparse.api.ParsedDocument.objects.filter")
def test_content_chunks_marks_incomplete_page_range(
    filter_mock,
    get_chunks_mock,
    ownership_mock,
):
    ownership_mock.return_value = (SimpleNamespace(), None)
    parsed = SimpleNamespace(
        status=ParsedDocument.Status.READY,
        total_pages=23,
        parsed_pages=23,
    )
    filter_mock.return_value.first.return_value = parsed
    get_chunks_mock.return_value = [
        _chunk(min(23, ((index - 1) // 19) + 1), f"Chunk {index}")
        for index in range(1, 431)
    ]

    result = get_content(MagicMock(), "file-1", mode="chunks", limit=20)

    assert result["mode"] == "chunks"
    assert result["total_pages"] == 23
    assert result["total_chunks"] == 430
    assert result["returned"] == 20
    assert result["coverage_pages"] == [1, 2]
    assert result["has_more"] is True
