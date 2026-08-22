"""tins 失败路径迁移到标准 error envelope（JSON 字符串返回）。"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

from apps.services.tools.domains.tins.tin_tools import (
    ActivateTinTool,
    CreateTinTool,
    GetTinContextTool,
    ListTinsTool,
    UpdateTinFileTool,
)
from apps.services.tools.error_envelope import is_standard_tool_error


def _payload(raw: str) -> dict:
    data = json.loads(raw)
    assert isinstance(data, dict)
    return data


def test_tin_create_missing_organization_uses_standard_envelope():
    payload = _payload(CreateTinTool().run(name="demo", panel_html="<div/>"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False
    assert "organization" in payload["error"].lower() or "organization" in payload["hint"].lower()


def test_tin_create_exception_hides_raw_exception():
    with (
        patch(
            "apps.tins.services.tin_service.TinService.create_tin",
            side_effect=RuntimeError("secret-dsn=postgres://x:y@host/db"),
        ),
        patch("django.db.transaction.atomic") as atomic,
    ):
        atomic.return_value.__enter__ = MagicMock(return_value=None)
        atomic.return_value.__exit__ = MagicMock(return_value=False)
        payload = _payload(
            CreateTinTool().run(
                name="demo",
                panel_html="<div/>",
                organization_id="org-1",
                auto_activate=False,
            )
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert payload["retryable"] is True
    assert "secret-dsn" not in payload["error"]
    assert "secret-dsn" not in payload["hint"]
    assert "postgres://" not in json.dumps(payload)


def _assert_secret_not_logged(logger_mock: MagicMock, secret: str) -> None:
    logger_mock.exception.assert_not_called()
    logger_mock.error.assert_called_once()
    assert secret not in repr(logger_mock.mock_calls)
    assert logger_mock.error.call_args.kwargs.get("exc_info") is not True


def test_tin_create_exception_does_not_log_secret_or_traceback():
    secret = "secret-dsn=postgres://create-leak"
    with (
        patch(
            "apps.tins.services.tin_service.TinService.create_tin",
            side_effect=RuntimeError(secret),
        ),
        patch("django.db.transaction.atomic") as atomic,
        patch(
            "apps.services.tools.domains.tins.tin_tools.logger",
        ) as logger_mock,
    ):
        atomic.return_value.__enter__ = MagicMock(return_value=None)
        atomic.return_value.__exit__ = MagicMock(return_value=False)
        CreateTinTool().run(
            name="demo",
            panel_html="<div/>",
            organization_id="org-1",
            auto_activate=False,
        )
    _assert_secret_not_logged(logger_mock, secret)


def test_tin_update_exception_does_not_log_secret_or_traceback():
    secret = "secret-token=update-leak"
    tin = MagicMock()
    with (
        patch("apps.tins.services.tin_service.TinService.get_tin", return_value=tin),
        patch(
            "apps.tins.services.tin_service.TinService.update_file",
            side_effect=RuntimeError(secret),
        ),
        patch(
            "apps.services.tools.domains.tins.tin_tools.logger",
        ) as logger_mock,
    ):
        UpdateTinFileTool().run(
            tin_id="11111111-1111-1111-1111-111111111111",
            file_type="panel_html",
            content="x",
            organization_id="org-1",
        )
    _assert_secret_not_logged(logger_mock, secret)


def test_tin_list_exception_does_not_log_secret_or_traceback():
    secret = "secret-token=list-leak"
    with (
        patch(
            "apps.tins.services.tin_service.TinService.list_tins_qs",
            side_effect=RuntimeError(secret),
        ),
        patch(
            "apps.services.tools.domains.tins.tin_tools.logger",
        ) as logger_mock,
    ):
        ListTinsTool().run(organization_id="org-1")
    _assert_secret_not_logged(logger_mock, secret)


def test_tin_activate_exception_does_not_log_secret_or_traceback():
    secret = "secret-token=activate-leak"
    tin = MagicMock()
    with (
        patch("apps.tins.services.tin_service.TinService.get_tin", return_value=tin),
        patch(
            "apps.tins.services.tin_service.TinService.activate_tin",
            side_effect=RuntimeError(secret),
        ),
        patch("django.db.transaction.atomic") as atomic,
        patch(
            "apps.services.tools.domains.tins.tin_tools.logger",
        ) as logger_mock,
    ):
        atomic.return_value.__enter__ = MagicMock(return_value=None)
        atomic.return_value.__exit__ = MagicMock(return_value=False)
        ActivateTinTool().run(
            tin_id="11111111-1111-1111-1111-111111111111",
            organization_id="org-1",
        )
    _assert_secret_not_logged(logger_mock, secret)


def test_tin_get_context_exception_does_not_log_secret_or_traceback():
    secret = "secret-token=context-leak"
    with (
        patch(
            "apps.tins.models.TinInstance.objects.filter",
            side_effect=RuntimeError(secret),
        ),
        patch(
            "apps.services.tools.domains.tins.tin_tools.logger",
        ) as logger_mock,
    ):
        GetTinContextTool().run(organization_id="org-1", space_id="space-1")
    _assert_secret_not_logged(logger_mock, secret)


def test_tin_update_file_invalid_id_uses_standard_envelope():
    payload = _payload(
        UpdateTinFileTool().run(
            tin_id="not-a-uuid",
            file_type="panel_html",
            content="<div/>",
            organization_id="org-1",
        )
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert payload["retryable"] is False


def test_tin_update_file_not_found_uses_standard_envelope():
    with patch(
        "apps.tins.services.tin_service.TinService.get_tin",
        return_value=None,
    ):
        payload = _payload(
            UpdateTinFileTool().run(
                tin_id="11111111-1111-1111-1111-111111111111",
                file_type="panel_html",
                content="<div/>",
                organization_id="org-1",
            )
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"
    assert payload["retryable"] is False


def test_tin_update_file_value_error_maps_invalid_param():
    tin = MagicMock()
    tin.name = "demo"
    with (
        patch("apps.tins.services.tin_service.TinService.get_tin", return_value=tin),
        patch(
            "apps.tins.services.tin_service.TinService.update_file",
            side_effect=ValueError("Invalid file_type: bad"),
        ),
    ):
        payload = _payload(
            UpdateTinFileTool().run(
                tin_id="11111111-1111-1111-1111-111111111111",
                file_type="bad",
                content="x",
                organization_id="org-1",
            )
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert payload["retryable"] is False
    assert "Invalid file_type" not in payload["error"]


def test_tin_list_exception_hides_raw_exception():
    with patch(
        "apps.tins.services.tin_service.TinService.list_tins_qs",
        side_effect=RuntimeError("token=abc-secret"),
    ):
        payload = _payload(ListTinsTool().run(organization_id="org-1"))
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert "abc-secret" not in payload["error"]
    assert "abc-secret" not in payload["hint"]


def test_tin_activate_not_found_uses_standard_envelope():
    with patch(
        "apps.tins.services.tin_service.TinService.get_tin",
        return_value=None,
    ):
        payload = _payload(
            ActivateTinTool().run(
                tin_id="11111111-1111-1111-1111-111111111111",
                organization_id="org-1",
            )
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"


def test_tin_get_context_missing_space_uses_standard_envelope():
    payload = _payload(
        GetTinContextTool().run(organization_id="org-1", space_id=None)
    )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False
