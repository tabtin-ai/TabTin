"""
F9 回归测试 — XLSX 解析器 P0 修复
覆盖: DP-006 (close 顺序), DP-007 (inf/nan), DP-009 (xls MIME)
"""
import math
import os
import tempfile
from unittest.mock import MagicMock, patch, PropertyMock

from django.test import TestCase

from apps.services.docparse.parsers.xlsx_parser import (
    ExcelParser,
    _cell_to_str,
    _rows_to_markdown,
)


class DP006CloseBeforeAccessTest(TestCase):
    """DP-006: wb.close() 之后不应再访问 wb.sheetnames"""

    @patch("apps.services.docparse.parsers.xlsx_parser.openpyxl", create=True)
    def test_sheetnames_accessed_before_close(self, mock_openpyxl):
        """确保 sheet_names 在 wb.close() 前已保存到局部变量"""
        source_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "parsers", "xlsx_parser.py",
        )
        with open(source_path) as f:
            source = f.read()

        lines = source.split("\n")
        close_line = None
        sheetnames_after_close = False
        for idx, line in enumerate(lines):
            if "wb.close()" in line:
                close_line = idx
            if close_line is not None and idx > close_line and "wb.sheetnames" in line:
                sheetnames_after_close = True

        self.assertFalse(
            sheetnames_after_close,
            "wb.sheetnames 不应在 wb.close() 之后被访问",
        )

    def test_sheet_names_saved_before_close(self):
        """确认代码中使用了局部变量 sheet_names 来缓存"""
        source_path = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),
            "parsers", "xlsx_parser.py",
        )
        with open(source_path) as f:
            source = f.read()

        self.assertIn("sheet_names", source)
        self.assertIn("list(wb.sheetnames)", source)


class DP007InfNanHandlingTest(TestCase):
    """DP-007: _cell_to_str 对 inf/nan 不应抛出 OverflowError"""

    def test_positive_inf_returns_empty(self):
        result = _cell_to_str(float("inf"))
        self.assertEqual(result, "")

    def test_negative_inf_returns_empty(self):
        result = _cell_to_str(float("-inf"))
        self.assertEqual(result, "")

    def test_nan_returns_empty(self):
        result = _cell_to_str(float("nan"))
        self.assertEqual(result, "")

    def test_normal_float_integer_value(self):
        self.assertEqual(_cell_to_str(3.0), "3")

    def test_normal_float_decimal_value(self):
        self.assertEqual(_cell_to_str(3.14159), "3.14159")

    def test_none_returns_empty(self):
        self.assertEqual(_cell_to_str(None), "")

    def test_string_value(self):
        self.assertEqual(_cell_to_str("hello"), "hello")

    def test_pipe_escaped(self):
        self.assertEqual(_cell_to_str("a|b"), "a\\|b")

    def test_newline_replaced(self):
        self.assertEqual(_cell_to_str("line1\nline2"), "line1 line2")

    def test_int_value(self):
        self.assertEqual(_cell_to_str(42), "42")


class DP009XlsMimeRemovedTest(TestCase):
    """DP-009: 不应注册 application/vnd.ms-excel（openpyxl 不支持 .xls）"""

    def test_xls_mime_not_in_supported(self):
        parser = ExcelParser()
        mimes = parser.supported_mimes()
        self.assertNotIn(
            "application/vnd.ms-excel",
            mimes,
            "openpyxl 不支持 .xls，不应注册 application/vnd.ms-excel",
        )

    def test_xlsx_mime_still_supported(self):
        parser = ExcelParser()
        mimes = parser.supported_mimes()
        self.assertIn(
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            mimes,
        )

    def test_only_one_mime_registered(self):
        parser = ExcelParser()
        mimes = parser.supported_mimes()
        self.assertEqual(len(mimes), 1)


class RowsToMarkdownTest(TestCase):
    """辅助函数 _rows_to_markdown 基础验证"""

    def test_empty_rows(self):
        self.assertEqual(_rows_to_markdown([]), [])

    def test_single_row(self):
        result = _rows_to_markdown([["A", "B"]])
        self.assertEqual(len(result), 2)
        self.assertIn("A", result[0])
        self.assertIn("---", result[1])

    def test_multiple_rows(self):
        result = _rows_to_markdown([["H1", "H2"], ["v1", "v2"]])
        self.assertEqual(len(result), 3)
