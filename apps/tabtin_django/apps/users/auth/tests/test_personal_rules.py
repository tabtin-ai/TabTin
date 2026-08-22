"""设置 IA Phase 3 §8.6 单测 · UserProfile.personal_rules 读写 API（三层规则·个人基线层）。

覆盖：
  - GET/PUT /profile/personal-rules 往返
  - 整体替换语义（PUT 覆盖前值）+ 空串清空
  - 新用户 GET 返回空串（get_or_create 兜底）
  - 落库到 UserProfile.personal_rules
  - schema 上限 5000（PersonalRulesUpdateSchema Field max_length，与 custom_rules 对齐）

跑法（root conftest 的 _ISOLATED_SETTINGS_HINTS 已登记 → 自动切 isolated settings）：
    python -m pytest apps/users/auth/tests/test_personal_rules.py -v
"""
from __future__ import annotations

from django.test import RequestFactory, TestCase
from pydantic import ValidationError

from apps.users.auth.api.profile_routes import (
    get_personal_rules,
    update_personal_rules,
    PersonalRulesUpdateSchema,
    _PERSONAL_RULES_MAX_CHARS,
)
from apps.users.auth.models import User, UserProfile


class PersonalRulesApiTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="pr@rules.test",
            password="StrongPass123!",
        )
        self.rf = RequestFactory()

    # ── helpers ────────────────────────────────────────────────────

    def _put(self, personal_rules: str):
        req = self.rf.put("/api/auth/profile/personal-rules")
        req.auth = self.user
        return update_personal_rules(
            req, PersonalRulesUpdateSchema(personal_rules=personal_rules)
        )

    def _get(self) -> str:
        req = self.rf.get("/api/auth/profile/personal-rules")
        req.auth = self.user
        return get_personal_rules(req)["data"]["personal_rules"]

    # ── 1. GET/PUT 往返 ────────────────────────────────────────────

    def test_get_empty_for_new_user(self):
        self.assertEqual(self._get(), "")

    def test_put_then_get_round_trip(self):
        resp = self._put("请始终用中文回复\n回答前先查询，不要编造")
        self.assertTrue(resp.success)
        self.assertEqual(self._get(), "请始终用中文回复\n回答前先查询，不要编造")

    def test_put_replaces_previous(self):
        """整体替换语义：PUT 覆盖前值（非 merge）。"""
        self._put("旧的个人规则")
        self._put("新的个人规则")
        self.assertEqual(self._get(), "新的个人规则")

    def test_empty_string_clears(self):
        self._put("先写点东西")
        resp = self._put("")
        self.assertTrue(resp.success)
        self.assertEqual(self._get(), "")

    # ── 2. 落库 ────────────────────────────────────────────────────

    def test_persisted_to_profile(self):
        self._put("落库校验内容")
        profile = UserProfile.objects.get(user=self.user)
        self.assertEqual(profile.personal_rules, "落库校验内容")

    # ── 3. schema 上限（与 Agent.custom_rules 对齐 5000）────────────

    def test_schema_rejects_over_limit(self):
        with self.assertRaises(ValidationError):
            PersonalRulesUpdateSchema(personal_rules="字" * (_PERSONAL_RULES_MAX_CHARS + 1))

    def test_schema_accepts_at_limit(self):
        schema = PersonalRulesUpdateSchema(personal_rules="字" * _PERSONAL_RULES_MAX_CHARS)
        self.assertEqual(len(schema.personal_rules), _PERSONAL_RULES_MAX_CHARS)
