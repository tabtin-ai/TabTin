"""飞书导入错误分类与面向用户的中文提示。"""

from __future__ import annotations

from typing import Any, Mapping

from .client import FeishuAPIError
from .constants import IMPORT_INTERRUPTED_REASON_PROVIDER_REAUTHENTICATED

_AUTH_ERROR_CODES = frozenset({99991668, 99991671, 99991677})
_EXPIRED_ACCESS_TOKEN_CODES = frozenset({99991677})


class ImportInterrupted(Exception):
    """导入被组织级企业应用重新认证终止。"""


def raise_if_provider_reauthenticated(result: Mapping[str, Any]) -> None:
    if (
        result.get("interrupted_reason")
        == IMPORT_INTERRUPTED_REASON_PROVIDER_REAUTHENTICATED
    ):
        raise ImportInterrupted


def is_auth_api_error(exc: FeishuAPIError) -> bool:
    return exc.status_code == 401 or exc.code in _AUTH_ERROR_CODES


def is_expired_access_token_error(exc: FeishuAPIError) -> bool:
    return exc.code in _EXPIRED_ACCESS_TOKEN_CODES


def user_facing_import_error(exc: Exception) -> str:
    """把第三方与内部异常收口为稳定、无错误码的中文提示。"""
    if isinstance(exc, FeishuAPIError):
        if is_auth_api_error(exc):
            return "飞书授权已失效，请重新授权"

        message = str(exc).lower()
        unavailable_markers = (
            "deleted",
            "not found",
            "not exist",
            "does not exist",
            "no permission",
            "permission denied",
            "forbidden",
        )
        if (
            exc.status_code in {403, 404}
            or exc.code in {403, 1002, 99991679}
            or any(marker in message for marker in unavailable_markers)
        ):
            return "资源已被删除或无法访问"
        return "飞书资源导入失败，请稍后重试"

    return "资源导入失败，请稍后重试"
