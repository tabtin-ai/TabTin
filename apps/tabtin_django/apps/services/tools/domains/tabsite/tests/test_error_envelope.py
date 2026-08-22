"""tabsite 失败路径迁移到标准 error envelope（dict 返回）。"""
from __future__ import annotations

from unittest.mock import patch

from apps.services.tools.domains.tabsite.site_tools import (
    TabsiteCreateSiteTool,
    TabsiteGetSiteTool,
    TabsiteUpdateSiteTool,
)
from apps.services.tools.error_envelope import is_standard_tool_error
from apps.tabsite.error_codes import ErrorCode
from apps.tabtinspace.services.base import ServiceError


def test_create_site_missing_user_uses_standard_envelope():
    payload = TabsiteCreateSiteTool().run(name="demo", user_id=None)
    assert isinstance(payload, dict)
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["retryable"] is False


def test_create_site_missing_context_uses_standard_envelope():
    with patch(
        "apps.services.tools.domains.tabsite.site_tools._load_user",
        return_value=object(),
    ):
        payload = TabsiteCreateSiteTool().run(
            name="demo",
            user_id="u1",
            organization_id=None,
            space_id=None,
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert "organization_id" in payload["error"] or "organization_id" in payload["hint"]


def test_create_site_exception_hides_raw_exception():
    with (
        patch(
            "apps.services.tools.domains.tabsite.site_tools._load_user",
            return_value=object(),
        ),
        patch(
            "apps.tabsite.services.site_service.SiteService.create_site",
            side_effect=RuntimeError("secret-db-dsn=postgres://x"),
        ),
    ):
        payload = TabsiteCreateSiteTool().run(
            name="demo",
            user_id="u1",
            organization_id="org",
            space_id="space",
        )
    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "internal_error"
    assert payload["retryable"] is True
    assert "secret-db-dsn" not in payload["error"]
    assert "secret-db-dsn" not in payload["hint"]


def test_get_site_maps_typed_not_found_error():
    with (
        patch(
            "apps.services.tools.domains.tabsite.site_tools._load_user",
            return_value=object(),
        ),
        patch(
            "apps.tabsite.services.site_service.SiteService.get_site_detail",
            side_effect=ServiceError(
                ErrorCode.SITE_NOT_FOUND,
                "站点不存在",
                status=404,
            ),
        ),
    ):
        payload = TabsiteGetSiteTool().run(
            site_id="missing",
            user_id="u1",
            organization_id="org",
            space_id="space",
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "resource_not_found"
    assert payload["upstream_code"] == ErrorCode.SITE_NOT_FOUND
    assert payload["retryable"] is False
    assert "site_id" in payload["hint"]


def test_update_site_maps_typed_permission_error():
    with (
        patch(
            "apps.services.tools.domains.tabsite.site_tools._load_user",
            return_value=object(),
        ),
        patch(
            "apps.tabsite.services.site_service.SiteService.update_site",
            side_effect=ServiceError(
                ErrorCode.PERMISSION_DENIED,
                "权限不足",
                status=403,
            ),
        ),
    ):
        payload = TabsiteUpdateSiteTool().run(site_id="site-1", user_id="u1")

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "permission_denied"
    assert payload["upstream_code"] == ErrorCode.PERMISSION_DENIED
    assert payload["retryable"] is False
    assert "access" in payload["hint"].lower() or "权限" in payload["hint"]


def test_create_site_maps_typed_invalid_error():
    with (
        patch(
            "apps.services.tools.domains.tabsite.site_tools._load_user",
            return_value=object(),
        ),
        patch(
            "apps.tabsite.services.site_service.SiteService.create_site",
            side_effect=ServiceError(
                "INVALID_DIST_URL",
                "dist_url 非法",
                status=400,
            ),
        ),
    ):
        payload = TabsiteCreateSiteTool().run(
            name="demo",
            user_id="u1",
            organization_id="org",
            space_id="space",
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "invalid_param_format"
    assert payload["upstream_code"] == "INVALID_DIST_URL"
    assert payload["retryable"] is False
    assert "input" in payload["hint"].lower() or "参数" in payload["hint"]


def test_create_site_maps_oss_config_invalid_dist_url_to_runtime_misconfig():
    with (
        patch(
            "apps.services.tools.domains.tabsite.site_tools._load_user",
            return_value=object(),
        ),
        patch(
            "apps.tabsite.services.site_service.SiteService.create_site",
            side_effect=ServiceError(
                "INVALID_DIST_URL",
                "OSS endpoint secret configuration detail",
                status=500,
            ),
        ),
    ):
        payload = TabsiteCreateSiteTool().run(
            name="demo",
            user_id="u1",
            organization_id="org",
            space_id="space",
        )

    assert is_standard_tool_error(payload)
    assert payload["error_kind"] == "runtime_misconfig"
    assert payload["upstream_code"] == "INVALID_DIST_URL"
    assert payload["retryable"] is False
    assert "OSS endpoint secret" not in payload["error"]
    assert "configure" in payload["hint"].lower() or "配置" in payload["hint"]
