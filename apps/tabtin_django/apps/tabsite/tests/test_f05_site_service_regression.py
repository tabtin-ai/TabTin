"""
F05 回归测试：site_service.py 修复验证

覆盖问题:
  TC-004: _deactivate_old_token 失败时重新抛出，防止双活 Token
  TC-005: _check_token_valid 区分 DoesNotExist 与 DB 错误
  DVC-002: 消除双重 FileUsage 计费（deactivate upload-time 记录）
  DVC-003: Celery 补偿任务处理 on_commit 崩溃
  DVC-004: Celery 补偿任务处理 on_commit 内失败
  DVC-007: 版本化 context_id + add_usage 幂等
  DVC-008: 版本化 context_id 精确 deactivate
  DVC-009: add_usage 重激活确保回滚目标不被 OSS 孤儿清理
  DVC-022: 回滚乐观锁版本检查
"""
import os
import sys

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402
django.setup()

import uuid  # noqa: E402
from unittest.mock import patch, MagicMock, call  # noqa: E402

import pytest  # noqa: E402

from apps.tabtinspace.services.base import ServiceError  # noqa: E402
from apps.tabsite.services.site_service import SiteService  # noqa: E402

DEACTIVATE_FN = "apps.services.oss.services.deactivate_utils.deactivate_file_usages_and_release_storage"
REGISTER_FN = "apps.services.oss.services.file_registry.FileRegistryService.register_uploaded_file"
TOKEN_OBJECTS = "apps.tabdata.models_token.TableApiToken.objects"


# ── Fixtures ──

def _make_mock_user():
    user = MagicMock()
    user.id = uuid.uuid4()
    return user


def _make_mock_site(**overrides):
    defaults = {
        "id": uuid.uuid4(),
        "slug": "test-site",
        "name": "Test Site",
        "space_id": uuid.uuid4(),
        "organization_id": uuid.uuid4(),
        "tabdata_token_id": "",
        "tabdata_table_ids": [],
        "status": "draft",
        "dist_oss_url": "",
        "current_version": 0,
        "published_url": "",
    }
    defaults.update(overrides)
    site = MagicMock()
    for k, v in defaults.items():
        setattr(site, k, v)
    site.save = MagicMock()
    return site


def _make_service():
    svc = SiteService.__new__(SiteService)
    svc.user = _make_mock_user()
    svc.check_space_permission = MagicMock(return_value=True)
    return svc


# ── TC-005: _check_token_valid 区分 DoesNotExist 与 DB 错误 ──

class TestCheckTokenValid:
    def test_does_not_exist_returns_false(self):
        """TC-005: Token 不存在时返回 False（不抛异常）。"""
        from apps.tabdata.models_token import TableApiToken
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.side_effect = TableApiToken.DoesNotExist()
            mock_qs.using.return_value = mock_using
            result = SiteService._check_token_valid(str(uuid.uuid4()))
            assert result is False

    def test_db_error_raises(self):
        """TC-005: DB 不可达时重新抛出异常，不误判为 Token 无效。"""
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.side_effect = ConnectionError("DB unreachable")
            mock_qs.using.return_value = mock_using
            with pytest.raises(ConnectionError, match="DB unreachable"):
                SiteService._check_token_valid(str(uuid.uuid4()))

    def test_active_valid_token_returns_true(self):
        """TC-005: 活跃且未过期的 Token 返回 True。"""
        mock_token = MagicMock()
        mock_token.is_active = True
        mock_token.expired_at = None
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.return_value = mock_token
            mock_qs.using.return_value = mock_using
            assert SiteService._check_token_valid(str(uuid.uuid4())) is True


# ── TC-004: _deactivate_old_token 重新抛出异常 ──

class TestDeactivateOldToken:
    def test_does_not_exist_is_safe(self):
        """TC-004: Token 不存在时不抛异常（旧 Token 已清除）。"""
        from apps.tabdata.models_token import TableApiToken
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.side_effect = TableApiToken.DoesNotExist()
            mock_qs.using.return_value = mock_using
            SiteService._deactivate_old_token(str(uuid.uuid4()))

    def test_db_error_raises(self):
        """TC-004: deactivation 失败时重新抛出，防止双活 Token。"""
        mock_token = MagicMock()
        mock_token.is_active = True
        mock_token.cascade_deactivate.side_effect = RuntimeError("DB write failed")
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.return_value = mock_token
            mock_qs.using.return_value = mock_using
            with pytest.raises(RuntimeError, match="DB write failed"):
                SiteService._deactivate_old_token(str(uuid.uuid4()))

    def test_successful_deactivation(self):
        """TC-004: 正常撤销不抛异常。"""
        mock_token = MagicMock()
        mock_token.is_active = True
        with patch(TOKEN_OBJECTS) as mock_qs:
            mock_using = MagicMock()
            mock_using.get.return_value = mock_token
            mock_qs.using.return_value = mock_using
            SiteService._deactivate_old_token(str(uuid.uuid4()))
            mock_token.cascade_deactivate.assert_called_once()


# ── DVC-008: 版本化 context_id ──

class TestVersionedContextId:
    def test_format(self):
        """DVC-008: context_id 格式为 {site_id}:v{version_num}。"""
        site_id = str(uuid.uuid4())
        result = SiteService._versioned_context_id(site_id, 3)
        assert result == f"{site_id}:v3"

    def test_different_versions_differ(self):
        """DVC-008: 不同版本生成不同 context_id。"""
        site_id = str(uuid.uuid4())
        v1 = SiteService._versioned_context_id(site_id, 1)
        v2 = SiteService._versioned_context_id(site_id, 2)
        assert v1 != v2


# ── DVC-007/DVC-008: _do_register_site_dist_file_usage 使用版本化 context_id ──

class TestRegisterSiteDistFileUsage:
    def test_uses_versioned_context_id(self):
        """DVC-007/DVC-008: 注册时使用版本化 context_id。"""
        svc = _make_service()
        site = _make_mock_site()
        dist_url = "https://cdn.example.com/sites/abc/v2/dist/"

        with patch(REGISTER_FN) as mock_reg:
            svc._do_register_site_dist_file_usage(site, dist_url, 1024, 2)
            mock_reg.assert_called_once()
            kwargs = mock_reg.call_args.kwargs
            expected_ctx = f"{site.id}:v2"
            assert kwargs["context_id"] == expected_ctx
            assert kwargs["context_type"] == "site_dist"


# ── DVC-008: _do_deactivate_site_dist_file_usages 精确版本 deactivate ──

class TestDeactivateSiteDistFileUsages:
    def test_version_specific_deactivate(self):
        """DVC-008: 指定版本号时精确匹配版本化 context_id + 兼容旧格式。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch(DEACTIVATE_FN) as mock_deact:
            mock_deact.return_value = 1
            svc._do_deactivate_site_dist_file_usages(site, version_num=3)
            assert mock_deact.call_count == 2
            calls = mock_deact.call_args_list

            new_format_filter = calls[0].kwargs["context_filter"]
            assert new_format_filter["context_id"] == f"{site.id}:v3"

            old_format_filter = calls[1].kwargs["context_filter"]
            assert old_format_filter["context_id"] == str(site.id)

    def test_archive_deactivates_all_versions(self):
        """DVC-008: 归档（version_num=None）清理旧格式 + 所有版本化记录。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch(DEACTIVATE_FN) as mock_deact:
            mock_deact.return_value = 0
            svc._do_deactivate_site_dist_file_usages(site, version_num=None)
            assert mock_deact.call_count == 2

            old_filter = mock_deact.call_args_list[0].kwargs["context_filter"]
            assert old_filter["context_id"] == str(site.id)

            new_filter = mock_deact.call_args_list[1].kwargs["context_filter"]
            assert "context_id__startswith" in new_filter
            assert new_filter["context_id__startswith"] == f"{site.id}:v"


# ── DVC-002: _deactivate_upload_file_usages ──

class TestDeactivateUploadFileUsages:
    def test_deactivates_site_context_type(self):
        """DVC-002: 清理 confirm-upload 阶段的 FileUsage(context_type='site')。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch(DEACTIVATE_FN) as mock_deact:
            mock_deact.return_value = 3
            svc._deactivate_upload_file_usages(site)
            mock_deact.assert_called_once()
            ctx_filter = mock_deact.call_args.kwargs["context_filter"]
            assert ctx_filter["context_type"] == "site"
            assert ctx_filter["context_id"] == str(site.id)

    def test_failure_does_not_raise(self):
        """DVC-002: upload FileUsage 清理失败不阻断主流程。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch(DEACTIVATE_FN) as mock_deact:
            mock_deact.side_effect = RuntimeError("MySQL down")
            svc._deactivate_upload_file_usages(site)


# ── DVC-002: _post_commit_sync_file_usages 包含 upload deactivation ──

class TestPostCommitSyncFileUsages:
    def test_calls_deactivate_upload_file_usages(self):
        """DVC-002: post-commit 同步时先清理 upload-time FileUsage。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch.object(SiteService, '_deactivate_upload_file_usages') as mock_upload_deact, \
             patch.object(SiteService, '_do_deactivate_site_dist_file_usages'), \
             patch.object(SiteService, '_do_register_site_dist_file_usage'), \
             patch("apps.tabsite.services.site_service.Site") as mock_site_cls:
            mock_site_cls.objects.get.return_value = site
            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=None,
                new_dist_url="https://cdn.example.com/dist/",
                total_size=1024,
                version_num=1,
            )
            mock_upload_deact.assert_called_once_with(site)

    def test_schedules_compensation_on_deactivate_failure(self):
        """DVC-004: deactivate 失败时调度 Celery 补偿任务。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch.object(SiteService, '_deactivate_upload_file_usages'), \
             patch.object(SiteService, '_do_deactivate_site_dist_file_usages',
                          side_effect=RuntimeError("MySQL down")), \
             patch.object(SiteService, '_schedule_file_usage_compensation') as mock_sched, \
             patch("apps.tabsite.services.site_service.Site") as mock_site_cls:
            mock_site_cls.objects.get.return_value = site
            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=2,
                new_dist_url="https://cdn.example.com/dist/",
                total_size=1024,
                version_num=3,
            )
            mock_sched.assert_called_once()

    def test_schedules_compensation_on_register_failure(self):
        """DVC-004: register 失败时调度 Celery 补偿任务。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch.object(SiteService, '_deactivate_upload_file_usages'), \
             patch.object(SiteService, '_do_register_site_dist_file_usage',
                          side_effect=RuntimeError("MySQL down")), \
             patch.object(SiteService, '_schedule_file_usage_compensation') as mock_sched, \
             patch("apps.tabsite.services.site_service.Site") as mock_site_cls:
            mock_site_cls.objects.get.return_value = site
            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=None,
                new_dist_url="https://cdn.example.com/dist/",
                total_size=1024,
                version_num=1,
            )
            mock_sched.assert_called_once()

    def test_old_version_num_passed_to_deactivate(self):
        """DVC-008: post-commit 将 old_version_num 传递给精确 deactivate。"""
        svc = _make_service()
        site = _make_mock_site()

        with patch.object(SiteService, '_deactivate_upload_file_usages'), \
             patch.object(SiteService, '_do_deactivate_site_dist_file_usages') as mock_deact, \
             patch.object(SiteService, '_do_register_site_dist_file_usage'), \
             patch("apps.tabsite.services.site_service.Site") as mock_site_cls:
            mock_site_cls.objects.get.return_value = site
            svc._post_commit_sync_file_usages(
                site_id=str(site.id),
                old_version_num=5,
                new_dist_url="https://cdn.example.com/dist/",
                total_size=1024,
                version_num=6,
            )
            mock_deact.assert_called_once_with(site, version_num=5)


# ── DVC-022: 回滚乐观锁 ──

class TestRollbackOptimisticLock:
    def test_version_conflict_raises_409(self):
        """DVC-022: 并发回滚时当前版本不匹配则返回 409 冲突。"""
        svc = _make_service()
        site = _make_mock_site(current_version=3, dist_oss_url="https://cdn.example.com/dist/")

        with patch.object(svc, '_get_site', return_value=site):
            with pytest.raises(ServiceError) as exc_info:
                svc.rollback_to_version(
                    str(site.id), 1,
                    expected_current_version=2,
                )
            assert exc_info.value.status == 409

    def test_version_match_proceeds(self):
        """DVC-022: 版本匹配时正常回滚。"""
        svc = _make_service()
        site = _make_mock_site(current_version=3, dist_oss_url="https://cdn.example.com/v3/dist/")

        mock_version = MagicMock()
        mock_version.dist_url = "https://cdn.example.com/v1/dist/"
        mock_version.total_size = 512
        mock_version.version = 1

        with patch.object(svc, '_get_site', return_value=site), \
             patch("apps.tabsite.services.site_service.SiteVersion") as mock_sv_cls, \
             patch("apps.tabsite.services.site_service.transaction") as mock_tx, \
             patch("apps.tabsite.services.site_service.ResourceBridge"):
            mock_sv_cls.objects.get.return_value = mock_version
            mock_sv_cls.objects.filter.return_value.update = MagicMock()

            result = svc.rollback_to_version(
                str(site.id), 1,
                expected_current_version=3,
            )
            assert result.current_version == 1

    def test_no_expected_version_always_proceeds(self):
        """DVC-022: expected_current_version 不传时不做检查。"""
        svc = _make_service()
        site = _make_mock_site(current_version=5, dist_oss_url="https://cdn.example.com/v5/")

        mock_version = MagicMock()
        mock_version.dist_url = "https://cdn.example.com/v2/"
        mock_version.total_size = 256

        with patch.object(svc, '_get_site', return_value=site), \
             patch("apps.tabsite.services.site_service.SiteVersion") as mock_sv_cls, \
             patch("apps.tabsite.services.site_service.transaction") as mock_tx, \
             patch("apps.tabsite.services.site_service.ResourceBridge"):
            mock_sv_cls.objects.get.return_value = mock_version
            mock_sv_cls.objects.filter.return_value.update = MagicMock()

            result = svc.rollback_to_version(str(site.id), 2)
            assert result.current_version == 2


# ── DVC-003: Celery 补偿任务 ──

class TestCompensateTask:
    def test_task_exists_and_importable(self):
        """DVC-003: 补偿任务可正常导入。"""
        from apps.tabsite.tasks import compensate_file_usage_sync
        assert compensate_file_usage_sync is not None

    def test_reconcile_task_exists(self):
        """DVC-003: 周期性协调任务可正常导入。"""
        from apps.tabsite.tasks import reconcile_site_file_usages
        assert reconcile_site_file_usages is not None

    def test_beat_schedule_defined(self):
        """DVC-003: Beat 调度配置已定义。"""
        from apps.tabsite.tasks import TABSITE_BEAT_SCHEDULE
        assert "tabsite-reconcile-file-usages" in TABSITE_BEAT_SCHEDULE
