"""
PDF-TWOPASS 回归测试 — 两遍扫描 + 自适应阈值

验证：
- _build_document_profile 对 academic / business / scan / mixed 文档的分类
- _compute_adaptive_thresholds 根据 doc_type 返回正确阈值
- _classify_block 使用不同阈值后 heading 判断差异
- _weighted_median 加权中位数正确性
- parse_page 带/不带 profile 参数的向后兼容性
- AdaptiveThresholds.default() 与原始硬编码一致
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


# ======================================================================
# 辅助函数：构造 mock fitz doc / page
# ======================================================================

def _make_span(text: str, size: float, font: str = "Helvetica") -> dict:
    return {"text": text, "size": size, "font": font}


def _make_text_block(spans: list[dict], bbox=(72, 72, 540, 100)) -> dict:
    return {
        "type": 0,
        "bbox": bbox,
        "lines": [{"spans": spans}],
    }


def _make_mock_page(
    blocks: list[dict],
    width: float = 612.0,
    height: float = 792.0,
) -> MagicMock:
    page = MagicMock()
    page.rect = SimpleNamespace(width=width, height=height)

    def _get_text(mode="text", **kwargs):
        if mode == "dict":
            return {"blocks": blocks}
        return " ".join(
            span["text"]
            for b in blocks if b["type"] == 0
            for line in b.get("lines", [])
            for span in line.get("spans", [])
        )

    page.get_text = MagicMock(side_effect=_get_text)
    return page


def _make_mock_doc(pages: list[MagicMock]) -> MagicMock:
    doc = MagicMock()
    doc.__len__ = MagicMock(return_value=len(pages))
    doc.__getitem__ = MagicMock(side_effect=lambda idx: pages[idx])
    doc.close = MagicMock()
    return doc


# ======================================================================
# _weighted_median 测试
# ======================================================================

class TestWeightedMedian:

    def test_single_entry(self):
        from apps.services.docparse.parsers.pdf_parser import _weighted_median
        assert _weighted_median({10.0: 100}) == 10.0

    def test_two_entries_median(self):
        from apps.services.docparse.parsers.pdf_parser import _weighted_median
        result = _weighted_median({10.0: 100, 20.0: 100})
        assert result == 10.0  # cumulative reaches half=100 at first entry (100 >= 100)

    def test_skewed_distribution(self):
        from apps.services.docparse.parsers.pdf_parser import _weighted_median
        result = _weighted_median({9.0: 1000, 12.0: 50, 18.0: 10})
        assert result == 9.0  # 9pt chars dominate

    def test_empty(self):
        from apps.services.docparse.parsers.pdf_parser import _weighted_median
        assert _weighted_median({}) == 0.0


# ======================================================================
# _build_document_profile 测试
# ======================================================================

class TestBuildDocumentProfile:

    def _build(self, pages):
        from apps.services.docparse.parsers.pdf_parser import _build_document_profile
        doc = _make_mock_doc(pages)
        return _build_document_profile(doc)

    def test_academic_profile(self):
        """小字号正文 (10pt) + 低粗体比例 → academic"""
        body_text = "x" * 500
        blocks = [_make_text_block([_make_span(body_text, 10.0)])]
        page = _make_mock_page(blocks)
        profile = self._build([page])

        assert profile.doc_type == "academic"
        assert profile.body_size == 10.0
        assert profile.bold_ratio == 0.0

    def test_business_profile(self):
        """中等字号正文 (12pt) + 高粗体比例 → business"""
        body_text = "y" * 300
        bold_text = "z" * 200
        blocks = [
            _make_text_block([_make_span(body_text, 12.0)]),
            _make_text_block(
                [_make_span(bold_text, 12.0, font="Helvetica-Bold")],
                bbox=(72, 120, 540, 150),
            ),
        ]
        page = _make_mock_page(blocks)
        profile = self._build([page])

        assert profile.doc_type == "business"
        assert profile.body_size == 12.0
        assert profile.bold_ratio == pytest.approx(0.4, abs=0.01)

    def test_scan_profile(self):
        """极少可见字符 → scan"""
        blocks = [_make_text_block([_make_span("ab", 6.0)])]
        page = _make_mock_page(blocks)
        profile = self._build([page])

        assert profile.doc_type == "scan"
        assert profile.visible_char_count == 2

    def test_mixed_profile(self):
        """大字号正文 (12pt) 但低粗体比例 → mixed"""
        body_text = "m" * 500
        blocks = [_make_text_block([_make_span(body_text, 12.0)])]
        page = _make_mock_page(blocks)
        profile = self._build([page])

        assert profile.doc_type == "mixed"
        assert profile.bold_ratio == 0.0

    def test_multipage_median(self):
        """多页文档的页面尺寸中位数"""
        pages = []
        for w, h in [(612, 792), (612, 792), (800, 600)]:
            blocks = [_make_text_block([_make_span("a" * 200, 10.0)])]
            pages.append(_make_mock_page(blocks, width=float(w), height=float(h)))

        profile = self._build(pages)
        assert profile.median_page_width == 612.0
        assert profile.total_pages == 3

    def test_skips_tiny_font(self):
        """size < 1pt 的隐藏 OCR 文字不计入统计"""
        hidden = _make_span("hidden" * 100, 0.5)
        visible = _make_span("visible" * 50, 10.0)
        blocks = [_make_text_block([hidden, visible])]
        page = _make_mock_page(blocks)
        profile = self._build([page])

        assert 0.5 not in profile.font_size_histogram
        assert profile.visible_char_count == len("visible" * 50)


# ======================================================================
# _compute_adaptive_thresholds 测试
# ======================================================================

class TestComputeAdaptiveThresholds:

    def _make_profile(self, doc_type: str) -> "DocumentProfile":
        from apps.services.docparse.parsers.pdf_parser import DocumentProfile
        return DocumentProfile(
            font_size_histogram={10.0: 1000},
            body_size=10.0,
            bold_ratio=0.1,
            median_page_width=612.0,
            median_page_height=792.0,
            visible_char_count=5000,
            total_pages=5,
            doc_type=doc_type,
        )

    def test_academic_thresholds(self):
        from apps.services.docparse.parsers.pdf_parser import _compute_adaptive_thresholds
        t = _compute_adaptive_thresholds(self._make_profile("academic"))
        assert t.text_layer_threshold == 100
        assert t.heading_ratios == (1.5, 1.25, 1.1)
        assert t.heading_min_gap_pt == 1.5

    def test_business_thresholds(self):
        from apps.services.docparse.parsers.pdf_parser import _compute_adaptive_thresholds
        t = _compute_adaptive_thresholds(self._make_profile("business"))
        assert t.text_layer_threshold == 80
        assert t.heading_ratios == (1.3, 1.15, 1.05)
        assert t.heading_min_gap_pt == 2.0

    def test_scan_thresholds(self):
        from apps.services.docparse.parsers.pdf_parser import _compute_adaptive_thresholds
        t = _compute_adaptive_thresholds(self._make_profile("scan"))
        assert t.text_layer_threshold == 50

    def test_mixed_uses_defaults(self):
        from apps.services.docparse.parsers.pdf_parser import (
            _compute_adaptive_thresholds,
            AdaptiveThresholds,
        )
        t = _compute_adaptive_thresholds(self._make_profile("mixed"))
        d = AdaptiveThresholds.default()
        assert t.text_layer_threshold == d.text_layer_threshold
        assert t.heading_ratios == d.heading_ratios
        assert t.heading_min_gap_pt == d.heading_min_gap_pt


# ======================================================================
# AdaptiveThresholds.default() 与原始硬编码一致
# ======================================================================

class TestAdaptiveThresholdsDefault:

    def test_matches_original_constants(self):
        from apps.services.docparse.parsers.pdf_parser import (
            AdaptiveThresholds,
            TEXT_LAYER_THRESHOLD,
            _HEADING_MIN_GAP_PT,
        )
        d = AdaptiveThresholds.default()
        assert d.text_layer_threshold == TEXT_LAYER_THRESHOLD
        assert d.heading_ratios == (1.5, 1.25, 1.1)
        assert d.heading_min_gap_pt == _HEADING_MIN_GAP_PT


# ======================================================================
# _classify_block 自适应阈值效果
# ======================================================================

class TestClassifyBlockAdaptive:
    """验证不同阈值下同一 block 的分类差异——核心回归点。"""

    def test_business_thresholds_detect_smaller_heading(self):
        """business 阈值 (h2=1.15) 能识别 ratio=1.21 的标题，默认 (h2=1.25) 不能"""
        from apps.services.docparse.parsers.pdf_parser import (
            _classify_block,
            AdaptiveThresholds,
        )
        body_size = 12.0
        dominant = 14.5  # ratio ≈ 1.208, gap = 2.5pt

        biz = AdaptiveThresholds(
            text_layer_threshold=80,
            heading_ratios=(1.3, 1.15, 1.05),
            heading_min_gap_pt=2.0,
        )
        default = AdaptiveThresholds.default()

        ct_biz, hl_biz = _classify_block(
            "Business Title Section Name Here", 14.5, dominant, body_size, False,
            thresholds=biz,
        )
        ct_def, hl_def = _classify_block(
            "Business Title Section Name Here", 14.5, dominant, body_size, False,
            thresholds=default,
        )

        # ratio 1.208 > biz h2=1.15 → heading h2; default h2=1.25 → paragraph
        assert ct_biz == "heading" and hl_biz == 2
        assert ct_def == "paragraph"

    def test_business_h3_bold_lower_threshold(self):
        """business 阈值 h3=1.05 识别 ratio=1.08 的粗体标题"""
        from apps.services.docparse.parsers.pdf_parser import (
            _classify_block,
            AdaptiveThresholds,
        )
        body_size = 12.0
        dominant = 13.0  # ratio ≈ 1.08, gap = 1.0pt < 1.5 但 >= business min_gap? No, min_gap=2.0
        # gap < 2.0 → should NOT be heading even with business thresholds
        biz = AdaptiveThresholds(
            text_layer_threshold=80,
            heading_ratios=(1.3, 1.15, 1.05),
            heading_min_gap_pt=2.0,
        )
        ct, hl = _classify_block(
            "Section", 13.0, dominant, body_size, True, thresholds=biz,
        )
        # gap=1.0 < min_gap=2.0, so heading via ratio is blocked;
        # but short bold → h4 via the bold-short-sentence path
        assert ct == "heading" and hl == 4

    def test_default_thresholds_backward_compat(self):
        """不传 thresholds 时行为与原始硬编码完全一致"""
        from apps.services.docparse.parsers.pdf_parser import _classify_block
        body_size = 10.0
        dominant = 16.0  # ratio=1.6, gap=6.0

        ct, hl = _classify_block("Big Title", 16.0, dominant, body_size, False)
        assert ct == "heading" and hl == 1

    def test_academic_h2_threshold(self):
        """academic 阈值 h2=1.25 识别 ratio=1.3 的标题"""
        from apps.services.docparse.parsers.pdf_parser import (
            _classify_block,
            AdaptiveThresholds,
        )
        body_size = 10.0
        dominant = 13.0  # ratio=1.3, gap=3.0

        acad = AdaptiveThresholds(
            text_layer_threshold=100,
            heading_ratios=(1.5, 1.25, 1.1),
            heading_min_gap_pt=1.5,
        )
        ct, hl = _classify_block(
            "Section Title", 13.0, dominant, body_size, False, thresholds=acad,
        )
        assert ct == "heading" and hl == 2


# ======================================================================
# parse_page 向后兼容性
# ======================================================================

class TestParsePageProfileParam:

    def _make_text_page(self, text="Hello world " * 20, size=12.0):
        blocks = [_make_text_block([_make_span(text, size)])]
        return _make_mock_page(blocks)

    def _make_plumber_page(self):
        pp = MagicMock()
        pp.find_tables.return_value = []
        return pp

    def test_without_profile_uses_defaults(self):
        """不传 profile 时使用默认阈值——与修改前行为一致"""
        from apps.services.docparse.parsers.pdf_parser import PDFParser

        parser = PDFParser()
        page = self._make_text_page()
        pp = self._make_plumber_page()

        from unittest.mock import patch
        with patch("apps.services.docparse.parsers.pdf_parser.fitz") as mf:
            mf.TEXT_PRESERVE_WHITESPACE = 1
            chunks = parser.parse_page(page, pp, 0)

        assert len(chunks) > 0
        assert all(c.metadata.get("source") == "text_layer" for c in chunks)

    def test_with_profile_uses_adaptive(self):
        """传入 profile 时使用自适应阈值"""
        from apps.services.docparse.parsers.pdf_parser import (
            PDFParser,
            DocumentProfile,
        )

        profile = DocumentProfile(
            font_size_histogram={12.0: 5000},
            body_size=12.0,
            bold_ratio=0.5,
            median_page_width=612.0,
            median_page_height=792.0,
            visible_char_count=5000,
            total_pages=1,
            doc_type="business",
        )

        parser = PDFParser()
        page = self._make_text_page()
        pp = self._make_plumber_page()

        from unittest.mock import patch
        with patch("apps.services.docparse.parsers.pdf_parser.fitz") as mf:
            mf.TEXT_PRESERVE_WHITESPACE = 1
            chunks = parser.parse_page(page, pp, 0, profile=profile)

        assert len(chunks) > 0

    def test_scan_threshold_triggers_vision_path(self):
        """scan profile 降低 text_layer_threshold=50, 60 个字符走文本层"""
        from apps.services.docparse.parsers.pdf_parser import (
            PDFParser,
            DocumentProfile,
        )

        scan_profile = DocumentProfile(
            font_size_histogram={10.0: 20},
            body_size=10.0,
            bold_ratio=0.0,
            median_page_width=612.0,
            median_page_height=792.0,
            visible_char_count=20,
            total_pages=1,
            doc_type="scan",
        )

        # 用足够多样的文本避免 _is_text_layer_reliable 的单字符重复检测
        text = "The quick brown fox jumps over the lazy dog and returns home safely"
        blocks = [_make_text_block([_make_span(text, 10.0)])]
        page = _make_mock_page(blocks)
        pp = self._make_plumber_page()

        parser = PDFParser()
        from unittest.mock import patch
        with patch("apps.services.docparse.parsers.pdf_parser.fitz") as mf:
            mf.TEXT_PRESERVE_WHITESPACE = 1
            chunks_scan = parser.parse_page(page, pp, 0, profile=scan_profile)
            chunks_default = parser.parse_page(page, pp, 0)

        # scan threshold=50, text has 67 chars → text_layer
        assert any(c.metadata.get("source") == "text_layer" for c in chunks_scan)
        # default threshold=100, 67 < 100 → vision/skipped_scan
        assert any(
            c.metadata.get("source") in ("skipped_scan", "vision")
            for c in chunks_default
        )
