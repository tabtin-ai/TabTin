"""SCENE.md frontmatter 加载器。

用 Python 标准库解析 YAML frontmatter（--- 分隔），共享给 SceneRegistry 和 PromptRegistry。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BUNDLED_DIR = Path(__file__).resolve().parent / "bundled"


def _parse_yaml(text: str) -> dict[str, Any]:
    """解析 YAML 文本为 dict。优先用 PyYAML，fallback 到简易手写解析。"""
    try:
        import yaml
        return yaml.safe_load(text) or {}
    except ImportError:
        pass

    result: dict[str, Any] = {}
    import json
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, _, val = line.partition(":")
        key = key.strip()
        val = val.strip()
        if val.lower() in ("true", "yes"):
            result[key] = True
        elif val.lower() in ("false", "no"):
            result[key] = False
        elif val.isdigit():
            result[key] = int(val)
        elif val.startswith("{") or val.startswith("["):
            try:
                result[key] = json.loads(val)
            except (json.JSONDecodeError, ValueError):
                result[key] = val
        else:
            try:
                result[key] = float(val)
            except ValueError:
                result[key] = val
    return result


def load_scene_md_frontmatter(scene_dir: Path) -> dict[str, Any] | None:
    """从 scene 目录加载 SCENE.md frontmatter。返回 None 表示无 SCENE.md。"""
    scene_md = scene_dir / "SCENE.md"
    if not scene_md.exists():
        return None

    content = scene_md.read_text(encoding="utf-8")
    if not content.startswith("---"):
        return None

    parts = content.split("---", 2)
    if len(parts) < 3:
        return None

    frontmatter_text = parts[1].strip()
    if not frontmatter_text:
        return None

    try:
        import yaml
        data = yaml.safe_load(frontmatter_text) or {}
    except ImportError:
        data = _parse_yaml(frontmatter_text)
    except Exception as exc:
        logger.error("SCENE.md frontmatter 解析失败: %s - %s", scene_dir.name, exc)
        return None

    _normalize_tuples_in_requirements(data)
    return data


def _normalize_tuples_in_requirements(data: dict) -> None:
    """YAML 加载的 list 转 tuple，以便跟 frozen dataclass 中的 tuple 字段比较。"""
    reqs = data.get("capability_requirements")
    if not isinstance(reqs, dict):
        return
    for key, val in reqs.items():
        if isinstance(val, list):
            reqs[key] = tuple(val)


def load_all_scene_md_frontmatters() -> dict[str, dict[str, Any]]:
    """扫描 bundled/ 下所有子目录，加载 SCENE.md frontmatter。"""
    result: dict[str, dict[str, Any]] = {}

    if not BUNDLED_DIR.exists():
        return result

    for child in sorted(BUNDLED_DIR.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith((".", "_")):
            continue

        fm = load_scene_md_frontmatter(child)
        if fm is not None:
            scene_key = fm.get("scene_key", child.name)
            result[scene_key] = fm

    return result
