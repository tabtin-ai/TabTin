"""
Trace 日志脱敏工具 — S3-05

对 Agent tool_calls 的 trace 日志中的敏感字段进行脱敏。
保留字段名和值的类型/长度信息以辅助调试，但屏蔽实际内容。
"""

from __future__ import annotations

import json
import re
from typing import Any

SENSITIVE_KEYS = frozenset({
    "token", "password", "api_key", "apikey", "secret",
    "credential", "credentials", "authorization",
    "access_token", "refresh_token", "private_key",
    "client_secret", "passphrase", "signing_key",
    "cookie", "session", "session_id", "bearer", "jwt",
    "database_url", "connection_string", "dsn", "otp", "pin",
    "x_api_key", "access_key", "auth_header",
})

_SENSITIVE_KEY_PATTERN = re.compile(
    r'(["\']?)(' + "|".join(re.escape(k) for k in sorted(SENSITIVE_KEYS)) + r')\1'
    r'\s*[:=]\s*'
    r'(["\'])(.+?)\3',
    re.IGNORECASE,
)

VALUE_PATTERNS = [
    re.compile(r'Bearer\s+\S+', re.IGNORECASE),
    re.compile(r'sk-ant-[a-zA-Z0-9\-_]{20,}'),
    re.compile(r'sk-[a-zA-Z0-9\-_]{20,}'),
    re.compile(r'AKIA[0-9A-Z]{16}'),
    re.compile(r'ghp_[a-zA-Z0-9]{36}'),
    re.compile(r'gho_[a-zA-Z0-9]{36}'),
    re.compile(r'github_pat_[a-zA-Z0-9_]{20,}'),
    re.compile(r'glpat-[a-zA-Z0-9\-_]{20,}'),
    re.compile(r'xox[bpars]-[a-zA-Z0-9\-]{10,}'),
]


def _matches_sensitive_value_pattern(value: str) -> bool:
    """检查值是否匹配已知的敏感数据模式（如 Bearer token、API key）。"""
    return any(p.search(value) for p in VALUE_PATTERNS)


_MAX_VALUE_LOG_LENGTH = 500


def _redact_value(value: Any) -> str:
    """生成保留类型和长度信息的脱敏占位符。"""
    type_name = type(value).__name__
    if isinstance(value, str):
        return f"[REDACTED:{type_name}:{len(value)}]"
    if isinstance(value, bytes):
        return f"[REDACTED:{type_name}:{len(value)}]"
    return f"[REDACTED:{type_name}]"


def redact_sensitive_fields(data: Any, *, _depth: int = 0) -> Any:
    """递归脱敏字典/列表中的敏感字段。

    - 字段名（大小写不敏感）匹配 SENSITIVE_KEYS 时，值替换为 ``[REDACTED:type:len]``
    - 超长字符串值截断至 _MAX_VALUE_LOG_LENGTH 并标注原始长度
    - 嵌套结构递归处理，深度上限 10 层以防循环引用
    """
    if _depth > 10:
        return "[DEPTH_LIMIT]"

    if isinstance(data, dict):
        sanitized = {}
        for k, v in data.items():
            if isinstance(k, str) and k.lower() in SENSITIVE_KEYS:
                sanitized[k] = _redact_value(v)
            elif isinstance(v, str) and _matches_sensitive_value_pattern(v):
                sanitized[k] = _redact_value(v)
            else:
                sanitized[k] = redact_sensitive_fields(v, _depth=_depth + 1)
        return sanitized

    if isinstance(data, (list, tuple)):
        return [redact_sensitive_fields(item, _depth=_depth + 1) for item in data]

    if isinstance(data, str):
        if _matches_sensitive_value_pattern(data):
            return _redact_value(data)
        if len(data) > _MAX_VALUE_LOG_LENGTH:
            return data[:_MAX_VALUE_LOG_LENGTH] + f"...(truncated, total {len(data)} chars)"

    return data


def redact_sensitive_string(text: str) -> str:
    """对纯字符串做正则脱敏，匹配 ``"key": "value"`` 模式中的敏感 key。

    适用于 tool_result content 等无法保证为 dict 的场景。
    如果字符串可以解析为 JSON dict/list，优先走结构化脱敏。
    """
    try:
        parsed = json.loads(text)
    except (json.JSONDecodeError, TypeError, ValueError):
        parsed = None

    if isinstance(parsed, (dict, list)):
        return json.dumps(redact_sensitive_fields(parsed), ensure_ascii=False)

    def _replace(match: re.Match) -> str:
        quote_l = match.group(1)
        key = match.group(2)
        val_quote = match.group(3)
        val = match.group(4)
        redacted = f"[REDACTED:str:{len(val)}]"
        return f"{quote_l}{key}{quote_l}: {val_quote}{redacted}{val_quote}"

    text = _SENSITIVE_KEY_PATTERN.sub(_replace, text)
    for pattern in VALUE_PATTERNS:
        text = pattern.sub(lambda m: f"[REDACTED:str:{len(m.group())}]", text)
    return text
