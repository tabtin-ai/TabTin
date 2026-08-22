"""
App package skill discovery single-source regression tests.

运行：
    cd apps/tabtin_django
    python -m pytest apps/skills/tests/test_app_package_skills_discovery.py -v
"""

from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import SimpleTestCase


def _write_skill(root: Path, skill_id: str, *, description: str | None = None) -> None:
    skill_dir = root / "skills" / skill_id
    skill_dir.mkdir(parents=True, exist_ok=True)
    skill_dir.joinpath("SKILL.md").write_text(
        "\n".join([
            "---",
            f"name: {skill_id}",
            f"description: {description or skill_id}",
            "---",
            f"# {skill_id}",
            "",
            "Test skill.",
            "",
        ]),
        encoding="utf-8",
    )


class AppPackageSkillsDiscoveryTest(SimpleTestCase):
    def test_skills_md_is_declaration_source_not_manifest_list(self):
        """实际存在的 SKILL.md 应被发现，即使 app.json.skills 清单是旧的。"""
        from apps.skills.services.app_package_skills import discover_app_skills

        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_skill(base, "new-skill")

            entries, skills_index, errors = discover_app_skills(
                str(base),
                manifest_skills=["skills/stale-skill"],
            )

        self.assertEqual(entries, ["skills/new-skill"])
        self.assertEqual([s["skill_id"] for s in skills_index], ["new-skill"])
        self.assertEqual(errors, [])

    def test_skills_config_only_overrides_discovered_skills(self):
        """skillsConfig.entries 只控制配置/启用状态，不声明技能身份。"""
        from apps.skills.services.app_package_skills import AppPackageSkillsService

        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_skill(base, "visible-skill")
            _write_skill(base, "disabled-skill")

            payload = {
                "id": "demo",
                "_base_dir": str(base),
                "skills": ["skills/stale-skill"],
                "skillsConfig": {
                    "entries": {
                        "disabled-skill": {"enabled": False},
                        "visible-skill": {
                            "enabled": True,
                            "env": {"DEMO_ENV": "1"},
                            "config": {"mode": "test"},
                        },
                    },
                },
            }

            skills = AppPackageSkillsService.list_skills(payloads=[payload])

        self.assertEqual([s["skill_id"] for s in skills], ["visible-skill"])
        self.assertEqual(skills[0]["skill_key"], "app:demo/visible-skill")
        self.assertEqual(skills[0]["path"], str(base / "skills" / "visible-skill"))
        self.assertEqual(skills[0]["doc_path"], str(base / "skills" / "visible-skill" / "SKILL.md"))
        self.assertEqual(skills[0]["env"], {"DEMO_ENV": "1"})
        self.assertEqual(skills[0]["config"], {"mode": "test"})

    def test_runtime_package_must_opt_in_to_local_skills(self):
        """runtime 包默认不贡献 Skill，避免与用户可见 App 双源重复。"""
        from apps.skills.services.app_package_skills import AppPackageSkillsService

        with TemporaryDirectory() as tmp:
            app_base = Path(tmp) / "apps" / "terminal"
            runtime_base = Path(tmp) / "runtimes" / "terminal"
            _write_skill(app_base, "terminal-operator", description="app copy")
            _write_skill(runtime_base, "terminal-operator", description="runtime copy")

            payloads = [
                {
                    "id": "terminal",
                    "kind": "runtime",
                    "_base_dir": str(runtime_base),
                    "runtimeBindings": {"toolProvider": "action-tools:terminal"},
                },
                {
                    "id": "terminal",
                    "kind": "app",
                    "_base_dir": str(app_base),
                    "runtimeBindings": {"skillsProvider": "skills:local"},
                },
            ]

            skills = AppPackageSkillsService.list_skills(payloads=payloads)

        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["skill_key"], "app:terminal/terminal-operator")
        self.assertEqual(skills[0]["description"], "app copy")

    def test_app_skill_distribution_is_preserved_for_marketplace_semantics(self):
        """marketplace app skills need distribution so enablement can distinguish installable catalog entries."""
        from apps.skills.services.app_package_skills import AppPackageSkillsService

        with TemporaryDirectory() as tmp:
            base = Path(tmp)
            _write_skill(base, "office-skill")
            payload = {
                "id": "office-pack",
                "distribution": "marketplace",
                "_base_dir": str(base),
                "runtimeBindings": {"skillsProvider": "skills:local"},
            }

            skills = AppPackageSkillsService.list_skills(payloads=[payload])

        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0]["skill_key"], "app:office-pack/office-skill")
        self.assertEqual(skills[0]["distribution"], "marketplace")

    def test_marketplace_app_skill_requires_enablement_to_inject(self):
        """Unlike builtin app skills, marketplace app skills are not injected until installed."""
        from apps.skills.services.registry_service import SkillsRegistryService

        skills = [
            {
                "skill_key": "app:office-pack/office-skill",
                "source": "app",
                "distribution": "marketplace",
            },
            {
                "skill_key": "app:tabdoc/tabdoc-operator",
                "source": "app",
                "distribution": "builtin",
            },
        ]

        filtered = SkillsRegistryService._filter_by_enablement(skills, {})
        self.assertEqual(
            [entry["skill_key"] for entry in filtered],
            ["app:tabdoc/tabdoc-operator"],
        )

        filtered = SkillsRegistryService._filter_by_enablement(
            skills,
            {"app:office-pack/office-skill": {"enabled": True}},
        )
        self.assertEqual(
            [entry["skill_key"] for entry in filtered],
            ["app:office-pack/office-skill", "app:tabdoc/tabdoc-operator"],
        )

    def test_cowart_official_plugin_skills_are_discoverable(self):
        """Cowart official plugin contributes local app skills from the bundled package."""
        from apps.skills.services.app_package_skills import AppPackageSkillsService

        skills = AppPackageSkillsService.list_skills(app_id="cowart")
        keys = {skill["skill_key"] for skill in skills}

        self.assertEqual(
            keys,
            {
                "app:cowart/cowart-open-canvas",
                "app:cowart/cowart-image-gen",
                "app:cowart/cowart-image-edit",
            },
        )
        for skill in skills:
            self.assertEqual(skill["distribution"], "marketplace")


class ContainerRepoRootAppSkillsLoadTest(SimpleTestCase):
    """#8726：容器布局下 AppPackageSkills 必须认 TABTIN_REPO_ROOT，不能走 path_utils 旧启发式。"""

    def test_load_app_payloads_honors_tabtin_repo_root_without_package_json(self):
        """
        镜像典型布局：``{root}/apps/tabtin_django`` + ``{root}/packages/apps``，
        无根 ``package.json`` / ``pnpm-workspace.yaml``。
        ``apps.common.path_utils`` 会错落到 ``apps/``；本路径必须仍扫到 app skill。
        """
        import json
        import os

        from apps.services.repo_root import get_repo_root
        from apps.skills.services import app_package_skills as mod
        from apps.skills.services.app_package_skills import (
            AppPackageSkillsService,
            clear_app_payloads_cache,
        )

        with TemporaryDirectory() as tmp:
            root = Path(tmp) / "app"
            django_base = root / "apps" / "tabtin_django"
            app_dir = root / "packages" / "apps" / "demo-app"
            django_base.mkdir(parents=True)
            app_dir.mkdir(parents=True)
            (app_dir / "app.json").write_text(
                json.dumps({"id": "demo-app", "distribution": "builtin"}),
                encoding="utf-8",
            )
            _write_skill(app_dir, "demo-operator", description="demo operator")

            previous = os.environ.get("TABTIN_REPO_ROOT")
            os.environ["TABTIN_REPO_ROOT"] = str(root)
            get_repo_root.cache_clear()
            clear_app_payloads_cache()
            try:
                from apps.common import path_utils

                with self.settings(BASE_DIR=str(django_base)):
                    # path_utils 已委托 services.repo_root，不再因无 package.json 落到 apps/
                    self.assertIs(path_utils.get_repo_root, get_repo_root)
                    self.assertEqual(path_utils.find_repo_root(django_base), root.resolve())
                    self.assertEqual(get_repo_root(), root.resolve())

                payloads = mod._load_app_payloads()
                self.assertTrue(
                    any(p.get("id") == "demo-app" for p in payloads),
                    f"expected demo-app in payloads, got {[p.get('id') for p in payloads]}",
                )
                skills = AppPackageSkillsService.list_skills(app_id="demo-app")
                self.assertEqual(
                    [s["skill_key"] for s in skills],
                    ["app:demo-app/demo-operator"],
                )
            finally:
                if previous is None:
                    os.environ.pop("TABTIN_REPO_ROOT", None)
                else:
                    os.environ["TABTIN_REPO_ROOT"] = previous
                get_repo_root.cache_clear()
                clear_app_payloads_cache()


class CowartOfficialPluginEnablementTest(SimpleTestCase):
    def test_cowart_install_metadata_and_enablement_filter_are_current_context_only(self):
        """Concrete Agent/Space install is represented by only that context's enablement map."""
        from apps.skills.services.registry_service import SkillsRegistryService
        from apps.skills.services.skill_service import SkillService

        canonical_key = "app:cowart/cowart-open-canvas"

        install_metadata = SkillService._app_skill_install_metadata(canonical_key)
        self.assertEqual(
            install_metadata["official_plugin_release"]["source"]["origin"],
            "https://github.com/zhongerxin/cowart",
        )
        self.assertEqual(
            install_metadata["official_plugin_release"]["source"]["pinnedRevision"],
            "v0.1.2",
        )
        self.assertEqual(
            install_metadata["official_plugin_release"]["adapter"]["id"],
            "tabtin-cowart-adapter",
        )
        self.assertFalse(install_metadata["prepared_runtime"]["dependencyInstallRequired"])

        cowart_skill = {
            "skill_key": canonical_key,
            "source": "app",
            "distribution": "marketplace",
        }
        not_installed = SkillsRegistryService._filter_by_enablement([cowart_skill], {})
        self.assertEqual(not_installed, [])

        current_context = SkillsRegistryService._filter_by_enablement(
            [cowart_skill],
            {canonical_key: {"enabled": True, **install_metadata}},
        )
        self.assertIn(
            canonical_key,
            {skill["skill_key"] for skill in current_context},
        )
