"""SemVer 工具函数单测（发布版本校验）。"""
from django.test import SimpleTestCase

from apps.skills.services.semver_utils import (
    compare_semver,
    display_semver_for_published_version,
    max_semver_label,
    normalize_semver_label,
    suggest_next_semver,
)
from apps.skills.services.skill_service import SkillVersionConflictError


class SemverUtilsUnitTests(SimpleTestCase):
    def test_normalize_semver_label(self):
        self.assertEqual(normalize_semver_label("1.2.3"), "1.2.3")
        self.assertEqual(normalize_semver_label("v1.2.3"), "1.2.3")
        with self.assertRaises(ValueError):
            normalize_semver_label("1.2")

    def test_compare_semver(self):
        self.assertEqual(compare_semver("1.0.0", "1.0.1"), -1)
        self.assertEqual(compare_semver("2.0.0", "1.9.9"), 1)

    def test_max_semver_label(self):
        self.assertEqual(max_semver_label(["1.0.0", "1.2.0", "1.1.9"]), "1.2.0")

    def test_suggest_next_semver(self):
        self.assertEqual(suggest_next_semver([]), "0.0.1")
        self.assertEqual(suggest_next_semver(["1.2.3"]), "1.2.4")

    def test_display_semver_for_published_version(self):
        self.assertEqual(
            display_semver_for_published_version("1.0.0", 2),
            "1.0.0",
        )
        self.assertEqual(
            display_semver_for_published_version("", 1),
            "1.0.0",
        )

    def test_version_conflict_exposes_client_recovery_fields(self):
        error = SkillVersionConflictError(
            "版本号 0.0.3 已存在，请使用新的版本号",
            requested_version="0.0.3",
            latest_version="0.0.3",
        )

        self.assertEqual(str(error), "版本号 0.0.3 已存在，请使用新的版本号")
        self.assertEqual(error.response_data(), {
            "reason": "skill_version_conflict",
            "requested_version": "0.0.3",
            "latest_version": "0.0.3",
            "suggested_patch_version": "0.0.4",
        })
