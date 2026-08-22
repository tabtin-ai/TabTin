"""
App Package Skills discovery and reading.

从 App 包目录（packages/apps, packages/runtimes 等）中扫描 SKILL.md 文件，
解析 frontmatter 元数据，构建 skill index。
"""
from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

logger = logging.getLogger(__name__)


def _read_text_safe(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Frontmatter parsing (Phase S1 — rich YAML)
# ---------------------------------------------------------------------------


def _parse_frontmatter(lines: List[str]) -> Tuple[Dict[str, Any], int]:
    """
    Parse YAML frontmatter delimited by ``---``.

    Returns ``(data_dict, body_start_line_index)``.
    Supports nested YAML (requires, install, os, etc.) via ``yaml.safe_load``.
    Falls back to simple key:value parsing when the content is malformed.
    """
    if not lines or lines[0].strip() != "---":
        return {}, 0

    end_idx = 0
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx == 0:
        return {}, 0

    raw_yaml = "\n".join(lines[1:end_idx])
    body_start = end_idx + 1

    try:
        data = yaml.safe_load(raw_yaml)
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data: Dict[str, Any] = {}
        for line in lines[1:end_idx]:
            line = line.strip()
            if ":" in line:
                key, value = line.split(":", 1)
                data[key.strip().lower()] = value.strip()

    return data, body_start


def _as_str_list(val: Any) -> List[str]:
    """Coerce a value to a list of strings."""
    if isinstance(val, list):
        return [str(v) for v in val if v]
    if isinstance(val, str) and val:
        return [v.strip() for v in val.split(",") if v.strip()]
    return []


def _extract_rich_metadata(frontmatter: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extract rich metadata fields from parsed frontmatter dict.

    Maps both camelCase and snake_case keys.
    Returns a flat dict suitable for merging into a skill index entry.
    """
    meta: Dict[str, Any] = {}

    meta["emoji"] = frontmatter.get("emoji") or None
    meta["primary_env"] = (
        frontmatter.get("primaryEnv")
        or frontmatter.get("primary_env")
        or None
    )
    meta["homepage"] = frontmatter.get("homepage") or None

    os_val = frontmatter.get("os")
    if isinstance(os_val, list):
        meta["os_filter"] = [str(o) for o in os_val if o]
    elif isinstance(os_val, str) and os_val:
        meta["os_filter"] = [os_val]
    else:
        meta["os_filter"] = None

    always_val = frontmatter.get("always")
    meta["always"] = bool(always_val) if always_val is not None else False

    tags_val = frontmatter.get("tags")
    if isinstance(tags_val, list):
        meta["tags"] = [str(t) for t in tags_val if t]
    elif isinstance(tags_val, str) and tags_val:
        meta["tags"] = [t.strip() for t in tags_val.split(",") if t.strip()]
    else:
        meta["tags"] = None

    category_val = frontmatter.get("category")
    if isinstance(category_val, str) and category_val.strip():
        meta["category"] = category_val.strip().lower()
    else:
        meta["category"] = None

    requires_val = frontmatter.get("requires")
    if isinstance(requires_val, dict):
        meta["requires"] = {
            "bins": _as_str_list(requires_val.get("bins")),
            "any_bins": _as_str_list(requires_val.get("anyBins") or requires_val.get("any_bins")),
            "env": _as_str_list(requires_val.get("env")),
            "config": _as_str_list(requires_val.get("config")),
        }
    else:
        meta["requires"] = None

    install_val = frontmatter.get("install")
    if isinstance(install_val, list):
        specs: List[Dict[str, Any]] = []
        for item in install_val:
            if not isinstance(item, dict):
                continue
            spec: Dict[str, Any] = {
                "id": str(item.get("id") or ""),
                "kind": str(item.get("kind") or "brew"),
            }
            for key in ("formula", "package", "module", "url", "label"):
                val = item.get(key)
                if val:
                    spec[key] = str(val)
            spec["bins"] = _as_str_list(item.get("bins"))
            os_spec = item.get("os")
            if isinstance(os_spec, list):
                spec["os"] = [str(o) for o in os_spec if o]
            specs.append(spec)
        meta["install"] = specs if specs else None
    else:
        meta["install"] = None

    # snake_case + camelCase 双读：新标准格式 metadata.tabtin.autoActivateFor 提升
    # 到顶层后是 camelCase，必须一起认，否则迁移后的 app skill 会丢自动激活。
    auto_activate = (
        frontmatter.get("auto_activate_for")
        or frontmatter.get("autoActivateFor")
    )
    if isinstance(auto_activate, list):
        meta["auto_activate_for"] = [str(v) for v in auto_activate if v]
    elif isinstance(auto_activate, str) and auto_activate:
        meta["auto_activate_for"] = [v.strip() for v in auto_activate.split(",") if v.strip()]
    else:
        meta["auto_activate_for"] = None

    return meta


def _parse_skill_doc(content: str) -> Dict[str, Any]:
    """
    Parse a SKILL.md document and return a rich metadata dict.

    Returns dict with keys: name, description, version, has_frontmatter,
    plus all rich metadata fields (emoji, primary_env, os_filter, etc.).
    """
    result: Dict[str, Any] = {
        "name": "",
        "description": "",
        "version": "",
        "has_frontmatter": False,
    }

    if not content:
        return result

    lines = content.splitlines()
    frontmatter, body_start = _parse_frontmatter(lines)

    result["has_frontmatter"] = bool(frontmatter)

    result["name"] = str(frontmatter.get("name") or "").strip()
    result["description"] = str(frontmatter.get("description") or "").strip()
    result["version"] = str(frontmatter.get("version") or "").strip()

    if not result["name"]:
        for line in lines[body_start:]:
            line = line.strip()
            if line.startswith("# "):
                result["name"] = line.replace("#", "").strip()
                break

    if not result["description"]:
        paragraph: List[str] = []
        for line in lines[body_start:]:
            line = line.strip()
            if not line:
                if paragraph:
                    break
                continue
            if line.startswith("#"):
                continue
            paragraph.append(line)
        result["description"] = " ".join(paragraph).strip()

    # 新标准格式归一化（metadata.* 优先，顶层回退）——与 skill_doc_parser.parse_skill_doc 一致。
    _meta_ns = frontmatter.get("metadata")
    _inner: Dict[str, Any] = {}
    if isinstance(_meta_ns, dict):
        _mv = _meta_ns.get("version")
        if _mv is not None and str(_mv).strip():
            result["version"] = str(_mv).strip()
        # metadata.tabtin 优先；openclaw 为存量 skill 包兼容键，勿删
        _inner_candidate = _meta_ns.get("tabtin") or _meta_ns.get("openclaw") or {}
        if isinstance(_inner_candidate, dict):
            _inner = _inner_candidate
            for _k, _v in _inner.items():
                frontmatter[_k] = _v

    result["display_name"] = _resolve_display_name(
        _inner, str(frontmatter.get("name") or "").strip(),
    )

    rich = _extract_rich_metadata(frontmatter)
    result.update(rich)

    return result


# ---------------------------------------------------------------------------
# Skill path normalization
# ---------------------------------------------------------------------------

from apps.skills.services.skill_doc_parser import (
    RICH_METADATA_KEYS,
    beautify_slug,
    _resolve_display_name,
)


def _normalize_skill_path(base_dir: Path, entry: str) -> Tuple[Optional[Path], Optional[Path]]:
    if not entry:
        return None, None
    candidate = (base_dir / entry).resolve()
    if candidate.is_dir():
        doc_path = candidate / "SKILL.md"
        if doc_path.exists():
            return candidate, doc_path
        return None, None
    if candidate.is_file():
        return candidate.parent, candidate
    return None, None


def _build_app_skill_key(app_id: Optional[str], skill_id: Optional[str]) -> str:
    clean_app_id = str(app_id or "").strip()
    clean_skill_id = str(skill_id or "").strip()
    if clean_app_id and clean_skill_id:
        return f"app:{clean_app_id}/{clean_skill_id}"
    if clean_skill_id:
        return f"app:{clean_skill_id}"
    return ""


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def discover_app_skills(
    base_dir: str,
    manifest_skills: Optional[List[str]] = None,
) -> Tuple[List[str], List[Dict[str, Any]], List[str]]:
    """
    Discover SKILL.md files in an app package directory and build skill index entries.

    Returns:
        (skills_list, skills_index, errors)
    """
    errors: List[str] = []
    base = Path(base_dir)
    if not base.exists():
        return [], [], [f"base_dir not found: {base_dir}"]

    normalized_entries: List[str] = []
    skills_dir = base / "skills"
    if skills_dir.exists() and skills_dir.is_dir():
        for child in sorted(skills_dir.iterdir()):
            if not child.is_dir():
                continue
            doc = child / "SKILL.md"
            if doc.exists():
                normalized_entries.append(str(Path("skills") / child.name))
    elif manifest_skills:
        for raw in manifest_skills:
            if isinstance(raw, str) and raw.strip():
                normalized_entries.append(raw.strip())

    skills_index: List[Dict[str, Any]] = []
    for entry in normalized_entries:
        skill_dir, doc_path = _normalize_skill_path(base, entry)
        if not doc_path:
            errors.append(f"skill not found: {entry}")
            continue
        content = _read_text_safe(doc_path)
        parsed = _parse_skill_doc(content)
        if not parsed.get("has_frontmatter"):
            errors.append(f"skill frontmatter required: {entry}")
        skill_id = skill_dir.name if skill_dir else doc_path.stem

        agents_list: List[Dict[str, Any]] = []
        if skill_dir:
            try:
                from apps.skills.services.registry_service import scan_skill_agents
                agents_list = scan_skill_agents(skill_dir)
            except Exception:
                logger.debug(
                    "[AppSkills] scan_skill_agents failed for %s", skill_dir, exc_info=True,
                )

        index_entry: Dict[str, Any] = {
            "skill_id": skill_id,
            "name": parsed.get("name") or skill_id,
            "display_name": parsed.get("display_name") or beautify_slug(skill_id),
            "description": parsed.get("description"),
            "version": parsed.get("version"),
            "path": str(Path(entry)),
            "doc_path": str(Path(entry) / "SKILL.md")
            if skill_dir
            else str(Path(entry)),
            "agents": agents_list,
        }

        for key in RICH_METADATA_KEYS:
            val = parsed.get(key)
            if val is not None:
                index_entry[key] = val

        skills_index.append(index_entry)

    return normalized_entries, skills_index, errors


_app_payloads_cache: Dict[str, Any] = {"data": None, "ts": 0.0}
_APP_PAYLOADS_TTL = 300  # seconds


def _scan_app_packages(repo_root: Path) -> List[Dict[str, Any]]:
    """Scan app package directories for app.json manifests.

    Returns a list of dicts, each with at least: id, _base_dir, and optionally skills.
    """
    import json

    apps: List[Dict[str, Any]] = []
    scan_dirs = [
        repo_root / "packages" / "apps",
        repo_root / "packages" / "runtimes",
        repo_root / "packages" / "infrastructure",
    ]
    for base_dir in scan_dirs:
        if not base_dir.exists():
            continue
        for app_manifest in base_dir.rglob("app.json"):
            try:
                payload = json.loads(app_manifest.read_text(encoding="utf-8"))
            except Exception as exc:
                logger.warning("[AppSkills] app.json parse failed: %s (%s)", app_manifest, exc)
                continue
            kind = payload.get("kind") or payload.get("appKind")
            if isinstance(kind, str) and kind.lower() == "capability":
                continue
            payload["_base_dir"] = str(app_manifest.parent)
            apps.append(payload)
    return apps


def _load_app_payloads() -> List[Dict[str, Any]]:
    """Lazy-load app package payloads with a TTL cache to avoid repeated disk scans."""
    now = time.monotonic()
    if _app_payloads_cache["data"] is not None and (now - _app_payloads_cache["ts"]) < _APP_PAYLOADS_TTL:
        return _app_payloads_cache["data"]

    # : 必须用 services.repo_root（认 TABTIN_REPO_ROOT / packages+apps），
    # 勿再走曾漏认容器布局的 path_utils 旧启发式。
    from apps.services.repo_root import get_repo_root

    data = _scan_app_packages(get_repo_root())
    _app_payloads_cache["data"] = data
    _app_payloads_cache["ts"] = now
    return data


def clear_app_payloads_cache() -> None:
    """测试 / 运维：清空 app.json 扫描缓存（根路径或磁盘变更后）。"""
    _app_payloads_cache["data"] = None
    _app_payloads_cache["ts"] = 0.0




class AppPackageSkillsService:
    """App package skills discovery and reading (based on local packages/).

    扫描 packages/apps/*/skills/ 等目录下的 SKILL.md 文件。
    """

    @staticmethod
    def list_skills(
        *,
        app_id: Optional[str] = None,
        include_content: bool = False,
        payloads: Optional[List[Dict[str, Any]]] = None,
    ) -> List[Dict[str, Any]]:
        if payloads is None:
            payloads = _load_app_payloads()

        skills: List[Dict[str, Any]] = []
        for payload in payloads:
            manifest_app_id = payload.get("id") or payload.get("app_id") or payload.get("appId")
            if app_id and manifest_app_id != app_id:
                continue
            runtime_bindings = payload.get("runtimeBindings")
            if isinstance(runtime_bindings, dict) and runtime_bindings.get("skillsProvider") != "skills:local":
                continue
            base_path = payload.get("_base_dir")
            if not base_path:
                continue
            manifest_skills = payload.get("skills") if isinstance(payload.get("skills"), list) else None
            _, skills_index, _ = discover_app_skills(base_path, manifest_skills)
            skills_config = payload.get("skillsConfig") if isinstance(payload.get("skillsConfig"), dict) else {}
            config_entries = skills_config.get("entries") if isinstance(skills_config.get("entries"), dict) else {}
            for entry in skills_index:
                skill_id = entry.get("skill_id")
                entry_config = config_entries.get(skill_id) if isinstance(config_entries.get(skill_id), dict) else {}
                if entry_config.get("enabled") is False:
                    continue
                skill_key = _build_app_skill_key(manifest_app_id, skill_id)
                output: Dict[str, Any] = {
                    "app_id": manifest_app_id,
                    "distribution": payload.get("distribution"),
                    "skill_id": skill_id,
                    "skill_key": skill_key,
                    "name": entry.get("name"),
                    "display_name": entry.get("display_name") or beautify_slug(skill_id),
                    "description": entry.get("description"),
                    "version": entry.get("version"),
                    "path": str(Path(base_path) / entry["path"]) if entry.get("path") else None,
                    "doc_path": str(Path(base_path) / entry["doc_path"]) if entry.get("doc_path") else None,
                    "agents": entry.get("agents") or [],
                    "location": f"skills://{skill_key}" if skill_key else None,
                }
                if isinstance(entry_config.get("env"), dict):
                    output["env"] = entry_config.get("env")
                if isinstance(entry_config.get("config"), dict):
                    output["config"] = entry_config.get("config")
                for key in RICH_METADATA_KEYS:
                    val = entry.get(key)
                    if val is not None:
                        output[key] = val

                if include_content:
                    content_path = Path(base_path) / (entry.get("doc_path") or "")
                    output["content"] = _read_text_safe(content_path)
                skills.append(output)
        return skills


__all__ = [
    "discover_app_skills",
    "AppPackageSkillsService",
    "clear_app_payloads_cache",
]
