"""
校验 Skill 的 tools 字段与 ToolHub 注册的 FC 工具双向一致性。

用法:
    python manage.py validate_skill_tools
    python manage.py validate_skill_tools --strict  # 有差异时以非零退出码退出

输出:
    1. Skill 声明但 ToolHub 未注册的工具（Skill → ToolHub 缺失）
    2. ToolHub 注册但无 Skill 覆盖的工具（ToolHub → Skill 无覆盖）
"""

import re
from pathlib import Path
from typing import Dict, Iterator, List, Set

from django.core.management.base import BaseCommand


_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
_IGNORED_SCAN_DIRS = {
    ".git",
    ".hg",
    ".mypy_cache",
    ".pytest_cache",
    ".svn",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
}


def _parse_yaml_tools(content: str) -> List[str]:
    """从 SKILL.md frontmatter 中提取 tools 列表（轻量解析，不依赖 PyYAML）。"""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return []
    fm = match.group(1)
    in_tools = False
    tools: List[str] = []
    for line in fm.split("\n"):
        stripped = line.strip()
        if stripped.startswith("tools:"):
            remainder = stripped[len("tools:"):].strip()
            if remainder.startswith("["):
                items = remainder.strip("[]").split(",")
                tools.extend(i.strip().strip("'\"") for i in items if i.strip())
                return tools
            in_tools = True
            continue
        if in_tools:
            if stripped.startswith("- "):
                tools.append(stripped[2:].strip().strip("'\""))
            elif stripped and not stripped.startswith("#"):
                break
    return tools


def _parse_yaml_name(content: str) -> str:
    """从 frontmatter 提取 name 字段。"""
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return ""
    for line in match.group(1).split("\n"):
        stripped = line.strip()
        if stripped.startswith("name:"):
            return stripped[len("name:"):].strip().strip("'\"")
    return ""


def _iter_skill_markdown_files(base: Path) -> Iterator[Path]:
    """Yield SKILL.md files while avoiding dependency/build trees.

    ``Path.rglob`` follows pnpm-style nested dependency trees on Windows and can
    hit disappearing linked paths. This explicit walk keeps validation scoped to
    source directories and treats unreadable transient directories as skipped.
    """
    stack = [base]
    while stack:
        current = stack.pop()
        try:
            children = list(current.iterdir())
        except (FileNotFoundError, OSError):
            continue
        for child in children:
            try:
                is_dir = child.is_dir()
            except OSError:
                continue
            if is_dir:
                if child.name in _IGNORED_SCAN_DIRS:
                    continue
                stack.append(child)
            elif child.name == "SKILL.md":
                yield child


def _scan_skill_files(base_dirs: List[Path]) -> Dict[str, List[str]]:
    """扫描目录下所有 SKILL.md，返回 {skill_name: [tool_names]}。"""
    result: Dict[str, List[str]] = {}
    for base in base_dirs:
        if not base.exists():
            continue
        for skill_md in _iter_skill_markdown_files(base):
            try:
                content = skill_md.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            tools = _parse_yaml_tools(content)
            if not tools:
                continue
            name = _parse_yaml_name(content) or skill_md.parent.name
            label = f"{name} ({skill_md.relative_to(base.parents[0])})"
            result[label] = tools
    return result


def _get_toolhub_tools() -> Set[str]:
    """从 ToolHub 获取所有已注册工具名（含 action-tools 客户端工具）。"""
    try:
        from apps.services.tools import ToolHub, ensure_builtin_tools_registered
        ensure_builtin_tools_registered()
        all_tools: Set[str] = set()
        for domain in ToolHub.list_domains():
            if domain == "action-tools":
                continue
            try:
                for tool in ToolHub.get_tools(domain=domain):
                    name = getattr(tool, "name", None)
                    if name:
                        all_tools.add(name)
            except Exception:
                pass
        try:
            from apps.services.tools import load_action_tool_manifest
            manifest = load_action_tool_manifest()
            for tool_meta in manifest.get("tools") or []:
                name = tool_meta.get("name")
                if name:
                    all_tools.add(name)
        except Exception:
            pass
        return all_tools
    except ImportError:
        return set()


class Command(BaseCommand):
    help = "校验 Skill tools 字段与 ToolHub 注册工具的双向一致性"

    def add_arguments(self, parser):
        parser.add_argument(
            "--strict",
            action="store_true",
            help="有差异时以退出码 1 退出",
        )

    def handle(self, *args, **options):
        from apps.services.repo_root import get_repo_root

        project_root = get_repo_root()
        scan_dirs = [
            project_root / "packages",
            project_root / "apps" / "tabtin_django" / "apps" / "skills" / "bundled",
        ]

        self.stdout.write(self.style.NOTICE("=== Skill Tools 校验 ===\n"))

        skill_tools_map = _scan_skill_files(scan_dirs)
        if not skill_tools_map:
            self.stdout.write(self.style.WARNING("未找到任何含 tools 字段的 SKILL.md"))
            return

        all_skill_tools: Set[str] = set()
        for tools in skill_tools_map.values():
            all_skill_tools.update(tools)

        self.stdout.write(f"扫描到 {len(skill_tools_map)} 个 Skill，声明了 {len(all_skill_tools)} 个唯一工具名\n")

        toolhub_tools = _get_toolhub_tools()
        if not toolhub_tools:
            self.stdout.write(self.style.WARNING("ToolHub 为空或加载失败，跳过双向校验\n"))
            for name, tools in sorted(skill_tools_map.items()):
                self.stdout.write(f"  {name}: {', '.join(tools)}")
            return

        self.stdout.write(f"ToolHub 注册了 {len(toolhub_tools)} 个工具\n")

        has_issues = False

        missing_in_hub: Dict[str, List[str]] = {}
        for skill_name, tools in skill_tools_map.items():
            missing = [t for t in tools if t not in toolhub_tools]
            if missing:
                missing_in_hub[skill_name] = missing
                has_issues = True

        if missing_in_hub:
            self.stdout.write(self.style.WARNING("\n[Skill → ToolHub] 以下工具在 Skill 中声明但未在 ToolHub 注册："))
            for skill_name, tools in sorted(missing_in_hub.items()):
                self.stdout.write(f"  {skill_name}:")
                for t in tools:
                    self.stdout.write(f"    - {t}")
        else:
            self.stdout.write(self.style.SUCCESS("\n[Skill → ToolHub] ✓ 所有 Skill 声明的工具均已注册"))

        uncovered = toolhub_tools - all_skill_tools
        if uncovered:
            self.stdout.write(self.style.WARNING(f"\n[ToolHub → Skill] 以下 {len(uncovered)} 个工具未被任何 Skill 覆盖："))
            for t in sorted(uncovered):
                self.stdout.write(f"    - {t}")
            has_issues = True
        else:
            self.stdout.write(self.style.SUCCESS("\n[ToolHub → Skill] ✓ 所有 ToolHub 工具均有 Skill 覆盖"))

        self.stdout.write("")

        if has_issues and options["strict"]:
            raise SystemExit(1)
