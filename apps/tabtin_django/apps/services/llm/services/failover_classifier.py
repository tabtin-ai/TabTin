"""
LLM 故障转移分类器。

将 LLM 调用失败映射为结构化的 FailoverReason，驱动：
- Key 级轮换（rate_limit / timeout / overloaded）
- Key 长禁用（billing / auth_permanent）
- Provider/Model 降级（model_not_found）
- 不处理（format / unknown）

Failover 原因分类设计，同时复用现有 LLMErrorCode 体系。
"""

from __future__ import annotations

import re
from enum import Enum
from typing import Optional

from ..errors import LLMErrorCode, LLMServiceError


class FailoverReason(str, Enum):
    RATE_LIMIT = "rate_limit"
    BILLING = "billing"
    AUTH = "auth"
    AUTH_PERMANENT = "auth_permanent"
    TIMEOUT = "timeout"
    OVERLOADED = "overloaded"
    MODEL_NOT_FOUND = "model_not_found"
    FORMAT = "format"
    UNKNOWN = "unknown"

    @property
    def should_rotate_key(self) -> bool:
        return self in _KEY_ROTATION_REASONS

    @property
    def should_disable_key(self) -> bool:
        return self in _KEY_DISABLE_REASONS

    @property
    def should_skip_provider(self) -> bool:
        return self in _PROVIDER_SKIP_REASONS


_KEY_ROTATION_REASONS = frozenset({
    FailoverReason.RATE_LIMIT,
    FailoverReason.TIMEOUT,
    FailoverReason.OVERLOADED,
    FailoverReason.AUTH,
})

_KEY_DISABLE_REASONS = frozenset({
    FailoverReason.BILLING,
    FailoverReason.AUTH_PERMANENT,
})

_PROVIDER_SKIP_REASONS = frozenset({
    FailoverReason.MODEL_NOT_FOUND,
})

# -- Error code → FailoverReason 映射 --

_ERROR_CODE_MAP: dict[str, FailoverReason] = {
    LLMErrorCode.RATE_LIMIT: FailoverReason.RATE_LIMIT,
    LLMErrorCode.QUOTA_EXCEEDED: FailoverReason.BILLING,
    LLMErrorCode.AUTH_FAILED: FailoverReason.AUTH,
    LLMErrorCode.MODEL_NOT_FOUND: FailoverReason.MODEL_NOT_FOUND,
    LLMErrorCode.TIMEOUT: FailoverReason.TIMEOUT,
    LLMErrorCode.PROVIDER_DOWN: FailoverReason.OVERLOADED,
    LLMErrorCode.TOKEN_LIMIT: FailoverReason.FORMAT,
    LLMErrorCode.CONTENT_FILTERED: FailoverReason.FORMAT,
    LLMErrorCode.INVALID_REQUEST: FailoverReason.FORMAT,
    LLMErrorCode.VISION_NOT_SUPPORTED: FailoverReason.FORMAT,
}

# -- 文本模式匹配（字符串匹配，覆盖中英文错误消息） --

_BILLING_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"insufficient.{0,20}(credits?|balance|funds?|quota)",
        r"(credit|balance).{0,15}(too low|exceeded|insufficient|exhausted)",
        r"billing.{0,15}(error|issue|limit|exceeded|disabled)",
        r"payment.{0,15}required",
        r"account.{0,15}(suspended|deactivated|disabled)",
        r"余额不足",
        r"额度.*?(用尽|不足|耗尽|超限)",
    ]
]

_RATE_LIMIT_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"rate.?limit",
        r"too many requests",
        r"请求过于频繁",
        r"throttl",
        r"requests? per (minute|second|hour|day)",
        r"TPM|RPM|RPD",
    ]
]

_OVERLOADED_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"(server|service).{0,15}(overloaded|unavailable|busy)",
        r"capacity",
        r"\b503\b",
        r"\b529\b",
        r"服务繁忙",
    ]
]

_AUTH_PERMANENT_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"invalid.{0,10}(api.?key|token|credential)",
        r"(api.?key|token|credential).{0,10}(invalid|expired|revoked|deactivated)",
        r"(密钥|令牌).{0,5}(无效|过期|已撤销)",
        r"Incorrect API key provided",
    ]
]

_AUTH_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"(authentication|authorization).{0,10}(failed|error|denied)",
        r"(permission|access).{0,10}denied",
        r"\b401\b",
        r"\b403\b",
        r"认证失败",
    ]
]

_TIMEOUT_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"timed?\s*out",
        r"deadline exceeded",
        r"connection.{0,10}(reset|refused|aborted|closed)",
        r"read timeout",
        r"连接超时",
        r"stop reason: error",
    ]
]

_MODEL_NOT_FOUND_PATTERNS = [
    re.compile(p, re.I) for p in [
        r"model.{0,15}(not found|does not exist|unavailable|not available)",
        r"The model .+ does not exist",
        r"模型.*不存在",
    ]
]


def classify_failover_reason(
    error: Optional[Exception] = None,
    raw_message: str = "",
    error_code: str = "",
) -> Optional[FailoverReason]:
    """结构化分类 LLM 调用失败原因。

    分类优先级：
    1. LLMServiceError.code → 直接映射
    2. HTTP status_code 驱动
    3. 错误消息文本匹配（按严重程度排序）

    Returns:
        FailoverReason or None（无法分类时）
    """
    if isinstance(error, LLMServiceError):
        code = error.code
        raw_message = raw_message or str(error)
        status_code = error.status_code
    else:
        code = error_code
        status_code = getattr(error, "status_code", None)
        if not raw_message and error:
            raw_message = str(error)

    if code and code in _ERROR_CODE_MAP:
        reason = _ERROR_CODE_MAP[code]
        if reason == FailoverReason.AUTH:
            if _matches_any(_AUTH_PERMANENT_PATTERNS, raw_message):
                return FailoverReason.AUTH_PERMANENT
            if _matches_any(_BILLING_PATTERNS, raw_message):
                return FailoverReason.BILLING
        return reason

    if status_code:
        if status_code == 429:
            return FailoverReason.RATE_LIMIT
        if status_code == 402:
            if _matches_any(_BILLING_PATTERNS, raw_message):
                return FailoverReason.BILLING
            return FailoverReason.BILLING
        if status_code == 401:
            if _matches_any(_AUTH_PERMANENT_PATTERNS, raw_message):
                return FailoverReason.AUTH_PERMANENT
            return FailoverReason.AUTH
        if status_code == 403:
            return FailoverReason.AUTH
        if status_code == 404:
            return FailoverReason.MODEL_NOT_FOUND
        if status_code in (502, 503, 529):
            return FailoverReason.OVERLOADED
        if status_code in (504, 408):
            return FailoverReason.TIMEOUT

    if not raw_message:
        return None

    if _matches_any(_BILLING_PATTERNS, raw_message):
        return FailoverReason.BILLING
    if _matches_any(_AUTH_PERMANENT_PATTERNS, raw_message):
        return FailoverReason.AUTH_PERMANENT
    if _matches_any(_AUTH_PATTERNS, raw_message):
        return FailoverReason.AUTH
    if _matches_any(_MODEL_NOT_FOUND_PATTERNS, raw_message):
        return FailoverReason.MODEL_NOT_FOUND
    if _matches_any(_RATE_LIMIT_PATTERNS, raw_message):
        return FailoverReason.RATE_LIMIT
    if _matches_any(_OVERLOADED_PATTERNS, raw_message):
        return FailoverReason.OVERLOADED
    if _matches_any(_TIMEOUT_PATTERNS, raw_message):
        return FailoverReason.TIMEOUT

    return None


def _matches_any(patterns: list, text: str) -> bool:
    return any(p.search(text) for p in patterns)
