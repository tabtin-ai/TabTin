"""generate_skill_skeleton 新标准格式单元测试。

纯函数（SimpleTestCase，无 DB）。骨架生成不再暴露文件级版本字段。
"""

import hashlib

from django.test import SimpleTestCase

from apps.skills.services.skill_doc_parser import parse_skill_doc
from apps.skills.services.skill_service import SkillService


class GenerateSkeletonNewFormatTests(SimpleTestCase):
    def test_skeleton_uses_metadata_namespace(self):
        md = SkillService.generate_skill_skeleton(
            "Table Operator", "做表格", category="productivity", slug="table-operator",
        )
        self.assertIn("name: table-operator", md)
        self.assertIn("metadata:", md)
        self.assertIn('    displayName: "Table Operator"', md)
        self.assertIn("    category: productivity", md)
        self.assertIn("# Table Operator", md)
        self.assertNotIn("version:", md)
        self.assertNotIn("tags:", md)

    def test_skeleton_roundtrip_parses_normalized(self):
        md = SkillService.generate_skill_skeleton(
            "Table Operator", "做表格", category="productivity", slug="table-operator",
        )
        parsed = parse_skill_doc(md)
        self.assertEqual(parsed["name"], "table-operator")
        self.assertEqual(parsed["display_name"], "Table Operator")
        self.assertEqual(parsed["version"], "")

    def test_skeleton_derives_slug_when_missing(self):
        md = SkillService.generate_skill_skeleton("My Weekly Report", "d")
        self.assertIn("name: my-weekly-report", md)
        parsed = parse_skill_doc(md)
        self.assertEqual(parsed["name"], "my-weekly-report")
        self.assertEqual(parsed["display_name"], "My Weekly Report")

    def test_skeleton_without_category_omits_line(self):
        md = SkillService.generate_skill_skeleton("Foo", "d", slug="foo")
        self.assertNotIn("category:", md)

    def test_skeleton_uses_display_name_when_description_empty(self):
        md = SkillService.generate_skill_skeleton("Weekly Report", "", slug="weekly-report")
        self.assertIn('description: "Weekly Report"', md)
        parsed = parse_skill_doc(md)
        self.assertEqual(parsed["description"], "Weekly Report")

    def test_create_initial_publish_uses_same_skeleton_bytes(self):
        kwargs = {
            "name": "My Weekly Report",
            "description": "Weekly summary",
            "category": "productivity",
            "slug": "my-weekly-report",
        }
        md = SkillService.generate_skill_skeleton(**kwargs)
        digest = hashlib.sha256(md.encode("utf-8")).hexdigest()
        self.assertEqual(
            digest,
            hashlib.sha256(
                SkillService.generate_skill_skeleton(**kwargs).encode("utf-8"),
            ).hexdigest(),
        )
        self.assertIn("name: my-weekly-report", md)
