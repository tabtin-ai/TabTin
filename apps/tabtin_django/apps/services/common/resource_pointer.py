"""
ResourcePointer Python 镜像 ── @tabtin/resource-router 的协议契约后端复制。

业务目标：让 `open_in_space` 工具（W2 schema、W5 execute）+ 任何后端代码
（W6 RichResourceRef render_block）能复用同一份双轨指针解析逻辑，确保 TS
端与 Python 端 byte-equal。

Cross-lang contract test fixture（W2 北极星之一）：
    `packages/resource-router/test/fixtures/parse-cross-lang.fixtures.json`
    两端读同一份 fixture 跑同样断言；任一端漂移 = D5 双轨双向覆盖失守。

设计取向（与 TS 端 packages/resource-router/src/parser.ts 严格对齐）：
    - 不抛异常；任何无法解析的输入退化为
      `ResourcePointer(scheme='unknown', type=None, id=raw, raw=raw, hint=None)`
    - 自有格式优先：环境协议 `tabtin[-preprod|-dev]://resource/<type>/<id>?<query>`
    - 其余协议（http/https/file/mailto/tel/weixin/...）按行业格式解析
    - 行业格式 hint 恒为 None（D5 决策）
    - meta 多值 query 收敛为列表，hint 重复出现只取第一个

当前后端没有任何"消费 ResourcePointer 派发到 carrier"的代码（那是 W3 / 渲染层
的事），但 W2 必须就位 schema 契约——`open_in_space.py` 工具入参校验、
后端 telemetry / RichResourceRef 反构 deep link 都要在 W2 起步。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Union
from urllib.parse import parse_qsl, quote, urlsplit


_SELF_FORMAT_PREFIXES = (
    "tabtin://resource/",
    "tabtin-preprod://resource/",
    "tabtin-dev://resource/",
)

# Agent 常见笔误归一化（须与 TS `packages/resource-router/src/parser.ts` 字符级对齐）。
# 不是补全注册表——unknown type 仍走 pass-through 由 registry 决定能否派发；
# 这里只兜底字面 typo：
#   - type=doc → document：agent 把 carrier app 简写当成 resource type
#   - hint=document → tabdoc：agent 把 resource type 写进 hint 段
#   - hint=doc → tabdoc：agent 把 app id 写成简写
_SELF_FORMAT_TYPE_ALIASES = {"doc": "document"}
_SELF_FORMAT_HINT_ALIASES = {"document": "tabdoc", "doc": "tabdoc"}


def _normalize_self_format_fields(
    type: str,
    hint: Optional[str],
) -> tuple[str, Optional[str]]:
    normalized_type = _SELF_FORMAT_TYPE_ALIASES.get(type, type)
    normalized_hint = hint
    if normalized_hint is not None and normalized_hint in _SELF_FORMAT_HINT_ALIASES:
        normalized_hint = _SELF_FORMAT_HINT_ALIASES[normalized_hint]
    return normalized_type, normalized_hint


@dataclass
class ResourcePointer:
    """与 TS 端 @tabtin/resource-router/types.ts:ResourcePointer 契约一致。"""

    scheme: str
    type: Optional[str]
    id: str
    raw: str
    hint: Optional[str]
    meta: Optional[Dict[str, Union[str, List[str]]]] = None
    base_dir: Optional[str] = None

    @classmethod
    def parse(cls, uri: Any, base_dir: Optional[str] = None) -> "ResourcePointer":
        """解析任意 URI 字符串为 ResourcePointer。永远不抛异常。"""
        raw = "" if uri is None else str(uri)

        # ── Step 1. 自有格式优先 ────────────────────────────────────
        self_format_prefix = next(
            (prefix for prefix in _SELF_FORMAT_PREFIXES if raw.startswith(prefix)),
            None,
        )
        if self_format_prefix is not None:
            self_pointer = _try_parse_self_format(raw, self_format_prefix)
            if self_pointer is not None:
                if base_dir is not None:
                    self_pointer.base_dir = base_dir
                return self_pointer
            # 头部对了但 path 形态不合法——退化为 scheme=tabtin + type=None
            return cls(
                scheme="tabtin",
                type=None,
                id=raw,
                raw=raw,
                hint=None,
                base_dir=base_dir,
            )

        # ── Step 2. 行业格式 ─────────────────────────────────────────
        # 用 urllib.parse.urlsplit；它对未知 scheme 也能给出 scheme/path
        try:
            parsed = urlsplit(raw)
        except Exception:
            return cls(
                scheme="unknown",
                type=None,
                id=raw,
                raw=raw,
                hint=None,
                base_dir=base_dir,
            )

        scheme = parsed.scheme
        # urlsplit 对 "this is not a uri" 这种纯文本会返回 scheme=''；
        # 与 TS 端 new URL() throw → unknown 行为对齐
        if not scheme:
            return cls(
                scheme="unknown",
                type=None,
                id=raw,
                raw=raw,
                hint=None,
                base_dir=base_dir,
            )

        return cls(
            scheme=scheme,
            type=None,
            id=raw,
            raw=raw,
            hint=None,
            base_dir=base_dir,
        )


def _try_parse_self_format(
    raw: str,
    self_format_prefix: str,
) -> Optional[ResourcePointer]:
    # `<environment-scheme>://resource/<type>/<id>[?<query>][#<frag>]`
    after_prefix = raw[len(self_format_prefix):]

    # 拿到 path（截掉 query / fragment 之前）
    path_end = len(after_prefix)
    for sep in ("?", "#"):
        idx = after_prefix.find(sep)
        if idx >= 0 and idx < path_end:
            path_end = idx
    path = after_prefix[:path_end]
    rest = after_prefix[path_end:]

    # path 形态必须是 "<type>/<id>"，type/id 都不能为空
    parts = path.split("/", 1)
    if len(parts) != 2:
        return None
    type_raw, id_raw = parts[0], parts[1]
    if not type_raw or not id_raw:
        return None

    type_decoded = _decode_uri_component_safe(type_raw).strip()
    id_decoded = _decode_uri_component_safe(id_raw)
    if not type_decoded or not id_decoded:
        return None

    # query 解析：?<key>=<value>&...
    hint: Optional[str] = None
    meta: Dict[str, Union[str, List[str]]] = {}
    if rest.startswith("?"):
        query_str = rest[1:]
        # 切掉 fragment 部分
        frag_idx = query_str.find("#")
        if frag_idx >= 0:
            query_str = query_str[:frag_idx]
        if query_str:
            # `keep_blank_values=True` 与 TS URLSearchParams 对齐——空 hint=
            # 视作未声明
            for key, value in parse_qsl(
                query_str,
                keep_blank_values=True,
                strict_parsing=False,
            ):
                if key == "hint":
                    if hint is None and value:
                        hint = value
                else:
                    if key in meta:
                        existing = meta[key]
                        if isinstance(existing, list):
                            existing.append(value)
                        else:
                            meta[key] = [existing, value]
                    else:
                        meta[key] = value

    type_decoded, hint = _normalize_self_format_fields(type_decoded, hint)

    return ResourcePointer(
        scheme="tabtin",
        type=type_decoded,
        id=id_decoded,
        raw=raw,
        hint=hint,
        meta=meta if meta else None,
    )


def _decode_uri_component_safe(s: str) -> str:
    """与 TS decodeURIComponent + try/catch 保护对齐——非法 % 序列直接返回原文。"""
    from urllib.parse import unquote

    try:
        return unquote(s, errors="strict")
    except Exception:
        return s


def serialize_self_format(
    *,
    type: Optional[str],
    id: str,
    hint: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
    scheme: str = "tabtin",
) -> str:
    """与 TS serializeSelfFormat 对齐——把 self-format pointer 反序列化为 URI 字符串。"""
    if not type:
        raise ValueError("serialize_self_format: type is required for self format")
    if not id:
        raise ValueError("serialize_self_format: id is required for self format")

    # quote 用 safe='' 跟 TS encodeURIComponent 行为对齐
    path = f"{scheme}://resource/{quote(type, safe='')}/{quote(id, safe='')}"

    pairs: List[tuple[str, str]] = []
    if hint:
        pairs.append(("hint", hint))
    if meta:
        for key, value in meta.items():
            if value is None:
                continue
            if isinstance(value, list):
                for item in value:
                    pairs.append((key, str(item)))
            else:
                pairs.append((key, str(value)))

    if not pairs:
        return path

    # 与 URLSearchParams 一致：使用 application/x-www-form-urlencoded（空格 → +）
    from urllib.parse import urlencode

    return f"{path}?{urlencode(pairs, quote_via=quote)}"


__all__ = ["ResourcePointer", "serialize_self_format"]
