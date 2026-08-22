"""
TC-006 / TC-007 回归测试

TC-006: provision-token API 的 force=true 必须受速率限制
TC-007: tabsite_dashboard scope 必须包含 field:read
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import json  # noqa: E402
import uuid  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

from apps.tabdata.models_token import SCOPE_PRESETS  # noqa: E402


class TestTC006ProvisionTokenRateLimit:
    """TC-006: force=true 的 provision-token 调用必须受速率限制"""

    RATE_LIMIT_PATH = "apps.services.common.utils.is_rate_limited"

    def _call_provision(self, site_id: str, force: bool, rate_limited: bool = False):
        from apps.tabsite.api import provision_tabdata_token

        request = MagicMock()
        request.auth = MagicMock()
        request.auth.id = uuid.uuid4()

        body_dict = {"force": force} if force else {}
        request.body = json.dumps(body_dict).encode() if body_dict else b""

        with patch(
            self.RATE_LIMIT_PATH, return_value=rate_limited
        ) as mock_rl, patch(
            "apps.tabsite.services.site_service.SiteService.provision_tabdata_token",
            return_value={"is_newly_created": True},
        ) as mock_provision, patch(
            "apps.tabsite.services.site_service.SiteService.__init__",
            return_value=None,
        ), patch(
            "apps.tabsite.services.site_service.SiteService.check_space_permission",
            return_value=True,
        ):
            result = provision_tabdata_token(request, site_id)
            return result, mock_rl, mock_provision

    def test_force_true_triggers_rate_limit_check(self):
        """force=true 时必须调用 is_rate_limited"""
        site_id = str(uuid.uuid4())
        _, mock_rl, _ = self._call_provision(site_id, force=True, rate_limited=False)

        mock_rl.assert_called_once()
        call_kwargs = mock_rl.call_args
        assert f"tabsite:provision_token:force:{site_id}" in str(call_kwargs)

    def test_force_true_rate_limited_returns_429(self):
        """force=true 触发速率限制时返回 429"""
        site_id = str(uuid.uuid4())
        result, _, mock_provision = self._call_provision(site_id, force=True, rate_limited=True)

        mock_provision.assert_not_called()
        if isinstance(result, tuple):
            status_code = result[0]
            assert status_code == 429
        elif hasattr(result, "status_code"):
            assert result.status_code == 429

    def test_force_false_skips_rate_limit_check(self):
        """force=false 时不触发速率限制检查"""
        site_id = str(uuid.uuid4())

        from apps.tabsite.api import provision_tabdata_token

        request = MagicMock()
        request.auth = MagicMock()
        request.auth.id = uuid.uuid4()
        request.body = b""

        with patch(
            self.RATE_LIMIT_PATH, return_value=False
        ) as mock_rl, patch(
            "apps.tabsite.services.site_service.SiteService.provision_tabdata_token",
            return_value={"is_newly_created": False},
        ), patch(
            "apps.tabsite.services.site_service.SiteService.__init__",
            return_value=None,
        ):
            provision_tabdata_token(request, site_id)
            mock_rl.assert_not_called()

    def test_rate_limit_key_is_per_site(self):
        """速率限制 key 必须包含 site_id，确保是按站点隔离"""
        site_id = str(uuid.uuid4())
        _, mock_rl, _ = self._call_provision(site_id, force=True, rate_limited=False)

        call_kwargs = mock_rl.call_args
        key_arg = call_kwargs.kwargs.get("key") or call_kwargs[0][0]
        assert site_id in key_arg


class TestTC007TabsiteDashboardScope:
    """TC-007: tabsite_dashboard scope 必须包含 field:read"""

    def test_tabsite_dashboard_includes_field_read(self):
        """Dashboard SDK 的 select('*') 可能调用 /fields 端点，必须有 field:read"""
        assert 'tabsite_dashboard' in SCOPE_PRESETS
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        assert 'field:read' in scopes, (
            "tabsite_dashboard 缺少 field:read scope，"
            "Dashboard SDK 的 from(tableId).select('*') 将触发 403"
        )

    def test_tabsite_dashboard_has_minimum_read_scopes(self):
        """Dashboard 最低需求：table + record + field + view 的读权限"""
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        for required in ('table:read', 'record:read', 'field:read', 'view:read'):
            assert required in scopes, f"tabsite_dashboard 缺少 {required}"

    def test_tabsite_dashboard_no_write_scopes(self):
        """Dashboard Token 不应包含任何写权限"""
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        write_scopes = [s for s in scopes if ':create' in s or ':update' in s or ':delete' in s or ':write' in s]
        assert write_scopes == [], f"tabsite_dashboard 不应包含写 scope: {write_scopes}"
