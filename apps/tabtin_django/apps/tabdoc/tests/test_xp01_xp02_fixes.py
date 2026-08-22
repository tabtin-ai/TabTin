"""Tests for XP-01 (table pipe escape) and XP-02 (nested list preservation).

XP-01: _parse_table_row must handle \\| escape so cells containing pipe chars
       are not split into extra columns.

XP-02: Markdown → PM JSON list parsing must preserve nested list hierarchy
       instead of flattening all items to the top level.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import unittest

# 直接导入模块文件，绕过 services/__init__.py（会触发 Django 模型加载）
_BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_MODULE_PATH = os.path.join(_BASE, "tabdoc", "services", "markdown_exchange.py")
_spec = importlib.util.spec_from_file_location("markdown_exchange", _MODULE_PATH)
_mod = importlib.util.module_from_spec(_spec)  # type: ignore[arg-type]
_spec.loader.exec_module(_mod)  # type: ignore[union-attr]

markdown_to_pm_json = _mod.markdown_to_pm_json
pm_json_to_markdown = _mod.pm_json_to_markdown


# ── XP-01: Table pipe escape ─────────────────────────────────────────────────


class TestTablePipeEscape(unittest.TestCase):
    """_parse_table_row must respect \\| and not treat it as a cell delimiter."""

    def test_basic_table_no_escape(self):
        """Regression: a plain table (no escaped pipes) must still parse correctly."""
        md = "| A | B |\n| --- | --- |\n| 1 | 2 |"
        doc = markdown_to_pm_json(md)
        table = doc["content"][0]
        self.assertEqual(table["type"], "table")
        header_cells = table["content"][0]["content"]
        self.assertEqual(len(header_cells), 2)

    def test_escaped_pipe_in_cell(self):
        """A cell containing \\| must be parsed as one cell with a literal pipe."""
        md = "| Name | Formula |\n| --- | --- |\n| OR gate | A \\| B |"
        doc = markdown_to_pm_json(md)
        table = doc["content"][0]
        data_row = table["content"][1]
        cells = data_row["content"]
        self.assertEqual(len(cells), 2, "Row should have exactly 2 cells")
        cell_text = cells[1]["content"][0]["content"][0]["text"]
        self.assertIn("|", cell_text, "Cell text should contain a literal pipe")

    def test_multiple_escaped_pipes(self):
        """Multiple \\| in one cell should all be preserved."""
        md = "| Expr |\n| --- |\n| A \\| B \\| C |"
        doc = markdown_to_pm_json(md)
        table = doc["content"][0]
        data_row = table["content"][1]
        cells = data_row["content"]
        self.assertEqual(len(cells), 1)
        cell_text = cells[0]["content"][0]["content"][0]["text"]
        self.assertEqual(cell_text, "A | B | C")

    def test_double_backslash_before_pipe(self):
        """\\\\| should be parsed as literal backslash + cell delimiter."""
        md = "| A | B |\n| --- | --- |\n| foo\\\\ | bar |"
        doc = markdown_to_pm_json(md)
        table = doc["content"][0]
        data_row = table["content"][1]
        cells = data_row["content"]
        self.assertEqual(len(cells), 2)

    def test_escaped_pipe_roundtrip_from_markdown(self):
        """Markdown with \\| → PM JSON → Markdown: pipe should survive roundtrip."""
        md_in = "| Expr |\n| --- |\n| A \\| B |"
        doc = markdown_to_pm_json(md_in)
        table = doc["content"][0]
        self.assertEqual(table["type"], "table")
        cell_text = table["content"][1]["content"][0]["content"][0]["content"][0]["text"]
        self.assertEqual(cell_text, "A | B")
        md_out = pm_json_to_markdown(doc)
        self.assertIn("A \\| B", md_out, "Serialized Markdown should escape the pipe")


# ── XP-02: Nested list preservation ──────────────────────────────────────────


class TestNestedListParsing(unittest.TestCase):
    """Markdown → PM JSON must build nested list structures from indentation."""

    def test_simple_bullet_regression(self):
        """A flat bullet list should still work."""
        md = "- Alpha\n- Beta\n- Gamma"
        doc = markdown_to_pm_json(md)
        bl = doc["content"][0]
        self.assertEqual(bl["type"], "bulletList")
        self.assertEqual(len(bl["content"]), 3)

    def test_simple_ordered_regression(self):
        """A flat ordered list should still work."""
        md = "1. First\n2. Second"
        doc = markdown_to_pm_json(md)
        ol = doc["content"][0]
        self.assertEqual(ol["type"], "orderedList")
        self.assertEqual(len(ol["content"]), 2)

    def test_simple_task_regression(self):
        """A flat task list should still work."""
        md = "- [x] Done\n- [ ] Todo"
        doc = markdown_to_pm_json(md)
        tl = doc["content"][0]
        self.assertEqual(tl["type"], "taskList")
        self.assertEqual(len(tl["content"]), 2)
        self.assertTrue(tl["content"][0]["attrs"]["checked"])
        self.assertFalse(tl["content"][1]["attrs"]["checked"])

    def test_nested_bullet_2_levels(self):
        """Two-level nesting should produce a bulletList inside a listItem."""
        md = "- Parent\n  - Child A\n  - Child B\n- Sibling"
        doc = markdown_to_pm_json(md)
        bl = doc["content"][0]
        self.assertEqual(bl["type"], "bulletList")
        self.assertEqual(len(bl["content"]), 2, "Top level should have 2 items")
        parent_item = bl["content"][0]
        self.assertEqual(parent_item["content"][0]["type"], "paragraph")
        nested_list = parent_item["content"][1]
        self.assertEqual(nested_list["type"], "bulletList")
        self.assertEqual(len(nested_list["content"]), 2, "Nested level should have 2 items")

    def test_nested_bullet_3_levels(self):
        """Three-level nesting should produce doubly-nested bulletLists."""
        md = "- L1\n  - L2\n    - L3"
        doc = markdown_to_pm_json(md)
        bl = doc["content"][0]
        l1_item = bl["content"][0]
        l2_list = l1_item["content"][1]
        self.assertEqual(l2_list["type"], "bulletList")
        l2_item = l2_list["content"][0]
        l3_list = l2_item["content"][1]
        self.assertEqual(l3_list["type"], "bulletList")
        l3_text = l3_list["content"][0]["content"][0]["content"][0]["text"]
        self.assertEqual(l3_text, "L3")

    def test_nested_ordered_list(self):
        """Nested ordered list should preserve hierarchy."""
        md = "1. Step one\n  1. Sub-step\n2. Step two"
        doc = markdown_to_pm_json(md)
        ol = doc["content"][0]
        self.assertEqual(ol["type"], "orderedList")
        self.assertEqual(len(ol["content"]), 2)
        first_item = ol["content"][0]
        nested = first_item["content"][1]
        self.assertEqual(nested["type"], "orderedList")

    def test_mixed_list_types(self):
        """Bullet parent with ordered child should produce correct types."""
        md = "- Bullet\n  1. Ordered child"
        doc = markdown_to_pm_json(md)
        bl = doc["content"][0]
        self.assertEqual(bl["type"], "bulletList")
        nested = bl["content"][0]["content"][1]
        self.assertEqual(nested["type"], "orderedList")

    def test_nested_list_roundtrip(self):
        """PM JSON with nested list → Markdown → PM JSON should preserve nesting."""
        pm_json = {
            "type": "doc",
            "content": [
                {
                    "type": "bulletList",
                    "content": [
                        {
                            "type": "listItem",
                            "content": [
                                {"type": "paragraph", "content": [{"type": "text", "text": "Top"}]},
                                {
                                    "type": "bulletList",
                                    "content": [
                                        {
                                            "type": "listItem",
                                            "content": [
                                                {"type": "paragraph", "content": [{"type": "text", "text": "Nested"}]},
                                            ],
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                }
            ],
        }
        md = pm_json_to_markdown(pm_json)
        self.assertIn("- Top", md)
        self.assertIn("  - Nested", md)
        reparsed = markdown_to_pm_json(md)
        bl = reparsed["content"][0]
        self.assertEqual(bl["type"], "bulletList")
        nested = bl["content"][0]["content"][1]
        self.assertEqual(nested["type"], "bulletList")
        nested_text = nested["content"][0]["content"][0]["content"][0]["text"]
        self.assertEqual(nested_text, "Nested")

    def test_multiple_items_with_nesting(self):
        """Multiple top-level items, each with nested children."""
        md = "- A\n  - A1\n  - A2\n- B\n  - B1"
        doc = markdown_to_pm_json(md)
        bl = doc["content"][0]
        self.assertEqual(len(bl["content"]), 2)
        a_nested = bl["content"][0]["content"][1]
        self.assertEqual(len(a_nested["content"]), 2)
        b_nested = bl["content"][1]["content"][1]
        self.assertEqual(len(b_nested["content"]), 1)


if __name__ == "__main__":
    unittest.main()
