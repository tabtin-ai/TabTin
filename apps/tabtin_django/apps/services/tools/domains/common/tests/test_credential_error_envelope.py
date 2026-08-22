"""credential_lookup / credential_retrieve：失败路径走共享 error_envelope。"""
from __future__ import annotations

import json
from unittest.mock import patch

from apps.services.tools.domains.common.credential_tool import (
    CredentialLookupTool,
    CredentialRetrieveTool,
)
from apps.services.tools.error_envelope import is_standard_tool_error


def _payload(raw: str) -> dict:
    return json.loads(raw)


def test_credential_lookup_missing_user_uses_standard_envelope():
    tool = CredentialLookupTool()
    payload = _payload(tool.run(domain="github.com"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["hint"].strip()
    # 旧裸 {"error": "..."} 不再是合法失败出口
    assert payload["success"] is False


def test_credential_lookup_missing_domain_and_package_uses_standard_envelope():
    tool = CredentialLookupTool()
    payload = _payload(tool.run(domain="", app_package="", user_id="user-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "missing_required_param"
    assert "domain" in payload["hint"].lower() or "app_package" in payload["hint"]


def test_credential_retrieve_invalid_id_uses_standard_envelope():
    tool = CredentialRetrieveTool()
    payload = _payload(tool.run(credential_id="not-a-uuid", user_id="user-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert "credential_lookup" in payload["hint"]


def test_credential_retrieve_missing_user_uses_standard_envelope():
    tool = CredentialRetrieveTool()
    payload = _payload(tool.run(credential_id="11111111-1111-1111-1111-111111111111"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"


def test_credential_lookup_orm_exception_is_sanitized():
    secret = "postgresql://user:pass@db/SECRET_DB_DSN"

    with patch(
        "apps.credential_vault.models.UserCredential.objects.filter",
        side_effect=RuntimeError(secret),
    ), patch(
        "apps.services.tools.domains.common.credential_tool.logger.error",
    ) as log_error:
        payload = _payload(
            CredentialLookupTool().run(domain="github.com", user_id="user-1")
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "credential_lookup" in payload["hint"]
    assert secret not in str(payload)
    assert "details" not in payload
    assert log_error.call_count == 1
    assert secret not in str(log_error.call_args_list)


def test_credential_retrieve_not_found_is_non_retryable_resource_error():
    from apps.credential_vault.models import UserCredential

    with patch(
        "apps.credential_vault.models.UserCredential.objects.get",
        side_effect=UserCredential.DoesNotExist,
    ):
        payload = _payload(
            CredentialRetrieveTool().run(
                credential_id="11111111-1111-1111-1111-111111111111",
                user_id="user-1",
            )
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"
    assert payload["retryable"] is False
    assert "credential_lookup" in payload["hint"]


def test_credential_retrieve_database_error_is_retryable_and_sanitized():
    secret = "postgresql://user:pass@db/SECRET_DB_DSN"

    with patch(
        "apps.credential_vault.models.UserCredential.objects.get",
        side_effect=RuntimeError(secret),
    ), patch(
        "apps.services.tools.domains.common.credential_tool.logger.warning",
    ) as log_warning:
        payload = _payload(
            CredentialRetrieveTool().run(
                credential_id="11111111-1111-1111-1111-111111111111",
                user_id="user-1",
            )
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "upstream_error"
    assert payload["retryable"] is True
    assert "credential_retrieve" in payload["hint"]
    assert secret not in str(payload)
    assert "details" not in payload
    assert log_warning.call_count == 1
    assert secret not in str(log_warning.call_args_list)
