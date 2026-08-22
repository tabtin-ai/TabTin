"""
PDF-QUALITY-LABEL 回归测试

验证 PDF 解析各路径产出的 ChunkResult 均携带正确的 quality 字段：
- text_layer 路径 → quality="high"
- Vision 正常路径 → quality="medium"
- Vision 失败路径 → quality="low"
- 扫描件跳过路径 → quality="skipped"
- VisionParser JSON 输出 → quality="medium"
- VisionParser 纯文本回退 → quality="medium"
- VisionParser 全部失败 → quality="low"
"""

import os
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

SRC_DIR = os.path.dirname(os.path.abspath(__file__))


# ------------------------------------------------------------------
# Mock 工具
# ------------------------------------------------------------------

def _make_text_page(text="Hello world " * 20, font_size=12.0):
    """创建含文本层的 fitz mock page（>= TEXT_LAYER_THRESHOLD 字符）"""
    page = MagicMock()
    page.rect = SimpleNamespace(width=612.0, height=792.0)

    def _get_text(mode="text", **kwargs):
        if mode == "dict":
            return {"blocks": [
                {
                    "type": 0,
                    "bbox": (72, 72, 540, 100),
                    "lines": [{"spans": [
                        {"text": text, "size": font_size, "font": "Helvetica"},
                    ]}],
                }
            ]}
        return text

    page.get_text = MagicMock(side_effect=_get_text)
    return page


def _make_scan_page():
    """创建无文本层的 fitz mock page（扫描件，< TEXT_LAYER_THRESHOLD 字符）"""
    page = MagicMock()
    page.rect = SimpleNamespace(width=612.0, height=792.0)

    def _get_text(mode="text", **kwargs):
        if mode == "dict":
            return {"blocks": []}
        return ""

    page.get_text = MagicMock(side_effect=_get_text)
    return page


def _make_plumber_page():
    pp = MagicMock()
    pp.find_tables.return_value = []
    return pp


# ------------------------------------------------------------------
# 1. 文本层 → quality="high"
# ------------------------------------------------------------------

class TestTextLayerQualityHigh:
    def test_text_layer_chunks_have_quality_high(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        fitz_page = _make_text_page()
        plumber_page = _make_plumber_page()

        chunks = parser._extract_text_layer(fitz_page, plumber_page)
        assert len(chunks) > 0
        for chunk in chunks:
            assert chunk.metadata.get("quality") == "high", (
                f"text_layer chunk 应有 quality='high'，实际: {chunk.metadata}"
            )
            assert chunk.metadata.get("source") == "text_layer"

    def test_parse_page_text_layer_quality_high(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        fitz_page = _make_text_page()
        plumber_page = _make_plumber_page()

        chunks = parser.parse_page(fitz_page, plumber_page, page_idx=0)
        assert len(chunks) > 0
        for chunk in chunks:
            assert chunk.metadata.get("quality") == "high"


# ------------------------------------------------------------------
# 2. 扫描件无 Vision 配置 → quality="skipped"
# ------------------------------------------------------------------

class TestSkippedScanQuality:
    def test_skipped_scan_quality(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        fitz_page = _make_scan_page()

        chunks = parser._extract_via_vision(fitz_page, page_idx=0, vision_model="")
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "skipped"
        assert chunks[0].metadata.get("source") == "skipped_scan"

    def test_parse_page_scan_no_vision_quality_skipped(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        fitz_page = _make_scan_page()

        chunks = parser.parse_page(fitz_page, None, page_idx=0, vision_model="")
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "skipped"


# ------------------------------------------------------------------
# 3. Vision 异常 → quality="low"
# ------------------------------------------------------------------

class TestVisionErrorQualityLow:
    def test_vision_import_error_quality_low(self):
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        fitz_page = _make_scan_page()
        fitz_page.get_pixmap = MagicMock(side_effect=RuntimeError("render fail"))

        chunks = parser._extract_via_vision(
            fitz_page, page_idx=0, vision_model="test-model",
        )
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "low"
        assert chunks[0].metadata.get("is_error") is True


# ------------------------------------------------------------------
# 4. VisionParser._parse_response JSON 正常 → quality="medium"
# ------------------------------------------------------------------

class TestVisionParserQualityMedium:
    def test_parse_response_json_quality_medium(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        parser = VisionParser(model="test-model")
        raw_json = '{"blocks": [{"type": "paragraph", "content": "Hello", "bbox": [0, 0, 500, 100]}]}'
        chunks = parser._parse_response(
            raw_json, page_number=1, page_width=612, page_height=792, model="test-model",
        )
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "medium"
        assert chunks[0].metadata.get("source") == "vision"

    def test_parse_response_raw_fallback_quality_medium(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        parser = VisionParser(model="test-model")
        raw_text = "This is not valid JSON at all, just plain text"
        chunks = parser._parse_response(
            raw_text, page_number=1, page_width=612, page_height=792, model="test-model",
        )
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "medium"
        assert chunks[0].metadata.get("raw") is True

    def test_parse_response_multiple_blocks_all_medium(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        parser = VisionParser(model="test-model")
        raw_json = '{"blocks": [{"type": "heading", "content": "Title", "heading_level": 1, "bbox": [0,0,1000,50]}, {"type": "paragraph", "content": "Body text", "bbox": [0,50,1000,200]}]}'
        chunks = parser._parse_response(
            raw_json, page_number=1, page_width=612, page_height=792, model="test-model",
        )
        assert len(chunks) == 2
        for chunk in chunks:
            assert chunk.metadata.get("quality") == "medium"


# ------------------------------------------------------------------
# 5. VisionParser._fallback_error → quality="low"
# ------------------------------------------------------------------

class TestVisionParserFallbackQualityLow:
    def test_fallback_error_quality_low(self):
        from apps.services.docparse.parsers.vision_parser import VisionParser

        chunks = VisionParser._fallback_error("some error")
        assert len(chunks) == 1
        assert chunks[0].metadata.get("quality") == "low"
        assert chunks[0].metadata.get("is_error") is True


# ------------------------------------------------------------------
# 6. 完整 parse() 流程 — 文本层页面
# ------------------------------------------------------------------

class TestFullParseQuality:
    def test_full_parse_text_pages_quality_high(self):
        fake_doc = MagicMock()
        pages = [_make_text_page() for _ in range(2)]
        fake_doc.__len__ = MagicMock(return_value=2)
        fake_doc.__getitem__ = MagicMock(side_effect=lambda idx: pages[idx])
        fake_doc.close = MagicMock()

        fake_plumber = MagicMock()
        plumber_pages = [_make_plumber_page() for _ in range(2)]
        fake_plumber.pages = plumber_pages
        fake_plumber.close = MagicMock()

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
            result = parser.parse("/fake/test.pdf")

        for page in result.pages:
            for chunk in page.chunks:
                assert "quality" in chunk.metadata, (
                    f"chunk 缺少 quality 字段: {chunk.metadata}"
                )
                assert chunk.metadata["quality"] == "high"
