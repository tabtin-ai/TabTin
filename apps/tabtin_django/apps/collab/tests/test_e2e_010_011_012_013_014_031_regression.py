"""
E2E-010 / E2E-011 / E2E-012 / E2E-013 / E2E-014 / E2E-031 回归测试

E2E-010: create_space_checkpoint 的 checkpoint 创建与 VH 保护在同一事务中
E2E-011: restore_space_checkpoint 预校验使用 get_resource_for_rollback（包含已删除资源）
E2E-012: restore_space_checkpoint 区分 RestoreError 类型（LOCK_CONTENTION→503，其他→500）
E2E-013: restore_space_checkpoint Redis 锁在 DB 事务外申请
E2E-014: create_space_checkpoint 非 UUID resource_id 记录警告日志而非静默跳过
E2E-031: restore_space_checkpoint 事务完成后立即主动释放所有 Redis 锁
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


def _make_request(user_id="u-test"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    req.auth.nickname = "tester"
    return req


def _make_body(space_id=None, name="test-cp", file_checkpoint_hash="", agent_run_id="", trigger="manual"):
    body = MagicMock()
    body.space_id = space_id or uuid.uuid4()
    body.name = name
    body.file_checkpoint_hash = file_checkpoint_hash
    body.agent_run_id = agent_run_id
    body.trigger = trigger
    return body


class FakeAtomic:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


# ══════════════════════════════════════════════════════════
# E2E-010: checkpoint 创建与 VH 保护在同一事务
# ══════════════════════════════════════════════════════════

class TestE2E010CheckpointAtomicWithVHProtection:
    """E2E-010: checkpoint 创建与 VH expired_at 更新必须在同一 DB 事务中。"""

    def test_checkpoint_and_vh_update_in_same_transaction(self):
        """checkpoint 创建与 VH update 在同一 transaction.atomic 块中。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        mock_space = MagicMock()
        mock_space.organization_id = organization_id

        operations = []

        class TrackingAtomic:
            def __enter__(self):
                operations.append("atomic_enter")
                return self

            def __exit__(self, *args):
                operations.append("atomic_exit")
                return False

        def fake_create(**kwargs):
            operations.append("checkpoint_create")
            cp = MagicMock()
            cp.id = uuid.uuid4()
            cp.name = kwargs.get("name", "")
            cp.created_at = MagicMock()
            cp.created_at.isoformat.return_value = "2026-01-01T00:00:00"
            return cp

        def fake_vh_update(**kwargs):
            operations.append("vh_update")
            return 1

        mock_cp_qs = MagicMock()
        mock_cp_qs.create.side_effect = fake_create

        with patch("django.db.transaction.atomic", return_value=TrackingAtomic()), \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_mgr, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr:

            mock_space_mgr.filter.return_value.only.return_value.first.return_value = mock_space
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_ci_mgr.using.return_value.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = [str(res_id)]
            mock_cp_mgr.using.return_value = mock_cp_qs
            mock_vh_mgr.using.return_value.filter.return_value.values.return_value.distinct.return_value = [
                {"resource_type": "slide", "resource_id": res_id}
            ]
            mock_vh_mgr.using.return_value.filter.return_value.order_by.return_value.values_list.return_value.first.return_value = vh_id
            mock_vh_mgr.using.return_value.filter.return_value.values_list.return_value = []
            mock_vh_mgr.using.return_value.filter.return_value.update.side_effect = fake_vh_update

            create_space_checkpoint(req, body)

        assert "atomic_enter" in operations, "checkpoint 创建应在 atomic 块内"
        assert "atomic_exit" in operations, "atomic 块应正常退出"

        if "checkpoint_create" in operations and "vh_update" in operations:
            enter_idx = operations.index("atomic_enter")
            create_idx = operations.index("checkpoint_create")
            update_idx = operations.index("vh_update")
            exit_idx = operations.index("atomic_exit")
            assert enter_idx < create_idx < exit_idx, "checkpoint_create 应在 atomic 块内"
            assert enter_idx < update_idx < exit_idx, "vh_update 应在 atomic 块内"

    def test_transaction_atomic_called_for_checkpoint_creation(self):
        """验证 create_space_checkpoint 调用 transaction.atomic。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        atomic_called = []

        class CountingAtomic:
            def __enter__(self):
                atomic_called.append(True)
                return self

            def __exit__(self, *args):
                return False

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.name = "test"
        mock_cp.created_at = MagicMock()
        mock_cp.created_at.isoformat.return_value = "2026-01-01T00:00:00"

        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()

        with patch("django.db.transaction.atomic", return_value=CountingAtomic()), \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_mgr, \
             patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr:

            mock_space_mgr.filter.return_value.only.return_value.first.return_value = MagicMock(organization_id=uuid.uuid4())
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_ci_mgr.using.return_value.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = [str(res_id)]
            mock_vh_mgr.using.return_value.filter.return_value.values.return_value.distinct.return_value = [
                {"resource_type": "slide", "resource_id": res_id}
            ]
            mock_vh_mgr.using.return_value.filter.return_value.order_by.return_value.values_list.return_value.first.return_value = vh_id
            mock_vh_mgr.using.return_value.filter.return_value.values_list.return_value = []
            mock_vh_mgr.using.return_value.filter.return_value.update.return_value = 1
            mock_cp_mgr.using.return_value.create.return_value = mock_cp

            create_space_checkpoint(req, body)

        assert len(atomic_called) > 0, "transaction.atomic 应被调用"


# ══════════════════════════════════════════════════════════
# E2E-011: restore 预校验使用 get_resource_for_rollback
# ══════════════════════════════════════════════════════════

class TestE2E011RestoreUsesGetResourceForRollback:
    """E2E-011: restore_space_checkpoint 预校验应使用 get_resource_for_rollback。"""

    def test_get_resource_for_rollback_called_not_get_resource(self):
        """restore_space_checkpoint 预校验应调用 get_resource_for_rollback，不调用 get_resource。"""
        from apps.collab.api import restore_space_checkpoint

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.space_id = uuid.uuid4()
        mock_cp.version_refs = {f"slide:{res_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = None
        mock_cp.agent_run_id = None

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = None
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True

        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        mock_svc_instance.restore_to_version_with_lock_held.return_value = MagicMock(id=uuid.uuid4())

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            restore_space_checkpoint(req, checkpoint_id)

        mock_adapter.get_resource_for_rollback.assert_called_once_with(str(res_id))
        mock_adapter.get_resource.assert_not_called()

    def test_deleted_resource_not_in_pre_errors(self):
        """资源被删除后（get_resource=None），get_resource_for_rollback 找到它，不应产生 pre_error。"""
        from apps.collab.api import restore_space_checkpoint

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = MagicMock()
        mock_cp.space_id = uuid.uuid4()
        mock_cp.version_refs = {f"slide:{res_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = None
        mock_cp.agent_run_id = None

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = None
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True

        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        mock_svc_instance.restore_to_version_with_lock_held.return_value = MagicMock(id=uuid.uuid4())

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            result = restore_space_checkpoint(req, checkpoint_id)

        # 成功时返回 dict（不是元组），失败时返回 (status_code, dict)
        if isinstance(result, tuple):
            status_code, resp = result
            assert status_code == 200, f"已删除资源应能通过 get_resource_for_rollback 恢复，实际状态: {status_code}, resp: {resp}"
        else:
            assert result.get("status") == "ok", f"已删除资源应能通过 get_resource_for_rollback 恢复，实际: {result}"


# ══════════════════════════════════════════════════════════
# E2E-012: RestoreError 类型区分（LOCK_CONTENTION→503）
# ══════════════════════════════════════════════════════════

class TestE2E012RestoreErrorTypeDistinction:
    """E2E-012: LOCK_CONTENTION 返回 503，其他 RestoreError 返回 500。"""

    def _make_checkpoint_mock(self, res_id, vh_id):
        mock_cp = MagicMock()
        mock_cp.space_id = uuid.uuid4()
        mock_cp.version_refs = {f"slide:{res_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = None
        mock_cp.agent_run_id = None
        return mock_cp

    def test_lock_contention_returns_503(self):
        """Redis 锁争用（LOCK_CONTENTION）应返回 503 而非 500。"""
        from apps.collab.api import restore_space_checkpoint
        from apps.collab.service import RestoreError

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.side_effect = RestoreError(
            RestoreError.LOCK_CONTENTION, "Concurrent restore blocked"
        )

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls:

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            status, data = restore_space_checkpoint(req, checkpoint_id)

        assert status == 503, f"LOCK_CONTENTION 应返回 503，实际返回 {status}"
        assert data["error_type"] == RestoreError.LOCK_CONTENTION
        assert data["status"] == "error"

    def test_rebuild_failed_returns_500(self):
        """REBUILD_FAILED 错误应返回 500（不可重试）。"""
        from apps.collab.api import restore_space_checkpoint
        from apps.collab.service import RestoreError

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        mock_svc_instance.restore_to_version_with_lock_held.side_effect = RestoreError(
            RestoreError.REBUILD_FAILED, "Failed to rebuild data"
        )

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            status, data = restore_space_checkpoint(req, checkpoint_id)

        assert status == 500, f"REBUILD_FAILED 应返回 500，实际返回 {status}"
        assert data.get("error_type") == RestoreError.REBUILD_FAILED

    def test_lock_contention_during_restore_returns_503(self):
        """恢复过程中（事务内）出现 LOCK_CONTENTION 也应返回 503。"""
        from apps.collab.api import restore_space_checkpoint
        from apps.collab.service import RestoreError

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        # 事务内恢复时出现锁争用
        mock_svc_instance.restore_to_version_with_lock_held.side_effect = RestoreError(
            RestoreError.LOCK_CONTENTION, "lock contention during restore"
        )

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            status, data = restore_space_checkpoint(req, checkpoint_id)

        assert status == 503, f"事务内 LOCK_CONTENTION 应返回 503，实际返回 {status}"


# ══════════════════════════════════════════════════════════
# E2E-013 + E2E-031: Redis 锁在 DB 事务外申请和释放
# ══════════════════════════════════════════════════════════

class TestE2E013RedisLockOutsideTransaction:
    """E2E-013: Redis 锁申请在 DB 事务外；E2E-031: 事务完成后立即释放锁。"""

    def _make_checkpoint_mock(self, res_id, vh_id):
        mock_cp = MagicMock()
        mock_cp.space_id = uuid.uuid4()
        mock_cp.version_refs = {f"slide:{res_id}": str(vh_id)}
        mock_cp.file_checkpoint_hash = None
        mock_cp.agent_run_id = None
        return mock_cp

    def test_lock_acquired_before_db_transaction(self):
        """acquire_restore_lock 应在 db_transaction.atomic 之前被调用。"""
        from apps.collab.api import restore_space_checkpoint

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        call_order = []

        mock_svc_instance = MagicMock()

        def fake_acquire(resource_id, version_id):
            call_order.append("acquire_lock")

        def fake_release(resource_id):
            call_order.append("release_lock")

        def fake_restore(*args, **kwargs):
            call_order.append("restore")
            return MagicMock(id=uuid.uuid4())

        mock_svc_instance.acquire_restore_lock.side_effect = fake_acquire
        mock_svc_instance.release_restore_lock.side_effect = fake_release
        mock_svc_instance.restore_to_version_with_lock_held.side_effect = fake_restore

        class TrackingAtomic:
            def __enter__(self):
                call_order.append("atomic_enter")
                return self

            def __exit__(self, *a):
                call_order.append("atomic_exit")
                return False

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=TrackingAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            restore_space_checkpoint(req, checkpoint_id)

        # 验证顺序：acquire_lock → atomic_enter → restore → atomic_exit → release_lock
        assert "acquire_lock" in call_order, "acquire_lock 应被调用"
        assert "atomic_enter" in call_order, "atomic_enter 应被调用"
        assert "release_lock" in call_order, "release_lock 应被调用（E2E-031）"

        acquire_idx = call_order.index("acquire_lock")
        atomic_idx = call_order.index("atomic_enter")
        release_idx = call_order.index("release_lock")
        atomic_exit_idx = call_order.index("atomic_exit")

        assert acquire_idx < atomic_idx, \
            f"acquire_lock（{acquire_idx}）应在 atomic_enter（{atomic_idx}）之前"
        assert atomic_exit_idx < release_idx, \
            f"release_lock（{release_idx}）应在 atomic_exit（{atomic_exit_idx}）之后（E2E-031）"

    def test_locks_released_even_when_transaction_fails(self):
        """事务回滚时，已申请的 Redis 锁仍应被主动释放（E2E-031）。"""
        from apps.collab.api import restore_space_checkpoint
        from apps.collab.service import RestoreError

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        mock_svc_instance.restore_to_version_with_lock_held.side_effect = RestoreError(
            RestoreError.REBUILD_FAILED, "rebuild failed"
        )

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            status, data = restore_space_checkpoint(req, checkpoint_id)

        # 即使事务失败，release_restore_lock 也应被调用
        mock_svc_instance.release_restore_lock.assert_called_once()
        assert status == 500

    def test_locks_released_on_success(self):
        """事务成功时，Redis 锁也应被主动释放（E2E-031）。"""
        from apps.collab.api import restore_space_checkpoint

        checkpoint_id = uuid.uuid4()
        res_id = uuid.uuid4()
        vh_id = uuid.uuid4()
        req = _make_request()

        mock_cp = self._make_checkpoint_mock(res_id, vh_id)
        mock_adapter = MagicMock()
        mock_adapter.get_resource_for_rollback.return_value = MagicMock()
        mock_adapter.check_permission.return_value = True
        mock_vh = MagicMock()
        mock_vh.id = vh_id

        mock_svc_instance = MagicMock()
        mock_svc_instance.acquire_restore_lock.return_value = None
        mock_svc_instance.release_restore_lock.return_value = None
        mock_svc_instance.restore_to_version_with_lock_held.return_value = MagicMock(id=uuid.uuid4())

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_cp_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("apps.collab.api.get_adapter_or_raise") as mock_get_adapter, \
             patch("apps.collab.api.VersionHistoryService") as mock_svc_cls, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_cp_mgr.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_vh_mgr.using.return_value.filter.return_value.__iter__ = lambda self: iter([mock_vh])
            mock_get_adapter.return_value = mock_adapter
            mock_svc_cls.return_value = mock_svc_instance

            result = restore_space_checkpoint(req, checkpoint_id)

        # 成功时也应释放锁
        mock_svc_instance.release_restore_lock.assert_called_once()
        # 成功时返回 dict（不是元组）
        if isinstance(result, tuple):
            status_code, _ = result
            assert status_code == 200
        else:
            assert result.get("status") == "ok"


# ══════════════════════════════════════════════════════════
# E2E-014: 非 UUID resource_id 记录警告日志
# ══════════════════════════════════════════════════════════

class TestE2E014NonUUIDResourceIdWarning:
    """E2E-014: 非 UUID resource_id 应记录警告日志，不静默跳过。"""

    def test_invalid_resource_id_logs_warning(self):
        """非 UUID resource_id 应触发 logger.warning。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        invalid_rid = "not-a-uuid"

        with patch("apps.collab.api.logger") as mock_logger, \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_mgr, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_space_mgr.filter.return_value.only.return_value.first.return_value = MagicMock(organization_id=uuid.uuid4())
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_ci_mgr.using.return_value.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = [invalid_rid]
            mock_vh_mgr.using.return_value.filter.return_value.values.return_value.distinct.return_value = []

            create_space_checkpoint(req, body)

        warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
        has_warning = any(
            "not-a-uuid" in c or "non-UUID" in c or "skipping" in c
            for c in warning_calls
        )
        assert has_warning, f"应记录非 UUID resource_id 的警告日志，实际调用: {warning_calls}"

    def test_valid_uuid_does_not_log_non_uuid_warning(self):
        """合法 UUID resource_id 不应触发非 UUID 警告日志。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        valid_rid = uuid.uuid4()
        body = _make_body(space_id=space_id)
        req = _make_request()

        with patch("apps.collab.api.logger") as mock_logger, \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_mgr, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_space_mgr.filter.return_value.only.return_value.first.return_value = MagicMock(organization_id=uuid.uuid4())
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_ci_mgr.using.return_value.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = [str(valid_rid)]
            mock_vh_mgr.using.return_value.filter.return_value.values.return_value.distinct.return_value = []

            create_space_checkpoint(req, body)

        warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
        non_uuid_warnings = [c for c in warning_calls if "non-UUID" in c or "skipping non-UUID" in c]
        assert len(non_uuid_warnings) == 0, \
            f"合法 UUID 不应触发非 UUID 警告，实际: {non_uuid_warnings}"

    def test_mixed_ids_warns_only_for_invalid(self):
        """混合 UUID 和非 UUID 时，只对非 UUID 记录警告。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        valid_rid = uuid.uuid4()
        invalid_rid = "bad-id-123"
        body = _make_body(space_id=space_id)
        req = _make_request()

        with patch("apps.collab.api.logger") as mock_logger, \
             patch("apps.tabtinspace.models.Space.objects") as mock_space_mgr, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_svc, \
             patch("apps.tabtinspace.models.ContextItem.objects") as mock_ci_mgr, \
             patch("apps.collab.models.VersionHistory.objects") as mock_vh_mgr, \
             patch("django.db.transaction.atomic", return_value=FakeAtomic()):

            mock_space_mgr.filter.return_value.only.return_value.first.return_value = MagicMock(organization_id=uuid.uuid4())
            mock_base_svc.return_value.check_space_permission.return_value = True
            mock_ci_mgr.using.return_value.filter.return_value.exclude.return_value.values_list.return_value.distinct.return_value = [
                str(valid_rid), invalid_rid
            ]
            mock_vh_mgr.using.return_value.filter.return_value.values.return_value.distinct.return_value = []

            create_space_checkpoint(req, body)

        warning_calls = [str(c) for c in mock_logger.warning.call_args_list]
        has_invalid_warning = any("bad-id-123" in c for c in warning_calls)
        assert has_invalid_warning, f"应记录 bad-id-123 的警告，实际: {warning_calls}"
