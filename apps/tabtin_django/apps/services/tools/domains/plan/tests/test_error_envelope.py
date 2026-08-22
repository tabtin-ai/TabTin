"""plan 域失败路径迁移到标准 error envelope。"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.tools.domains.plan.plan_tools import PlanCreateTool
from apps.services.tools.error_envelope import is_standard_tool_error
from apps.tabdoc.services.plan_service import PlanServiceError


def test_plan_create_missing_user_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.plan.plan_tools._load_user",
        return_value=None,
    ):
        payload = PlanCreateTool().run(name="X")
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False


def test_plan_create_service_error_keeps_upstream_code():
    with patch(
        "apps.services.tools.domains.plan.plan_tools._load_user",
        return_value=MagicMock(),
    ), patch(
        "apps.services.tools.domains.plan.plan_tools.PlanService"
    ) as svc_cls:
        svc = MagicMock()
        svc.create_plan.side_effect = PlanServiceError(
            "PLAN_INVALID_INPUT", "name 太长", status=400,
        )
        svc_cls.return_value = svc
        payload = PlanCreateTool().run(
            name="X",
            user_id="u",
            organization_id="w",
            space_id="s",
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert payload["upstream_code"] == "PLAN_INVALID_INPUT"


def test_plan_create_unexpected_exception_is_sanitized():
    with patch(
        "apps.services.tools.domains.plan.plan_tools._load_user",
        return_value=MagicMock(),
    ), patch(
        "apps.services.tools.domains.plan.plan_tools.PlanService"
    ) as svc_cls, patch(
        "apps.services.tools.domains.plan.plan_tools.logger.exception"
    ) as log_exc:
        svc = MagicMock()
        svc.create_plan.side_effect = RuntimeError("super-secret-token")
        svc_cls.return_value = svc
        payload = PlanCreateTool().run(
            name="X",
            user_id="u",
            organization_id="w",
            space_id="s",
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert "super-secret-token" not in payload["error"]
    assert "super-secret-token" not in repr(log_exc.call_args_list)
