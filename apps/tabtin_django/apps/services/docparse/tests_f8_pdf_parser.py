"""
F8 测试 — PDF 解析器文件句柄泄漏 (DP-004) + DoS 页数防护 (DP-005)

通过 mock fitz / pdfplumber 验证：
- 异常时 doc.close() 和 plumber_pdf.close() 仍被调用
- 正常结束时两者均 close
- 超过 _MAX_PAGES 时截断并记录警告日志
- 未超限时不截断、不警告
"""

import logging
import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

SRC_DIR = os.path.dirname(os.path.abspath(__file__))


def _read_source(relpath: str) -> str:
    with open(os.path.join(SRC_DIR, relpath)) as f:
        return f.read()


# ------------------------------------------------------------------
# 源码静态检查（不依赖 fitz / pdfplumber 可导入）
# ------------------------------------------------------------------

class TestDP004SourceAnalysis:
    """DP-004: 验证 parse() 中使用了 try/finally 保护文件句柄"""

    def test_try_finally_present(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "try:" in src
        assert "finally:" in src

    def test_close_in_finally(self):
        src = _read_source("parsers/pdf_parser.py")
        lines = src.split("\n")
        in_finally = False
        found_doc_close = False
        found_plumber_close = False
        for line in lines:
            stripped = line.strip()
            if stripped == "finally:":
                in_finally = True
                continue
            if in_finally:
                if "doc.close()" in stripped:
                    found_doc_close = True
                if "plumber_pdf.close()" in stripped:
                    found_plumber_close = True
        assert found_doc_close, "doc.close() 应在 finally 块中"
        assert found_plumber_close, "plumber_pdf.close() 应在 finally 块中"

    def test_close_guards_none_check(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "if plumber_pdf is not None:" in src
        assert "if doc is not None:" in src


class TestDP005SourceAnalysis:
    """DP-005: 验证 _MAX_PAGES 常量与截断逻辑"""

    def test_max_pages_constant(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "_MAX_PAGES = 2000" in src

    def test_truncation_uses_min(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "min(total_pages, _MAX_PAGES)" in src

    def test_warning_logged_on_exceed(self):
        src = _read_source("parsers/pdf_parser.py")
        assert "logger.warning" in src
        assert "超过上限" in src


class TestOverlappingTextLayerDedup:
    def test_removes_overlapping_ocr_copy_with_normalized_punctuation(self):
        from apps.services.docparse.parsers.pdf_parser import (
            _RawChunk,
            _deduplicate_overlapping_chunks,
        )

        original = _RawChunk(
            chunk_type="paragraph",
            content="Anthropic’s internal teams use Claude Code.",
            bbox=(54, 100, 500, 150),
            font_size=12,
            is_bold=False,
        )
        ocr_copy = _RawChunk(
            chunk_type="paragraph",
            content="Anthropic's internal teams use Claude Code.",
            bbox=(54.2, 99.8, 499.5, 150.3),
            font_size=12,
            is_bold=False,
        )

        deduplicated = _deduplicate_overlapping_chunks([original, ocr_copy])

        assert len(deduplicated) == 1

    def test_keeps_distinct_text_in_separate_regions(self):
        from apps.services.docparse.parsers.pdf_parser import (
            _RawChunk,
            _deduplicate_overlapping_chunks,
        )

        chunks = [
            _RawChunk("paragraph", "Left column content", (20, 100, 200, 130), 12, False),
            _RawChunk("paragraph", "Right column content", (300, 100, 500, 130), 12, False),
        ]

        assert _deduplicate_overlapping_chunks(chunks) == chunks

    def test_removes_partial_ocr_copy_with_typo(self):
        from apps.services.docparse.parsers.pdf_parser import (
            _RawChunk,
            _deduplicate_overlapping_chunks,
        )

        original = _RawChunk(
            chunk_type="paragraph",
            content=(
                "The Legal team discovered Claude Code’s potential through "
                "experimentation, and a desire to learn about Anthropic’s product "
                "offerings. Additionally, one team member had a personal use case "
                "related to creating accessibility tools for family and work "
                "prototypes that demonstrate the technology’s power for non-developers."
            ),
            bbox=(70, 114, 216, 255),
            font_size=12,
            is_bold=False,
        )
        partial_ocr_copy = _RawChunk(
            chunk_type="paragraph",
            content=(
                "The Legal team discovered Claude Code's potential through "
                "experimentation, and a desire to learn about Anthropic's product "
                "offerings. Additionally, one team member had a personal use case "
                "related to creating accessibility tools for fomily and work."
            ),
            bbox=(70.1, 113.3, 215.2, 217),
            font_size=12,
            is_bold=False,
        )

        deduplicated = _deduplicate_overlapping_chunks([original, partial_ocr_copy])

        assert deduplicated == [original]


# ------------------------------------------------------------------
# 行为测试（mock fitz + pdfplumber）
# ------------------------------------------------------------------

def _make_fake_page(text="Hello world " * 5):
    page = MagicMock()
    page.rect = SimpleNamespace(width=612.0, height=792.0)

    def _get_text(mode="text", **kwargs):
        if mode == "dict":
            return {"blocks": [
                {
                    "type": 0,
                    "bbox": (72, 72, 540, 100),
                    "lines": [{"spans": [
                        {"text": text, "size": 12.0, "font": "Helvetica"},
                    ]}],
                }
            ]}
        return text

    page.get_text = MagicMock(side_effect=_get_text)
    return page


def _make_fake_doc(num_pages=3, page_factory=None):
    if page_factory is None:
        page_factory = _make_fake_page
    doc = MagicMock()
    pages = [page_factory() for _ in range(num_pages)]
    doc.__len__ = MagicMock(return_value=num_pages)
    doc.__getitem__ = MagicMock(side_effect=lambda idx: pages[idx])
    doc.close = MagicMock()
    return doc


def _make_fake_plumber(num_pages=3):
    plumber = MagicMock()
    plumber_pages = [MagicMock() for _ in range(num_pages)]
    for pp in plumber_pages:
        pp.find_tables.return_value = []
    plumber.pages = plumber_pages
    plumber.close = MagicMock()
    return plumber


@pytest.fixture
def _patch_imports():
    """Patch fitz.open and pdfplumber.open for the parser module."""
    fake_doc = _make_fake_doc()
    fake_plumber = _make_fake_plumber()

    with patch(
        "apps.services.docparse.parsers.pdf_parser.fitz"
    ) as mock_fitz, patch(
        "apps.services.docparse.parsers.pdf_parser.pdfplumber"
    ) as mock_plumber:
        mock_fitz.open.return_value = fake_doc
        mock_fitz.TEXT_PRESERVE_WHITESPACE = 1
        mock_plumber.open.return_value = fake_plumber
        yield {
            "fitz": mock_fitz,
            "plumber": mock_plumber,
            "doc": fake_doc,
            "plumber_pdf": fake_plumber,
        }


class TestDP004HandleLeak:
    """DP-004 行为: 文件句柄在正常 / 异常路径均被关闭"""

    def test_handles_closed_on_success(self, _patch_imports):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        parser.parse("/fake/test.pdf")

        _patch_imports["doc"].close.assert_called_once()
        _patch_imports["plumber_pdf"].close.assert_called_once()

    def test_handles_closed_on_page_error(self, _patch_imports):
        doc = _patch_imports["doc"]
        doc.__getitem__.side_effect = RuntimeError("corrupt page")

        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        with pytest.raises(RuntimeError, match="corrupt page"):
            parser.parse("/fake/test.pdf")

        doc.close.assert_called_once()
        _patch_imports["plumber_pdf"].close.assert_called_once()

    def test_doc_closed_when_plumber_open_fails(self):
        fake_doc = _make_fake_doc()

        with patch(
            "apps.services.docparse.parsers.pdf_parser.fitz"
        ) as mock_fitz, patch(
            "apps.services.docparse.parsers.pdf_parser.pdfplumber"
        ) as mock_plumber:
            mock_fitz.open.return_value = fake_doc
            mock_plumber.open.side_effect = OSError("cannot open")

            from apps.services.docparse.parsers.pdf_parser import PDFParser

            parser = PDFParser()
            with pytest.raises(OSError, match="cannot open"):
                parser.parse("/fake/test.pdf")

            fake_doc.close.assert_called_once()


class TestDP005PageLimit:
    """DP-005 行为: 超过 _MAX_PAGES 时截断处理"""

    def test_truncated_when_exceeds_max(self, caplog):
        big_page_count = 2500
        fake_doc = _make_fake_doc(num_pages=big_page_count)
        fake_plumber = _make_fake_plumber(num_pages=big_page_count)

        with patch(
            "apps.services.docparse.parsers.pdf_parser.fitz"
        ) as mock_fitz, patch(
            "apps.services.docparse.parsers.pdf_parser.pdfplumber"
        ) as mock_plumber:
            mock_fitz.open.return_value = fake_doc
            mock_fitz.TEXT_PRESERVE_WHITESPACE = 1
            mock_plumber.open.return_value = fake_plumber

            from apps.services.docparse.parsers.pdf_parser import PDFParser, _MAX_PAGES

            parser = PDFParser()
            with caplog.at_level(logging.WARNING):
                result = parser.parse("/fake/big.pdf")

            assert len(result.pages) == _MAX_PAGES
            assert any("超过上限" in r.message for r in caplog.records)

    def test_no_truncation_within_limit(self, caplog):
        fake_doc = _make_fake_doc(num_pages=10)
        fake_plumber = _make_fake_plumber(num_pages=10)

        with patch(
            "apps.services.docparse.parsers.pdf_parser.fitz"
        ) as mock_fitz, patch(
            "apps.services.docparse.parsers.pdf_parser.pdfplumber"
        ) as mock_plumber:
            mock_fitz.open.return_value = fake_doc
            mock_fitz.TEXT_PRESERVE_WHITESPACE = 1
            mock_plumber.open.return_value = fake_plumber

            from apps.services.docparse.parsers.pdf_parser import PDFParser

            parser = PDFParser()
            with caplog.at_level(logging.WARNING):
                result = parser.parse("/fake/small.pdf")

            assert len(result.pages) == 10
            assert not any("超过上限" in r.message for r in caplog.records)

    def test_max_pages_constant_value(self):
        from apps.services.docparse.parsers.pdf_parser import _MAX_PAGES
        assert _MAX_PAGES == 2000
