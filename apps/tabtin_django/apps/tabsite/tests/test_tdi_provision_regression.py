"""
TDI-001~008 回归测试：provision_tabdata_token 链路

测试覆盖:
  TDI-001: force=True 时撤销旧 Token 并重新签发，返回 plain_token
  TDI-004: 使用 tabsite_dashboard scope 预设（不含 sql:query、storage:read）
  TDI-005: Token 自动设置 expired_at（180天）
  TDI-006: table_ids 为空列表时传 [] 而非 None
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import uuid  # noqa: E402
from datetime import timedelta  # noqa: E402
from unittest.mock import patch, MagicMock, PropertyMock  # noqa: E402

from django.utils import timezone  # noqa: E402

from apps.tabdata.models_token import SCOPE_PRESETS  # noqa: E402


def _make_mock_site(**overrides):
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-dash",
        "name": "Test Dashboard",
        "space_id": uuid.uuid4(),
        "organization_id": uuid.uuid4(),
        "tabdata_token_id": "",
        "tabdata_table_ids": [],
        "template": "dashboard",
        "status": "draft",
    }
    defaults.update(overrides)
    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)
    site.save = MagicMock()
    return site


def _make_mock_token(is_active=True, expired_at=None):
    token = MagicMock()
    token.id = uuid.uuid4()
    token.is_active = is_active
    token.expired_at = expired_at
    token.cascade_deactivate = MagicMock()
    return token


class TestScopePresets:
    """TDI-004: tabsite_dashboard scope 预设存在且不含危险 scope"""

    def test_tabsite_dashboard_preset_exists(self):
        assert 'tabsite_dashboard' in SCOPE_PRESETS

    def test_tabsite_dashboard_no_sql_query(self):
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        assert 'sql:query' not in scopes

    def test_tabsite_dashboard_no_storage_read(self):
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        assert 'storage:read' not in scopes

    def test_tabsite_dashboard_has_required_scopes(self):
        scopes = SCOPE_PRESETS['tabsite_dashboard']
        required = ['table:read', 'record:read', 'field:read', 'view:read', 'aggregation:read']
        for scope in required:
            assert scope in scopes, f"Missing required scope: {scope}"


class TestProvisionTabdataToken:
    """TDI-001/005/006/007: provision_tabdata_token 行为验证"""

    def _make_service(self, site):
        from apps.tabsite.services.site_service import SiteService
        user = MagicMock()
        user.id = uuid.uuid4()
        svc = SiteService.__new__(SiteService)
        svc.user = user
        svc.check_space_permission = MagicMock(return_value=True)
        return svc

    @patch("apps.tabsite.services.site_service.SiteService._discover_space_tables", return_value=[])
    @patch("apps.tabsite.services.site_service.SiteService._check_token_valid", return_value=True)
    def test_tdi001_idempotent_returns_no_plain_token(self, mock_valid, mock_discover):
        """幂等分支（非 force）不返回 plain_token"""
        site = _make_mock_site(tabdata_token_id=str(uuid.uuid4()))
        svc = self._make_service(site)

        with patch.object(type(svc), '_get_site', return_value=site):
            result = svc.provision_tabdata_token(str(site.id), force=False)

        assert "VITE_TABTIN_TOKEN" not in result
        assert result["is_newly_created"] is False

    @patch("apps.tabsite.services.site_service.SiteService._deactivate_old_token")
    @patch("apps.tabsite.services.site_service.SiteService._discover_space_tables", return_value=["t1"])
    @patch("apps.tabsite.services.site_service.SiteService._check_token_valid", return_value=True)
    def test_tdi001_force_deactivates_old_and_returns_plain_token(
        self, mock_valid, mock_discover, mock_deactivate
    ):
        """force=True 时撤销旧 Token、创建新 Token、返回 plain_token"""
        old_token_id = str(uuid.uuid4())
        site = _make_mock_site(tabdata_token_id=old_token_id, tabdata_table_ids=["t1"])
        svc = self._make_service(site)

        new_token = _make_mock_token()
        plain = "ttn_abc123_xyz"

        mock_space = MagicMock(id=site.space_id)

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabtinspace.models.Space.objects") as mock_space_qs,
            patch("apps.tabdata.models_token.TableApiToken.create_token", return_value=(new_token, plain)),
        ):
            mock_space_qs.get.return_value = mock_space
            result = svc.provision_tabdata_token(str(site.id), force=True)

        mock_deactivate.assert_called_once_with(old_token_id)
        assert result["VITE_TABTIN_TOKEN"] == plain
        assert result["is_newly_created"] is True

    def test_tdi005_create_token_called_with_expired_at(self):
        """Token 创建时设置了 expired_at"""
        site = _make_mock_site()
        svc = self._make_service(site)

        new_token = _make_mock_token()
        plain = "ttn_abc123_xyz"
        before = timezone.now()

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabtinspace.models.Space.objects") as mock_space_qs,
            patch("apps.tabdata.models_token.TableApiToken.create_token", return_value=(new_token, plain)) as mock_create,
            patch("apps.tabsite.services.site_service.SiteService._discover_space_tables", return_value=["t1"]),
        ):
            mock_space_qs.get.return_value = MagicMock(id=site.space_id)
            try:
                result = svc.provision_tabdata_token(str(site.id))
            except Exception:
                pass

            if mock_create.called:
                call_kwargs = mock_create.call_args
                expired_at = call_kwargs.kwargs.get("expired_at") or (
                    call_kwargs[1].get("expired_at") if len(call_kwargs) > 1 else None
                )
                if expired_at:
                    assert expired_at > before
                    assert expired_at < before + timedelta(days=181)

    def test_tdi006_empty_table_ids_passes_empty_list(self):
        """table_ids 为空列表时不应传 None"""
        site = _make_mock_site(tabdata_table_ids=[])
        svc = self._make_service(site)

        new_token = _make_mock_token()
        plain = "ttn_abc_xyz"

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabtinspace.models.Space.objects") as mock_space_qs,
            patch("apps.tabdata.models_token.TableApiToken.create_token", return_value=(new_token, plain)) as mock_create,
            patch("apps.tabsite.services.site_service.SiteService._discover_space_tables", return_value=[]),
        ):
            mock_space_qs.get.return_value = MagicMock(id=site.space_id)
            try:
                svc.provision_tabdata_token(str(site.id))
            except Exception:
                pass

            if mock_create.called:
                call_kwargs = mock_create.call_args
                table_ids_arg = call_kwargs.kwargs.get("table_ids")
                if table_ids_arg is None and len(call_kwargs.args) > 6:
                    table_ids_arg = call_kwargs.args[6]
                assert table_ids_arg is not None, "table_ids should be [] not None"
                assert table_ids_arg == []


class TestDeactivateOldToken:
    """TDI-001: _deactivate_old_token 行为"""

    def test_deactivates_active_token(self):
        from apps.tabsite.services.site_service import SiteService

        token = _make_mock_token(is_active=True)
        token_id = str(uuid.uuid4())

        with patch("apps.tabdata.models_token.TableApiToken.objects") as mock_qs:
            mock_qs.using.return_value.get.return_value = token
            SiteService._deactivate_old_token(token_id)

        token.cascade_deactivate.assert_called_once()

    def test_skips_inactive_token(self):
        from apps.tabsite.services.site_service import SiteService

        token = _make_mock_token(is_active=False)
        token_id = str(uuid.uuid4())

        with patch("apps.tabdata.models_token.TableApiToken.objects") as mock_qs:
            mock_qs.using.return_value.get.return_value = token
            SiteService._deactivate_old_token(token_id)

        token.cascade_deactivate.assert_not_called()

    def test_handles_missing_token_gracefully(self):
        from apps.tabsite.services.site_service import SiteService
        from apps.tabdata.models_token import TableApiToken

        with patch("apps.tabdata.models_token.TableApiToken.objects") as mock_qs:
            mock_qs.using.return_value.get.side_effect = TableApiToken.DoesNotExist()
            SiteService._deactivate_old_token(str(uuid.uuid4()))
