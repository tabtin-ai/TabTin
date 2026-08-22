"""
P2-1 回归测试：audit_apps G3 对 app: skill key 引用的可达性校验

验证 prompts/apps/*.py 中引用不存在的 app: skill key 时，
G3 检查输出 FAIL 而非默默放过。

运行：
    cd apps/tabtin_django
    python -m pytest apps/skills/tests/test_audit_g3_app_ref.py -v
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase


class TestAuditG3AppKeyReachability(SimpleTestCase):
    """audit_apps G3 应校验 app: 前缀的 skill key 可达性"""

    def _run_global_checks(self, prompts_content: str, known_app_skills: list):
        """创建临时 prompt 文件，运行 G3 校验，返回 results。"""
        from apps.capabilities.management.commands.audit_apps import _check_global_invariants

        with tempfile.TemporaryDirectory() as tmpdir:
            prompts_dir = Path(tmpdir) / "apps" / "services" / "agent_engine" / "prompts" / "apps"
            prompts_dir.mkdir(parents=True)
            (prompts_dir / "test_app.py").write_text(prompts_content, encoding="utf-8")

            system_skills = [
                {"skill_key": "platform:device/operations"},
            ]

            with patch(
                "apps.capabilities.management.commands.audit_apps._DJANGO_ROOT",
                Path(tmpdir),
            ), patch(
                "apps.skills.services.registry_service.SkillsRegistryService.list_system_skills",
                return_value=system_skills,
            ), patch(
                "apps.skills.services.app_package_skills.AppPackageSkillsService.list_skills",
                return_value=known_app_skills,
            ):
                results = _check_global_invariants([])

        return results

    def test_valid_app_key_passes(self):
        content = 'skills.read("app:tabdata/table-query")'
        app_skills = [{"skill_key": "app:tabdata/table-query"}]
        results = self._run_global_checks(content, app_skills)
        g3_results = [r for r in results if "skill_key" in r[2].lower() or "skills.read" in r[2].lower()]
        fails = [r for r in g3_results if "无效" in r[2]]
        self.assertEqual(len(fails), 0, f"Valid key should not fail: {fails}")

    def test_invalid_app_key_fails(self):
        content = 'skills.read("app:nonexistent/missing-skill")'
        app_skills = [{"skill_key": "app:tabdata/table-query"}]
        results = self._run_global_checks(content, app_skills)
        g3_results = [r for r in results if "无效" in r[2]]
        self.assertTrue(len(g3_results) > 0, "Invalid app: key should trigger FAIL")
