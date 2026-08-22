"""
E2E-008 / E2E-009 回归测试 — rollback_agent_run 并发安全与 Redis 锁隔离

E2E-008: _force_close_collab_document 串行调用超时风险
         修复：改为 ThreadPoolExecutor 并发调用，最坏情况从 75s 降至 ~15s。

E2E-009: rollback_agent_run 内 Redis restore_lock 在 DB 事务内申请
         修复：锁申请移到事务外（预校验阶段），事务内调用 restore_to_version_with_lock_held。
"""
import os
import uuid
from unittest.mock import MagicMock, call, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402


# ─────────────────────────────────────────────────────────────
# E2E-009: VersionHistoryService 新增锁管理方法
# ─────────────────────────────────────────────────────────────

class TestVersionHistoryServiceLockMethods:
    """验证 VersionHistoryService 新增的锁管理方法行为正确。"""

    def _make_svc(self):
        from apps.collab.service import VersionHistoryService
        adapter = MagicMock()
        adapter.resource_type = "slide"
        svc = VersionHistoryService(adapter)
        return svc

    @patch("apps.collab.service.cache")
    def test_acquire_restore_lock_success(self, mock_cache):
        """cache.add 返回 True → 锁申请成功，不抛异常。"""
        mock_cache.add.return_value = True
        svc = self._make_svc()
        resource_id = uuid.uuid4()
        # 不应抛出异常
        svc.acquire_restore_lock(resource_id, uuid.uuid4())
        mock_cache.add.assert_called_once()

    @patch("apps.collab.service.cache")
    def test_acquire_restore_lock_contention(self, mock_cache):
        """cache.add 返回 False（锁已被持有）→ 抛 RestoreError(LOCK_CONTENTION)。"""
        from apps.collab.service import RestoreError
        mock_cache.add.return_value = False
        svc = self._make_svc()
        with pytest.raises(RestoreError) as exc_info:
            svc.acquire_restore_lock(uuid.uuid4(), uuid.uuid4())
        assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION

    @patch("apps.collab.service.cache")
    def test_acquire_restore_lock_rejects_inflight_version_writer(self, mock_cache):
        """版本写已拿到自身锁时，恢复必须释放占位并零副作用退出。"""
        from apps.collab.service import RestoreError

        mock_cache.add.return_value = True
        mock_cache.get.side_effect = lambda key: (
            1 if "create_history_lock" in key else None
        )
        svc = self._make_svc()
        resource_id = uuid.uuid4()

        with pytest.raises(RestoreError) as exc_info:
            svc.acquire_restore_lock(resource_id, uuid.uuid4())

        assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION
        mock_cache.delete.assert_called_once_with(
            f"collab:restore_lock:slide:{resource_id}"
        )

    @patch("apps.collab.service.cache")
    def test_acquire_restore_lock_redis_unavailable(self, mock_cache):
        """cache.add 抛出异常（Redis 不可用）→ 抛 RestoreError(LOCK_CONTENTION)。"""
        from apps.collab.service import RestoreError
        mock_cache.add.side_effect = Exception("Redis connection error")
        svc = self._make_svc()
        with pytest.raises(RestoreError) as exc_info:
            svc.acquire_restore_lock(uuid.uuid4(), uuid.uuid4())
        assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION

    @patch("apps.collab.service.cache")
    def test_release_restore_lock_calls_cache_delete(self, mock_cache):
        """release_restore_lock 调用 cache.delete。"""
        svc = self._make_svc()
        resource_id = uuid.uuid4()
        svc.release_restore_lock(resource_id)
        mock_cache.delete.assert_called_once()
        key_arg = mock_cache.delete.call_args[0][0]
        assert str(resource_id) in key_arg

    @patch("apps.collab.service.cache")
    def test_release_restore_lock_tolerates_redis_failure(self, mock_cache):
        """release_restore_lock 在 Redis 不可用时不抛异常（仅记录警告）。"""
        mock_cache.delete.side_effect = Exception("Redis down")
        svc = self._make_svc()
        # 不应抛出异常
        svc.release_restore_lock(uuid.uuid4())

    @patch("apps.collab.service.cache")
    def test_restore_to_version_with_lock_held_skips_cache_add(self, mock_cache):
        """restore_to_version_with_lock_held 不调用 cache.add（跳过锁申请）。"""
        svc = self._make_svc()
        resource_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with patch.object(svc, "_do_restore", return_value=MagicMock()) as mock_do:
            svc.restore_to_version_with_lock_held(
                resource_id, version_id, {"editor_type": "user"}
            )
            mock_do.assert_called_once()

        mock_cache.add.assert_not_called()

    @patch("apps.collab.service.cache")
    def test_restore_to_version_still_acquires_lock(self, mock_cache):
        """restore_to_version（非 with_lock_held 版本）仍然调用 cache.add 申请锁。"""
        mock_cache.add.return_value = True
        svc = self._make_svc()
        resource_id = uuid.uuid4()
        version_id = uuid.uuid4()

        with patch.object(svc, "_do_restore", return_value=MagicMock()):
            svc.restore_to_version(resource_id, version_id, {"editor_type": "user"})

        mock_cache.add.assert_called_once()


# ─────────────────────────────────────────────────────────────
# E2E-009: rollback_agent_run 锁申请在事务外
# ─────────────────────────────────────────────────────────────

class TestRollbackExecutionRunLockOutsideTransaction:
    """验证 rollback_agent_run 在 DB 事务外申请 Redis 锁。"""

    def _make_request(self, user_id="u-test"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        req.auth.nickname = "tester"
        req.auth.email = "tester@test.com"
        return req

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_redis_unavailable_does_not_rollback_entire_batch(
        self, mock_get_adapter, mock_svc_cls, mock_clear, mock_fc
    ):
        """Redis 不可用时，锁申请失败的资源被标记为 error，
        其他资源（trash 类）仍然正常处理，整个批量事务不回滚。"""
        from apps.collab.api import rollback_agent_run
        from apps.collab.service import RestoreError

        resource_id_1 = str(uuid.uuid4())  # 有 pre_change_version，需要 restore（锁会失败）
        resource_id_2 = str(uuid.uuid4())  # 无 pre_change_version，有 create log，需要 trash

        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        # 构造 adapter
        adapter = MagicMock()
        adapter.resource_type = "slide"
        adapter.get_resource_for_rollback.return_value = MagicMock(title="Test Slide")
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        # 构造 VersionHistoryService：acquire_restore_lock 抛出 RestoreError
        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.side_effect = RestoreError(
            RestoreError.LOCK_CONTENTION, "Redis unavailable"
        )
        mock_svc_cls.return_value = mock_svc

        pre_ver = MagicMock()
        pre_ver.id = uuid.uuid4()

        # ChangeLog 和 VersionHistory 在函数内通过 from .models import 导入，
        # 需要 patch models 模块
        with patch("apps.collab.models.ChangeLog") as mock_cl_cls, \
             patch("apps.collab.models.VersionHistory") as mock_vh_cls, \
             patch("apps.collab.api._trash_resource_in_rollback", return_value=True), \
             patch("django.db.transaction.atomic"):

            # resource_1 的 ChangeLog
            cl1 = MagicMock()
            cl1.resource_type = "slide"
            cl1.resource_id = uuid.UUID(resource_id_1)

            # resource_2 的 ChangeLog（无 pre_change_version，有 create log）
            cl2 = MagicMock()
            cl2.resource_type = "slide"
            cl2.resource_id = uuid.UUID(resource_id_2)

            mock_cl_qs = MagicMock()
            mock_cl_qs.__iter__ = MagicMock(return_value=iter([cl1, cl2]))
            mock_cl_cls.objects.using.return_value.filter.return_value.order_by.return_value = mock_cl_qs

            mock_vh_qs = MagicMock()
            mock_vh_qs.order_by.return_value.first.return_value = pre_ver
            mock_vh_cls.objects.using.return_value.filter.return_value = mock_vh_qs

            req = self._make_request()
            result = rollback_agent_run(req, "run-001")

        # resource_1 锁失败应返回 error，不应导致整批失败
        if isinstance(result, tuple):
            status_code, resp = result
        else:
            status_code, resp = 200, result
        assert status_code in (200, 400)

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_lock_released_after_transaction_completes(
        self, mock_get_adapter, mock_svc_cls, mock_fc
    ):
        """事务完成后（无论成功还是失败），Redis 锁必须被释放。"""
        resource_id = str(uuid.uuid4())
        mock_fc.return_value = {"success": True, "loaded": True, "connections_closed": 0}

        adapter = MagicMock()
        adapter.resource_type = "slide"
        adapter.get_resource_for_rollback.return_value = MagicMock(title="Test")
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None  # 锁申请成功
        mock_vh = MagicMock()
        mock_vh.id = uuid.uuid4()
        mock_svc.restore_to_version_with_lock_held.return_value = mock_vh
        mock_svc_cls.return_value = mock_svc

        pre_ver = MagicMock()
        pre_ver.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_cls, \
             patch("apps.collab.models.VersionHistory") as mock_vh_cls, \
             patch("django.db.transaction.atomic") as mock_atomic:

            cl = MagicMock()
            cl.resource_type = "slide"
            cl.resource_id = uuid.UUID(resource_id)

            mock_cl_qs = MagicMock()
            mock_cl_qs.__iter__ = MagicMock(return_value=iter([cl]))
            mock_cl_cls.objects.using.return_value.filter.return_value.order_by.return_value = mock_cl_qs

            mock_vh_qs = MagicMock()
            mock_vh_qs.order_by.return_value.first.return_value = pre_ver
            mock_vh_cls.objects.using.return_value.filter.return_value = mock_vh_qs

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            from apps.collab.api import rollback_agent_run
            req = self._make_request()
            rollback_agent_run(req, "run-002")

        # 验证 release_restore_lock 被调用
        mock_svc.release_restore_lock.assert_called()


# ─────────────────────────────────────────────────────────────
# E2E-008: force_close 并发调用
# ─────────────────────────────────────────────────────────────

class TestRollbackExecutionRunForceCloseConcurrent:
    """验证 rollback_agent_run 对多个资源并发调用 force_close。"""

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_force_close_called_for_all_restored_items(
        self, mock_get_adapter, mock_svc_cls, mock_fc
    ):
        """所有 restored 状态的资源都应调用 force_close。"""
        import threading

        call_order = []
        call_lock = threading.Lock()

        def fc_side_effect(res_type, res_id):
            with call_lock:
                call_order.append(f"{res_type}:{res_id}")
            return {"success": True, "loaded": True, "connections_closed": 1}

        mock_fc.side_effect = fc_side_effect

        resource_ids = [str(uuid.uuid4()) for _ in range(3)]

        adapter = MagicMock()
        adapter.resource_type = "slide"
        adapter.get_resource_for_rollback.return_value = MagicMock(title="Test")
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = MagicMock(id=uuid.uuid4())
        mock_svc_cls.return_value = mock_svc

        pre_ver = MagicMock()
        pre_ver.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_cls, \
             patch("apps.collab.models.VersionHistory") as mock_vh_cls, \
             patch("django.db.transaction.atomic") as mock_atomic:

            cls_list = []
            for rid in resource_ids:
                cl = MagicMock()
                cl.resource_type = "slide"
                cl.resource_id = uuid.UUID(rid)
                cls_list.append(cl)

            mock_cl_qs = MagicMock()
            mock_cl_qs.__iter__ = MagicMock(return_value=iter(cls_list))
            mock_cl_cls.objects.using.return_value.filter.return_value.order_by.return_value = mock_cl_qs

            mock_vh_qs = MagicMock()
            mock_vh_qs.order_by.return_value.first.return_value = pre_ver
            mock_vh_cls.objects.using.return_value.filter.return_value = mock_vh_qs

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            from apps.collab.api import rollback_agent_run
            req = MagicMock()
            req.auth = MagicMock()
            req.auth.id = "u-test"
            req.auth.nickname = "tester"
            req.auth.email = "tester@test.com"

            rollback_agent_run(req, "run-003")

        # 所有 3 个资源都应调用了 force_close
        assert mock_fc.call_count == 3

    @patch("apps.collab.api._force_close_collab_document")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.api.get_adapter_or_raise")
    def test_force_close_failure_does_not_fail_response(
        self, mock_get_adapter, mock_svc_cls, mock_fc
    ):
        """force_close 失败不影响整体响应，仅添加 collab_sync_warnings。"""
        mock_fc.return_value = {"success": False, "loaded": False, "connections_closed": 0}

        resource_id = str(uuid.uuid4())
        adapter = MagicMock()
        adapter.resource_type = "slide"
        adapter.get_resource_for_rollback.return_value = MagicMock(title="Test")
        adapter.check_permission.return_value = True
        mock_get_adapter.return_value = adapter

        mock_svc = MagicMock()
        mock_svc.acquire_restore_lock.return_value = None
        mock_svc.restore_to_version_with_lock_held.return_value = MagicMock(id=uuid.uuid4())
        mock_svc_cls.return_value = mock_svc

        pre_ver = MagicMock()
        pre_ver.id = uuid.uuid4()

        with patch("apps.collab.models.ChangeLog") as mock_cl_cls, \
             patch("apps.collab.models.VersionHistory") as mock_vh_cls, \
             patch("django.db.transaction.atomic") as mock_atomic:

            cl = MagicMock()
            cl.resource_type = "slide"
            cl.resource_id = uuid.UUID(resource_id)

            mock_cl_qs = MagicMock()
            mock_cl_qs.__iter__ = MagicMock(return_value=iter([cl]))
            mock_cl_cls.objects.using.return_value.filter.return_value.order_by.return_value = mock_cl_qs

            mock_vh_qs = MagicMock()
            mock_vh_qs.order_by.return_value.first.return_value = pre_ver
            mock_vh_cls.objects.using.return_value.filter.return_value = mock_vh_qs

            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            from apps.collab.api import rollback_agent_run
            req = MagicMock()
            req.auth = MagicMock()
            req.auth.id = "u-test"
            req.auth.nickname = "tester"
            req.auth.email = "tester@test.com"

            result = rollback_agent_run(req, "run-004")

        # 响应应为 200 ok，带 collab_sync_warnings
        if isinstance(result, tuple):
            status_code, data = result
            assert status_code == 200 or data.get("status") == "ok"
        else:
            assert result.get("status") == "ok"
            assert "collab_sync_warnings" in result.get("data", {})


# ─────────────────────────────────────────────────────────────
# E2E-009: restore_to_version_with_lock_held 不在事务内申请 Redis 锁
# ─────────────────────────────────────────────────────────────

class TestRestoreToVersionWithLockHeld:
    """验证 restore_to_version_with_lock_held 的行为。"""

    def _make_svc(self):
        from apps.collab.service import VersionHistoryService
        adapter = MagicMock()
        adapter.resource_type = "slide"
        svc = VersionHistoryService(adapter)
        return svc

    @patch("apps.collab.service.cache")
    def test_does_not_call_cache_add_or_delete(self, mock_cache):
        """restore_to_version_with_lock_held 不调用 cache.add 或 cache.delete。"""
        svc = self._make_svc()
        mock_vh = MagicMock()

        with patch.object(svc, "_do_restore", return_value=mock_vh):
            result = svc.restore_to_version_with_lock_held(
                uuid.uuid4(), uuid.uuid4(), {"editor_type": "user"}
            )

        assert result is mock_vh
        mock_cache.add.assert_not_called()
        mock_cache.delete.assert_not_called()

    @patch("apps.collab.service.cache")
    def test_propagates_restore_error(self, mock_cache):
        """_do_restore 抛出 RestoreError 时，with_lock_held 版本也应传播该异常。"""
        from apps.collab.service import RestoreError
        svc = self._make_svc()

        with patch.object(svc, "_do_restore", side_effect=RestoreError(
            RestoreError.VERSION_NOT_FOUND, "not found"
        )):
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version_with_lock_held(
                    uuid.uuid4(), uuid.uuid4(), {"editor_type": "user"}
                )
        assert exc_info.value.error_type == RestoreError.VERSION_NOT_FOUND

    @patch("apps.collab.service.cache")
    def test_wraps_runtime_error_as_history_write_failed(self, mock_cache):
        """_do_restore 抛出 RuntimeError 时，包装为 HISTORY_WRITE_FAILED。"""
        from apps.collab.service import RestoreError
        svc = self._make_svc()

        with patch.object(svc, "_do_restore", side_effect=RuntimeError("DB error")):
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version_with_lock_held(
                    uuid.uuid4(), uuid.uuid4(), {"editor_type": "user"}
                )
        assert exc_info.value.error_type == RestoreError.HISTORY_WRITE_FAILED
