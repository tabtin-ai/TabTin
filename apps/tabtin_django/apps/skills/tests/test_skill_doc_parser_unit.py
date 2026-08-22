"""skill_doc_parser 归一化双读单元测试（Phase A frontmatter 标准对齐）。

纯函数（SimpleTestCase，无 DB），覆盖：
- 旧格式（顶层 name=Title / version / 扩展字段）
- 新格式（name=kebab / metadata.version / metadata.tabtin.*）
- display_name 归一化优先级与 slug 美化兜底
"""

from django.test import SimpleTestCase

from apps.skills.services.skill_doc_parser import (
    beautify_slug,
    is_kebab_case,
    parse_skill_doc,
)


OLD_FORMAT = """---
name: Table Operator
description: 表格结构与数据操作
version: 0.4.0
auto_activate_for:
  - tabdata
tools:
  - run_terminal_command
---

# Table Operator

body
"""

NEW_FORMAT = """---
name: table-operator
description: 表格结构与数据操作
metadata:
  version: 0.4.0
  tabtin:
    displayName: Table Operator
    autoActivateFor: [tabdata]
    tools: [run_terminal_command]
---

# Table Operator

body
"""


class SkillDocParserDualReadTests(SimpleTestCase):
    def test_old_format_top_level(self):
        r = parse_skill_doc(OLD_FORMAT)
        self.assertEqual(r["name"], "Table Operator")
        self.assertEqual(r["display_name"], "Table Operator")
        self.assertEqual(r["version"], "0.4.0")
        self.assertEqual(r["auto_activate_for"], ["tabdata"])
        self.assertEqual(r["tools"], ["run_terminal_command"])

    def test_new_format_metadata_namespace(self):
        r = parse_skill_doc(NEW_FORMAT)
        # name 现在是 kebab 机器 id
        self.assertEqual(r["name"], "table-operator")
        # 展示名来自 metadata.tabtin.displayName
        self.assertEqual(r["display_name"], "Table Operator")
        # version 来自 metadata.version
        self.assertEqual(r["version"], "0.4.0")
        # 扩展字段从 metadata.tabtin 归一化
        self.assertEqual(r["auto_activate_for"], ["tabdata"])
        self.assertEqual(r["tools"], ["run_terminal_command"])

    def test_old_and_new_normalize_identically(self):
        old = parse_skill_doc(OLD_FORMAT)
        new = parse_skill_doc(NEW_FORMAT)
        for key in ("display_name", "version", "auto_activate_for", "tools"):
            self.assertEqual(old[key], new[key], f"key={key}")

    def test_metadata_version_overrides_top_level(self):
        doc = """---
name: foo
description: d
version: 0.1.0
metadata:
  version: 2.0.0
---
body"""
        self.assertEqual(parse_skill_doc(doc)["version"], "2.0.0")

    def test_kebab_name_without_display_returns_empty(self):
        doc = """---
name: weekly-report
description: d
metadata:
  version: 1.0.0
---
body"""
        r = parse_skill_doc(doc)
        self.assertEqual(r["name"], "weekly-report")
        # 没有 displayName 且 name 是 kebab → 留空，由消费方按 slug 美化
        self.assertEqual(r["display_name"], "")
        self.assertEqual(r["version"], "1.0.0")

    def test_display_name_never_falls_back_to_heading(self):
        # 无 frontmatter name / displayName 时，display_name 不应回退 `# 标题`
        doc = """---
description: d
metadata:
  version: 1.0.0
---

# Some Heading
body"""
        self.assertEqual(parse_skill_doc(doc)["display_name"], "")

    def test_display_name_prefers_explicit_over_old_name(self):
        doc = """---
name: Legacy Title
description: d
metadata:
  tabtin:
    displayName: New Display
---
body"""
        self.assertEqual(parse_skill_doc(doc)["display_name"], "New Display")

    def test_no_frontmatter(self):
        r = parse_skill_doc("just body, no frontmatter")
        self.assertFalse(r["has_frontmatter"])
        self.assertEqual(r["display_name"], "")


class BeautifySlugTests(SimpleTestCase):
    def test_basic(self):
        self.assertEqual(beautify_slug("table-operator"), "Table Operator")

    def test_path_takes_last_segment(self):
        self.assertEqual(beautify_slug("device/operations"), "Operations")

    def test_underscores_and_spaces(self):
        self.assertEqual(beautify_slug("weekly_report"), "Weekly Report")

    def test_empty(self):
        self.assertEqual(beautify_slug(""), "")


class IsKebabCaseTests(SimpleTestCase):
    def test_valid(self):
        self.assertTrue(is_kebab_case("table-operator"))
        self.assertTrue(is_kebab_case("foo"))

    def test_invalid(self):
        self.assertFalse(is_kebab_case("Table Operator"))
        self.assertFalse(is_kebab_case("PDF Toolkit"))
        self.assertFalse(is_kebab_case(""))
        self.assertFalse(is_kebab_case("-bad"))
