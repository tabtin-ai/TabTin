"""企业微信工具共享辅助函数。

封装 ChannelAccount 查询、access_token 获取，以及标准失败 envelope 映射。
工具的 run() 方法是同步的，因此这里使用 httpx 同步客户端。

失败路径不得回传 corpsecret / access_token / 上游 errmsg 原文。
"""

from __future__ import annotations

import logging
from typing import Final, Optional

import httpx
from django.core.cache import cache

from apps.channel_gateway.models import ChannelAccount
from apps.services.tools.error_envelope import json_tool_error, tool_result_success

logger = logging.getLogger(__name__)

QYAPI_BASE = "https://qyapi.weixin.qq.com/cgi-bin"
TOKEN_CACHE_TTL = 7000

_WECOM_AUTH_ERRCODES: Final[frozenset[int]] = frozenset(
    {40001, 40013, 40014, 41001, 42001}
)
_WECOM_RATE_ERRCODES: Final[frozenset[int]] = frozenset({45009, 45033})
_WECOM_PERM_ERRCODES: Final[frozenset[int]] = frozenset(
    {48001, 60009, 60011, 60020}
)
_WECOM_NOT_FOUND_ERRCODES: Final[frozenset[int]] = frozenset(
    {40003, 40068, 60111, 86001}
)


class WecomConfigError(RuntimeError):
    """Required local WeCom configuration is missing."""


class WecomTokenApiError(RuntimeError):
    """WeCom token endpoint returned a typed business error."""

    def __init__(self, errcode: object) -> None:
        super().__init__("wecom_token_api_error")
        self.errcode = errcode


class WecomTokenResponseError(RuntimeError):
    """WeCom token endpoint returned a malformed success response."""


def get_wecom_account(organization_id: str) -> Optional[ChannelAccount]:
    """通过 organization_id 查找已启用的企业微信渠道账号。"""
    return ChannelAccount.objects.filter(
        organization_id=organization_id,
        channel="wechat_work",
        enabled=True,
    ).first()


def get_access_token(account: ChannelAccount) -> str:
    """获取并缓存企微 access_token（同步版本）。

    失败时抛出不含 secret / errmsg 原文的异常；由 resolve_account_and_token
    映射为标准 envelope。
    """
    config = account.config or {}
    corp_id = (config.get("corp_id") or "").strip()
    secret = (config.get("secret") or "").strip()
    if not corp_id or not secret:
        raise WecomConfigError("wecom_config_missing")

    cache_key = f"wechat_work:token:{corp_id}"
    token = cache.get(cache_key)
    if token:
        return token

    with httpx.Client(timeout=10) as client:
        resp = client.get(
            f"{QYAPI_BASE}/gettoken",
            params={"corpid": corp_id, "corpsecret": secret},
        )
        resp.raise_for_status()
        data = resp.json()

    if not isinstance(data, dict):
        raise WecomTokenResponseError("wecom_token_response_not_object")
    errcode = data.get("errcode")
    if errcode != 0:
        # 不把上游 errmsg（可能含配置细节）带进异常消息。
        raise WecomTokenApiError(errcode)

    token = data.get("access_token")
    if not isinstance(token, str) or not token.strip():
        raise WecomTokenResponseError("wecom_token_missing")
    cache.set(cache_key, token, TOKEN_CACHE_TTL)
    return token


def wecom_api_get(token: str, path: str, params: dict | None = None) -> dict:
    """发起企微 GET 请求（同步）。"""
    all_params = {"access_token": token}
    if params:
        all_params.update(params)
    with httpx.Client(timeout=30) as client:
        resp = client.get(f"{QYAPI_BASE}{path}", params=all_params)
        return resp.json()


def wecom_api_post(token: str, path: str, payload: dict) -> dict:
    """发起企微 POST 请求（同步）。"""
    with httpx.Client(timeout=30) as client:
        resp = client.post(
            f"{QYAPI_BASE}{path}",
            params={"access_token": token},
            json=payload,
        )
        return resp.json()


def json_missing_organization() -> str:
    return json_tool_error(
        "Missing organization_id for WeCom tools.",
        error_kind="runtime_misconfig",
        hint=(
            "Start the Agent in an authenticated Space so organization_id "
            "is injected, then retry."
        ),
        retryable=False,
    )


def json_account_not_found() -> str:
    return json_tool_error(
        "No enabled WeCom account is bound to this organization.",
        error_kind="runtime_misconfig",
        hint=(
            "Ask the user to connect and enable WeChat Work in channel "
            "settings, then retry."
        ),
        retryable=False,
    )


def json_missing_param(param: str, *, tool_name: str) -> str:
    return json_tool_error(
        f"{param} is required.",
        error_kind="missing_required_param",
        hint=f"Provide {param} before calling {tool_name}.",
        retryable=False,
    )


def json_wecom_transport_error(exc: Exception, *, operation: str) -> str:
    """Map network / timeout / unexpected transport failures."""
    if isinstance(exc, httpx.TimeoutException):
        return json_tool_error(
            f"WeCom {operation} timed out.",
            error_kind="request_timeout",
            hint="Retry once. If timeouts persist, ask the user to check WeCom connectivity.",
            retryable=True,
        )
    if isinstance(exc, (httpx.ConnectError, httpx.NetworkError)):
        return json_tool_error(
            f"WeCom {operation} could not reach the upstream API.",
            error_kind="network_failed",
            hint="Retry once after the network recovers. Do not repeat rapidly.",
            retryable=True,
        )
    logger.error(
        "wecom %s transport/internal failure type=%s",
        operation,
        type(exc).__name__,
    )
    return json_tool_error(
        f"WeCom {operation} failed.",
        error_kind="internal_error",
        hint="Retry once. If it fails again, ask the user to retry from WeCom settings.",
        retryable=True,
    )


def json_wecom_api_error(
    data: dict,
    *,
    operation: str,
    hint: str | None = None,
) -> str:
    """Map WeCom errcode to a standard envelope without leaking errmsg."""
    raw_code = data.get("errcode")
    try:
        errcode = int(raw_code) if raw_code is not None else None
    except (TypeError, ValueError):
        errcode = None
    upstream = str(errcode) if errcode is not None else None

    if errcode in _WECOM_AUTH_ERRCODES:
        return json_tool_error(
            f"WeCom authentication failed for {operation}.",
            error_kind="auth_failed",
            hint=(
                "Ask the user to reconnect WeChat Work (corp_id/secret) "
                "in channel settings, then retry."
            ),
            retryable=False,
            upstream_code=upstream,
        )
    if errcode in _WECOM_RATE_ERRCODES:
        return json_tool_error(
            f"WeCom rate-limited {operation}.",
            error_kind="rate_limited",
            hint="Wait before retrying the WeCom operation.",
            retryable=True,
            upstream_code=upstream,
        )
    if errcode in _WECOM_PERM_ERRCODES:
        return json_tool_error(
            f"WeCom denied permission for {operation}.",
            error_kind="permission_denied",
            hint=hint
            or (
                "Ask the user to grant the required WeCom app permission, "
                "then retry."
            ),
            retryable=False,
            upstream_code=upstream,
        )
    if errcode in _WECOM_NOT_FOUND_ERRCODES:
        return json_tool_error(
            f"WeCom resource not found for {operation}.",
            error_kind="resource_not_found",
            hint="Confirm the userid/department/resource still exists, then retry.",
            retryable=False,
            upstream_code=upstream,
        )
    return json_tool_error(
        f"WeCom {operation} could not be completed.",
        error_kind="upstream_error",
        hint="Retry once. If it fails again, ask the user to retry from WeCom.",
        retryable=True,
        upstream_code=upstream,
    )


def resolve_account_and_token(
    organization_id: str | None,
) -> tuple[ChannelAccount, str] | tuple[None, str]:
    """统一获取 account + token，返回 (account, token) 或 (None, error_json)。"""
    if not organization_id:
        return None, json_missing_organization()

    account = get_wecom_account(organization_id)
    if not account:
        return None, json_account_not_found()

    try:
        token = get_access_token(account)
    except httpx.TimeoutException as exc:
        return None, json_wecom_transport_error(exc, operation="get_access_token")
    except (httpx.ConnectError, httpx.NetworkError) as exc:
        return None, json_wecom_transport_error(exc, operation="get_access_token")
    except WecomConfigError:
        return None, json_tool_error(
            "WeCom corp_id/secret is not configured.",
            error_kind="runtime_misconfig",
            hint=(
                "Ask an administrator to configure WeChat Work corp_id "
                "and secret, then retry."
            ),
            retryable=False,
        )
    except WecomTokenApiError as exc:
        return None, json_wecom_api_error(
            {"errcode": exc.errcode},
            operation="get_access_token",
        )
    except httpx.HTTPStatusError as exc:
        return None, json_wecom_api_error(
            {"errcode": exc.response.status_code},
            operation="get_access_token",
        )
    except (ValueError, KeyError, WecomTokenResponseError):
        return None, json_wecom_api_error({}, operation="get_access_token")
    except Exception as exc:
        return None, json_wecom_transport_error(
            exc,
            operation="get_access_token",
        )

    # Mark token as explicit success content so tuple-element audit of the
    # success path stays statically proven without changing runtime identity.
    return account, tool_result_success(token)


__all__ = [
    "QYAPI_BASE",
    "WecomConfigError",
    "WecomTokenApiError",
    "WecomTokenResponseError",
    "get_access_token",
    "get_wecom_account",
    "json_account_not_found",
    "json_missing_organization",
    "json_missing_param",
    "json_wecom_api_error",
    "json_wecom_transport_error",
    "resolve_account_and_token",
    "wecom_api_get",
    "wecom_api_post",
]
