"""
Wave 3 Batch 02 — F2-01: _extract_paragraph_spacing 仅取 space_after

验证修复后 _extract_paragraph_spacing 不再将 space_before 作为元素级 paragraphSpace 返回，
避免与段落 HTML 中 margin-top 双重叠加。
"""
import importlib.util
from pathlib import Path
from unittest import TestCase
from unittest.mock import MagicMock

_MODULE_PATH = Path(__file__).resolve().parents[1] / "services" / "pptx_io.py"
_SPEC = importlib.util.spec_from_file_location("tabslide_pptx_io_w3_02", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:
    raise RuntimeError(f"Failed to load module spec from {_MODULE_PATH}")
_PPTX_IO = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_PPTX_IO)

_extract_paragraph_spacing = _PPTX_IO._extract_paragraph_spacing


def _make_tf(paragraphs):
    """构造 mock TextFrame，包含给定的段落列表"""
    tf = MagicMock()
    tf.paragraphs = paragraphs
    return tf


def _make_para(space_before=None, space_after=None):
    """构造 mock Paragraph"""
    p = MagicMock()
    p.space_before = space_before
    p.space_after = space_after
    return p


class TestF201ParagraphSpacing(TestCase):
    """F2-01: _extract_paragraph_spacing 仅取 space_after"""

    def test_space_after_returned(self):
        """有 space_after 的段落应返回对应 pt 值"""
        tf = _make_tf([_make_para(space_after=152400)])  # 12pt
        result = _extract_paragraph_spacing(tf)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result, 12.0, places=1)

    def test_space_before_only_returns_none(self):
        """仅有 space_before 的段落不应返回任何值（由逐段 margin-top 处理）"""
        tf = _make_tf([_make_para(space_before=152400)])
        result = _extract_paragraph_spacing(tf)
        self.assertIsNone(result)

    def test_space_before_and_after_returns_after(self):
        """同时有 space_before 和 space_after 时应只返回 after 值"""
        tf = _make_tf([_make_para(space_before=76200, space_after=152400)])
        result = _extract_paragraph_spacing(tf)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result, 12.0, places=1)

    def test_no_spacing_returns_none(self):
        """无段间距时返回 None"""
        tf = _make_tf([_make_para()])
        result = _extract_paragraph_spacing(tf)
        self.assertIsNone(result)

    def test_second_para_space_after(self):
        """第一段无间距，第二段有 space_after 应返回第二段值"""
        tf = _make_tf([_make_para(), _make_para(space_after=76200)])  # 6pt
        result = _extract_paragraph_spacing(tf)
        self.assertIsNotNone(result)
        self.assertAlmostEqual(result, 6.0, places=1)

    def test_empty_textframe_returns_none(self):
        """空文本框返回 None"""
        tf = _make_tf([])
        result = _extract_paragraph_spacing(tf)
        self.assertIsNone(result)
