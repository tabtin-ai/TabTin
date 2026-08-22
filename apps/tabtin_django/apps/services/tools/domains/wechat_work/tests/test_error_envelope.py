"""wechat_work 失败路径迁移到标准 error envelope（JSON 字符串返回）。"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import httpx
import pytest

from apps.services.tools.domains.wechat_work.contact_tools import WecomContactLookupTool
from apps.services.tools.domains.wechat_work._helpers import (
    get_access_token,
    resolve_account_and_token,
)
from apps.services.tools.domains.wechat_work.message_tools import WecomGetChatListTool
from apps.services.tools.domains.wechat_work.schedule_tools import WecomCreateScheduleTool
from apps.services.tools.domains.wechat_work.todo_tools import WecomUpdateTodoTool
from apps.services.tools.error_envelope import is_standard_tool_error


def _payload(raw: str) -> dict:
    data = json.loads(raw)
    assert isinstance(data, dict)
    return data


def _ok_auth():
    return (MagicMock(), "token-xyz")


def _token_account() -> MagicMock:
    account = MagicMock()
    account.config = {"corp_id": "wwcid", "secret": "super-secret-value"}
    return account


def _mock_token_client(*, response: MagicMock | None = None, error: Exception | None = None):
    client = MagicMock()
    if error is not None:
        client.get.side_effect = error
    else:
        client.get.return_value = response
    context = MagicMock()
    context.__enter__.return_value = client
    context.__exit__.return_value = False
    return context


@pytest.mark.parametrize(
    ("errcode", "error_kind", "retryable"),
    (
        (45009, "rate_limited", True),
        (48001, "permission_denied", False),
    ),
)
def test_resolve_account_token_reuses_errcode_mapper(
    errcode: int,
    error_kind: str,
    retryable: bool,
):
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {
        "errcode": errcode,
        "errmsg": "secret=upstream-sensitive-detail",
    }
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
            return_value=_token_account(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(response=response),
        ),
    ):
        account, raw = resolve_account_and_token("org-1")

    assert account is None
    payload = _payload(raw)
    assert payload["error_kind"] == error_kind
    assert payload["retryable"] is retryable
    assert payload["upstream_code"] == str(errcode)
    assert "upstream-sensitive-detail" not in raw
    assert "super-secret-value" not in raw


def test_resolve_account_token_non_json_is_upstream_not_auth():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.side_effect = json.JSONDecodeError(
        "secret=response-body",
        "secret=response-body",
        0,
    )
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
            return_value=_token_account(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(response=response),
        ),
    ):
        account, raw = resolve_account_and_token("org-1")

    assert account is None
    payload = _payload(raw)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "reconnect" not in payload["hint"].lower()
    assert "response-body" not in raw


def test_resolve_account_token_missing_access_token_is_upstream_not_auth():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"errcode": 0, "errmsg": "secret=missing-token"}
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
            return_value=_token_account(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(response=response),
        ),
    ):
        account, raw = resolve_account_and_token("org-1")

    assert account is None
    payload = _payload(raw)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "reconnect" not in payload["hint"].lower()
    assert "missing-token" not in raw


def test_resolve_account_token_transport_failure_maps_network():
    request = httpx.Request("GET", "https://qyapi.weixin.qq.com/cgi-bin/gettoken")
    error = httpx.ConnectError("secret=transport-token", request=request)
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
            return_value=_token_account(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(error=error),
        ),
    ):
        account, raw = resolve_account_and_token("org-1")

    assert account is None
    payload = _payload(raw)
    assert payload["error_kind"] == "network_failed"
    assert payload["retryable"] is True
    assert "reconnect" not in payload["hint"].lower()
    assert "transport-token" not in raw


def test_resolve_account_token_http_failure_maps_upstream():
    request = httpx.Request("GET", "https://qyapi.weixin.qq.com/cgi-bin/gettoken")
    response = httpx.Response(503, request=request)
    error = httpx.HTTPStatusError(
        "secret=http-body",
        request=request,
        response=response,
    )
    mock_response = MagicMock()
    mock_response.raise_for_status.side_effect = error
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
            return_value=_token_account(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(response=mock_response),
        ),
    ):
        account, raw = resolve_account_and_token("org-1")

    assert account is None
    payload = _payload(raw)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "reconnect" not in payload["hint"].lower()
    assert "http-body" not in raw


def test_get_access_token_success_keeps_existing_return_shape():
    response = MagicMock()
    response.raise_for_status.return_value = None
    response.json.return_value = {"errcode": 0, "access_token": "token-ok"}
    with (
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.get",
            return_value=None,
        ),
        patch(
            "apps.services.tools.domains.wechat_work._helpers.cache.set",
        ) as cache_set,
        patch(
            "apps.services.tools.domains.wechat_work._helpers.httpx.Client",
            return_value=_mock_token_client(response=response),
        ),
    ):
        token = get_access_token(_token_account())

    assert token == "token-ok"
    cache_set.assert_called_once_with("wechat_work:token:wwcid", "token-ok", 7000)


def test_contact_lookup_missing_organization_uses_standard_envelope():
    payload = _payload(WecomContactLookupTool().run(organization_id=None))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False
    assert "organization" in payload["error"].lower() or "organization" in payload["hint"].lower()


def test_contact_lookup_account_missing_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
        return_value=None,
    ):
        payload = _payload(WecomContactLookupTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False


def test_resolve_account_token_missing_config_is_runtime_misconfig():
    account = MagicMock()
    account.config = {"corp_id": "wwcid", "secret": ""}
    with patch(
        "apps.services.tools.domains.wechat_work._helpers.get_wecom_account",
        return_value=account,
    ):
        resolved, raw = resolve_account_and_token("org-1")
    assert resolved is None
    payload = _payload(raw)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False


def test_contact_lookup_rate_limit_maps_retryable():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.wecom_api_get",
            return_value={"errcode": 45009, "errmsg": "api freq out of limit"},
        ),
    ):
        payload = _payload(WecomContactLookupTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "rate_limited"
    assert payload["retryable"] is True
    assert payload.get("upstream_code") == "45009"
    assert "api freq" not in payload["error"]


def test_contact_lookup_permission_denied_maps():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.wecom_api_get",
            return_value={"errcode": 48001, "errmsg": "api unauthorized detail"},
        ),
    ):
        payload = _payload(WecomContactLookupTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "permission_denied"
    assert payload["retryable"] is False
    assert "unauthorized detail" not in payload["error"]


def test_contact_lookup_network_failure_sanitized():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.wecom_api_get",
            side_effect=httpx.ConnectError("connect to qyapi failed token=leak"),
        ),
    ):
        payload = _payload(WecomContactLookupTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "network_failed"
    assert payload["retryable"] is True
    assert "token=leak" not in payload["error"]
    assert "token=leak" not in payload["hint"]


def test_contact_lookup_timeout_maps():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.contact_tools.wecom_api_get",
            side_effect=httpx.ReadTimeout("read timed out"),
        ),
    ):
        payload = _payload(WecomContactLookupTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "request_timeout"
    assert payload["retryable"] is True


def test_get_chat_list_missing_userid_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.wechat_work.message_tools.resolve_account_and_token",
        return_value=_ok_auth(),
    ):
        payload = _payload(
            WecomGetChatListTool().run(organization_id="org-1", userid="")
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
    assert payload["retryable"] is False


def test_get_chat_list_archive_permission_hint_preserved_shape():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.message_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.message_tools.wecom_api_post",
            return_value={"errcode": 48001, "errmsg": "no archive"},
        ),
    ):
        payload = _payload(
            WecomGetChatListTool().run(organization_id="org-1", userid="u1")
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "permission_denied"
    assert "会话内容存档" in payload["hint"] or "archive" in payload["hint"].lower()
    assert "no archive" not in payload["error"]


def test_create_schedule_upstream_error_sanitized():
    with (
        patch(
            "apps.services.tools.domains.wechat_work.schedule_tools.resolve_account_and_token",
            return_value=_ok_auth(),
        ),
        patch(
            "apps.services.tools.domains.wechat_work.schedule_tools.wecom_api_post",
            return_value={"errcode": 50000, "errmsg": "internal secret=xyz"},
        ),
    ):
        payload = _payload(
            WecomCreateScheduleTool().run(
                organization_id="org-1",
                organizer_userid="u1",
                summary="meet",
                start_time=1,
                end_time=2,
            )
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "secret=xyz" not in payload["error"]


def test_update_todo_missing_task_id_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.wechat_work.todo_tools.resolve_account_and_token",
        return_value=_ok_auth(),
    ):
        payload = _payload(
            WecomUpdateTodoTool().run(organization_id="org-1", task_id="")
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
