"""slug_utils 单元测试。"""

from django.test import SimpleTestCase

from apps.skills.services.slug_utils import (
    KEBAB_SLUG_RE,
    MAX_SKILL_SLUG_LENGTH,
    is_valid_kebab_slug,
    slugify_skill_name,
)


class SlugUtilsUnitTests(SimpleTestCase):
    def test_slugify_english_title(self):
        self.assertEqual(slugify_skill_name("My Weekly Report"), "my-weekly-report")

    def test_slugify_spaces_and_underscores(self):
        self.assertEqual(slugify_skill_name("Plan Mode"), "plan-mode")
        self.assertEqual(slugify_skill_name("foo_bar"), "foo-bar")

    def test_slugify_strips_slashes(self):
        self.assertEqual(slugify_skill_name("/code-review/"), "code-review")

    def test_slugify_collapses_hyphens(self):
        self.assertEqual(slugify_skill_name("a--b"), "a-b")

    def test_slugify_empty_fallback(self):
        self.assertEqual(slugify_skill_name(""), "skill")
        self.assertEqual(slugify_skill_name("!!!"), "skill")

    def test_slugify_drops_non_ascii_cjk(self):
        # Python str.isalnum() 对中文返回 True，但 slug 必须是 ASCII kebab——
        # 中文须被丢弃（与前端 /[a-z0-9-]/ 对齐），否则 resolve-path 的 kebab 校验会拒。
        self.assertEqual(slugify_skill_name("openai-docs (导入)"), "openai-docs")
        self.assertEqual(slugify_skill_name("中文技能"), "skill")
        self.assertTrue(is_valid_kebab_slug(slugify_skill_name("openai-docs (导入)")))

    def test_slugify_truncates_to_max_length(self):
        long_raw = "a" * 80
        slug = slugify_skill_name(long_raw)
        self.assertLessEqual(len(slug), MAX_SKILL_SLUG_LENGTH)
        self.assertTrue(is_valid_kebab_slug(slug))

    def test_is_valid_kebab_slug(self):
        self.assertTrue(is_valid_kebab_slug("code-review"))
        self.assertFalse(is_valid_kebab_slug(""))
        self.assertFalse(is_valid_kebab_slug("-bad"))
        self.assertFalse(is_valid_kebab_slug("bad-"))
        self.assertFalse(is_valid_kebab_slug("UPPER"))

    def test_regex_matches_parser_convention(self):
        self.assertTrue(KEBAB_SLUG_RE.match("gh-address-comments"))
