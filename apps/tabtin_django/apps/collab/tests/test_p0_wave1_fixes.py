"""
P0 Wave-1 回归测试

P0-1: create_space_checkpoint 权限校验
P0-2: list_space_checkpoints 权限校验
P0-3: cleanup_expired 快照保护逻辑
P0-4: DocsCollabAdapter.apply_diff 异常处理
P0-5: VideoCollabAdapter.persist_changes 事务行锁
S3-03: cleanup/downsample 分布式互斥锁
"""
import os
import uuid
from datetime import timedelta
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402
from django.utils import timezone  # noqa: E402


# ══════════════════════════════════════════════════════════
# P0-1: create_space_checkpoint 权限校验
# ══════════════════════════════════════════════════════════

class TestCreateSpaceCheckpointPermission:
    """验证 create_space_checkpoint 端点要求 Space editor 权限。"""

    def _make_request(self, user_id="u-owner"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        req.auth.nickname = "tester"
        return req

    def _make_body(self, space_id=None):
        body = MagicMock()
        body.space_id = space_id or uuid.uuid4()
        body.name = "test checkpoint"
        body.file_checkpoint_hash = ""
        body.agent_run_id = ""
        body.trigger = "manual"
        body.user_prompt = ""
        body.diff_summary = None
        body.checkpoint_policy = None
        body.anchor_session_id = ""
        body.anchor_message_id = ""
        return body

    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("apps.tabtinspace.models.Space")
    def test_rejects_unauthorized_user(self, mock_space_model, mock_base_svc_cls):
        """无 Space 权限的用户应被拒绝创建检查点。"""
        from apps.collab.api import create_space_checkpoint

        space_id = uuid.uuid4()
        mock_space = MagicMock()
        mock_space.organization_id = uuid.uuid4()
        mock_space_model.objects.filter.return_value.only.return_value.first.return_value = mock_space

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = False
        mock_base_svc_cls.return_value = mock_svc

        req = self._make_request(user_id="u-unauthorized")
        body = self._make_body(space_id=space_id)

        status, result = create_space_checkpoint(req, body)

        assert status == 403
        assert result["status"] == "error"
        mock_svc.check_space_permission.assert_called_once_with(
            str(space_id), required_role="editor"
        )

    @patch("apps.tabtinspace.models.Space")
    def test_returns_404_for_nonexistent_space(self, mock_space_model):
        """不存在的 Space 应返回 404。"""
        from apps.collab.api import create_space_checkpoint

        mock_space_model.objects.filter.return_value.only.return_value.first.return_value = None

        req = self._make_request()
        body = self._make_body()

        status, result = create_space_checkpoint(req, body)

        assert status == 404
        assert result["status"] == "error"


# ══════════════════════════════════════════════════════════
# P0-2: list_space_checkpoints 权限校验
# ══════════════════════════════════════════════════════════

class TestListSpaceCheckpointsPermission:
    """验证 list_space_checkpoints 端点要求 Space viewer 权限。"""

    def _make_request(self, user_id="u-viewer"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        return req

    @patch("apps.tabtinspace.services.base.BaseService")
    @patch("apps.tabtinspace.models.Space")
    def test_rejects_unauthorized_user(self, mock_space_model, mock_base_svc_cls):
        """无 Space 权限的用户应被拒绝列出检查点。"""
        from apps.collab.api import list_space_checkpoints

        space_id = uuid.uuid4()

        mock_space_model.objects.filter.return_value.exists.return_value = True

        mock_svc = MagicMock()
        mock_svc.check_space_permission.return_value = False
        mock_base_svc_cls.return_value = mock_svc

        req = self._make_request(user_id="u-unauthorized")

        status, result = list_space_checkpoints(req, space_id)

        assert status == 403
        assert result["status"] == "error"
        mock_svc.check_space_permission.assert_called_once_with(
            str(space_id), required_role="viewer"
        )

    @patch("apps.tabtinspace.models.Space")
    def test_returns_404_for_nonexistent_space(self, mock_space_model):
        """不存在的 Space 应返回 404。"""
        from apps.collab.api import list_space_checkpoints

        mock_space_model.objects.filter.return_value.exists.return_value = False

        req = self._make_request()
        space_id = uuid.uuid4()

        status, result = list_space_checkpoints(req, space_id)

        assert status == 404
        assert result["status"] == "error"


# ══════════════════════════════════════════════════════════
# P0-3: cleanup_expired 快照保护逻辑
# ══════════════════════════════════════════════════════════

class TestCleanupExpiredSnapshotProtection:
    """
    验证 cleanup_expired 保护所有被 diff 引用的快照，
    包括被已过期 diff 引用的快照。
    """

    @patch("apps.services.common.version_history.service.transaction")
    def test_protects_snapshot_referenced_by_expired_diff(self, mock_tx):
        """
        即使 diff 本身已过期，其引用的 snapshot 也不应被删除，
        确保 diff 在下次清理前仍可重建。
        """
        from apps.services.common.version_history.service import HistoryServiceBase

        mock_tx.atomic.return_value.__enter__ = MagicMock()
        mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

        now = timezone.now()
        snapshot_id = uuid.uuid4()
        diff_id = uuid.uuid4()

        mock_model = MagicMock()
        db_alias = "postgresql"

        expired_qs = MagicMock()
        locked_qs = MagicMock()
        expired_qs.select_for_update.return_value = locked_qs
        excluded_qs = MagicMock()
        excluded_qs.count.return_value = 0
        locked_qs.exclude.return_value = excluded_qs

        def mock_filter(**kwargs):
            if "expired_at__lt" in kwargs:
                return expired_qs
            if "base_history__isnull" in kwargs:
                qs = MagicMock()
                qs.values_list.return_value.flat = True
                qs.values_list.return_value = [snapshot_id]
                return qs
            return MagicMock()

        mock_model.objects.using.return_value.filter = mock_filter

        svc = HistoryServiceBase()
        svc._get_db_alias = lambda: db_alias

        svc.cleanup_expired(mock_model)

        expired_qs.select_for_update.assert_called_once_with(skip_locked=True)
        locked_qs.exclude.assert_called_once()
        exclude_args = locked_qs.exclude.call_args
        assert snapshot_id in exclude_args[1]["id__in"]

    def test_referenced_ids_query_has_no_expired_at_filter(self):
        """确认 referenced_ids 查询不包含 expired_at 过滤条件。"""
        import inspect
        from apps.services.common.version_history.service import HistoryServiceBase

        source = inspect.getsource(HistoryServiceBase.cleanup_expired)
        assert "expired_at__gte" not in source, (
            "cleanup_expired should not filter referenced_ids by expired_at"
        )


# ══════════════════════════════════════════════════════════
# P0-4: DocsCollabAdapter.apply_diff 异常处理
# ══════════════════════════════════════════════════════════

class TestDocsApplyDiffErrorHandling:
    """验证 DocsCollabAdapter.apply_diff 异常时抛出 RuntimeError。"""

    @patch("apps.services.common.live_api.call_live_api", side_effect=ConnectionError("collab-live down"))
    def test_raises_runtime_error_on_exception(self, _):
        """apply_diff 失败时应抛出 RuntimeError 而非返回 None。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        base_data = b"some yjs binary"
        import zlib
        diff_blob = zlib.compress(b"fake diff")

        with pytest.raises(RuntimeError, match="Failed to apply Y.js diff"):
            adapter.apply_diff(base_data, diff_blob)

    def test_returns_base_data_for_non_binary_input(self):
        """非 binary 输入应抛出 RuntimeError。"""
        from apps.collab.adapters.docs import DocsCollabAdapter

        adapter = DocsCollabAdapter()
        base_data = {"format": "json_snapshot", "content": "test"}
        with pytest.raises(RuntimeError, match="apply_diff requires binary base_data"):
            adapter.apply_diff(base_data, b"irrelevant")

    def test_rebuild_data_handles_apply_diff_exception(self):
        """rebuild_data 应将 apply_diff 的异常包装为 RebuildError(DIFF_APPLY_FAILED)。"""
        from apps.collab.service import VersionHistoryService, RebuildError
        from apps.collab.tests.test_service import MockAdapter
        from apps.collab.models import VersionHistory

        adapter = MockAdapter()

        def failing_apply_diff(base_data, diff_blob):
            raise RuntimeError("simulated apply_diff failure")

        adapter.apply_diff = failing_apply_diff
        svc = VersionHistoryService(adapter)

        snapshot_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        resource_id = uuid.uuid4()

        mock_snapshot = MagicMock()
        mock_snapshot.id = snapshot_id
        mock_snapshot.is_snapshot = True
        mock_snapshot.blob = adapter.serialize_snapshot({"key": "value"})

        mock_diff = MagicMock()
        mock_diff.id = diff_id
        mock_diff.is_snapshot = False
        mock_diff.resource_id = resource_id
        mock_diff.blob = b"fake"

        mock_history_input = MagicMock()
        mock_history_input.id = diff_id
        mock_history_input.is_snapshot = False
        mock_history_input.resource_id = resource_id
        mock_history_input.base_history_id = snapshot_id

        mock_entries_qs = MagicMock()
        mock_entries_qs.__iter__ = MagicMock(return_value=iter([mock_snapshot, mock_diff]))

        def mock_filter(**kwargs):
            if "id__in" in kwargs:
                return mock_entries_qs
            if "id" in kwargs:
                # while 循环回溯时查询单条元数据：filter(id=snapshot_id)
                row_qs = MagicMock()
                row_qs.values_list.return_value.first.return_value = (True, None)
                return row_qs
            return MagicMock()

        with patch.object(VersionHistory, "objects") as mock_objects, \
             patch("apps.collab.service.transaction.atomic") as mock_atomic:
            mock_atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_atomic.return_value.__exit__ = MagicMock(return_value=False)

            mock_using = MagicMock()
            mock_using.filter = mock_filter
            mock_objects.using.return_value = mock_using

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(mock_history_input)

            assert exc_info.value.error_code == RebuildError.DIFF_APPLY_FAILED


# ══════════════════════════════════════════════════════════
# P0-5: VideoCollabAdapter.persist_changes 事务行锁
# ══════════════════════════════════════════════════════════



# ══════════════════════════════════════════════════════════
# S3-03: cleanup/downsample 分布式互斥锁
# ══════════════════════════════════════════════════════════

class TestMaintenanceLockMutualExclusion:
    """验证 cleanup 和 downsample 通过分布式锁互斥执行。"""

    @patch("apps.collab.tasks.VersionHistoryService")
    @patch("apps.collab.tasks.cache")
    def test_cleanup_skipped_when_lock_held(self, mock_cache, mock_svc_cls):
        """锁被占用时 cleanup 应直接返回 0。"""
        from apps.collab.tasks import cleanup_expired_versions

        mock_cache.add.return_value = False
        result = cleanup_expired_versions()
        assert result == 0
        mock_svc_cls.assert_not_called()

    @patch("apps.collab.tasks.VersionHistoryService")
    @patch("apps.collab.tasks.cache")
    def test_downsample_skipped_when_lock_held(self, mock_cache, mock_svc_cls):
        """锁被占用时 downsample 应直接返回 0。"""
        from apps.collab.tasks import downsample_versions

        mock_cache.add.return_value = False
        result = downsample_versions()
        assert result == 0
        mock_svc_cls.assert_not_called()

    @patch("apps.collab.tasks.VersionHistoryService")
    @patch("apps.collab.tasks.cache")
    def test_cleanup_acquires_and_releases_lock(self, mock_cache, mock_svc_cls):
        """cleanup 成功执行后应释放 CLEANUP_LOCK_KEY（CC-017：独立锁）。"""
        from apps.collab.tasks import cleanup_expired_versions, CLEANUP_LOCK_KEY

        mock_cache.add.return_value = True
        mock_svc_cls.return_value.cleanup_expired_versions.return_value = 5

        result = cleanup_expired_versions()

        assert result == 5
        mock_cache.add.assert_called_once_with(CLEANUP_LOCK_KEY, "cleanup", 660)
        mock_cache.delete.assert_called_once_with(CLEANUP_LOCK_KEY)

    @patch("apps.collab.tasks.VersionHistoryService")
    @patch("apps.collab.tasks.cache")
    def test_lock_released_on_exception(self, mock_cache, mock_svc_cls):
        """即使任务异常，CLEANUP_LOCK_KEY 也应被释放。"""
        from apps.collab.tasks import cleanup_expired_versions, CLEANUP_LOCK_KEY

        mock_cache.add.return_value = True
        mock_svc_cls.return_value.cleanup_expired_versions.side_effect = RuntimeError("boom")

        with pytest.raises(RuntimeError, match="boom"):
            cleanup_expired_versions()

        mock_cache.delete.assert_called_once_with(CLEANUP_LOCK_KEY)

    @patch("apps.collab.tasks.VersionHistoryService")
    @patch("apps.collab.tasks.cache")
    def test_cleanup_and_downsample_use_independent_lock_keys(self, mock_cache, mock_svc_cls):
        """CC-017：cleanup 和 downsample 使用独立锁 key，允许并行执行。"""
        from apps.collab.tasks import CLEANUP_LOCK_KEY, DOWNSAMPLE_LOCK_KEY, MAINTENANCE_LOCK_KEY

        assert CLEANUP_LOCK_KEY == "collab:cleanup_lock"
        assert DOWNSAMPLE_LOCK_KEY == "collab:downsample_lock"
        assert MAINTENANCE_LOCK_KEY == "collab:maintenance_lock"  # 向后兼容保留


# ══════════════════════════════════════════════════════════
# RV-013: viewer 降级时降级为只读而非断连
# ══════════════════════════════════════════════════════════

class TestRV013ViewerDowngradeReadOnly:
    """验证 collab_auth 返回 permission 字段，以及 downgrade 函数正确调用 collab-live。"""

    def _make_request(self, user_id="u-viewer"):
        req = MagicMock()
        req.auth = MagicMock()
        req.auth.id = user_id
        req.auth.nickname = "viewer-user"
        return req

    @patch("apps.collab.api.get_adapter_or_raise")
    def test_collab_auth_returns_view_permission_for_viewer(self, mock_get_adapter):
        """viewer 用户调用 collab_auth 应返回 permission='view'。"""
        from apps.collab.api import collab_auth

        adapter = MagicMock()
        adapter.check_permission.side_effect = lambda u, r, action: action == "view"
        adapter.get_resource.return_value = MagicMock()
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        result = collab_auth(req, "docs", uuid.uuid4())

        assert result["status"] == "ok"
        assert result["data"]["permission"] == "view"
        assert result["data"]["authorized"] is True

    @patch("apps.collab.api.get_adapter_or_raise")
    def test_collab_auth_returns_edit_permission_for_editor(self, mock_get_adapter):
        """editor 用户调用 collab_auth 应返回 permission='edit'。"""
        from apps.collab.api import collab_auth

        adapter = MagicMock()
        adapter.check_permission.return_value = True
        adapter.get_resource.return_value = MagicMock()
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        result = collab_auth(req, "docs", uuid.uuid4())

        assert result["status"] == "ok"
        assert result["data"]["permission"] == "edit"

    @patch("apps.collab.api.get_adapter_or_raise")
    def test_collab_auth_rejects_user_without_view_permission(self, mock_get_adapter):
        """无任何权限的用户应被拒绝。"""
        from apps.collab.api import collab_auth

        adapter = MagicMock()
        adapter.check_permission.return_value = False
        adapter.get_resource.return_value = MagicMock()
        mock_get_adapter.return_value = adapter

        req = self._make_request()
        status, result = collab_auth(req, "docs", uuid.uuid4())

        assert status == 403
        assert result["status"] == "error"

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_downgrade_user_collab_to_readonly(self, mock_call):
        """downgrade_user_collab_to_readonly 调用 /internal/revoke-user-access 并传递 read_only=True。"""
        from apps.collab.api import downgrade_user_collab_to_readonly

        mock_call.return_value = {"connections_affected": 2}

        result = downgrade_user_collab_to_readonly("user-123", "ws-456")

        mock_call.assert_called_once()
        call_args = mock_call.call_args
        assert call_args[0][0] == "/internal/revoke-user-access"
        assert call_args[0][1]["read_only"] is True
        assert call_args[0][1]["user_id"] == "user-123"
        assert result["downgraded"] is True
        assert result["connections_affected"] == 2


# ══════════════════════════════════════════════════════════
# RV-014: 高危操作同步撤销
# ══════════════════════════════════════════════════════════

class TestRV014SyncRevokeCollabAccess:
    """验证 sync_revoke_collab_access 直接调用 HTTP 而非 Celery。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_sync_revoke_calls_live_api_directly(self, mock_call):
        """sync_revoke 直接调用 revoke_user_collab_access，无 Celery。"""
        from apps.collab.tasks import sync_revoke_collab_access

        mock_call.return_value = {"connections_closed": 3}

        result = sync_revoke_collab_access("user-x", "ws-y")

        mock_call.assert_called_once()
        assert result.get("revoked") is True

    @patch("apps.collab.api.revoke_user_collab_access")
    def test_sync_revoke_handles_failure_gracefully(self, mock_revoke):
        """sync_revoke 失败时不抛异常，返回 error。"""
        from apps.collab.tasks import sync_revoke_collab_access

        mock_revoke.side_effect = Exception("connection refused")

        result = sync_revoke_collab_access("user-x", "ws-y")

        assert result.get("error") == "sync_revoke_failed"

    def test_organization_service_remove_member_uses_sync_revoke(self):
        """remove_member 中的 collab 撤销应使用 _sync_collab_revoke 而非 _schedule_collab_revoke。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService

        source = inspect.getsource(OrganizationService.remove_member)
        assert "_sync_collab_revoke" in source, (
            "remove_member must use _sync_collab_revoke (RV-014)"
        )
        assert "_schedule_collab_revoke" not in source, (
            "remove_member should not use async _schedule_collab_revoke for high-risk operations"
        )

    def test_organization_service_update_member_role_uses_downgrade(self):
        """update_member_role 中 editor→viewer 应使用 _schedule_collab_downgrade。"""
        import inspect
        from apps.tabtinspace.services.organization_service import OrganizationService

        source = inspect.getsource(OrganizationService.update_member_role)
        assert "_schedule_collab_downgrade" in source, (
            "update_member_role must use _schedule_collab_downgrade for viewer downgrade (RV-013)"
        )


# ══════════════════════════════════════════════════════════
# RV-015: 单文档级撤销端点 Django 调用路径
# ══════════════════════════════════════════════════════════

class TestRV015SingleDocumentRevoke:
    """验证单文档级撤销 API 函数和 Celery 任务。"""

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_revoke_document_collab_access_calls_correct_endpoint(self, mock_call):
        """revoke_document_collab_access 调用 /internal/revoke-access。"""
        from apps.collab.api import revoke_document_collab_access

        mock_call.return_value = {"connections_affected": 1}

        result = revoke_document_collab_access("docs:doc-123", "user-456")

        mock_call.assert_called_once()
        call_args = mock_call.call_args
        assert call_args[0][0] == "/internal/revoke-access"
        assert call_args[0][1]["document_name"] == "docs:doc-123"
        assert call_args[0][1]["user_id"] == "user-456"
        assert call_args[0][1]["read_only"] is False
        assert result["revoked"] is True

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_revoke_document_with_read_only(self, mock_call):
        """read_only=True 时应传递给 collab-live。"""
        from apps.collab.api import revoke_document_collab_access

        mock_call.return_value = {"connections_affected": 1}

        result = revoke_document_collab_access(
            "docs:doc-123", "user-456", read_only=True,
        )

        call_args = mock_call.call_args
        assert call_args[0][1]["read_only"] is True
        assert result["revoked"] is True

    @patch("apps.services.common.live_api.call_live_api_safe")
    def test_revoke_document_handles_error(self, mock_call):
        """错误时返回 revoked=False。"""
        from apps.collab.api import revoke_document_collab_access

        mock_call.return_value = {"error": "connection refused"}

        result = revoke_document_collab_access("docs:doc-123", "user-456")

        assert result["revoked"] is False
        assert "error" in result


# ══════════════════════════════════════════════════════════
# RV-021 (附带修复): boolean 比较语义
# ══════════════════════════════════════════════════════════

class TestRV021BooleanComparisonFix:
    """验证 async_revoke_collab_access 的结果判断语义正确。"""

    def test_result_check_uses_truthiness_not_numeric_comparison(self):
        """确认结果判断不再使用 > 0 数值比较。"""
        import inspect
        from apps.collab.tasks import async_revoke_collab_access

        source = inspect.getsource(async_revoke_collab_access)
        assert 'result.get("revoked", 0) > 0' not in source, (
            "Should not use numeric comparison on boolean 'revoked' field"
        )
        assert 'result.get("errors", 0) > 0' not in source, (
            "Should not check non-existent 'errors' field"
        )
