"""App prompt section 加载与注册 — 按 App 类型加载领域策略文本。

S2 里程碑：从 ``prompts/apps/__init__.py`` 迁移至此，
让 skills / capabilities / tools 等外部模块不再依赖 ``prompts/`` 目录。

W10 cleanup：``apps/services/agent_engine/prompts/`` 目录已在 M1
（System Prompt SSoT 迁出）随 builtin 引擎一起删除。``.py`` 主仓源
理论上不再有模块，但保留扫描逻辑以兼容外部仓库 / 灰度 / 测试时
临时落盘的 ``.py`` prompt 模块；目录不存在时静默跳过（不再 WARNING）。

发现机制（双源）：

1. **主仓 .py 模块**（W10 后通常为空）：``pkgutil.iter_modules`` 扫描
   ``apps/services/agent_engine/prompts/apps/`` 目录下的 ``.py`` 文件，
   每个模块导出 ``SECTION_{MODULE_NAME.upper()}`` 字符串。
2. **marketplace markdown**（当前唯一稳定源）：扫描
   ``packages/apps/<id>/prompts/<lang>/system.md`` 并按 locale 选取一份注入。

Locale 选择（按优先级首个命中即停）：

- ``TABTIN_PROMPT_LOCALE`` 环境变量（显式覆盖）
- ``django.conf.settings.LANGUAGE_CODE`` 的两位前缀
- 内置 fallback ``["zh", "en"]``

去重 / 优先级：同一 App 同时在 ``.py`` 与 marketplace 出现时，
优先 marketplace markdown。
"""

from __future__ import annotations

import importlib
import logging
import os
import pkgutil
from pathlib import Path
from typing import Literal, Optional

logger = logging.getLogger(__name__)

PromptSource = Literal["py", "marketplace"]
_SRC_PY: PromptSource = "py"
_SRC_MARKETPLACE: PromptSource = "marketplace"

APP_SECTIONS: dict[str, str] = {}

_PROMPT_SOURCES: dict[str, PromptSource] = {}

# ─── 路径常量 ──────────────────────────────────────────────────
from apps.services.repo_root import get_repo_root

_PROJECT_ROOT = get_repo_root()
_PROMPTS_APPS_DIR = (
    _PROJECT_ROOT / "apps" / "tabtin_django" / "apps"
    / "services" / "agent_engine" / "prompts" / "apps"
)
_PROMPTS_APPS_PKG = "apps.services.agent_engine.prompts.apps"


def _resolve_prompt_locales() -> list[str]:
    """返回 prompt locale 优先级列表。"""
    explicit = os.environ.get("TABTIN_PROMPT_LOCALE", "").strip().lower()
    candidates: list[str] = []
    if explicit:
        candidates.append(explicit)

    try:
        from django.conf import settings

        lang = (getattr(settings, "LANGUAGE_CODE", "") or "").strip().lower()
        if lang:
            primary = lang.split("-", 1)[0]
            if primary and primary not in candidates:
                candidates.append(primary)
    except Exception:
        logger.debug("[AppSections] 无法读取 Django LANGUAGE_CODE，使用内置 fallback")

    for fallback in ("zh", "en"):
        if fallback not in candidates:
            candidates.append(fallback)

    return candidates


def _load_pkg_modules() -> dict[str, str]:
    """扫描 prompts/apps/ 目录的 .py 文件，导出 SECTION_{NAME.upper()}。

    W10：M1 迁走 prompts/ 后此目录默认不存在 → debug 即可，不再 WARNING。
    """
    sections: dict[str, str] = {}
    if not _PROMPTS_APPS_DIR.is_dir():
        logger.debug(
            "[AppSections] prompts/apps/ 目录不存在（M1 后预期状态），跳过 .py 源: %s",
            _PROMPTS_APPS_DIR,
        )
        return sections

    for _finder, _modname, _ispkg in pkgutil.iter_modules(
        [str(_PROMPTS_APPS_DIR)], _PROMPTS_APPS_PKG + "."
    ):
        try:
            _mod = importlib.import_module(_modname)
        except Exception:
            logger.exception("[AppSections] 导入 .py 模块失败: %s", _modname)
            continue
        _basename = _modname.rsplit(".", 1)[-1]
        _section_attr = f"SECTION_{_basename.upper()}"
        _section = getattr(_mod, _section_attr, None)
        if _section is not None:
            sections[_basename] = _section
    return sections


def _load_marketplace_markdown() -> dict[str, str]:
    """扫描 packages/apps/<id>/prompts/<lang>/system.md 并按 locale 选取。"""
    apps_dir = _PROJECT_ROOT / "packages" / "apps"
    if not apps_dir.is_dir():
        return {}

    locales = _resolve_prompt_locales()
    sections: dict[str, str] = {}

    for app_dir in sorted(apps_dir.iterdir()):
        if not app_dir.is_dir():
            continue
        prompts_dir = app_dir / "prompts"
        if not prompts_dir.is_dir():
            continue

        chosen: Optional[Path] = None
        chosen_lang: Optional[str] = None
        for lang in locales:
            candidate = prompts_dir / lang / "system.md"
            if candidate.is_file():
                chosen = candidate
                chosen_lang = lang
                break

        if chosen is None:
            available_langs = sorted(
                p.name for p in prompts_dir.iterdir()
                if p.is_dir() and (p / "system.md").is_file()
            )
            logger.warning(
                "[AppSections] %s 有 prompts/ 目录但无任何 locale 命中"
                "（尝试 locale 优先级=%s，目录下实际存在的 lang=%s）",
                app_dir.name, locales, available_langs or ["<空>"],
            )
            continue

        try:
            content = chosen.read_text(encoding="utf-8")
        except Exception:
            logger.exception(
                "[AppSections] 读取 %s 失败，%s 不会被加载", chosen, app_dir.name,
            )
            continue

        if not content.strip():
            logger.warning(
                "[AppSections] %s/%s/system.md 内容为空，跳过",
                app_dir.name, chosen_lang,
            )
            continue

        sections[app_dir.name] = content
        logger.debug(
            "[AppSections] 加载 marketplace prompt: app=%s lang=%s",
            app_dir.name, chosen_lang,
        )

    return sections


def _build_app_sections() -> tuple[dict[str, str], dict[str, PromptSource]]:
    """合并双源，返回 (sections, sources)。

    优先级：marketplace markdown > 主仓 .py。
    """
    py_sections = _load_pkg_modules()
    md_sections = _load_marketplace_markdown()

    merged: dict[str, str] = {}
    sources: dict[str, PromptSource] = {}

    for app_id, text in py_sections.items():
        merged[app_id] = text
        sources[app_id] = _SRC_PY

    for app_id, text in md_sections.items():
        if app_id in merged:
            logger.info(
                "[AppSections] %s 同时存在 .py 与 marketplace markdown，"
                "采用 marketplace 路径（marketplace 优先于 .py）",
                app_id,
            )
        merged[app_id] = text
        sources[app_id] = _SRC_MARKETPLACE

    return merged, sources


def reload_app_sections() -> None:
    """重新扫描双源并刷新 APP_SECTIONS / 来源映射。

    注意：仅刷新 dict；PromptRegistry 是单例，需额外 reset 才能
    让下游 prompt builder 输出新内容。如需一站式刷新，请使用
    ``apps.services.agent_engine.prompts.apps.reload_with_registry_reset()``。
    """
    new_sections, new_sources = _build_app_sections()
    APP_SECTIONS.clear()
    APP_SECTIONS.update(new_sections)
    _PROMPT_SOURCES.clear()
    _PROMPT_SOURCES.update(new_sources)


def get_prompt_source(app_id: str) -> Optional[PromptSource]:
    """返回 app_id 对应 prompt section 的来源（py / marketplace / None）。"""
    return _PROMPT_SOURCES.get(app_id)


def list_prompt_sources() -> dict[str, PromptSource]:
    """返回 {app_id: source} 全量映射。"""
    return dict(_PROMPT_SOURCES)


# ⚠ 必须位于模块末尾：reload 通过 importlib 加载 prompts/apps/*.py，
# 会触发 prompts/apps/__init__.py 导入，后者反向导入本模块符号。
# 所有 def / dict 必须在此之前完成定义。禁止上移。
reload_app_sections()
