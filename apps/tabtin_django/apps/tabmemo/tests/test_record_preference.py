"""
记录偏好渲染器测试（SimpleTestCase，不依赖数据库）。

覆盖 render_record_preference 的各风格、自定义维度组装、额外偏好追加，
以及向后兼容（faithful / 未知 style / 脏数据 → 不报错、不注入）。
"""

from django.test import SimpleTestCase

from apps.tabmemo.services.record_preference import render_record_preference


class RenderRecordPreferenceTests(SimpleTestCase):

    def test_faithful_returns_empty(self):
        """faithful = 现状默认，不注入额外指令（向后兼容）。"""
        self.assertEqual(render_record_preference("faithful"), "")

    def test_unknown_style_returns_empty(self):
        self.assertEqual(render_record_preference("nonexistent"), "")

    def test_minimal_has_instruction(self):
        self.assertIn("惜字如金", render_record_preference("minimal"))

    def test_companion_has_judgment_instruction(self):
        self.assertIn("长期协作者", render_record_preference("companion"))

    def test_custom_assembles_all_dimensions(self):
        out = render_record_preference(
            "custom",
            {
                "density": "concise",
                "depth": "with_judgment",
                "tone": "warm",
                "focus": ["about_user", "method"],
            },
        )
        self.assertIn("记录从简", out)          # density
        self.assertIn("判断", out)              # depth
        self.assertIn("有温度", out)            # tone
        self.assertIn("对这个人的理解", out)     # focus: about_user
        self.assertIn("方法与可复用经验", out)   # focus: method

    def test_custom_empty_config_returns_empty(self):
        self.assertEqual(render_record_preference("custom", {}), "")

    def test_custom_ignores_unknown_dimension_values(self):
        # 脏数据：未知枚举值被静默忽略，不抛错
        out = render_record_preference(
            "custom", {"density": "bogus", "depth": "facts_only"},
        )
        self.assertIn("只记客观事实", out)
        self.assertNotIn("bogus", out)

    def test_extra_preference_appended_with_faithful(self):
        out = render_record_preference("faithful", None, "多关注我的决策习惯")
        self.assertIn("用户的额外偏好", out)
        self.assertIn("多关注我的决策习惯", out)

    def test_extra_preference_combined_with_style(self):
        out = render_record_preference("companion", None, "别记代码细节")
        self.assertIn("长期协作者", out)
        self.assertIn("别记代码细节", out)

    def test_extra_preference_whitespace_only_stripped(self):
        self.assertEqual(render_record_preference("faithful", None, "   "), "")

    def test_framing_prefix_present_when_content(self):
        # TM-16：非空注入文本带平台框定语前缀，让其在 system prompt 里边界清晰。
        out = render_record_preference("minimal")
        self.assertTrue(out.startswith("以下是用户对你记笔记风格的偏好"))
        self.assertIn("惜字如金", out)

    def test_framing_prefix_absent_when_empty(self):
        # 空内容（faithful）不加框定语，仍返回纯空串（向后兼容、不注入）。
        self.assertEqual(render_record_preference("faithful"), "")
