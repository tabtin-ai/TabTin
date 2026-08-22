"""
CL-012 + CL-018 回归测试

CL-012: rebuild_data 各失败路径必须抛出 RebuildError（而非返回 None），
        携带 error_code 和 context 字典，便于区分 cleanup 删除 / 数据损坏 / 链路断裂。
CL-018: anchor 在阶段1和阶段2之间消失时，诊断查询应区分"并发 cleanup 删除"
        和"事务隔离异常"两种原因。
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.collab.adapters.base import CollabAdapter  # noqa: E402
from apps.collab.models import VersionHistory  # noqa: E402
from apps.collab.service import (  # noqa: E402
    DB_ALIAS,
    RebuildError,
    RestoreError,
    VersionHistoryService,
)


class _MockAdapter(CollabAdapter):
    resource_type = "test"

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
        return None

    def check_permission(self, user, resource, action="edit"):
        return True

    def build_snapshot(self, resource):
        return {}

    def persist_changes(self, resource, changes, editor_info):
        return {}

    def restore(self, resource, data, *, prepared=None, user=None):
        pass


def _editor():
    return {"editor_type": "user", "editor_id": "u1", "editor_name": "test"}


class TestRebuildErrorExceptionClass:
    """RebuildError 异常类基本行为。"""

    def test_error_code_and_context_accessible(self):
        err = RebuildError("TEST_CODE", "test msg", {"key": "val"})
        assert err.error_code == "TEST_CODE"
        assert err.context == {"key": "val"}
        assert "TEST_CODE" in str(err)
        assert "test msg" in str(err)

    def test_context_defaults_to_empty_dict(self):
        err = RebuildError("X", "msg")
        assert err.context == {}

    def test_all_error_codes_defined(self):
        codes = [
            RebuildError.CHAIN_TOO_DEEP,
            RebuildError.CHAIN_BROKEN,
            RebuildError.ANCHOR_MISSING,
            RebuildError.ANCHOR_CORRUPT,
            RebuildError.DIFF_ENTRY_MISSING,
            RebuildError.DIFF_APPLY_FAILED,
            RebuildError.DIFF_APPLY_NULL,
        ]
        assert len(set(codes)) == 7


class TestCL012RebuildDataDiagnostics:
    """CL-012: rebuild_data 各失败路径的诊断能力。"""

    def test_chain_broken_base_history_null(self):
        """base_history_id 为 NULL（FK SET_NULL）→ CHAIN_BROKEN + fk_set_null_direct。

        CC-010 早期检查在进入通用链路回溯之前就拦截此场景。
        """
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = None

        with pytest.raises(RebuildError) as exc_info:
            svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.CHAIN_BROKEN
        assert err.context["break_reason"] == "fk_set_null_direct"
        assert err.context["history_id"] == str(diff_id)

    def test_chain_broken_record_not_found(self):
        """中间节点在 DB 中不存在 → CHAIN_BROKEN + break_reason=record_not_found。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        diff_id = uuid.uuid4()
        missing_parent_id = uuid.uuid4()
        rid = uuid.uuid4()

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = missing_parent_id

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == missing_parent_id:
                qs.values_list.return_value.first.return_value = None
            elif "base_history_id" in kwargs:
                qs.exclude.return_value.exists.return_value = False
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.CHAIN_BROKEN
        assert err.context["break_reason"] == "record_not_found"
        assert err.context["missing_id"] == str(missing_parent_id)

    def test_anchor_corrupt_deserialization_failure(self):
        """anchor blob 反序列化失败 → ANCHOR_CORRUPT。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        mock_anchor = MagicMock(spec=VersionHistory)
        mock_anchor.id = anchor_id
        mock_anchor.is_snapshot = True
        mock_anchor.blob = b"corrupted-blob-data"

        mock_diff = MagicMock(spec=VersionHistory)
        mock_diff.id = diff_id
        mock_diff.is_snapshot = False
        mock_diff.resource_id = rid
        mock_diff.base_history_id = anchor_id

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                qs.values_list.return_value.first.return_value = (True, None)
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(
                    return_value=iter([mock_anchor, mock_diff])
                )
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(mock_diff)

        err = exc_info.value
        assert err.error_code == RebuildError.ANCHOR_CORRUPT
        assert err.context["anchor_id"] == str(anchor_id)

    def test_diff_apply_exception_wraps_original(self):
        """apply_diff 抛异常 → DIFF_APPLY_FAILED，__cause__ 保留原始异常。"""

        class _FailingAdapter(_MockAdapter):
            def apply_diff(self, base_data, diff_blob):
                raise ValueError("simulated corruption")

        adapter = _FailingAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        mock_anchor = MagicMock(spec=VersionHistory)
        mock_anchor.id = anchor_id
        mock_anchor.is_snapshot = True
        mock_anchor.blob = adapter.serialize_snapshot({"key": "v1"})

        mock_diff = MagicMock(spec=VersionHistory)
        mock_diff.id = diff_id
        mock_diff.is_snapshot = False
        mock_diff.resource_id = rid
        mock_diff.base_history_id = anchor_id
        mock_diff.blob = b"irrelevant"

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                qs.values_list.return_value.first.return_value = (True, None)
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(
                    return_value=iter([mock_anchor, mock_diff])
                )
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(mock_diff)

        err = exc_info.value
        assert err.error_code == RebuildError.DIFF_APPLY_FAILED
        assert err.__cause__ is not None
        assert isinstance(err.__cause__, ValueError)
        assert "simulated corruption" in str(err.__cause__)


    def test_diff_apply_null_returns_structured_error(self):
        """apply_diff 返回 None → DIFF_APPLY_NULL，携带 null_diff_id。"""

        class _NullAdapter(_MockAdapter):
            def apply_diff(self, base_data, diff_blob):
                return None

        adapter = _NullAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        mock_anchor = MagicMock(spec=VersionHistory)
        mock_anchor.id = anchor_id
        mock_anchor.is_snapshot = True
        mock_anchor.blob = adapter.serialize_snapshot({"key": "v1"})

        mock_diff = MagicMock(spec=VersionHistory)
        mock_diff.id = diff_id
        mock_diff.is_snapshot = False
        mock_diff.resource_id = rid
        mock_diff.base_history_id = anchor_id
        mock_diff.blob = adapter.compress_json({"_changes": {"key": "v2"}})

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                qs.values_list.return_value.first.return_value = (True, None)
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(
                    return_value=iter([mock_anchor, mock_diff])
                )
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(mock_diff)

        err = exc_info.value
        assert err.error_code == RebuildError.DIFF_APPLY_NULL
        assert err.context["null_diff_id"] == str(diff_id)

    def test_chain_too_deep_raises_structured_error(self):
        """链路深度超过 MAX_CHAIN_DEPTH → CHAIN_TOO_DEEP。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        rid = uuid.uuid4()
        diff_id = uuid.uuid4()
        parent_id = uuid.uuid4()

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = parent_id

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs:
                new_parent = uuid.uuid4()
                qs.values_list.return_value.first.return_value = (False, new_parent)
            return qs

        with patch("apps.collab.service.transaction"), \
             patch("apps.collab.service.MAX_CHAIN_DEPTH", 3), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.CHAIN_TOO_DEEP
        assert err.context["max_depth"] == 3

    def test_diff_entry_missing_in_batch_query(self):
        """diff 条目在阶段2批量查询中缺失 → DIFF_ENTRY_MISSING。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        mock_anchor = MagicMock(spec=VersionHistory)
        mock_anchor.id = anchor_id
        mock_anchor.is_snapshot = True
        mock_anchor.blob = adapter.serialize_snapshot({"key": "v1"})

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = anchor_id

        def mock_filter(**kwargs):
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                qs.values_list.return_value.first.return_value = (True, None)
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(return_value=iter([mock_anchor]))
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.DIFF_ENTRY_MISSING
        assert err.context["missing_diff_id"] == str(diff_id)


class TestCL018AnchorMissingDiagnostics:
    """CL-018: anchor 在阶段1/2之间消失时的竞态诊断。"""

    def test_anchor_missing_cleanup_race_diagnosis(self):
        """anchor 在阶段2批量查询中缺失，事务外也不存在
        → probable_cause=concurrent_cleanup_deleted。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = anchor_id

        call_count = [0]

        def mock_filter(**kwargs):
            nonlocal call_count
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                call_count[0] += 1
                if call_count[0] == 1:
                    qs.values_list.return_value.first.return_value = (True, None)
                else:
                    qs.values_list.return_value.first.return_value = None
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(return_value=iter([]))
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.ANCHOR_MISSING
        assert err.context["probable_cause"] == "concurrent_cleanup_deleted"
        assert err.context["anchor_id"] == str(anchor_id)
        assert err.context["anchor_exists_outside_tx"] is False


    def test_anchor_missing_transaction_read_anomaly(self):
        """anchor 在阶段2缺失但事务外仍存在
        → probable_cause=transaction_read_anomaly。"""
        from datetime import datetime

        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = diff_id
        history.resource_id = rid
        history.base_history_id = anchor_id

        call_count = [0]

        def mock_filter(**kwargs):
            nonlocal call_count
            qs = MagicMock()
            if "id" in kwargs and kwargs["id"] == anchor_id:
                call_count[0] += 1
                if call_count[0] == 1:
                    qs.values_list.return_value.first.return_value = (True, None)
                else:
                    qs.values_list.return_value.first.return_value = (
                        anchor_id,
                        datetime(2026, 6, 1),
                        False,
                        False,
                    )
            elif "id__in" in kwargs:
                qs.__iter__ = MagicMock(return_value=iter([]))
            else:
                qs.values_list.return_value.first.return_value = None
            return qs

        with patch("apps.collab.service.transaction"), \
             patch.object(VersionHistory.objects, "using") as mock_using:
            mock_mgr = MagicMock()
            mock_mgr.filter.side_effect = mock_filter
            mock_using.return_value = mock_mgr

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        err = exc_info.value
        assert err.error_code == RebuildError.ANCHOR_MISSING
        assert err.context["probable_cause"] == "transaction_read_anomaly"
        assert err.context["anchor_exists_outside_tx"] is True


class TestRestoreToVersionPropagatesRebuildError:
    """CL-012: restore_to_version 将 RebuildError 包装为 RestoreError。"""

    def test_rebuild_error_wrapped_in_restore_error(self):
        """rebuild_data 抛出 RebuildError → RestoreError(REBUILD_FAILED)
        包含详细 context。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        target_vh = MagicMock(spec=VersionHistory)
        target_vh.id = vid
        target_vh.name = ""

        rebuild_err = RebuildError(
            RebuildError.ANCHOR_MISSING,
            "test anchor missing",
            {"anchor_id": "abc", "probable_cause": "concurrent_cleanup_deleted"},
        )

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", side_effect=rebuild_err):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, vid, _editor())

        err = exc_info.value
        assert err.error_type == RestoreError.REBUILD_FAILED
        assert "ANCHOR_MISSING" in str(err)
        assert err.context["probable_cause"] == "concurrent_cleanup_deleted"

    def test_rebuild_returns_none_raises_restore_error(self):
        """rebuild_data 返回 None（快照反序列化失败）
        → RestoreError(REBUILD_FAILED)。"""
        adapter = _MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        vid = uuid.uuid4()

        target_vh = MagicMock(spec=VersionHistory)
        target_vh.id = vid
        target_vh.name = ""

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, vid, _editor())

        err = exc_info.value
        assert err.error_type == RestoreError.REBUILD_FAILED
        assert "deserialization returned None" in str(err)
