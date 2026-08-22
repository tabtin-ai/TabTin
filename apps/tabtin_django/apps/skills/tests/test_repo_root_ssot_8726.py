"""#8726: 仓库根 SSoT 与容器布局下 AppPackageSkills 发现回归。

运行：
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 python -m pytest apps/skills/tests/test_repo_root_ssot_8726.py -v
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from django.test import SimpleTestCase


def _write_container_layout(root: Path) -> Path:
    """模拟 ACK 镜像：/app/{apps/tabtin_django, packages/apps/...}，无根 package.json。"""
    (root / "apps" / "tabtin_django").mkdir(parents=True)
    app_dir = root / "packages" / "apps" / "tabslide"
    skill_dir = app_dir / "skills" / "html-spec"
    skill_dir.mkdir(parents=True)
    (app_dir / "app.json").write_text(
        json.dumps(
            {
                "id": "tabslide",
                "distribution": "builtin",
                "runtimeBindings": {"skillsProvider": "skills:local"},
                "skills": ["skills/html-spec"],
            }
        ),
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text(
        "\n".join(
            [
                "---",
                "name: html-spec",
                "description: TabSlide HTML spec",
                "---",
                "# html-spec",
                "",
            ]
        ),
        encoding="utf-8",
    )
    return root


class RepoRootSSoT8726Test(SimpleTestCase):
    def tearDown(self):
        from apps.services.repo_root import get_repo_root
        from apps.skills.services.app_package_skills import clear_app_payloads_cache

        get_repo_root.cache_clear()
        clear_app_payloads_cache()
        super().tearDown()

    def test_path_utils_delegates_to_services_repo_root(self):
        from apps.common import path_utils
        from apps.services import repo_root

        self.assertIs(path_utils.get_repo_root, repo_root.get_repo_root)
        self.assertEqual(path_utils.get_repo_root(), repo_root.get_repo_root())

    def test_container_layout_without_package_json_finds_app_skills(self):
        """TABTIN_REPO_ROOT 已设、无根 package.json 时仍能扫到 app skill。"""
        from apps.services.repo_root import get_repo_root
        from apps.skills.services.app_package_skills import (
            AppPackageSkillsService,
            clear_app_payloads_cache,
        )

        with TemporaryDirectory() as tmp:
            root = _write_container_layout(Path(tmp))
            get_repo_root.cache_clear()
            clear_app_payloads_cache()
            with mock.patch.dict(os.environ, {"TABTIN_REPO_ROOT": str(root)}):
                get_repo_root.cache_clear()
                self.assertEqual(get_repo_root(), root.resolve())
                skills = AppPackageSkillsService.list_skills()
            keys = {s.get("skill_key") for s in skills}
            self.assertIn("app:tabslide/html-spec", keys)

    def test_old_path_utils_fallback_would_miss_packages(self):
        """对照：旧启发式在无 package.json 时落到 apps/，扫不到 packages/apps。"""
        from apps.skills.services.app_package_skills import _scan_app_packages

        with TemporaryDirectory() as tmp:
            root = _write_container_layout(Path(tmp))
            wrong_root = root / "apps"
            self.assertEqual(_scan_app_packages(wrong_root), [])
            self.assertGreater(len(_scan_app_packages(root)), 0)
