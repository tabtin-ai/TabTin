"""Wave H · Device skill 发现测试（PRD V3.3 / W0 决策补丁 2，2026-05-02）。

Wave 1 重构：``register_skills_to_managed`` 已删除——device 来源 skill 不进
云端 ``Skill`` 表（D19），只在本机 LocalSkillRegistry 索引。``install_and_register_app_skills``
返回 ``discovered_skill_dirs`` 由调用方处理。

覆盖：
- ``discover_installed_skill_dirs`` 白名单过滤 + 缺失目录处理
- ``install_and_register_app_skills`` skillsInstall 成功 / 失败 / 跳过路径
- 白名单 ``setup`` 被自动过滤
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from apps.services.agent_engine.cli.tabtin_cli import skill_install


def _write_skill_md(dir_path: Path, name: str, description: str = "") -> None:
    """写一个最小可解析的 SKILL.md（frontmatter 含 name + description）。"""
    dir_path.mkdir(parents=True, exist_ok=True)
    content = (
        "---\n"
        f"name: {name}\n"
        "version: 1.0.0\n"
        f'description: "{description or name}"\n'
        "---\n\n"
        f"# {name}\n\nSkill body.\n"
    )
    (dir_path / "SKILL.md").write_text(content, encoding="utf-8")


def _build_manifest(
    *,
    app_id: str = "demo-app",
    skills_install: str = "",
    auto_load: list = (),
    on_demand: list = (),
) -> dict:
    return {
        "id": app_id,
        "install": {
            "type": "npm-global",
            "npmPackage": "@example/cli",
            "skillsInstall": skills_install,
        },
        "skills": {
            "autoLoad": list(auto_load),
            "onDemand": list(on_demand),
        },
    }


class TestDiscoverSkillDirs:
    def test_returns_only_whitelisted_dirs_with_skill_md(self, tmp_path):
        (tmp_path / "skills").mkdir()
        _write_skill_md(tmp_path / "skills" / "demo-records", "demo-records")
        _write_skill_md(tmp_path / "skills" / "demo-doc", "demo-doc")
        _write_skill_md(tmp_path / "skills" / "unrelated", "unrelated")
        (tmp_path / "skills" / "demo-empty").mkdir()

        found = skill_install.discover_installed_skill_dirs(
            ["demo-records", "demo-doc", "demo-empty", "demo-missing"],
            agents_skills_dir=tmp_path / "skills",
        )
        names = sorted([p.name for p in found])
        assert names == ["demo-doc", "demo-records"]

    def test_missing_root_dir_returns_empty(self, tmp_path):
        found = skill_install.discover_installed_skill_dirs(
            ["demo-records"],
            agents_skills_dir=tmp_path / "nonexistent",
        )
        assert found == []


class TestInstallAndRegisterTopLevel:
    def test_skills_install_empty_and_no_dirs_returns_skipped(self, tmp_path):
        manifest = {
            "id": "bare",
            "install": {"type": "npm-global", "npmPackage": "x"},
            "skills": {},
        }
        result = skill_install.install_and_register_app_skills(
            app_id="bare",
            manifest=manifest,
        )
        assert result["installed"] is False
        assert result["discovered_skill_dirs"] == []
        assert "未声明" in result["skip_reason"]

    def test_happy_path_with_mocked_install_command(self, tmp_path):
        # 准备"装完"的状态：直接铺 SKILL.md（mock install 过程）
        skills_root = tmp_path / "skills"
        skills_root.mkdir()
        _write_skill_md(skills_root / "demo-records", "demo-records", "演示记录")
        _write_skill_md(skills_root / "demo-doc", "demo-doc", "演示文档")
        _write_skill_md(skills_root / "demo-calendar", "demo-calendar", "演示日历")

        manifest = _build_manifest(
            skills_install="echo mock-install",  # 不会失败的命令
            auto_load=["setup"],  # setup 应被过滤
            on_demand=["demo-records", "demo-doc", "demo-calendar", "demo-missing"],
        )

        with patch.object(skill_install, "_agents_skills_dir", return_value=skills_root):
            result = skill_install.install_and_register_app_skills(
                app_id="demo-app",
                manifest=manifest,
            )

        assert result["installed"] is True
        assert len(result["discovered_skill_dirs"]) == 3  # demo-missing 没铺
        assert all("demo-missing" not in p for p in result["discovered_skill_dirs"])

    def test_install_command_failure_does_not_discover(self, tmp_path):
        manifest = _build_manifest(
            skills_install="false",  # UNIX `false` 退出码 1
            on_demand=["demo-records"],
        )
        with patch.object(
            skill_install, "_agents_skills_dir",
            return_value=tmp_path / "nonexistent",
        ):
            result = skill_install.install_and_register_app_skills(
                app_id="demo-app",
                manifest=manifest,
            )
        assert result["installed"] is False
        assert "install_error" in result
        assert result["discovered_skill_dirs"] == []

    def test_skip_install_flag(self, tmp_path):
        """skip_install=True 时跳过 fork，只做发现（用户可能已自己装过）。"""
        skills_root = tmp_path / "skills"
        skills_root.mkdir()
        _write_skill_md(skills_root / "demo-records", "demo-records", "演示记录")

        manifest = _build_manifest(
            skills_install="npx fake-command",  # 会失败，但被 skip
            on_demand=["demo-records"],
        )

        with patch.object(skill_install, "_agents_skills_dir", return_value=skills_root):
            result = skill_install.install_and_register_app_skills(
                app_id="demo-app",
                manifest=manifest,
                skip_install=True,
            )
        assert result["installed"] is False
        assert len(result["discovered_skill_dirs"]) == 1
