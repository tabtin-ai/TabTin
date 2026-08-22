"""Wave 1 重写（W0 决策补丁 3）：source canonical 校验，旧 alias 兼容层删除验证。

枚举：``platform`` / ``app`` / ``device`` / ``user`` / ``workspace``。
旧值 ``system`` / ``market`` / ``local_agent`` / ``managed`` / ``marketplace``
不再支持——``normalize_skill_source`` 现在统一兜底归 ``user``，不做任何 legacy
映射。
"""
from __future__ import annotations

from django.test import SimpleTestCase

from apps.skills.services.registry_service import (
    CANONICAL_SOURCES,
    SOURCE_APP,
    SOURCE_DEVICE,
    SOURCE_PLATFORM,
    SOURCE_USER,
    SOURCE_WORKSPACE,
    normalize_skill_source,
)


class CanonicalSourceConstantsTest(SimpleTestCase):
    def test_canonical_sources_include_workspace(self):
        self.assertEqual(
            CANONICAL_SOURCES,
            frozenset({
                SOURCE_PLATFORM,
                SOURCE_APP,
                SOURCE_DEVICE,
                SOURCE_USER,
                SOURCE_WORKSPACE,
            }),
        )

    def test_source_constants_values(self):
        self.assertEqual(SOURCE_PLATFORM, "platform")
        self.assertEqual(SOURCE_APP, "app")
        self.assertEqual(SOURCE_DEVICE, "device")
        self.assertEqual(SOURCE_USER, "user")
        self.assertEqual(SOURCE_WORKSPACE, "workspace")


class NormalizeSkillSourceTest(SimpleTestCase):
    def test_canonical_values_pass_through(self):
        for src in CANONICAL_SOURCES:
            self.assertEqual(normalize_skill_source(src), src)

    def test_uppercase_is_normalized(self):
        self.assertEqual(normalize_skill_source("PLATFORM"), SOURCE_PLATFORM)
        self.assertEqual(normalize_skill_source("App"), SOURCE_APP)

    def test_whitespace_is_stripped(self):
        self.assertEqual(normalize_skill_source(" device "), SOURCE_DEVICE)

    def test_legacy_aliases_no_longer_mapped(self):
        for legacy in ("system", "market", "managed", "marketplace", "local_agent"):
            self.assertEqual(
                normalize_skill_source(legacy),
                SOURCE_USER,
                f"legacy '{legacy}' must fall back to user (no alias mapping)",
            )

    def test_unknown_value_falls_back_to_user(self):
        self.assertEqual(normalize_skill_source("unknown-source"), SOURCE_USER)

    def test_empty_or_none_falls_back_to_user(self):
        self.assertEqual(normalize_skill_source(""), SOURCE_USER)
        self.assertEqual(normalize_skill_source(None), SOURCE_USER)
