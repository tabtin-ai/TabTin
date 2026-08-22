"""
验证 Skill 系统一致性：
1. Skill 声明的 tools 均在 ToolHub 中注册
2. Prompt 中硬编码的 skill_key 引用在 Skill 注册表中存在

运行：
    python manage.py test apps.skills.tests.test_skill_tools_validation
"""

import re
from pathlib import Path
from tempfile import TemporaryDirectory

from django.test import TestCase


class SkillToolsRegistrationTest(TestCase):
    """确保 Skill frontmatter 中声明的 tools 与 ToolHub 注册一致。"""

    def test_skill_scan_skips_node_modules(self):
        from apps.skills.management.commands.validate_skill_tools import (
            _scan_skill_files,
        )

        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_skill = root / "packages" / "apps" / "demo" / "skills" / "real"
            ignored_skill = root / "packages" / "node_modules" / "pkg" / "skills" / "ignored"
            real_skill.mkdir(parents=True)
            ignored_skill.mkdir(parents=True)
            (real_skill / "SKILL.md").write_text(
                "---\nname: real\ntools:\n  - read_file\n---\n",
                encoding="utf-8",
            )
            (ignored_skill / "SKILL.md").write_text(
                "---\nname: ignored\ntools:\n  - missing_tool\n---\n",
                encoding="utf-8",
            )

            skill_tools_map = _scan_skill_files([root / "packages"])

        self.assertEqual(len(skill_tools_map), 1)
        self.assertTrue(any(name.startswith("real ") for name in skill_tools_map))

    def test_skill_tools_all_registered(self):
        from apps.skills.management.commands.validate_skill_tools import (
            _get_toolhub_tools,
            _scan_skill_files,
        )

        project_root = Path(__file__).resolve().parents[5]
        scan_dirs = [
            project_root / "packages",
            project_root / "apps" / "tabtin_django" / "apps" / "skills" / "bundled",
        ]

        skill_tools_map = _scan_skill_files(scan_dirs)
        self.assertTrue(
            skill_tools_map,
            "未扫描到任何含 tools 字段的 SKILL.md，检查 scan_dirs 是否正确",
        )

        toolhub_tools = _get_toolhub_tools()
        if not toolhub_tools:
            self.skipTest("ToolHub 为空或加载失败（可能缺少运行时环境）")

        all_missing: dict[str, list[str]] = {}
        for skill_name, tools in skill_tools_map.items():
            missing = [t for t in tools if t not in toolhub_tools]
            if missing:
                all_missing[skill_name] = missing

        if all_missing:
            lines = ["以下 Skill 声明的工具未在 ToolHub 中注册："]
            for skill_name, tools in sorted(all_missing.items()):
                lines.append(f"  {skill_name}: {', '.join(tools)}")
            self.fail("\n".join(lines))


class PromptSkillKeyReferenceTest(TestCase):
    """确保 prompts/apps/*.py 中硬编码的 skill_key 引用在 Skill 注册表中存在。"""

    _SKILL_KEY_PATTERN = re.compile(r'skills\.read\(["\']([^"\']+)["\']\)')

    def test_prompt_skill_keys_resolvable(self):
        """扫描所有 prompt 文件中的 skills.read("key") 引用，验证 key 可解析。"""
        prompts_dir = (
            Path(__file__).resolve().parents[2]
            / "services" / "agent_engine" / "prompts" / "apps"
        )
        if not prompts_dir.exists():
            self.skipTest(f"Prompts 目录不存在: {prompts_dir}")

        referenced_keys: dict[str, list[str]] = {}
        for py_file in sorted(prompts_dir.glob("*.py")):
            if py_file.name == "__init__.py":
                continue
            content = py_file.read_text(encoding="utf-8", errors="replace")
            keys = self._SKILL_KEY_PATTERN.findall(content)
            if keys:
                referenced_keys[py_file.name] = keys

        if not referenced_keys:
            self.skipTest("未在 prompts/apps/ 中发现 skills.read 引用")

        from apps.skills.services.registry_service import SkillsRegistryService

        system_skills = SkillsRegistryService.list_system_skills()
        project_root = Path(__file__).resolve().parents[5]
        packages_dir = project_root / "packages"
        market_keys: set[str] = set()
        if packages_dir.exists():
            from apps.skills.management.commands.validate_skill_tools import (
                _iter_skill_markdown_files,
            )

            for skill_md in _iter_skill_markdown_files(packages_dir):
                rel = skill_md.parent
                parts = []
                for p in rel.parts:
                    if p == "skills":
                        parts = []
                        continue
                    parts.append(p)
                if parts:
                    skill_id = "/".join(parts)
                    app_parts = list(rel.parts)
                    app_id = ""
                    for i, p in enumerate(app_parts):
                        if p == "apps" and i + 1 < len(app_parts):
                            app_id = app_parts[i + 1]
                            break
                    if app_id:
                        market_keys.add(f"market:{app_id}/{skill_id}")
                        market_keys.add(f"market:{app_id}:{skill_id}")

        known_keys: set[str] = set()
        for s in system_skills:
            sk = s.get("skill_key")
            if sk:
                known_keys.add(sk)
        known_keys.update(market_keys)

        unresolved: dict[str, list[str]] = {}
        for filename, keys in referenced_keys.items():
            for key in keys:
                if key not in known_keys:
                    unresolved.setdefault(filename, []).append(key)

        if unresolved:
            lines = ["以下 Prompt 文件引用了无法解析的 skill_key："]
            for fname, keys in sorted(unresolved.items()):
                for k in keys:
                    lines.append(f"  {fname}: {k}")
            lines.append("")
            lines.append("请确认 skill_key 拼写是否与 SKILL.md 注册一致。")
            self.fail("\n".join(lines))
