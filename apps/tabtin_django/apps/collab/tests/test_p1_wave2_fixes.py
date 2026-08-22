"""
P1 Wave-2 回归测试

#7  list_versions total 字段在 named_only=True 时计算错误
#9  create_named_version 丢失 organization_id
#11 restore_version 无并发安全（cache 锁）
#24 VideoCollabAdapter.restore() 不递增 latest_version
#29 Video.get_version_data() 读内存可能过期
"""
import os
import uuid
from unittest.mock import MagicMock, patch, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ══════════════════════════════════════════════════════════
# #7: list_versions total 字段 named_only 过滤
# ══════════════════════════════════════════════════════════

class TestCountVersionsNamedOnly:
    """count_versions 应根据 named_only 过滤返回正确的 total。"""

    def test_count_all_versions(self):
        from apps.collab.service import VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        mock_qs = MagicMock()
        mock_qs.count.return_value = 10

        with patch.object(svc, "_base_qs", return_value=mock_qs):
            total = svc.count_versions(uuid.uuid4(), named_only=False)

        assert total == 10
        mock_qs.filter.assert_not_called()

    def test_count_named_only(self):
        from apps.collab.service import VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        mock_qs = MagicMock()
        filtered_qs = MagicMock()
        filtered_qs.count.return_value = 3
        mock_qs.filter.return_value = filtered_qs

        with patch.object(svc, "_base_qs", return_value=mock_qs):
            total = svc.count_versions(uuid.uuid4(), named_only=True)

        assert total == 3
        mock_qs.filter.assert_called_once_with(is_named=True)

    def test_api_passes_named_only_to_count(self):
        """list_versions API 应将 named_only 传递给 count_versions。"""
        import inspect
        from apps.collab.api import list_versions

        source = inspect.getsource(list_versions)
        assert "named_only=named_only" in source, (
            "list_versions must pass named_only to count_versions"
        )

    def test_list_versions_orders_pinned_before_recent(self):
        """置顶版本应优先进入列表首屏，再按创建时间倒序。"""
        from apps.collab.service import VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        mock_qs = MagicMock()
        ordered_qs = MagicMock()
        ordered_qs.__getitem__.return_value = ["history"]
        mock_qs.order_by.return_value = ordered_qs

        with patch.object(svc, "_base_qs", return_value=mock_qs), \
             patch("apps.collab.service.serialize_history_list", return_value=[{"id": "vh"}]):
            versions = svc.list_versions(uuid.uuid4(), limit=50, offset=0)

        mock_qs.order_by.assert_called_once_with("-pinned", "-created_at")
        ordered_qs.__getitem__.assert_called_once_with(slice(0, 50, None))
        assert versions == [{"id": "vh"}]


# ══════════════════════════════════════════════════════════
# #9: create_named_version 传递 organization_id
# ══════════════════════════════════════════════════════════

class TestCreateNamedVersionOrganizationId:
    """create_named_version API 应从 resource 提取 organization_id 并传递给 service。"""

    def test_api_extracts_organization_id(self):
        import inspect
        from apps.collab.api import create_named_version

        source = inspect.getsource(create_named_version)
        assert "organization_id" in source, (
            "create_named_version must extract and pass organization_id"
        )

    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_organization_id_passed_to_service(self, mock_get_adapter, mock_svc_cls):
        from apps.collab.api import create_named_version

        organization_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        mock_adapter = MagicMock()
        mock_get_adapter.return_value = mock_adapter

        mock_resource = MagicMock()
        mock_resource.organization_id = organization_id
        mock_adapter.get_resource.return_value = mock_resource
        mock_adapter.check_permission.return_value = True
        mock_adapter.get_version_data.return_value = {"content": "test"}

        mock_svc = MagicMock()
        mock_vh = MagicMock()
        mock_vh.id = uuid.uuid4()
        mock_vh.name = "v1"
        mock_svc.create_named_version.return_value = mock_vh
        mock_svc_cls.return_value = mock_svc

        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = uuid.uuid4()
        req.auth.nickname = "tester"

        body = MagicMock()
        body.name = "v1"

        create_named_version(req, "docs", resource_id, body)

        call_kwargs = mock_svc.create_named_version.call_args
        assert call_kwargs[1]["organization_id"] == organization_id


# ══════════════════════════════════════════════════════════
# #11: restore_version 并发安全（cache 锁）
# ══════════════════════════════════════════════════════════

class TestRestoreVersionConcurrencyLock:
    """restore_to_version 应使用 cache 锁防止并发恢复。"""

    def test_restore_acquires_lock(self):
        """恢复操作应先获取缓存锁。"""
        from apps.collab.service import VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        resource_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with patch("apps.collab.service.VersionHistoryService._do_restore") as mock_do, \
             patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = True
            mock_do.return_value = MagicMock()

            svc.restore_to_version(
                resource_id, version_id,
                {"editor_type": "user", "editor_id": "u1"},
            )

            expected_key = f"collab:restore_lock:{adapter.resource_type}:{resource_id}"
            mock_cache.add.assert_called_once_with(
                expected_key, 1, svc.RESTORE_LOCK_TTL
            )
            mock_cache.delete.assert_called_once_with(expected_key)

    def test_concurrent_restore_blocked(self):
        """并发恢复同一资源时，第二个请求应被阻止并抛出 RestoreError(LOCK_CONTENTION)。"""
        from apps.collab.service import RestoreError, VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        resource_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = False

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(
                    resource_id, version_id,
                    {"editor_type": "user", "editor_id": "u1"},
                )

        assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION

    def test_lock_released_on_exception(self):
        """即使恢复过程抛出异常，锁也应被释放。

        restore_to_version 现在抛出 RestoreError，
        但 finally 块中的锁释放仍必须执行。
        """
        from apps.collab.service import RestoreError, VersionHistoryService
        from apps.collab.tests.test_service import MockAdapter

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        resource_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with patch("apps.collab.service.VersionHistoryService._do_restore") as mock_do, \
             patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = True
            mock_do.side_effect = RuntimeError("boom")

            with pytest.raises(RestoreError):
                svc.restore_to_version(
                    resource_id, version_id,
                    {"editor_type": "user", "editor_id": "u1"},
                )

            expected_key = f"collab:restore_lock:{adapter.resource_type}:{resource_id}"
            mock_cache.delete.assert_called_once_with(expected_key)


# ══════════════════════════════════════════════════════════
# #24: VideoCollabAdapter.restore() 递增 latest_version
# ══════════════════════════════════════════════════════════



# ══════════════════════════════════════════════════════════
# #29: Video.get_version_data() 刷新内存
# ══════════════════════════════════════════════════════════

