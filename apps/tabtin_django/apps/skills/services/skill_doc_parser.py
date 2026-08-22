"""
SKILL.md 文档解析工具

从 SKILL.md 的 YAML frontmatter 中提取技能元数据。
纯工具函数，无外部依赖。
"""
from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

import yaml

logger = logging.getLogger(__name__)

# kebab-case 校验（机器 id：小写字母/数字 + 连字符，不以连字符开头/结尾）。
_KEBAB_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")


def is_kebab_case(value: str) -> bool:
    return bool(value) and bool(_KEBAB_RE.match(value))


def beautify_slug(slug: str) -> str:
    """slug / 目录名 → Title Case 展示名兜底（``table-operator`` → ``Table Operator``）。

    platform skill_id 可能是多段路径（``device/operations``），取最后一段美化。
    """
    if not slug:
        return ""
    seg = str(slug).replace("\\", "/").split("/")[-1] or str(slug)
    words = [w for w in re.split(r"[-_\s]+", seg) if w]
    if not words:
        return seg
    return " ".join(w[:1].upper() + w[1:] for w in words)


def _resolve_display_name(tabtin_meta: Dict[str, Any], top_name: str) -> str:
    """归一化展示名（不依赖 ``#`` 一级标题）。

    优先级：
    1. ``metadata.tabtin.displayName`` / ``display_name``（新标准格式）
    2. 旧格式顶层 ``name``（当它是人类可读标题，即非 kebab-case）
    3. ``""`` —— 交由消费方按 slug / 目录名 ``beautify_slug`` 兜底
    """
    if isinstance(tabtin_meta, dict):
        dn = tabtin_meta.get("displayName") or tabtin_meta.get("display_name")
        if isinstance(dn, str) and dn.strip():
            return dn.strip()
    if top_name and not is_kebab_case(top_name):
        return top_name
    return ""

# Rich metadata keys propagated from SKILL.md into index entries
RICH_METADATA_KEYS = (
    "emoji", "primary_env", "os_filter", "always",
    "requires", "install", "homepage", "tags",
    "auto_activate_for",
    # 市场 / 面板分类（metadata.tabtin.category）
    "category",
    # 分区与工具关联
    "sections", "tools",
    # 跨域工具预装
    "preload_tools_for",
    # V2: 脚本执行相关元数据
    "has_main", "main_runtime", "main_timeout", "agent_model",
    "input_schema", "output_schema",
    # V3: Agent 角色定义字段（agents/*.md）
    "reply_mode", "tool_domains", "model",
)

VALID_TOOL_DOMAINS = frozenset({
    "rag", "browser", "tabdata", "tabcode", "tabdoc",
    "tabslide", "tabwhiteboard", "tabvideo",
})


def _parse_frontmatter(lines: List[str]) -> Tuple[Dict[str, Any], int]:
    """
    Parse YAML frontmatter delimited by ``---``.

    Returns ``(data_dict, body_start_line_index)``.
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
        logger.warning(
            "[SkillDocParser] YAML frontmatter parse failed, falling back to line-by-line: %s",
            raw_yaml[:200],
            exc_info=True,
        )
        data: Dict[str, Any] = {}
        for line in lines[1:end_idx]:
            line = line.strip()
            if ":" in line:
                key, value = line.split(":", 1)
                data[key.strip().lower()] = value.strip()

    return data, body_start


def _as_str_list(val: Any) -> List[str]:
    if isinstance(val, list):
        return [str(v) for v in val if v]
    if isinstance(val, str) and val:
        return [v.strip() for v in val.split(",") if v.strip()]
    return []


def _extract_rich_metadata(frontmatter: Dict[str, Any]) -> Dict[str, Any]:
    """Extract rich metadata fields from parsed frontmatter dict."""
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
            "pip": _as_str_list(requires_val.get("pip")),  # V2: Python 依赖
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

    # ── auto_activate_for: 指定 app 聚焦时自动激活 ──

    auto_activate_val = (
        frontmatter.get("auto_activate_for")
        or frontmatter.get("autoActivateFor")
    )
    if isinstance(auto_activate_val, list):
        meta["auto_activate_for"] = [str(v) for v in auto_activate_val if v]
    elif isinstance(auto_activate_val, str) and auto_activate_val:
        meta["auto_activate_for"] = [v.strip() for v in auto_activate_val.split(",") if v.strip()]
    else:
        meta["auto_activate_for"] = None

    # ── sections: 已弃用，保留解析以兼容旧 SKILL.md 文件 ──

    sections_val = frontmatter.get("sections")
    if isinstance(sections_val, list):
        meta["sections"] = [str(v).strip() for v in sections_val if v]
    elif isinstance(sections_val, str) and sections_val:
        meta["sections"] = [v.strip() for v in sections_val.split(",") if v.strip()]
    else:
        meta["sections"] = None

    # ── tools: 关联的 FC 工具名列表 ──

    tools_val = frontmatter.get("tools")
    if isinstance(tools_val, list):
        meta["tools"] = [str(v).strip() for v in tools_val if v]
    elif isinstance(tools_val, str) and tools_val:
        meta["tools"] = [v.strip() for v in tools_val.split(",") if v.strip()]
    else:
        meta["tools"] = None

    # ── V2: 脚本执行相关元数据 ──

    has_main_val = frontmatter.get("has_main")
    meta["has_main"] = bool(has_main_val) if has_main_val is not None else False

    meta["main_runtime"] = (
        frontmatter.get("main_runtime")
        or frontmatter.get("mainRuntime")
        or None
    )

    main_timeout_val = frontmatter.get("main_timeout") or frontmatter.get("mainTimeout")
    meta["main_timeout"] = int(main_timeout_val) if main_timeout_val is not None else None

    meta["agent_model"] = (
        frontmatter.get("agent_model")
        or frontmatter.get("agentModel")
        or None
    )

    input_schema_val = frontmatter.get("input_schema") or frontmatter.get("inputSchema")
    if isinstance(input_schema_val, list):
        meta["input_schema"] = input_schema_val
    else:
        meta["input_schema"] = None

    output_schema_val = frontmatter.get("output_schema") or frontmatter.get("outputSchema")
    if isinstance(output_schema_val, dict):
        meta["output_schema"] = output_schema_val
    else:
        meta["output_schema"] = None

    # ── V3: Agent 角色定义字段 ──

    reply_mode_val = (
        frontmatter.get("reply_mode")
        or frontmatter.get("replyMode")
    )
    if isinstance(reply_mode_val, str) and reply_mode_val.strip():
        meta["reply_mode"] = reply_mode_val.strip()
    else:
        meta["reply_mode"] = None

    tool_domains_val = (
        frontmatter.get("tool_domains")
        or frontmatter.get("toolDomains")
    )
    if isinstance(tool_domains_val, list):
        meta["tool_domains"] = [
            str(v).strip() for v in tool_domains_val
            if isinstance(v, str) and v.strip()
        ]
    elif isinstance(tool_domains_val, str) and tool_domains_val:
        meta["tool_domains"] = [
            v.strip() for v in tool_domains_val.split(",") if v.strip()
        ]
    else:
        meta["tool_domains"] = None

    model_val = frontmatter.get("model")
    if isinstance(model_val, str) and model_val.strip():
        meta["model"] = model_val.strip()
    else:
        meta["model"] = None

    return meta


def parse_skill_doc(content: str) -> Dict[str, Any]:
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

    # ── 新标准格式归一化（metadata.* 优先，顶层字段回退）──
    #   name: <kebab 机器 id>
    #   description: ...
    #   metadata:
    #     version: x.y.z
    #     tabtin: { displayName, tools, autoActivateFor, ... }
    # 旧格式（顶层 name=Title / version / tools ...）继续走回退路径，保持兼容。
    _meta_ns = frontmatter.get("metadata")
    _inner: Dict[str, Any] = {}
    if isinstance(_meta_ns, dict):
        # version：metadata.version 优先于顶层 version
        _mv = _meta_ns.get("version")
        if _mv is not None and str(_mv).strip():
            result["version"] = str(_mv).strip()
        # metadata.tabtin 优先；openclaw 为存量 skill 包兼容键，勿删
        _inner_candidate = _meta_ns.get("tabtin") or _meta_ns.get("openclaw") or {}
        if isinstance(_inner_candidate, dict):
            _inner = _inner_candidate
            # metadata.tabtin.* 提升到顶层供 rich 提取——新格式优先覆盖顶层同名字段
            for _k, _v in _inner.items():
                frontmatter[_k] = _v

    # display_name 基于「原始 frontmatter name」判定，绝不回退 `#` 一级标题
    result["display_name"] = _resolve_display_name(
        _inner, str(frontmatter.get("name") or "").strip(),
    )

    rich = _extract_rich_metadata(frontmatter)
    result.update(rich)

    return result


_AGENT_SPECIFIC_KEYS = {"reply_mode", "replyMode", "tool_domains", "toolDomains"}


def is_agent_doc(frontmatter: Dict[str, Any]) -> bool:
    """判断 frontmatter 是否来自 agents/*.md 角色定义文件。

    agents/*.md 与 SKILL.md 的区分依据：存在 agent 专有字段
    （reply_mode / tool_domains）中的任意一个。
    """
    if not frontmatter or not isinstance(frontmatter, dict):
        return False
    return bool(_AGENT_SPECIFIC_KEYS & frontmatter.keys())


def parse_agent_doc(content: str) -> Dict[str, Any]:
    """解析 agents/*.md 角色定义文件，提取 agent 元数据。

    BLUEPRINT 要求 agents/*.md 必须包含以下五字段：
      name, model, description, reply_mode, tool_domains

    返回 dict，包含 doc_type="agent" 标识符以及上述字段。
    缺失的必填字段以 None 表示（调用方可据此做校验报警）。
    """
    result: Dict[str, Any] = {
        "doc_type": "agent",
        "name": "",
        "description": "",
        "model": None,
        "reply_mode": None,
        "tool_domains": None,
        "has_frontmatter": False,
    }

    if not content:
        return result

    lines = content.splitlines()
    frontmatter, body_start = _parse_frontmatter(lines)

    result["has_frontmatter"] = bool(frontmatter)
    result["name"] = str(frontmatter.get("name") or "").strip()
    result["description"] = str(frontmatter.get("description") or "").strip()

    # 从 frontmatter 提取 agent 专有字段
    rich = _extract_rich_metadata(frontmatter)
    result["model"] = rich.get("model")
    result["reply_mode"] = rich.get("reply_mode")
    result["tool_domains"] = rich.get("tool_domains")

    # 校验 tool_domains 值域（基于 DECISIONS.md BRA-008 裁定）
    if result["tool_domains"]:
        invalid = [d for d in result["tool_domains"] if d not in VALID_TOOL_DOMAINS]
        if invalid:
            logger.warning(
                "[parse_agent_doc] unknown tool_domains %s (valid: %s)",
                invalid, sorted(VALID_TOOL_DOMAINS),
            )

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

    # 将全部 rich metadata 也传播出去，供 registry 消费
    for rk in RICH_METADATA_KEYS:
        if rk not in result:
            val = rich.get(rk)
            if val is not None:
                result[rk] = val

    return result


__all__ = [
    "parse_skill_doc",
    "parse_agent_doc",
    "is_agent_doc",
    "beautify_slug",
    "is_kebab_case",
    "RICH_METADATA_KEYS",
    "VALID_TOOL_DOMAINS",
    "_parse_frontmatter",
    "_extract_rich_metadata",
]
