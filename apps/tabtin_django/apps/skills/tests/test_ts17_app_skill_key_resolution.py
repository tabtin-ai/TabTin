"""TS-17：app 来源 canonical key 的 round-trip 解析回归。

registry 把 packages/apps 下的 app skill 暴露为 ``app:<app_id>/<skill_id>``
（见 ``registry_service._build_skill_key`` / ``app_package_skills._build_app_skill_key``），
但 ``SkillPackageLoader._load_from_known_paths`` 是按
``packages/apps/*/skills/<local_id>`` 搜索的——带 ``<app_id>/`` 前缀时永远命不中
真实目录 ``packages/apps/<app_id>/skills/<skill_id>``。

修复前：用 canonical key（如 ``app:terminal/terminal-operator``）创建的 Tracker，
trigger 时 ``_resolve_skill`` 必返回 None → Run failed「Skill 未找到」。
修复后：``load()`` 的 ``app:`` 分支在整段路径查不到时，用末段（真实 skill 目录名）
兜底重试，让 canonical key 与裸 id 一样可解析。

纯文件系统读取，用 ``SimpleTestCase`` 不连库。裸 id 的 backward 路径会先探
``Skill`` 表（SimpleTestCase 下被拦），但 loader 已 try/except 兜底——这正是
DB 不可用时也能从磁盘解析 app/platform skill 的生产韧性行为，故测试照常通过。
"""
from __future__ import annotations

from django.test import SimpleTestCase

from apps.skills.services.package_loader import SkillPackageLoader


class AppSkillKeyResolutionTest(SimpleTestCase):
    """app:<app_id>/<skill_id> canonical key 必须能解析到真实 skill 包。"""

    # 选用仓库内稳定存在的 app skill：packages/apps/terminal/skills/terminal-operator/
    APP_ID = "terminal"
    SKILL_ID = "terminal-operator"

    def test_canonical_app_key_resolves(self):
        """app:<app_id>/<skill_id> 形式（registry 产出口径）应解析成功。"""
        pkg = SkillPackageLoader.load(f"app:{self.APP_ID}/{self.SKILL_ID}")
        self.assertIsNotNone(pkg, "canonical app key 未解析到包（TS-17 回归）")
        # 兜底用末段（真实 skill 目录名）命中，故 skill_id 为裸 id。
        self.assertEqual(pkg.skill_id, self.SKILL_ID)
        self.assertEqual(pkg.source, "app")
        self.assertTrue(pkg.has_doc, "app skill 应带 SKILL.md 正文")

    def test_bare_skill_id_still_resolves(self):
        """裸 skill_id（无前缀）的 backward 路径不能被破坏。"""
        pkg = SkillPackageLoader.load(self.SKILL_ID)
        self.assertIsNotNone(pkg)
        self.assertEqual(pkg.skill_id, self.SKILL_ID)
        self.assertEqual(pkg.source, "app")

    def test_app_prefixed_bare_id_resolves(self):
        """app:<skill_id>（无 app_id 段）也应解析。"""
        pkg = SkillPackageLoader.load(f"app:{self.SKILL_ID}")
        self.assertIsNotNone(pkg)
        self.assertEqual(pkg.source, "app")

    def test_unknown_app_key_returns_none(self):
        """不存在的 app key 仍返回 None（不误命中）。"""
        self.assertIsNone(SkillPackageLoader.load("app:ghost/does-not-exist-xyz"))
        self.assertIsNone(SkillPackageLoader.load("does-not-exist-xyz"))
