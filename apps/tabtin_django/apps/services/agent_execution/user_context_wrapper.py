"""
User-Context Wrapper — Python 复刻 ``packages/agent-prompt/src/user-context-wrapper.ts``。

**SSoT 关系**：本模块是 ``@tabtin/agent-prompt`` 中
``buildUserContextWrapper`` / ``findFirstUserContextWrapper`` 的 Python 等价
实现。Django 端无法 import TypeScript 包，但 ``context_assembler.py``
等路径需要在 Daemon 路径下也产出 byte-identical 的 wrapper 字符串，否则
跨轮 stale 检测在 Daemon 链路上失效。

**双源 SSoT 风险防范**：
1. 字段排序 / 转义算法逐行对齐 TS 版（XML attr 字典序、``&`` 必须最后还原）；
2. 单测 ``tests/test_user_context_wrapper.py`` + TS 端 ``user-context-wrapper.test.ts``
   覆盖同一组 fixture，输出逐字节对比。

完整文档见 TS 模块顶端 docstring。这里只保留 Python 端必需注释。
"""
from __future__ import annotations

import re
from typing import Optional, Dict, List, NamedTuple

# ─── Public Constants ───────────────────────────────────────────────

VALID_TYPES: frozenset[str] = frozenset({
    "environment",          # context-injector hook
    "memory-recall",        # memory-injector hook
    "agent-profile",        # agent-profile hook（当前 Agent 名称 / 目标，贴用户消息前）
    "referenced",           # 用户 @ 引用，持久化（跨轮 stale 检测）
    "attached",             # 用户上传附件，持久化（跨轮 stale 检测）
    "quoted-message",       #  用户引用回复某条历史消息，持久化（跨轮折叠为指针）
    "lsp-diagnostic",       # LSP diagnostic-injector hook
    "tool-eviction",        # dynamicToolManager.evictStale 通告
    "mode-reminder",        # mode-reminder-injector hook（ask/plan/study sparse）
    "mode-transition-reminder",   # Phase 3：用户批准 switch_mode 后一次性注入
    "active-todos",               # todo-state-injector hook
})


class ParsedUserContextWrapper(NamedTuple):
    """findFirstUserContextWrapper / findAllUserContextWrappers 的返回值。"""
    type: str
    attrs: Dict[str, str]
    body: str
    start_offset: int
    end_offset: int


# ─── XML attr escape / unescape ─────────────────────────────────────


def _escape_xml_attr(value: str) -> str:
    """XML attr value 转义，与 TS ``escapeXmlAttr`` 字字节对齐。"""
    return (
        value
        .replace("&", "&amp;")
        .replace("\"", "&quot;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def _unescape_xml_attr(value: str) -> str:
    """反向解。``&amp;`` 必须最后还原避免误解二次转义。"""
    return (
        value
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
    )


# ─── Builder ────────────────────────────────────────────────────────


def build_user_context_wrapper(
    type: str,
    body: str,
    attrs: Optional[Dict[str, Optional[str]]] = None,
) -> str:
    """渲染 wrapper 字符串。

    形态：
        <context type="<kind>"[ attr1="v1" ...]>
        <body>
        </context>

    - attr 按 key 字典序排序，让 Python / TS 输出 byte-identical；
    - attr value 为 ``None`` / 空字符串时跳过；
    - body 不做转义（user content 直出）。

    与 TS 版唯一的形态差异：本函数对 ``type`` 不强校验是否在 ``VALID_TYPES``
    集合内——保持 TS 版灵活性，让单测 / 调试场景能注入实验 type。
    """
    attr_pairs: List[str] = [f'type="{_escape_xml_attr(type)}"']

    if attrs:
        # 字典序排序，让 Python / TS 输出位序固定，contract test 可逐字节对比。
        for key in sorted(attrs.keys()):
            value = attrs[key]
            if value is None or value == "":
                continue
            attr_pairs.append(f'{key}="{_escape_xml_attr(value)}"')

    return f"<context {' '.join(attr_pairs)}>\n{body}\n</context>"


# ─── Parser ─────────────────────────────────────────────────────────

# 与 TS ``findFirstUserContextWrapper`` 同款正则。
# 强制 ``type="..."`` 开头——老 ``<context>`` 无 type 属性的形态不会被命中。
_WRAPPER_RE = re.compile(
    r'<context\s+type="([^"]+)"((?:\s+[a-zA-Z_][a-zA-Z0-9_]*="[^"]*")*)\s*>\n'
    r'([\s\S]*?)\n</context>'
)

_ATTR_RE = re.compile(r'([a-zA-Z_][a-zA-Z0-9_]*)="([^"]*)"')


def find_first_user_context_wrapper(
    text: str,
    start_from: int = 0,
) -> Optional[ParsedUserContextWrapper]:
    """找第一个 wrapper（从 ``start_from`` 偏移开始）。

    匹配语义与 TS 版一致：
    - 无 ``type`` 属性的老 ``<context>`` 不命中；
    - 非贪婪 body 匹配，避免吞下一个 wrapper。
    """
    match = _WRAPPER_RE.search(text, pos=start_from)
    if not match:
        return None

    raw_type, raw_attrs, body = match.group(1), match.group(2), match.group(3)
    attrs: Dict[str, str] = {}
    if raw_attrs:
        for am in _ATTR_RE.finditer(raw_attrs):
            attrs[am.group(1)] = _unescape_xml_attr(am.group(2))

    return ParsedUserContextWrapper(
        type=_unescape_xml_attr(raw_type),
        attrs=attrs,
        body=body,
        start_offset=match.start(),
        end_offset=match.end(),
    )


def find_all_user_context_wrappers(text: str) -> List[ParsedUserContextWrapper]:
    """找出 text 里所有 wrapper（按起始 offset 升序）。"""
    out: List[ParsedUserContextWrapper] = []
    cursor = 0
    while cursor < len(text):
        wrapper = find_first_user_context_wrapper(text, cursor)
        if not wrapper:
            break
        out.append(wrapper)
        cursor = wrapper.end_offset
    return out
