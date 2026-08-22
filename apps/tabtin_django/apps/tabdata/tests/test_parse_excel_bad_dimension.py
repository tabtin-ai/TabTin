"""Excelize 风格错误 dimension 声明的 parse_excel 回归。

Go Excelize 等导出器可能写出 <dimension ref="A1">，而 sheetData 实际有多行多列。
openpyxl read_only 信任该声明时只会读出 1x1；parse_excel 须 reset_dimensions 后读全表。
"""
from __future__ import annotations

import io
import re
import zipfile

from django.test import SimpleTestCase
from openpyxl import Workbook

from apps.tabdata.services.import_parsers import parse_excel


def _xlsx_bytes(headers: list[str], rows: list[list[object]]) -> bytes:
    wb = Workbook()
    ws = wb.active
    ws.append(headers)
    for row in rows:
        ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _corrupt_dimension_to_a1(file_bytes: bytes) -> bytes:
    """把所有 worksheet 的 dimension 改成 A1，模拟 Excelize 错误声明。"""
    src = zipfile.ZipFile(io.BytesIO(file_bytes), "r")
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, "w", compression=zipfile.ZIP_DEFLATED) as dst:
        for info in src.infolist():
            data = src.read(info.filename)
            if info.filename.startswith("xl/worksheets/") and info.filename.endswith(".xml"):
                text = data.decode("utf-8")
                text = re.sub(
                    r'<dimension[^/]*/>',
                    '<dimension ref="A1"/>',
                    text,
                    count=1,
                )
                text = re.sub(
                    r'<dimension[^>]*>.*?</dimension>',
                    '<dimension ref="A1"/>',
                    text,
                    count=1,
                )
                data = text.encode("utf-8")
            dst.writestr(info, data)
    src.close()
    return out_buf.getvalue()


class ParseExcelBadDimensionTests(SimpleTestCase):
    def test_normal_xlsx_still_parses_full_grid(self):
        file_bytes = _xlsx_bytes(
            ["编号", "标题", "优先级"],
            [["MDL-1", "新建表", "P0"], ["MDL-2", "导入", "P1"]],
        )
        headers, rows = parse_excel(file_bytes)
        self.assertEqual(headers, ["编号", "标题", "优先级"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], ["MDL-1", "新建表", "P0"])
        self.assertEqual(rows[1], ["MDL-2", "导入", "P1"])

    def test_bad_dimension_a1_still_parses_full_grid(self):
        file_bytes = _corrupt_dimension_to_a1(
            _xlsx_bytes(
                ["编号", "标题", "优先级"],
                [["MDL-1", "新建表", "P0"], ["MDL-2", "导入", "P1"]],
            )
        )
        # 确认 fixture 确实把 dimension 写成了 A1
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            sheet_xml = zf.read("xl/worksheets/sheet1.xml").decode("utf-8")
        self.assertIn('ref="A1"', sheet_xml)

        headers, rows = parse_excel(file_bytes)
        self.assertEqual(headers, ["编号", "标题", "优先级"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0], ["MDL-1", "新建表", "P0"])
        self.assertEqual(rows[1], ["MDL-2", "导入", "P1"])

    def test_bad_dimension_pads_short_rows_to_header_width(self):
        """末列为空时，reset_dimensions 后行宽可能短于表头，须补齐。"""
        file_bytes = _corrupt_dimension_to_a1(
            _xlsx_bytes(
                ["A", "B", "C"],
                [["1", "2", None], ["x", None, None]],
            )
        )
        headers, rows = parse_excel(file_bytes)
        self.assertEqual(headers, ["A", "B", "C"])
        self.assertEqual(len(rows), 2)
        self.assertEqual(len(rows[0]), 3)
        self.assertEqual(len(rows[1]), 3)
        self.assertEqual(rows[0][0], "1")
        self.assertEqual(rows[1][0], "x")

    def test_max_rows_still_respected_after_reset(self):
        file_bytes = _corrupt_dimension_to_a1(
            _xlsx_bytes(
                ["col"],
                [[1], [2], [3], [4]],
            )
        )
        headers, rows = parse_excel(file_bytes, max_rows=2)
        self.assertEqual(headers, ["col"])
        self.assertEqual(len(rows), 2)
