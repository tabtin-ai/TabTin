"""
F06 回归测试：site_service.py 修复验证

覆盖问题 ID:
  TS-008: _get_site 权限检查必须在归档状态检查之前
  TS-009: publish_site 中 deactivate 失败不应继续 register（通过 on_commit 机制保障）
  TS-010: rollback_to_version 必须将 status 设为 PUBLISHED
  TS-011/CC-006: FileUsage 操作应在 PG 事务提交后执行（on_commit）
  CC-007: FileUsage 注册的 file_name/content_type 应反映真实内容（非 zip）
  CC-010/CC-011: rollback 的 FileUsage 操作同样移至 on_commit
  CC-012: 回滚到 dist_url 为空的版本应被拒绝
  TS-023: slug 生成循环应有重试上限
  CC-019: DNS 解析应有缓存
  CC-027: file_size=0 时应有警告日志
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import time  # noqa: E402
import uuid  # noqa: E402
from unittest.mock import patch, MagicMock, call  # noqa: E402

import pytest  # noqa: E402

from apps.tabtinspace.services.base import ServiceError  # noqa: E402


def _make_mock_site(**overrides):
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-site",
        "name": "Test Site",
        "space_id": uuid.uuid4(),
        "organization_id": uuid.uuid4(),
        "status": "published",
        "dist_oss_url": "https://cdn.example.com/tabsite/sites/123/",
        "current_version": 2,
        "published_url": "https://site.example.com/s/test-site/",
        "tabdata_token_id": "",
        "tabdata_table_ids": [],
    }
    defaults.update(overrides)
    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)
    site.save = MagicMock()

    class _Status:
        DRAFT = "draft"
        PUBLISHED = "published"
        ARCHIVED = "archived"

    type(site).Status = _Status
    return site


def _make_service(*, has_permission=True):
    from apps.tabsite.services.site_service import SiteService
    user = MagicMock()
    user.id = uuid.uuid4()
    svc = SiteService.__new__(SiteService)
    svc.user = user
    svc.check_space_permission = MagicMock(return_value=has_permission)
    return svc


class TestTS008GetSitePermissionOrder:
    """TS-008: 权限检查必须在归档状态检查之前，防止状态信息泄露。"""

    def test_no_permission_returns_403_not_410_for_archived_site(self):
        """无权限用户访问归档站点应得到 403 而非 410。"""
        from apps.tabsite.services.site_service import SiteService
        from apps.tabsite.models import Site

        archived_site = MagicMock()
        archived_site.id = uuid.uuid4()
        archived_site.status = Site.Status.ARCHIVED
        archived_site.space_id = uuid.uuid4()

        svc = _make_service(has_permission=False)

        with patch("apps.tabsite.models.Site.objects") as mock_qs:
            mock_qs.all.return_value.get.return_value = archived_site

            with pytest.raises(ServiceError) as exc_info:
                svc._get_site(str(archived_site.id), "editor")

            assert exc_info.value.code == "PERMISSION_DENIED"
            assert exc_info.value.status == 403

    def test_has_permission_archived_returns_410(self):
        """有权限用户以 editor 角色访问归档站点应得到 410。"""
        from apps.tabsite.services.site_service import SiteService
        from apps.tabsite.models import Site

        archived_site = MagicMock()
        archived_site.id = uuid.uuid4()
        archived_site.status = Site.Status.ARCHIVED
        archived_site.space_id = uuid.uuid4()

        svc = _make_service(has_permission=True)

        with patch("apps.tabsite.models.Site.objects") as mock_qs:
            mock_qs.all.return_value.get.return_value = archived_site

            with pytest.raises(ServiceError) as exc_info:
                svc._get_site(str(archived_site.id), "editor")

            assert exc_info.value.code == "SITE_ARCHIVED"
            assert exc_info.value.status == 410

    def test_has_permission_archived_viewer_ok(self):
        """有权限用户以 viewer 角色访问归档站点应正常返回。"""
        from apps.tabsite.models import Site

        archived_site = MagicMock()
        archived_site.id = uuid.uuid4()
        archived_site.status = Site.Status.ARCHIVED
        archived_site.space_id = uuid.uuid4()

        svc = _make_service(has_permission=True)

        with patch("apps.tabsite.models.Site.objects") as mock_qs:
            mock_qs.all.return_value.get.return_value = archived_site
            result = svc._get_site(str(archived_site.id), "viewer")

        assert result == archived_site


class TestTS023SlugRetryLimit:
    """TS-023: slug 生成循环应有重试上限。"""

    def test_slug_generation_fails_after_max_retries(self):
        """slug 冲突超过上限时应抛出错误。"""
        svc = _make_service()

        with (
            patch("apps.tabsite.models.Site.objects") as mock_site_qs,
            patch("apps.tabsite.services.site_service._generate_slug", return_value="always-conflict"),
            patch("apps.tabsite.services.site_service.ResourceBridge"),
        ):
            mock_site_qs.filter.return_value.exists.return_value = True

            with pytest.raises(ServiceError) as exc_info:
                svc.create_site(
                    organization_id=str(uuid.uuid4()),
                    space_id=str(uuid.uuid4()),
                )

            assert exc_info.value.code == "SLUG_GENERATION_FAILED"
            assert exc_info.value.status == 500

    def test_slug_generation_succeeds_within_retries(self):
        """slug 冲突在上限内解决时应正常创建。"""
        svc = _make_service()
        call_count = [0]

        def _mock_exists():
            call_count[0] += 1
            return call_count[0] < 5

        with (
            patch("apps.tabsite.models.Site.objects") as mock_site_qs,
            patch("apps.tabsite.services.site_service._generate_slug", return_value="ok-slug"),
            patch("apps.tabsite.services.site_service.ResourceBridge"),
        ):
            mock_site_qs.filter.return_value.exists.side_effect = _mock_exists
            mock_site_qs.create.return_value = _make_mock_site()

            result = svc.create_site(
                organization_id=str(uuid.uuid4()),
                space_id=str(uuid.uuid4()),
            )
            assert result is not None


class TestTS010RollbackSetsStatus:
    """TS-010: rollback_to_version 必须将 status 设为 PUBLISHED。"""

    def test_rollback_sets_published_status(self):
        from apps.tabsite.models import Site

        site = MagicMock()
        site.id = uuid.uuid4()
        site.space_id = uuid.uuid4()
        site.organization_id = uuid.uuid4()
        site.status = Site.Status.DRAFT
        site.dist_oss_url = "https://cdn.example.com/old/"
        site.current_version = 2
        site.slug = "test"

        target_version = MagicMock()
        target_version.dist_url = "https://cdn.example.com/v1/"
        target_version.total_size = 1024
        target_version.is_current = False

        svc = _make_service()

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabsite.models.SiteVersion.objects") as mock_ver_qs,
            patch("apps.tabsite.services.site_service.ResourceBridge"),
            patch("apps.tabsite.services.site_service.transaction") as mock_tx,
        ):
            mock_ver_qs.get.return_value = target_version
            mock_ver_qs.filter.return_value.update = MagicMock()

            svc.rollback_to_version(str(site.id), 1)

        assert site.status == Site.Status.PUBLISHED
        save_kwargs = site.save.call_args
        assert "status" in save_kwargs.kwargs.get("update_fields", save_kwargs[1].get("update_fields", []))


class TestCC012RollbackEmptyDistUrl:
    """CC-012: 回滚到 dist_url 为空的版本应被拒绝。"""

    def test_rollback_rejects_empty_dist_url(self):
        from apps.tabsite.models import Site

        site = MagicMock()
        site.id = uuid.uuid4()
        site.space_id = uuid.uuid4()
        site.status = Site.Status.PUBLISHED
        site.dist_oss_url = "https://cdn.example.com/current/"
        site.current_version = 2

        empty_version = MagicMock()
        empty_version.dist_url = ""
        empty_version.total_size = 0

        svc = _make_service()

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabsite.models.SiteVersion.objects") as mock_ver_qs,
            patch("apps.tabsite.services.site_service.transaction"),
        ):
            mock_ver_qs.get.return_value = empty_version

            with pytest.raises(ServiceError) as exc_info:
                svc.rollback_to_version(str(site.id), 1)

            assert exc_info.value.status == 400
            assert "发布文件地址为空" in str(exc_info.value.message)


class TestCC007FileUsageMetadata:
    """CC-007: FileUsage 注册的 file_name 和 content_type 应反映真实内容。"""

    def test_register_uses_correct_file_name_and_content_type(self):
        svc = _make_service()

        site = _make_mock_site(slug="mysite", current_version=3)

        with patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file") as mock_reg:
            svc._do_register_site_dist_file_usage(
                site,
                dist_url="https://cdn.example.com/tabsite/sites/123/upload456/",
                total_size=2048,
                version_num=3,
            )

            mock_reg.assert_called_once()
            kwargs = mock_reg.call_args.kwargs
            assert kwargs["file_name"] == "site-mysite-v3-dist"
            assert kwargs["content_type"] == "application/x-site-dist"
            assert ".zip" not in kwargs["file_name"]
            assert "application/zip" != kwargs["content_type"]


class TestCC027ZeroSizeWarning:
    """CC-027: file_size=0 时应记录警告日志。"""

    def test_zero_size_logs_warning(self):
        svc = _make_service()
        site = _make_mock_site(slug="mysite")

        with (
            patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file"),
            patch("apps.tabsite.services.site_service.logger") as mock_logger,
        ):
            svc._do_register_site_dist_file_usage(
                site,
                dist_url="https://cdn.example.com/tabsite/sites/123/",
                total_size=0,
                version_num=1,
            )
            mock_logger.warning.assert_called()
            warning_msg = mock_logger.warning.call_args[0][0]
            assert "file_size=0" in warning_msg

    def test_nonzero_size_no_warning(self):
        svc = _make_service()
        site = _make_mock_site(slug="mysite")

        with (
            patch("apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file"),
            patch("apps.tabsite.services.site_service.logger") as mock_logger,
        ):
            svc._do_register_site_dist_file_usage(
                site,
                dist_url="https://cdn.example.com/tabsite/sites/123/",
                total_size=2048,
                version_num=1,
            )
            for c in mock_logger.warning.call_args_list:
                assert "file_size=0" not in c[0][0]


class TestTS009PostCommitDeactivateFailure:
    """TS-009: deactivate 失败时 _post_commit_sync_file_usages 应跳过 register。"""

    def test_deactivate_failure_skips_register(self):
        svc = _make_service()
        site = _make_mock_site()

        with (
            patch("apps.tabsite.models.Site.objects") as mock_site_qs,
            patch.object(svc, '_do_deactivate_site_dist_file_usages', side_effect=Exception("MySQL error")),
            patch.object(svc, '_do_register_site_dist_file_usage') as mock_register,
            patch("apps.tabsite.services.site_service.logger"),
        ):
            mock_site_qs.get.return_value = site

            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=2,
                new_dist_url="https://cdn.example.com/new/",
                total_size=1024,
                version_num=3,
            )

            mock_register.assert_not_called()

    def test_deactivate_success_proceeds_to_register(self):
        svc = _make_service()
        site = _make_mock_site()

        with (
            patch("apps.tabsite.models.Site.objects") as mock_site_qs,
            patch.object(svc, '_do_deactivate_site_dist_file_usages', return_value=1),
            patch.object(svc, '_do_register_site_dist_file_usage') as mock_register,
        ):
            mock_site_qs.get.return_value = site

            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=2,
                new_dist_url="https://cdn.example.com/new/",
                total_size=1024,
                version_num=3,
            )

            mock_register.assert_called_once()

    def test_no_old_dist_skips_deactivate(self):
        svc = _make_service()
        site = _make_mock_site()

        with (
            patch("apps.tabsite.models.Site.objects") as mock_site_qs,
            patch.object(svc, '_do_deactivate_site_dist_file_usages') as mock_deactivate,
            patch.object(svc, '_do_register_site_dist_file_usage') as mock_register,
        ):
            mock_site_qs.get.return_value = site

            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=None,
                new_dist_url="https://cdn.example.com/new/",
                total_size=1024,
                version_num=1,
            )

            mock_deactivate.assert_not_called()
            mock_register.assert_called_once()


class TestTS011CC006OnCommitPublish:
    """TS-011/CC-006: publish_site 的 FileUsage 操作应通过 on_commit 执行。"""

    def test_publish_uses_on_commit_for_file_usages(self):
        from apps.tabsite.models import Site

        site = MagicMock()
        site.id = uuid.uuid4()
        site.space_id = uuid.uuid4()
        site.organization_id = uuid.uuid4()
        site.status = Site.Status.DRAFT
        site.dist_oss_url = ""
        site.current_version = 0
        site.published_url = ""
        site.slug = "test"

        svc = _make_service()

        on_commit_callbacks = []

        with (
            patch.object(type(svc), '_get_site', return_value=site),
            patch("apps.tabsite.models.SiteVersion.objects") as mock_ver_qs,
            patch("apps.tabsite.services.site_service._validate_oss_dist_url"),
            patch("apps.tabsite.services.site_service.ResourceBridge"),
            patch("apps.tabsite.services.site_service.transaction") as mock_tx,
        ):
            mock_ver_qs.filter.return_value.update = MagicMock()
            mock_ver_qs.create.return_value = MagicMock(id=uuid.uuid4())

            def capture_on_commit(func, using=None):
                on_commit_callbacks.append(func)

            mock_tx.on_commit.side_effect = capture_on_commit
            mock_tx.atomic = MagicMock(return_value=lambda f: f)

            svc.publish_site(
                site_id=str(site.id),
                dist_url="https://cdn.example.com/tabsite/sites/123/",
                total_size=2048,
            )

            assert len(on_commit_callbacks) == 1
            mock_tx.on_commit.assert_called_once()


class TestCC019DnsCache:
    """CC-019: DNS 解析应有缓存，避免每次 publish 阻塞线程。"""

    def test_dns_result_is_cached(self):
        from apps.tabsite.services.site_service import _reject_dangerous_host, _dns_cache, _DNS_CACHE_TTL

        _dns_cache.clear()

        with patch("socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (2, 1, 6, '', ('1.2.3.4', 0)),
            ]

            _reject_dangerous_host("cdn.example.com")
            _reject_dangerous_host("cdn.example.com")
            _reject_dangerous_host("cdn.example.com")

            assert mock_dns.call_count == 1
            assert "cdn.example.com" in _dns_cache

        _dns_cache.clear()

    def test_dns_cache_expires(self):
        from apps.tabsite.services.site_service import _reject_dangerous_host, _dns_cache, _DNS_CACHE_TTL

        _dns_cache.clear()

        with patch("socket.getaddrinfo") as mock_dns:
            mock_dns.return_value = [
                (2, 1, 6, '', ('1.2.3.4', 0)),
            ]

            _reject_dangerous_host("expire-test.example.com")
            assert mock_dns.call_count == 1

            _dns_cache["expire-test.example.com"] = (
                _dns_cache["expire-test.example.com"][0],
                time.monotonic() - _DNS_CACHE_TTL - 1,
            )

            _reject_dangerous_host("expire-test.example.com")
            assert mock_dns.call_count == 2

        _dns_cache.clear()


class TestDoDeactivateStrictMode:
    """验证 _do_deactivate_site_dist_file_usages 严格模式：异常向上抛出。"""

    def test_raises_on_error(self):
        svc = _make_service()
        site = _make_mock_site()

        with patch(
            "apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage",
            side_effect=Exception("DB error"),
        ):
            with pytest.raises(Exception, match="DB error"):
                svc._do_deactivate_site_dist_file_usages(site)

    def test_silent_wrapper_does_not_raise(self):
        """_deactivate_site_dist_file_usages（静默版本）不应抛出异常。"""
        svc = _make_service()
        site = _make_mock_site()

        with (
            patch(
                "apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage",
                side_effect=Exception("DB error"),
            ),
            patch("apps.tabsite.services.site_service.logger"),
        ):
            svc._deactivate_site_dist_file_usages(site)
