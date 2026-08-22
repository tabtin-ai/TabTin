from __future__ import annotations

import html
from typing import Iterable, Dict, Any, List, Optional, Set

def _escape(value: str) -> str:
    return html.escape(value, quote=True)


def _normalize_skill_key(key: str) -> str:
    from apps.skills.services.registry_service import normalize_skill_key
    return normalize_skill_key(key)


def _normalize_skill_source(source: str) -> str:
    from apps.skills.services.registry_service import normalize_skill_source
    return normalize_skill_source(source)


def build_available_skills_xml(
    skills: Iterable[Dict[str, Any]],
    *,
    active_app_types: Optional[Set[str]] = None,
) -> str:
    """Build <available_skills> XML block for system prompt injection.

    Skills are tagged with their source category (app / system / market / etc.)
    and whether they are auto-activated for the current app context.

    Auto-activated app skills get full metadata; other skills use a compact
    format (name + description + location only) to save tokens.
    """
    entries: List[Dict[str, Any]] = [item for item in skills if item]
    if not entries:
        return ""

    active_apps = set(active_app_types) if active_app_types else set()

    lines: List[str] = ["<available_skills>"]
    for entry in entries:
        # 展示名优先 display_name（新格式 metadata.tabtin.displayName 归一化结果），
        # 回退顶层 name / skill_id。
        name = _escape(str(
            entry.get("display_name") or entry.get("name") or entry.get("skill_id") or ""
        ))
        if not name:
            continue

        source = _normalize_skill_source(entry.get("source") or "system")
        auto_for = entry.get("auto_activate_for") or []
        is_auto_activated = bool(auto_for and active_apps & set(auto_for))

        description = _escape(str(entry.get("description") or ""))
        raw_location = str(entry.get("location") or entry.get("skill_key") or "")
        location = _escape(_normalize_skill_key(raw_location) if raw_location else "")
        emoji = str(entry.get("emoji") or "").strip()

        attrs = f' source="{_escape(source)}"'
        if is_auto_activated:
            attrs += ' auto_activated="true"'

        lines.append(f"  <skill{attrs}>")

        if emoji:
            lines.append(f"    <name>{emoji} {name}</name>")
        else:
            lines.append(f"    <name>{name}</name>")

        if description:
            lines.append(f"    <description>{description}</description>")
        if location:
            lines.append(f"    <location>{location}</location>")

        # Full metadata only for auto-activated skills to save tokens
        if is_auto_activated or source == "app":
            primary_env = str(entry.get("primary_env") or "").strip()
            tags = entry.get("tags")
            if primary_env:
                lines.append(f"    <primaryEnv>{_escape(primary_env)}</primaryEnv>")
            if tags and isinstance(tags, list):
                lines.append(f"    <tags>{', '.join(_escape(str(t)) for t in tags)}</tags>")
        else:
            primary_env = str(entry.get("primary_env") or "").strip()
            if primary_env:
                lines.append(f"    <primaryEnv>{_escape(primary_env)}</primaryEnv>")

        lines.append("  </skill>")
    lines.append("</available_skills>")
    return "\n".join(lines)


_APP_CATEGORY_MAP: Dict[str, str] = {
    "tabdata": "表格",
    "tabdoc": "文档",
    "tabweb": "浏览器",
    "tabcode": "代码",
    "terminal": "终端",
    "tabslide": "演示",
    "tabvideo": "视频",
    "tabmail": "邮件",
    "tabfolder": "文件",
}

SKILL_BUDGET_CONTEXT_PERCENT = 0.01
"""索引占上下文窗口 token 的比例（1%）。"""

CHARS_PER_TOKEN = 4
"""粗估 chars/token 系数。"""

DEFAULT_CHAR_BUDGET = 6000
"""无法获取上下文窗口时的兜底预算。"""

MAX_DESC_CHARS = 200
"""单条 skill 描述的最大字符数。超出截断并加省略号。"""

_BUDGET_OVERFLOW_HINT = (
    '\n如果索引中没有找到匹配的技能，可使用 `skills_search("关键词")` 搜索更多。'
)
# 注：上面 perl 替换已经把 `skills.search` 改成 `skills_search`；
# 历史 LLM 训练语料里可能见过 `skills.read` 旧名，但当前实际工具名是
# `skills_read`（agent-runtime/src/tools/skills-tools.ts）+ `skills_read`
# 也是 ToolHub 注册名（agent_engine 已对齐）。


def get_char_budget(context_window_tokens: int = 0) -> int:
    """根据上下文窗口动态计算索引字符预算。

    context_window × CHARS_PER_TOKEN × 1%。
    """
    if context_window_tokens and context_window_tokens > 0:
        return max(
            DEFAULT_CHAR_BUDGET,
            int(context_window_tokens * CHARS_PER_TOKEN * SKILL_BUDGET_CONTEXT_PERCENT),
        )
    return DEFAULT_CHAR_BUDGET


def _truncate_desc(desc: str, max_chars: int = MAX_DESC_CHARS) -> str:
    if not desc or len(desc) <= max_chars:
        return desc
    return desc[: max_chars - 1] + "…"


def _estimate_chars(lines: List[str]) -> int:
    return sum(len(l) + 1 for l in lines)


# ── 兼容旧调用签名 ────────────────────────────────────────
MAX_INDEX_CHARS = DEFAULT_CHAR_BUDGET


def build_skills_index(
    skills: Iterable[Dict[str, Any]],
    *,
    active_app_types: Optional[Set[str]] = None,
    max_chars: int = 0,
    can_terminal: bool = True,
    context_window_tokens: int = 0,
) -> str:
    """Build compact skills index with category grouping.

    Key design decisions:
    - Budget dynamically derived from context window (1% × 4 chars/token).
    - Per-description cap at MAX_DESC_CHARS to prevent description bloat.
    - Builtin (platform/system) skills prioritized over marketplace apps.
    - Same-app skills folded into a single line when they share app_id.
    """
    budget = max_chars if max_chars > 0 else get_char_budget(context_window_tokens)

    entries: List[Dict[str, Any]] = [item for item in skills if item]
    if not entries:
        return ""

    active_apps = set(active_app_types) if active_app_types else set()

    # ── 分类 + 构建行 ──────────────────────────────────────
    # key: category, value: list of (sort_priority, line)
    categorized: Dict[str, List[tuple]] = {}

    # 同 app_id 折叠：一个 app_id 下多个 skill 合并成一行
    app_skill_collector: Dict[str, List[Dict[str, Any]]] = {}

    for entry in entries:
        source = _normalize_skill_source(entry.get("source") or "system")
        auto_for = entry.get("auto_activate_for") or []
        is_auto_activated = bool(auto_for and active_apps & set(auto_for))

        # app strategy 条目（无 app_id 的 "app" source）在已激活时跳过，
        # 因为其内容已由 <app_strategy> 注入。但 market skill（有 app_id）
        # 保留在索引中，因为 <app_strategy> 不一定被注入（预算截断等）。
        if source == "app" and is_auto_activated and not entry.get("app_id"):
            continue

        name = str(
            entry.get("display_name") or entry.get("name") or entry.get("skill_id") or ""
        ).strip()
        if not name:
            continue

        app_id = entry.get("app_id") or ""

        category = "通用"
        if source == "extension":
            category = "扩展"
        elif auto_for:
            for app_type in auto_for:
                if app_type in _APP_CATEGORY_MAP:
                    category = _APP_CATEGORY_MAP[app_type]
                    break

        # 同 app 折叠：如果一个 app_id 下有 3+ 个 skill，折叠展示
        if app_id and category == "通用":
            collector_key = f"{category}::{app_id}"
            app_skill_collector.setdefault(collector_key, []).append(entry)
            continue

        raw_key = str(entry.get("skill_key") or entry.get("location") or name).strip()
        skill_key = _normalize_skill_key(raw_key) if raw_key else raw_key
        description = _truncate_desc(str(entry.get("description") or "").strip())
        emoji = str(entry.get("emoji") or "").strip()

        display_name = f"{emoji} {skill_key}" if emoji else skill_key
        line = f"- {display_name}: {description}" if description else f"- {display_name}"

        # 优先级：platform/system 先，已激活的 market skill 降级排后
        if source in ("platform", "system"):
            sort_prio = 0
        elif is_auto_activated:
            sort_prio = 2
        else:
            sort_prio = 1
        categorized.setdefault(category, []).append((sort_prio, line))

    # 折叠同 app skills
    FOLD_THRESHOLD = 3
    for collector_key, collected in app_skill_collector.items():
        category = collector_key.split("::", 1)[0]
        app_id = collected[0].get("app_id", "")

        if len(collected) >= FOLD_THRESHOLD:
            skill_names = [
                str(e.get("display_name") or e.get("name") or e.get("skill_id") or "")
                for e in collected
            ]
            count = len(skill_names)
            preview = ", ".join(skill_names[:4])
            if count > 4:
                preview += f" 等 {count} 项能力"
            line = f"- app:{app_id}: {preview}"
            categorized.setdefault(category, []).append((1, line))
        else:
            for entry in collected:
                raw_key = str(entry.get("skill_key") or entry.get("location") or "").strip()
                skill_key = _normalize_skill_key(raw_key) if raw_key else raw_key
                description = _truncate_desc(str(entry.get("description") or "").strip())
                emoji = str(entry.get("emoji") or "").strip()
                display_name = f"{emoji} {skill_key}" if emoji else skill_key
                line = f"- {display_name}: {description}" if description else f"- {display_name}"
                categorized.setdefault(category, []).append((1, line))

    if not categorized:
        return ""

    # ── 排序 ───────────────────────────────────────────────
    header: List[str] = [
        "以下是你可以使用的技能。",
        "使用 skills_read(skill_key) 获取完整操作手册。",
        "批量读取：skills_read(skill_ids=[...])",
        "",
    ]

    active_app_categories = set()
    for app_type in active_apps:
        cat = _APP_CATEGORY_MAP.get(app_type)
        if cat:
            active_app_categories.add(cat)

    priority_order = ["表格", "文档", "浏览器", "代码", "终端", "演示", "设计", "视频", "邮件", "文件"]

    def _cat_priority(cat: str) -> int:
        if cat in active_app_categories:
            return -1
        if cat in priority_order:
            return priority_order.index(cat)
        return 999

    sorted_categories = sorted(categorized.keys(), key=_cat_priority)

    # 类内按 sort_prio 排序（platform 先于 marketplace）
    for cat in sorted_categories:
        categorized[cat].sort(key=lambda x: x[0])

    # ── 预算控制输出 ──────────────────────────────────────
    remaining = budget
    remaining -= _estimate_chars(header)
    remaining -= len(_BUDGET_OVERFLOW_HINT) + 2

    parts: List[str] = list(header)
    truncated = False

    for cat in sorted_categories:
        cat_header = f"### {cat}"
        cat_header_cost = len(cat_header) + 1
        if remaining < cat_header_cost + 20:
            truncated = True
            break

        remaining -= cat_header_cost
        parts.append(cat_header)

        for _prio, line in categorized[cat]:
            line_cost = len(line) + 1
            if remaining < line_cost:
                truncated = True
                break
            remaining -= line_cost
            parts.append(line)

        parts.append("")
        remaining -= 1

        if truncated:
            break

    if truncated:
        parts.append(_BUDGET_OVERFLOW_HINT)

    return "\n".join(parts).rstrip()


__all__ = ["build_available_skills_xml", "build_skills_index", "get_char_budget"]
