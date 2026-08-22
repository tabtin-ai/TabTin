"""W1-C 回归：SkillConfig.credential_id 在 eligibility 中的行为。

覆盖：
  - valid_credential_ids=None（查询失败/未注入）→ 保守视为有效，不因 DB 抖动集体消失（P1-2）
  - valid_credential_ids=set() → 所有 credential_id 都判为无效
  - valid_credential_ids={...} → 命中才算有效

不依赖数据库，全部走 SimpleTestCase + 纯内存 skill_settings。
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.skills.services.eligibility import SkillEligibilityService


class CredentialIdEligibilityTests(SimpleTestCase):
    def _entry(self):
        return {
            "skill_key": "openai-skill",
            "primary_env": "OPENAI_API_KEY",
            "requires": {"env": ["OPENAI_API_KEY"]},
        }

    def test_no_credential_no_env_excluded(self):
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={"openai-skill": {}},
            available_env=set(),
        )
        self.assertFalse(r, "没有 credential_id 也没有 env 时应排除")

    def test_credential_id_present_no_validation_set_included(self):
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={"openai-skill": {"credential_id": "abc"}},
            available_env=set(),
        )
        self.assertTrue(r, "未传 valid_credential_ids 时保守视为有效")

    def test_credential_id_in_valid_set_included(self):
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={"openai-skill": {"credential_id": "abc"}},
            available_env=set(),
            valid_credential_ids={"abc"},
        )
        self.assertTrue(r)

    def test_credential_id_not_in_valid_set_excluded(self):
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={"openai-skill": {"credential_id": "abc"}},
            available_env=set(),
            valid_credential_ids=set(),
        )
        self.assertFalse(r, "credential_id 不在有效集合时应排除")

    def test_credential_id_dangling_after_delete(self):
        """引用的 credential 被删除后再被查 → 不在 valid_credential_ids 集合 → 排除。"""
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={"openai-skill": {"credential_id": "deleted-uuid"}},
            available_env=set(),
            valid_credential_ids={"other-valid-uuid"},
        )
        self.assertFalse(r)

    def test_env_overrides_missing_credential(self):
        """即使没绑 credential_id，但 env 手动配了 primary_env 值，仍应通过。"""
        r = SkillEligibilityService.should_include(
            self._entry(),
            skill_settings={
                "openai-skill": {"env": {"OPENAI_API_KEY": "sk-manual-value"}}
            },
            available_env=set(),
            valid_credential_ids=set(),
        )
        self.assertTrue(r, "手动 env 覆盖时不依赖 credential_id")
