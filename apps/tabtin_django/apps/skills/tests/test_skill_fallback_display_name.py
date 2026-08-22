"""携带集兜底名称只留 canonical key 末段。"""

from django.test import SimpleTestCase

from apps.skills.services.agent_link_service import skill_fallback_display_name


class SkillFallbackDisplayNameTests(SimpleTestCase):
    def test_strips_app_pack_prefix(self):
        self.assertEqual(
            skill_fallback_display_name("app:tabtin-data-ai-pack/table-data-production"),
            "table-data-production",
        )
        self.assertEqual(
            skill_fallback_display_name("app:tabtin-document-ai-pack/ppt-master"),
            "ppt-master",
        )

    def test_keeps_single_segment_keys(self):
        self.assertEqual(skill_fallback_display_name("app:tabcode-operator"), "tabcode-operator")
        self.assertEqual(skill_fallback_display_name("user:deep-explain"), "deep-explain")
        self.assertEqual(skill_fallback_display_name(""), "")
