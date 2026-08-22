"""
CC-007 / CC-008 / CC-009 / CC-017 / CC-021 回归测试

CC-007: RESTORE_LOCK_TTL 从 30s 提升到 120s，防止大资源恢复锁超时
CC-008: create_history 在 restore 进行中时跳过，防止断链 diff
CC-009: cleanup_expired_versions 使用 Exists 子查询替代 referenced_ids 集合
CC-017: cleanup 和 downsample 使用独立锁 key，不再互斥
CC-021: Redis 不可用时 cache.add 异常处理，防止并发兄弟 diff
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import MagicMock, patch, PropertyMock  # noqa: E402

import pytest  # noqa: E402

from apps.collab.service import (  # noqa: E402
    RestoreError,
    VersionHistoryService,
    CREATE_HISTORY_LOCK_TTL,
)
from apps.collab.tasks import (  # noqa: E402
    CLEANUP_LOCK_KEY,
    DOWNSAMPLE_LOCK_KEY,
    MAINTENANCE_LOCK_KEY,
    MAINTENANCE_LOCK_TTL,
    cleanup_expired_versions,
    downsample_versions,
)
from apps.collab.tests.test_version_history_service import MockAdapter, _editor  # noqa: E402


# ══════════════════════════════════════════════════════════
# CC-007: RESTORE_LOCK_TTL 提升到 120s
# ══════════════════════════════════════════════════════════


class TestCC007RestoreLockTTL:
    """RESTORE_LOCK_TTL 应为 120s，足够覆盖大资源恢复耗时。"""

    def test_restore_lock_ttl_is_120(self):
        assert VersionHistoryService.RESTORE_LOCK_TTL == 120

    def test_restore_lock_ttl_gte_create_history_lock_ttl(self):
        """RESTORE_LOCK_TTL 不应小于 CREATE_HISTORY_LOCK_TTL。"""
        assert VersionHistoryService.RESTORE_LOCK_TTL >= CREATE_HISTORY_LOCK_TTL

    def test_restore_acquires_lock_with_correct_ttl(self):
        """restore_to_version 应使用 RESTORE_LOCK_TTL(120s) 获取锁。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = False
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, vid, _editor())
            assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION
            mock_cache.add.assert_called_once_with(
                f"collab:restore_lock:test:{rid}",
                1,
                120,
            )


# ══════════════════════════════════════════════════════════
# CC-008: create_history 在 restore 进行中时跳过
# ══════════════════════════════════════════════════════════


class TestCC008RestoreBlocksCreateHistory:
    """restore 持锁期间 create_history 应返回 None，防止断链 diff。"""

    def test_create_history_skips_when_restore_in_progress(self):
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.return_value = 1  # restore lock 值为 1（与 cache.add 写入一致）
            result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is None
        mock_cache.get.assert_called_once_with(
            f"collab:restore_lock:test:{rid}",
        )

    def test_create_history_not_blocked_by_non_restore_cache_value(self):
        """cache.get 返回非 1 值时不应阻塞 create_history。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.return_value = "some_other_value"
            mock_cache.add.return_value = True
            with patch.object(svc, "_do_create_history", return_value=MagicMock()):
                result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is not None

    def test_create_history_proceeds_when_no_restore(self):
        """无 restore 进行时 create_history 正常获取锁。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.return_value = None  # 无 restore
            mock_cache.add.return_value = True  # 成功获取 create lock
            with patch.object(svc, "_do_create_history", return_value=MagicMock()) as mock_do:
                result = svc.create_history(rid, {"a": 1}, _editor())

            assert result is not None
            mock_cache.get.assert_called_once()
            mock_cache.add.assert_called_once()

    def test_restore_lock_check_redis_failure_is_benign(self):
        """restore lock 检查的 Redis 异常不应阻塞 create_history。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.side_effect = ConnectionError("Redis down")
            mock_cache.add.return_value = True
            with patch.object(svc, "_do_create_history", return_value=MagicMock()):
                result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is not None


# ══════════════════════════════════════════════════════════
# CC-009: cleanup_expired_versions 使用 Exists 子查询
# ══════════════════════════════════════════════════════════


class TestCC009CleanupExistsSubquery:
    """cleanup_expired_versions 应使用 Exists 子查询而非 Python set。"""

    def test_cleanup_uses_exists_not_base_class(self):
        """确认 cleanup_expired_versions 不再直接调用基类 cleanup_expired。"""
        import inspect

        source = inspect.getsource(VersionHistoryService.cleanup_expired_versions)
        assert "Exists" in source, (
            "cleanup_expired_versions 应使用 Exists 子查询"
        )
        assert "self.cleanup_expired(VersionHistory)" not in source, (
            "cleanup_expired_versions 不应委托给基类 cleanup_expired"
        )

    def test_cleanup_method_uses_select_for_update(self):
        """确认 cleanup 使用 select_for_update 行锁保护。"""
        import inspect

        source = inspect.getsource(VersionHistoryService.cleanup_expired_versions)
        assert "select_for_update" in source

    def test_cleanup_method_uses_transaction_atomic(self):
        """确认 cleanup 在事务内执行。"""
        import inspect

        source = inspect.getsource(VersionHistoryService.cleanup_expired_versions)
        assert "transaction.atomic" in source


# ══════════════════════════════════════════════════════════
# CC-017: cleanup 和 downsample 使用独立锁 key
# ══════════════════════════════════════════════════════════


class TestCC017IndependentLockKeys:
    """cleanup 和 downsample 应使用独立锁 key，不再互斥。"""

    def test_lock_keys_are_different(self):
        assert CLEANUP_LOCK_KEY != DOWNSAMPLE_LOCK_KEY

    def test_cleanup_lock_key_value(self):
        assert CLEANUP_LOCK_KEY == "collab:cleanup_lock"

    def test_downsample_lock_key_value(self):
        assert DOWNSAMPLE_LOCK_KEY == "collab:downsample_lock"

    def test_maintenance_lock_key_still_exported(self):
        """向后兼容：MAINTENANCE_LOCK_KEY 仍然可以被导入。"""
        assert MAINTENANCE_LOCK_KEY == "collab:maintenance_lock"

    def test_cleanup_uses_cleanup_lock(self):
        """cleanup_expired_versions 任务应使用 CLEANUP_LOCK_KEY。"""
        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False
            cleanup_expired_versions()
            mock_cache.add.assert_called_once_with(
                CLEANUP_LOCK_KEY, "cleanup", MAINTENANCE_LOCK_TTL,
            )

    def test_downsample_uses_downsample_lock(self):
        """downsample_versions 任务应使用 DOWNSAMPLE_LOCK_KEY。"""
        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False
            downsample_versions()
            mock_cache.add.assert_called_once_with(
                DOWNSAMPLE_LOCK_KEY, "downsample", MAINTENANCE_LOCK_TTL,
            )

    def test_cleanup_and_downsample_can_run_concurrently(self):
        """cleanup 获锁不阻止 downsample 获锁。"""
        lock_state = {}

        def mock_add(key, value, ttl):
            if key in lock_state:
                return False
            lock_state[key] = value
            return True

        def mock_delete(key):
            lock_state.pop(key, None)

        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.side_effect = mock_add
            mock_cache.delete.side_effect = mock_delete

            with patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
                mock_instance = MagicMock()
                mock_instance.cleanup_expired_versions.return_value = 0
                mock_instance.downsample_versions.return_value = 0
                MockSvc.return_value = mock_instance

                # cleanup 先获锁
                lock_state.clear()
                lock_state[CLEANUP_LOCK_KEY] = "cleanup"

                # downsample 应仍然能获锁
                result = downsample_versions()
                assert result == 0
                assert DOWNSAMPLE_LOCK_KEY not in lock_state  # finally 已释放


# ══════════════════════════════════════════════════════════
# CC-021: Redis 不可用时的安全降级
# ══════════════════════════════════════════════════════════


class TestCC021RedisUnavailableHandling:
    """Redis 不可用时 create_history 和 restore_to_version 应安全降级。"""

    def test_create_history_returns_none_on_redis_error(self):
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.return_value = None  # restore check passes
            mock_cache.add.side_effect = ConnectionError("Redis down")
            result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is None

    def test_restore_raises_on_redis_error(self):
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.side_effect = ConnectionError("Redis down")
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, vid, _editor())
            assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION

    def test_create_history_cache_delete_failure_does_not_crash(self):
        """cache.delete 失败不应导致异常泄漏。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.get.return_value = None
            mock_cache.add.return_value = True
            mock_cache.delete.side_effect = ConnectionError("Redis down")
            with patch.object(svc, "_do_create_history", return_value=MagicMock()):
                result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is not None

    def test_restore_cache_delete_failure_does_not_crash(self):
        """restore 的 cache.delete 失败不应导致异常泄漏。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = True
            mock_cache.delete.side_effect = ConnectionError("Redis down")
            with patch.object(svc, "_do_restore", return_value=MagicMock()):
                result = svc.restore_to_version(rid, vid, _editor())

        assert result is not None
