"""
CC-010/CC-011/CC-015/CC-018/CC-019/CC-020 回归测试

CC-010: base_history FK SET_NULL 后 rebuild_data 应输出明确诊断日志
CC-011: restore_to_version 应抛出 RestoreError 而非吞掉异常返回 None
        + restore_version 端点应捕获 RestoreError 并返回结构化错误响应
CC-015: async_restore_file_checkpoint 任务应通知 daemon 恢复文件
        + restore_space_checkpoint 端点应在 file_checkpoint_hash 非空时调度任务
CC-018: CollabConfig.ready() 应延迟校验 adapter 注册完整性
CC-019: downsample_versions 应覆盖 30-90 天区间（TruncWeek）
CC-020: diff 的 expired_at 不得早于其 base snapshot
"""
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from datetime import timedelta  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

import pytest  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.collab.adapters.base import CollabAdapter  # noqa: E402
from apps.collab.models import ChangeLog, VersionHistory  # noqa: E402
from apps.collab.service import (  # noqa: E402
    DB_ALIAS,
    RebuildError,
    RestoreError,
    VersionHistoryService,
)


class MockAdapter(CollabAdapter):
    resource_type = "test"

    def __init__(self):
        self._resources: dict = {}
        self._restored: dict = {}
        self.restore_call_count = 0

    def serialize_snapshot(self, data):
        return self.compress_json(data)

    def deserialize_snapshot(self, blob):
        return self.decompress_json(blob)

    def compute_diff(self, base_data, current_data):
        if base_data == current_data:
            return None
        diff = {"_changes": {k: v for k, v in current_data.items() if base_data.get(k) != v}}
        return self.compress_json(diff)

    def apply_diff(self, base_data, diff_blob):
        diff = self.decompress_json(diff_blob)
        result = dict(base_data)
        result.update(diff["_changes"])
        return result

    def get_content_stats(self, data):
        return {"key_count": len(data)}

    def get_resource(self, resource_id):
        return self._resources.get(str(resource_id))

    def check_permission(self, user, resource, action="edit"):
        return True

    def build_snapshot(self, resource):
        return resource.get("data", {})

    def persist_changes(self, resource, changes, editor_info):
        resource["data"] = changes
        return {"version": 1}

    def restore(self, resource, data, *, prepared=None, user=None):
        self.restore_call_count += 1
        resource["data"] = data
        self._restored[resource.get("id")] = data


def _editor():
    return {
        "editor_type": "user",
        "editor_id": "test-user-123",
        "editor_name": "测试用户",
    }


# ═══════════════════════════════════════════════════════════
# CC-010: base_history FK SET_NULL 诊断
# ═══════════════════════════════════════════════════════════


class TestCC010FKSetNullDiagnostics:
    """CC-010 回归: diff 的 base_history 被 SET_NULL 后，rebuild_data 应输出
    明确的 CC-010 诊断日志，而非泛化的 'no anchor found'。
    """

    def test_rebuild_data_detects_null_base_history_on_diff(self):
        """diff 的 base_history_id 为 None 时，rebuild_data 抛出 RebuildError
        并包含 CC-010 和 SET_NULL 诊断信息。
        """
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        diff_vh = MagicMock(spec=VersionHistory)
        diff_vh.id = uuid.uuid4()
        diff_vh.is_snapshot = False
        diff_vh.base_history_id = None
        diff_vh.resource_id = uuid.uuid4()

        with pytest.raises(RebuildError) as exc_info:
            svc.rebuild_data(diff_vh)

        assert exc_info.value.error_code == RebuildError.CHAIN_BROKEN
        assert "CC-010" in str(exc_info.value)
        assert "SET_NULL" in str(exc_info.value)
        assert exc_info.value.context["break_reason"] == "fk_set_null_direct"

    def test_rebuild_data_detects_mid_chain_null_base(self):
        """链路中间节点的 base_history_id 为 None 时，
        抛出 RebuildError 并包含 fk_set_null 诊断信息。
        """
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        mid_id = uuid.uuid4()
        diff_vh = MagicMock(spec=VersionHistory)
        diff_vh.id = uuid.uuid4()
        diff_vh.is_snapshot = False
        diff_vh.base_history_id = mid_id
        diff_vh.resource_id = uuid.uuid4()

        mid_row = (False, None)

        mock_filter = MagicMock()
        mock_filter.values_list.return_value.first.return_value = mid_row
        mock_using = MagicMock()
        mock_using.filter.return_value = mock_filter

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using", return_value=mock_using):
            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(diff_vh)

        assert "fk_set_null" in str(exc_info.value).lower() or \
               exc_info.value.error_code == RebuildError.CHAIN_BROKEN


# ═══════════════════════════════════════════════════════════
# CC-011: restore_to_version 结构化错误
# ═══════════════════════════════════════════════════════════


class TestCC011RestoreErrorTypes:
    """CC-011 回归: restore_to_version 应抛出 RestoreError 而非返回 None，
    调用方可通过 error_type 区分错误类型。
    """

    def test_version_not_found_raises_restore_error(self):
        """版本不存在时抛出 RestoreError(VERSION_NOT_FOUND)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(uuid.uuid4(), uuid.uuid4(), _editor())

            assert exc_info.value.error_type == RestoreError.VERSION_NOT_FOUND

    def test_rebuild_failed_raises_restore_error(self):
        """数据重建失败时抛出 RestoreError(REBUILD_FAILED)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(uuid.uuid4(), target_vh.id, _editor())

            assert exc_info.value.error_type == RestoreError.REBUILD_FAILED

    def test_resource_not_found_raises_restore_error(self):
        """资源不存在时抛出 RestoreError(RESOURCE_NOT_FOUND)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"a": 1}):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, target_vh.id, _editor())

            assert exc_info.value.error_type == RestoreError.RESOURCE_NOT_FOUND

    def test_lock_contention_raises_restore_error(self):
        """并发锁竞争时抛出 RestoreError(LOCK_CONTENTION)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        with patch("apps.collab.service.cache") as mock_cache:
            mock_cache.add.return_value = False

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(uuid.uuid4(), uuid.uuid4(), _editor())

            assert exc_info.value.error_type == RestoreError.LOCK_CONTENTION

    def test_history_write_failed_raises_restore_error(self):
        """_do_create_history 失败时抛出 RestoreError(HISTORY_WRITE_FAILED)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = "v1"

        adapter._resources[str(rid)] = {"id": str(rid), "data": {}}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"a": 1}), \
             patch.object(adapter, "prepare_restore", return_value=None), \
             patch.object(svc, "_do_create_history", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, target_vh.id, _editor())

            assert exc_info.value.error_type == RestoreError.HISTORY_WRITE_FAILED

    def test_lock_released_on_restore_error(self):
        """即使抛出 RestoreError，缓存锁也应被释放。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError):
                svc.restore_to_version(uuid.uuid4(), uuid.uuid4(), _editor())

            mock_cache.delete.assert_called_once()


# ═══════════════════════════════════════════════════════════
# CC-015: 文件检查点恢复任务
# ═══════════════════════════════════════════════════════════


class TestCC015FileCheckpointRestore:
    """CC-015 回归: async_restore_file_checkpoint 应通知 daemon 恢复文件。"""

    def test_empty_hash_skipped(self):
        """空的 file_checkpoint_hash 应跳过恢复。"""
        from apps.collab.tasks import async_restore_file_checkpoint

        result = async_restore_file_checkpoint("thread-1", "")
        assert result["status"] == "skipped"

    def test_calls_daemon_checkpoint_service(self):
        """应调用 DaemonCheckpointService.maybe_checkpoint_restore。"""
        from apps.collab.tasks import async_restore_file_checkpoint

        with patch(
            "apps.services.agent_engine.services.daemon_checkpoint_service.DaemonCheckpointService"
        ) as mock_dcs_class:
            mock_dcs_class.maybe_checkpoint_restore.return_value = True

            result = async_restore_file_checkpoint(
                "thread-1", "abc123", space_id="space-1"
            )

        assert result["status"] == "ok"
        mock_dcs_class.maybe_checkpoint_restore.assert_called_once_with(
            thread_id="thread-1",
            commit_hash="abc123",
        )


# ═══════════════════════════════════════════════════════════
# CC-018: Adapter 注册完整性校验
# ═══════════════════════════════════════════════════════════


class TestCC018AdapterCompleteness:
    """CC-018 回归: CollabConfig._check_adapter_completeness 应在
    缺少 adapter 注册时输出 ERROR 日志。
    """

    def test_missing_adapters_logs_error(self):
        """部分 adapter 未注册时应记录 ERROR 日志。"""
        from apps.collab.apps import CollabConfig

        with patch("apps.collab.registry.list_registered_types", return_value=["docs", "table"]), \
             patch("apps.collab.apps.logger") as mock_logger:
            CollabConfig._check_adapter_completeness()

        mock_logger.error.assert_called_once()
        log_msg = mock_logger.error.call_args[0][0]
        assert "CC-018" in log_msg
        assert "incomplete" in log_msg.lower() or "Missing" in log_msg

    def test_all_adapters_registered_logs_info(self):
        """所有 adapter 都已注册时应记录 INFO 日志。

        注意：完整性检查的期望集是 ``ADAPTER_RESOURCE_TYPES``（即 RESOURCE_TYPES 去掉
        VIRTUAL_RESOURCE_TYPES，例如 "file"）。"file" 是 TabCode 虚拟资源类型，
        没有也不应有 Collab Adapter——见 ``collab/api.py`` conversation-anchors 的注释。
        """
        from apps.collab.apps import CollabConfig
        from apps.collab.constants import ADAPTER_RESOURCE_TYPES

        with patch("apps.collab.registry.list_registered_types", return_value=list(ADAPTER_RESOURCE_TYPES)), \
             patch("apps.collab.apps.logger") as mock_logger:
            CollabConfig._check_adapter_completeness()

        mock_logger.error.assert_not_called()
        mock_logger.info.assert_called_once()

    def test_virtual_resource_types_excluded_from_completeness_check(self):
        """虚拟资源类型（如 'file'）即便未注册 adapter 也不应触发 CC-018 ERROR。

        回归保护：阻止有人误把 VIRTUAL_RESOURCE_TYPES 重新合并回完整性检查的期望集。
        """
        from apps.collab.apps import CollabConfig
        from apps.collab.constants import ADAPTER_RESOURCE_TYPES, VIRTUAL_RESOURCE_TYPES

        assert "file" in VIRTUAL_RESOURCE_TYPES
        assert "file" not in ADAPTER_RESOURCE_TYPES

        with patch(
            "apps.collab.registry.list_registered_types",
            return_value=list(ADAPTER_RESOURCE_TYPES),
        ), patch("apps.collab.apps.logger") as mock_logger:
            CollabConfig._check_adapter_completeness()

        mock_logger.error.assert_not_called()


# ═══════════════════════════════════════════════════════════
# CC-019: downsample 30-90 天 TruncWeek 区间
# ═══════════════════════════════════════════════════════════


class TestCC019DownsampleTeamRange:
    """CC-019 回归: downsample_versions 应包含 30-90 天 TruncWeek 区间。"""

    def test_downsample_has_three_ranges(self):
        """downsample_versions 应定义 3 个降采样区间。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        with patch("apps.collab.service.VersionHistory") as mock_vh_model, \
             patch("apps.collab.service.transaction"):
            mock_qs = MagicMock()
            mock_qs.exists.return_value = False
            mock_vh_model.objects.using.return_value.filter.return_value = mock_qs

            svc.downsample_versions()

            filter_calls = mock_vh_model.objects.using.return_value.filter.call_args_list
            date_ranges = []
            for call in filter_calls:
                kwargs = call[1] if call[1] else {}
                if "created_at__gte" in kwargs and "created_at__lt" in kwargs:
                    date_ranges.append(
                        (kwargs["created_at__gte"], kwargs["created_at__lt"])
                    )

            assert len(date_ranges) == 3, (
                f"Expected 3 downsample ranges (CC-019), got {len(date_ranges)}"
            )

    def test_third_range_covers_30_to_90_days(self):
        """第三个区间应覆盖 30-90 天。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        now = timezone.now()
        captured_ranges = []

        original_filter = VersionHistory.objects.using

        def capture_filter(*args, **kwargs):
            mock_qs = MagicMock()
            mock_qs.exists.return_value = False

            def inner_filter(**kw):
                if "created_at__gte" in kw:
                    captured_ranges.append(kw)
                return mock_qs

            mock_qs.filter = inner_filter
            return mock_qs

        with patch.object(VersionHistory.objects, "using", side_effect=capture_filter), \
             patch("apps.collab.service.transaction"):
            svc.downsample_versions()

        assert len(captured_ranges) >= 3, (
            f"Expected >= 3 range filters, got {len(captured_ranges)}"
        )

        third = captured_ranges[2]
        start_delta = (now - third["created_at__gte"]).days
        end_delta = (now - third["created_at__lt"]).days
        assert 89 <= start_delta <= 91, f"Start should be ~90 days ago, got {start_delta}"
        assert 29 <= end_delta <= 31, f"End should be ~30 days ago, got {end_delta}"


# ═══════════════════════════════════════════════════════════
# CC-020: diff TTL 不得早于 base snapshot
# ═══════════════════════════════════════════════════════════


def _make_base_snapshot(adapter, data, expired_at):
    """创建一个可用于 VersionHistory(base_history=...) 的 mock，包含 Django _state。"""
    from django.db.models.base import ModelState

    snap = MagicMock(spec=VersionHistory)
    snap.id = uuid.uuid4()
    snap.pk = snap.id
    snap.is_snapshot = True
    snap.blob = adapter.serialize_snapshot(data)
    snap.expired_at = expired_at
    snap._state = ModelState()
    snap._state.db = DB_ALIAS
    return snap


class TestCC020DiffTTLProtection:
    """CC-020 回归: 创建 diff 时，expired_at 不得早于 base snapshot 的 expired_at。"""

    def test_diff_expired_at_not_before_base_snapshot(self):
        """当 base snapshot 的 expired_at 晚于 diff 计算的 TTL 时，
        diff 应使用 base 的 expired_at。
        """
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        now = timezone.now()

        base_expired_at = now + timedelta(days=90)
        diff_computed_ttl = now + timedelta(days=7)
        base_snapshot = _make_base_snapshot(adapter, {"title": "v1"}, base_expired_at)

        data = {"title": "v2"}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_snapshot), \
             patch.object(svc, "_compute_ttl", return_value=diff_computed_ttl):
            mock_cache.add.return_value = True
            mock_cache.get.return_value = None
            vh = svc.create_history(rid, data, _editor())

        assert vh is not None
        assert vh.is_snapshot is False
        assert vh.base_history is base_snapshot
        assert vh.expired_at == base_expired_at, (
            f"diff expired_at should be {base_expired_at}, got {vh.expired_at}"
        )

    def test_diff_keeps_own_ttl_when_later_than_base(self):
        """当 diff 计算的 TTL 晚于 base snapshot 时，保持 diff 自己的 TTL。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        now = timezone.now()

        base_expired_at = now + timedelta(days=7)
        diff_computed_ttl = now + timedelta(days=30)
        base_snapshot = _make_base_snapshot(adapter, {"title": "v1"}, base_expired_at)

        data = {"title": "v2"}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_snapshot), \
             patch.object(svc, "_compute_ttl", return_value=diff_computed_ttl):
            mock_cache.add.return_value = True
            mock_cache.get.return_value = None
            vh = svc.create_history(rid, data, _editor())

        assert vh is not None
        assert vh.is_snapshot is False
        assert vh.expired_at == diff_computed_ttl

    def test_diff_handles_base_null_expired_at(self):
        """base snapshot 的 expired_at 为 None（命名版本）时，diff 保持自己的 TTL。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        now = timezone.now()

        diff_computed_ttl = now + timedelta(days=7)
        base_snapshot = _make_base_snapshot(adapter, {"title": "v1"}, None)

        data = {"title": "v2"}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_snapshot), \
             patch.object(svc, "_compute_ttl", return_value=diff_computed_ttl):
            mock_cache.add.return_value = True
            mock_cache.get.return_value = None
            vh = svc.create_history(rid, data, _editor())

        assert vh is not None
        assert vh.is_snapshot is False
        assert vh.expired_at == diff_computed_ttl


# ═══════════════════════════════════════════════════════════
# CC-011 API 端点: restore_version 捕获 RestoreError
# ═══════════════════════════════════════════════════════════


class TestCC011RestoreVersionEndpoint:
    """CC-011 残留修复回归: restore_version 端点应捕获 RestoreError
    并返回结构化 HTTP 错误响应，而非意外 500。
    """

    def _call_restore_version(self, side_effect):
        """辅助方法：mock 调用 restore_version 端点。"""
        from apps.collab.api import restore_version

        mock_request = MagicMock()
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()
        mock_request.auth.nickname = "tester"

        mock_body = MagicMock()
        mock_body.version_id = uuid.uuid4()

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = {"id": "r1"}
        mock_adapter.check_permission.return_value = True

        mock_svc = MagicMock()
        mock_svc.restore_to_version.side_effect = side_effect

        with patch("apps.collab.api.get_adapter_or_raise", return_value=mock_adapter), \
             patch("apps.collab.api.VersionHistoryService", return_value=mock_svc), \
             patch("apps.collab.api._validate_resource_type", return_value=None):
            return restore_version(mock_request, "docs", uuid.uuid4(), mock_body)

    def test_version_not_found_returns_404(self):
        """VERSION_NOT_FOUND → HTTP 404。"""
        result = self._call_restore_version(
            RestoreError(RestoreError.VERSION_NOT_FOUND, "not found"),
        )
        assert result[0] == 404
        assert result[1]["error_type"] == RestoreError.VERSION_NOT_FOUND

    def test_lock_contention_returns_409(self):
        """LOCK_CONTENTION → HTTP 409。"""
        result = self._call_restore_version(
            RestoreError(RestoreError.LOCK_CONTENTION, "locked"),
        )
        assert result[0] == 409
        assert result[1]["error_type"] == RestoreError.LOCK_CONTENTION

    def test_rebuild_failed_returns_400(self):
        """REBUILD_FAILED → HTTP 400（默认映射）。"""
        result = self._call_restore_version(
            RestoreError(RestoreError.REBUILD_FAILED, "rebuild failed"),
        )
        assert result[0] == 400
        assert result[1]["error_type"] == RestoreError.REBUILD_FAILED

    def test_resource_not_found_returns_404(self):
        """RESOURCE_NOT_FOUND → HTTP 404。"""
        result = self._call_restore_version(
            RestoreError(RestoreError.RESOURCE_NOT_FOUND, "resource gone"),
        )
        assert result[0] == 404
        assert result[1]["error_type"] == RestoreError.RESOURCE_NOT_FOUND

    def test_history_write_failed_returns_400(self):
        """HISTORY_WRITE_FAILED → HTTP 400（默认映射）。"""
        result = self._call_restore_version(
            RestoreError(RestoreError.HISTORY_WRITE_FAILED, "write failed"),
        )
        assert result[0] == 400
        assert result[1]["error_type"] == RestoreError.HISTORY_WRITE_FAILED


# ═══════════════════════════════════════════════════════════
# CC-015 集成: restore_space_checkpoint 调度文件恢复任务
# ═══════════════════════════════════════════════════════════


class TestCC015RestoreSpaceCheckpointFileDispatch:
    """CC-015 集成回归: restore_space_checkpoint 端点应在
    file_checkpoint_hash 非空时调度 async_restore_file_checkpoint 任务。
    """

    @patch("apps.collab.api._force_close_collab_document",
           return_value={"success": True, "loaded": True, "connections_closed": 0})
    @patch("apps.collab.api._clear_tabdata_undo_redo_stacks")
    @patch("apps.collab.api.get_adapter_or_raise")
    @patch("apps.collab.api.VersionHistoryService")
    @patch("apps.collab.tasks.async_restore_file_checkpoint")
    def test_dispatches_file_restore_when_hash_present(
        self, mock_task, mock_svc_cls, mock_get_adapter, mock_clear, mock_fc,
    ):
        """有 file_checkpoint_hash 时应调用 async_restore_file_checkpoint.delay()。"""
        from apps.collab.api import restore_space_checkpoint

        space_id = uuid.uuid4()
        agent_run_id = "run-abc123"
        file_hash = "deadbeef1234"
        vid = uuid.uuid4()
        res_id = uuid.uuid4()

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.space_id = space_id
        mock_cp.name = "test-cp"
        mock_cp.agent_run_id = agent_run_id
        mock_cp.file_checkpoint_hash = file_hash
        mock_cp.version_refs = {f"docs:{res_id}": str(vid)}

        mock_target_vh = MagicMock()
        mock_target_vh.id = vid

        mock_new_vh = MagicMock()
        mock_new_vh.id = uuid.uuid4()
        mock_svc_cls.return_value.restore_to_version.return_value = mock_new_vh

        mock_adapter = MagicMock()
        mock_adapter.get_resource.return_value = {"id": str(res_id)}
        mock_adapter.check_permission.return_value = True
        mock_get_adapter.return_value = mock_adapter

        mock_request = MagicMock()
        mock_request.auth = MagicMock()
        mock_request.auth.id = uuid.uuid4()
        mock_request.auth.nickname = "tester"

        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc_cls, \
             patch("apps.collab.models.VersionHistory") as mock_vh_cls, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_bsvc_cls, \
             patch("django.db.transaction.atomic"):

            mock_sc_cls.objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_vh_cls.objects.using.return_value.filter.return_value = [mock_target_vh]
            mock_bsvc_cls.return_value.check_space_permission.return_value = True

            result = restore_space_checkpoint(mock_request, mock_cp.id)

        mock_task.delay.assert_called_once_with(
            thread_id=agent_run_id,
            file_checkpoint_hash=file_hash,
            space_id=str(space_id),
        )

    @patch("apps.collab.tasks.async_restore_file_checkpoint")
    def test_no_dispatch_when_hash_empty(self, mock_task):
        """file_checkpoint_hash 为空时不应调度任务。"""
        from apps.collab.api import restore_space_checkpoint

        mock_cp = MagicMock()
        mock_cp.id = uuid.uuid4()
        mock_cp.space_id = uuid.uuid4()
        mock_cp.name = "test-cp"
        mock_cp.agent_run_id = ""
        mock_cp.file_checkpoint_hash = ""
        mock_cp.version_refs = {}

        mock_request = MagicMock()
        mock_request.auth = MagicMock()

        with patch("apps.collab.models.SpaceCheckpoint") as mock_sc_cls, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_bsvc_cls:

            mock_sc_cls.objects.using.return_value.filter.return_value.first.return_value = mock_cp
            mock_bsvc_cls.return_value.check_space_permission.return_value = True

            restore_space_checkpoint(mock_request, mock_cp.id)

        mock_task.delay.assert_not_called()
