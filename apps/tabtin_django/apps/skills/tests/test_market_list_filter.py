"""GET /skills/market 货架过滤：只保留可安装商品。"""

from unittest.mock import patch

from django.test import SimpleTestCase

from apps.skills.api import list_market_skills


class _FakeRequest:
    auth = object()


class MarketListFilterTests(SimpleTestCase):
    def test_market_excludes_platform_and_builtin_app_skills(self):
        app_skills = [
            {
                "skill_id": "table-operator",
                "name": "Table Operator",
                "source": "app",
                "distribution": "builtin",
                "skill_key": "app:tabdata/table-operator",
            },
            {
                "skill_id": "office-skill",
                "name": "Office Pack Skill",
                "source": "app",
                "distribution": "marketplace",
                "skill_key": "app:office-pack/office-skill",
            },
            {
                "skill_id": "missing-distribution",
                "name": "Legacy App Skill",
                "source": "app",
                "skill_key": "app:legacy/missing-distribution",
            },
        ]

        with (
            patch(
                "apps.skills.api.SkillsRegistryService.list_app_skills",
                return_value=app_skills,
            ),
            patch("apps.skills.models.Skill.objects.filter") as public_filter,
        ):
            public_filter.side_effect = Exception("skip public qs in unit test")
            response = list_market_skills(_FakeRequest())

        self.assertIsInstance(response, dict)
        payload = response["data"]
        keys = [s["skill_key"] for s in payload["skills"]]
        self.assertEqual(keys, ["app:office-pack/office-skill"])
        self.assertEqual(payload["total"], 1)
        self.assertNotIn("app:tabdata/table-operator", keys)
        self.assertNotIn("app:legacy/missing-distribution", keys)
