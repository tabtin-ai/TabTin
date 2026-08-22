"""
V2 P1 Wave2-03b 修复回归测试

- B6-V2-03: _write_cell_rich_text 需写入 bullet/list 格式 (a:buChar / a:buAutoNum)
"""

from __future__ import annotations

import re
from pathlib import Path
from unittest import TestCase

_BASE = Path(__file__).resolve().parents[1]
_PPTX_IO_SRC = (_BASE / "services" / "pptx_io.py").read_text(encoding="utf-8")


def _extract_function_body(src: str, func_name: str) -> str:
    """Extract the body of a function from source code."""
    pattern = rf"^def {re.escape(func_name)}\b"
    match = re.search(pattern, src, re.MULTILINE)
    if not match:
        return ""
    start = match.start()
    # Find the end of the function (next def at same indent level or EOF)
    remaining = src[start:]
    lines = remaining.split("\n")
    body_lines = [lines[0]]
    for line in lines[1:]:
        if line and not line[0].isspace() and line.strip():
            break
        body_lines.append(line)
    return "\n".join(body_lines)


class TestB6V203WriteRichTextBullet(TestCase):
    """B6-V2-03: _write_cell_rich_text must write bullet/list XML to paragraphs."""

    def setUp(self):
        self.func_body = _extract_function_body(_PPTX_IO_SRC, "_write_cell_rich_text")
        self.assertTrue(
            len(self.func_body) > 100,
            "_write_cell_rich_text function not found in pptx_io.py",
        )

    def test_reads_bullet_type_from_para_data(self):
        """Function must read 'bullet' key from parsed paragraph data."""
        self.assertRegex(
            self.func_body,
            r'para_data\.get\(\s*["\']bullet["\']\s*\)',
            "Must read bullet_type from para_data",
        )

    def test_writes_buChar_for_unordered_list(self):
        """Must create a:buChar XML element for bullet (unordered) lists."""
        self.assertIn(
            "buChar",
            self.func_body,
            "Must write a:buChar element for unordered bullet lists",
        )

    def test_writes_buAutoNum_for_ordered_list(self):
        """Must create a:buAutoNum XML element for numbered (ordered) lists."""
        self.assertIn(
            "buAutoNum",
            self.func_body,
            "Must write a:buAutoNum element for ordered lists",
        )

    def test_sets_indent_level(self):
        """Must set lvl and marL attributes for nested list levels."""
        self.assertRegex(
            self.func_body,
            r'\.set\(\s*["\']lvl["\']\s*,',
            "Must set lvl attribute on pPr for list indentation",
        )
        self.assertRegex(
            self.func_body,
            r'\.set\(\s*["\']marL["\']\s*,',
            "Must set marL attribute on pPr for left margin indentation",
        )

    def test_reads_bulletChar_for_custom_symbols(self):
        """Must support custom bullet characters (e.g. ■, ●, ➢)."""
        self.assertRegex(
            self.func_body,
            r'para_data\.get\(\s*["\']bulletChar["\']\s*\)',
            "Must read bulletChar for custom bullet symbols",
        )

    def test_reads_numberFormat_for_ordered_list(self):
        """Must read numberFormat for ordered list type (arabicPeriod, etc)."""
        self.assertRegex(
            self.func_body,
            r'para_data\.get\(\s*["\']numberFormat["\']\s*\)',
            "Must read numberFormat from para_data for ordered list format",
        )

    def test_bulletStyle_color_support(self):
        """Must support bullet style color via buClr element."""
        self.assertIn(
            "buClr",
            self.func_body,
            "Must write a:buClr element for bullet color styling",
        )

    def test_bulletStyle_font_support(self):
        """Must support bullet style font via buFont element."""
        self.assertIn(
            "buFont",
            self.func_body,
            "Must write a:buFont element for bullet font styling",
        )

    def test_parity_with_textbox_writer(self):
        """Bullet writing pattern should match the textbox writer for consistency."""
        textbox_body = _extract_function_body(_PPTX_IO_SRC, "_write_text_element_body")
        if not textbox_body:
            self.skipTest("_write_text_element_body not found")

        for keyword in ["buChar", "buAutoNum", "buClr", "buFont"]:
            if keyword in textbox_body:
                self.assertIn(
                    keyword,
                    self.func_body,
                    f"_write_cell_rich_text missing {keyword} that exists in textbox writer",
                )
