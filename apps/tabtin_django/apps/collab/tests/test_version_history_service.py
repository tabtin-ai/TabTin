"""
VersionHistoryService 核心路径测试

覆盖 5 个关键路径（对应设计文档 report-S3-06.md）:
1. create_history 正常路径 — 首次快照 / 增量 diff / 命名版本 / 无变更跳过
2. create_history 锁争抢 — cache 锁获取失败 / finally 释放 / 资源隔离
3. cleanup_expired 锚点保护 — 被引用 snapshot 不删 / 命名+置顶过滤
4. restore 基本路径 — 数据正确恢复 + ChangeLog + 异常路径
5. cleanup/downsample 互斥 — MAINTENANCE_LOCK_KEY 共享锁防护
"""
import base64
import os

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import uuid  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

import pytest  # noqa: E402

from apps.collab.adapters.base import CollabAdapter  # noqa: E402
from apps.collab.models import ChangeLog, VersionHistory  # noqa: E402
from apps.collab.service import DB_ALIAS, RestoreError, VersionHistoryService  # noqa: E402
from apps.collab.tasks import (  # noqa: E402
    MAINTENANCE_LOCK_KEY,
    CLEANUP_LOCK_KEY,
    DOWNSAMPLE_LOCK_KEY,
    cleanup_expired_versions,
    downsample_versions,
)


# ── 共享 Fixture ──────────────────────────────────────────


class MockAdapter(CollabAdapter):
    """测试用 mock adapter，操作纯 JSON 数据。与 test_service.py 保持一致。"""

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
# 1. create_history 正常路径
# ═══════════════════════════════════════════════════════════


class TestCreateHistoryNormalPath:
    """TC-CH-01 ~ TC-CH-05: create_history 正常路径。"""

    def test_first_create_produces_snapshot(self):
        """TC-CH-01: 首次创建（should_create_snapshot=True）→ 全量快照，字段正确。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        data = {"title": "测试", "content": "hello"}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=True):
            mock_cache.add.return_value = True
            vh = svc.create_history(rid, data, _editor())

        assert vh is not None
        assert vh.is_snapshot is True
        assert vh.base_history is None
        assert vh.resource_type == "test"
        assert vh.resource_id == rid
        assert vh.editor_type == "user"
        assert vh.editor_id == "test-user-123"
        assert vh.editor_name == "测试用户"
        assert vh.metadata == {"key_count": 2}
        assert vh.blob_size == len(vh.blob)
        assert vh.blob_size > 0

        rebuilt = adapter.deserialize_snapshot(vh.blob)
        assert rebuilt == data

    def test_second_create_produces_diff(self):
        """TC-CH-02: 有快照基础且 diff 未超阈值 → 增量 diff。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        base_data = {"title": "v1"}
        base_blob = adapter.serialize_snapshot(base_data)
        base_vh = VersionHistory(
            id=uuid.uuid4(),
            resource_type="test",
            resource_id=rid,
            blob=base_blob,
            blob_size=len(base_blob),
            is_snapshot=True,
        )

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_vh):
            mock_cache.add.return_value = True
            vh = svc.create_history(rid, {"title": "v2", "extra": True}, _editor())

        assert vh is not None
        assert vh.is_snapshot is False
        assert vh.base_history is base_vh
        assert vh.blob_size > 0

    def test_named_version_always_snapshot_no_expiry(self):
        """TC-CH-04: 命名版本始终全量快照且 expired_at=None。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()):
            mock_cache.add.return_value = True
            vh = svc.create_history(
                rid, {"title": "发布版"}, _editor(),
                is_named=True, name="v1.0",
            )

        assert vh is not None
        assert vh.is_snapshot is True
        assert vh.is_named is True
        assert vh.name == "v1.0"
        assert vh.expired_at is None

    def test_no_diff_returns_none(self):
        """TC-CH-05: compute_diff 返回 None（无变更）→ 返回 None 不创建。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        data = {"title": "same"}

        base_blob = adapter.serialize_snapshot(data)
        base_vh = MagicMock()
        base_vh.id = uuid.uuid4()
        base_vh.blob = base_blob

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save") as mock_save, \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_vh):
            mock_cache.add.return_value = True
            vh = svc.create_history(rid, data, _editor())

        assert vh is None
        mock_save.assert_not_called()

    def test_safe_editor_info_filters_extra_keys(self):
        """TC-REVN-02: editor_info 含额外键 → 不污染 ORM 字段。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        editor = {
            "editor_type": "agent", "editor_id": "a1",
            "editor_name": "Bot", "hack_key": "evil",
        }

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=True):
            mock_cache.add.return_value = True
            vh = svc.create_history(rid, {"x": 1}, editor)

        assert vh is not None
        assert vh.editor_type == "agent"
        assert vh.editor_id == "a1"
        assert not hasattr(vh, "hack_key")


# ═══════════════════════════════════════════════════════════
# 2. create_history 锁争抢
# ═══════════════════════════════════════════════════════════


class TestCreateHistoryLockContention:
    """TC-LOCK-01 ~ TC-LOCK-03: cache 锁争抢防护。"""

    def test_lock_contention_returns_none(self):
        """TC-LOCK-01: cache.add 返回 False → 返回 None，_do_create_history 未调用。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "_do_create_history") as mock_do:
            mock_cache.add.return_value = False
            result = svc.create_history(rid, {"a": 1}, _editor())

        assert result is None
        mock_do.assert_not_called()

    def test_lock_released_in_finally_even_on_exception(self):
        """TC-LOCK-02: _do_create_history 抛异常 → finally 中锁仍被释放。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        lock_key = f"collab:create_history_lock:test:{rid}"

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "_do_create_history", side_effect=RuntimeError("boom")):
            mock_cache.add.return_value = True

            with pytest.raises(RuntimeError, match="boom"):
                svc.create_history(rid, {}, _editor())

            mock_cache.delete.assert_called_once_with(lock_key)

    def test_different_resources_locks_independent(self):
        """TC-LOCK-03: 不同 resource_id 的锁互不干扰。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid_a = uuid.uuid4()
        rid_b = uuid.uuid4()
        lock_key_a = f"collab:create_history_lock:test:{rid_a}"

        mock_result = MagicMock(spec=VersionHistory)

        def selective_lock(key, value, timeout):
            return key != lock_key_a

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "_do_create_history", return_value=mock_result):
            mock_cache.add.side_effect = selective_lock

            assert svc.create_history(rid_a, {"x": 1}, _editor()) is None
            assert svc.create_history(rid_b, {"x": 1}, _editor()) is mock_result

    def test_writer_rechecks_restore_lock_after_acquiring_its_lock(self):
        """版本写不能在首次检查后、真正写入前穿过并发恢复。"""
        from apps.collab.service import RestoreInProgress

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        restore_key = f"collab:restore_lock:test:{rid}"
        reads = 0

        def read_lock(key):
            nonlocal reads
            if key != restore_key:
                return None
            reads += 1
            return None if reads == 1 else 1

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "_do_create_history") as mock_do:
            mock_cache.add.return_value = True
            mock_cache.get.side_effect = read_lock

            with pytest.raises(RestoreInProgress):
                svc.create_history(rid, {"x": 1}, _editor())

        mock_do.assert_not_called()
        mock_cache.delete.assert_called_once_with(
            f"collab:create_history_lock:test:{rid}"
        )


# ═══════════════════════════════════════════════════════════
# 3. cleanup_expired 锚点保护
# ═══════════════════════════════════════════════════════════


class TestCleanupExpiredAnchorProtection:
    """TC-CLEAN-01 ~ TC-CLEAN-03: cleanup 锚点 / 命名 / 置顶保护。"""

    @staticmethod
    def _setup_cleanup_mocks(*, expired_ids_before_exclude, referenced_ids,
                             count_after_exclude):
        """构造 cleanup_expired 内部的 ORM mock 链。"""
        expired_qs = MagicMock(name="expired_qs")
        expired_qs.select_for_update.return_value = expired_qs

        after_exclude = MagicMock(name="after_exclude")
        after_exclude.count.return_value = count_after_exclude
        expired_qs.exclude.return_value = after_exclude

        if not referenced_ids:
            expired_qs.count.return_value = count_after_exclude

        ref_qs = MagicMock(name="ref_qs")
        ref_qs.values_list.return_value = list(referenced_ids)

        manager = MagicMock(name="using_manager")

        def filter_dispatch(**kwargs):
            if "expired_at__lt" in kwargs:
                return expired_qs
            if "base_history__isnull" in kwargs:
                return ref_qs
            return MagicMock()

        manager.filter.side_effect = filter_dispatch

        return manager, expired_qs, after_exclude

    def test_expired_unreferenced_deleted(self):
        """TC-CLEAN-01: 过期且未被引用的版本 → 被删除（使用 Exists 子查询，CC-009）。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        now_mock = MagicMock()
        to_delete_qs = MagicMock()
        to_delete_qs.count.return_value = 2

        is_referenced_qs = MagicMock()

        def mock_using(db):
            mgr = MagicMock()
            mgr.filter.return_value = is_referenced_qs
            return mgr

        with patch.object(VersionHistory.objects, "using", side_effect=mock_using), \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.timezone") as mock_tz:
            mock_tz.now.return_value = now_mock
            mock_tx.atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            filter_qs = MagicMock()
            filter_qs.select_for_update.return_value.exclude.return_value = to_delete_qs

            with patch.object(VersionHistory.objects, "using") as mock_obj_using:
                mock_obj_using.return_value.filter.return_value = filter_qs
                mock_obj_using.return_value.filter.return_value.select_for_update.return_value.exclude.return_value = to_delete_qs

                count = svc.cleanup_expired_versions()

        assert count == 2
        to_delete_qs.delete.assert_called_once()

    def test_referenced_snapshot_excluded_from_deletion(self):
        """TC-CLEAN-02: 被 diff 引用的过期 snapshot → 通过 Exists 子查询排除（CC-009）。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        to_delete_qs = MagicMock()
        to_delete_qs.count.return_value = 0

        with patch.object(VersionHistory.objects, "using") as mock_obj_using, \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.timezone") as mock_tz:
            mock_tz.now.return_value = MagicMock()
            mock_tx.atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            filter_qs = MagicMock()
            filter_qs.select_for_update.return_value.exclude.return_value = to_delete_qs
            mock_obj_using.return_value.filter.return_value = filter_qs

            count = svc.cleanup_expired_versions()

        assert count == 0
        to_delete_qs.delete.assert_not_called()

    def test_filter_excludes_named_and_pinned(self):
        """TC-CLEAN-03 + TC-CLEAN-04: ORM filter 包含 is_named=False, pinned=False。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        to_delete_qs = MagicMock()
        to_delete_qs.count.return_value = 0

        with patch.object(VersionHistory.objects, "using") as mock_obj_using, \
             patch("apps.collab.service.transaction") as mock_tx, \
             patch("apps.collab.service.timezone") as mock_tz:
            mock_tz.now.return_value = MagicMock()
            mock_tx.atomic.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.atomic.return_value.__exit__ = MagicMock(return_value=False)

            filter_qs = MagicMock()
            filter_qs.select_for_update.return_value.exclude.return_value = to_delete_qs
            mock_obj_using.return_value.filter.return_value = filter_qs

            svc.cleanup_expired_versions()

        filter_calls = mock_obj_using.return_value.filter.call_args_list
        expired_call = next(c for c in filter_calls if "expired_at__lt" in c[1])
        assert expired_call[1]["is_named"] is False
        assert expired_call[1]["pinned"] is False


# ═══════════════════════════════════════════════════════════
# 4. restore 基本路径
# ═══════════════════════════════════════════════════════════


class TestRestoreBasicPath:
    """TC-REST-01 ~ TC-REST-06: restore 基本路径。"""

    def test_restore_data_correct_and_changelog_created(self):
        """TC-REST-01: 恢复 → 数据正确写回 + ChangeLog 创建。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        original = {"title": "原始版本", "content": "hello"}

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = "v1"

        new_vh = MagicMock(spec=VersionHistory)
        new_vh.is_snapshot = True

        resource = {"id": str(rid), "data": {"title": "已修改"}}
        adapter._resources[str(rid)] = resource

        # SR-017: _do_restore 现在调用 _do_create_history（绕过 Redis 锁）
        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value=original), \
             patch.object(svc, "_do_create_history", return_value=new_vh), \
             patch.object(ChangeLog.objects, "using") as mock_cl_using:
            mock_cache.add.return_value = True
            result = svc.restore_to_version(rid, target_vh.id, _editor())

        assert result is new_vh
        assert resource["data"] == original
        assert adapter._restored[str(rid)] == original

        mock_cl_using.return_value.create.assert_called_once()
        cl_kwargs = mock_cl_using.return_value.create.call_args[1]
        assert cl_kwargs["change_type"] == "restore"
        assert cl_kwargs["changes"]["restored_from"] == str(target_vh.id)
        assert cl_kwargs["editor_type"] == "user"
        assert cl_kwargs["version_history"] is new_vh

    def test_restore_creates_force_snapshot(self):
        """恢复操作调用 _do_create_history 时 force_snapshot=True。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = ""

        adapter._resources[str(rid)] = {"id": str(rid), "data": {}}

        # SR-017: _do_restore 现在调用 _do_create_history（绕过 Redis 锁）
        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"v": 1}), \
             patch.object(svc, "_do_create_history", return_value=MagicMock()) as mock_dch, \
             patch.object(ChangeLog.objects, "using"):
            mock_cache.add.return_value = True
            svc.restore_to_version(rid, target_vh.id, _editor())

        mock_dch.assert_called_once()
        _, kwargs = mock_dch.call_args
        assert kwargs["force_snapshot"] is True

    def test_restore_created_history_inherits_target_metadata(self):
        """恢复后新写入的 VH 应继承目标 metadata，保留 TabDoc title 等旁路元数据。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = ""
        target_vh.metadata = {"tabdoc_title": "恢复前标题"}

        adapter._resources[str(rid)] = {"id": str(rid), "data": {}}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"v": 1}), \
             patch.object(svc, "_do_create_history", return_value=MagicMock()) as mock_dch, \
             patch.object(ChangeLog.objects, "using"):
            mock_cache.add.return_value = True
            svc.restore_to_version(rid, target_vh.id, _editor())

        _, kwargs = mock_dch.call_args
        assert kwargs["extra_metadata"] == {"tabdoc_title": "恢复前标题"}

    def test_restore_legacy_binary_snapshot_writes_raw_history_with_title_metadata(self):
        """恢复存量 binary_snapshot 时，新 VH 不应继续写出 wrapper blob。"""
        adapter = MockAdapter()
        adapter.resource_type = "docs"
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        raw_binary = b"legacy-yjs"
        legacy_snapshot = {
            "format": "binary_snapshot",
            "title": "旧 envelope 标题",
            "binary_b64": base64.b64encode(raw_binary).decode(),
        }

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = ""
        target_vh.metadata = {}

        adapter._resources[str(rid)] = {"id": str(rid), "data": {}}

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value=legacy_snapshot), \
             patch.object(svc, "_do_create_history", return_value=MagicMock()) as mock_dch, \
             patch.object(ChangeLog.objects, "using"):
            mock_cache.add.return_value = True
            svc.restore_to_version(rid, target_vh.id, _editor())

        args, kwargs = mock_dch.call_args
        assert args[1] == raw_binary
        assert kwargs["extra_metadata"] == {"tabdoc_title": "旧 envelope 标题"}

    def test_restore_nonexistent_version_returns_none(self):
        """TC-REST-04: 版本不存在 → 抛出 RestoreError(VERSION_NOT_FOUND)，adapter.restore 未调用。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=None):
            mock_cache.add.return_value = True
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(uuid.uuid4(), uuid.uuid4(), _editor())

        assert exc_info.value.error_type == RestoreError.VERSION_NOT_FOUND
        assert adapter.restore_call_count == 0

    def test_restore_nonexistent_resource_returns_none(self):
        """TC-REST-06: 资源不存在 → 抛出 RestoreError(RESOURCE_NOT_FOUND)。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"a": 1}):
            mock_cache.add.return_value = True
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, target_vh.id, _editor())

        assert exc_info.value.error_type == RestoreError.RESOURCE_NOT_FOUND
        assert adapter.restore_call_count == 0

    def test_restore_create_history_none_rolls_back_transaction(self):
        """DC-010 回归: _do_create_history 返回 None 时事务回滚，ChangeLog 不创建。

        修复前的行为是创建 ChangeLog 但 version_history=NULL（审计链路断裂）。
        修复后 _do_restore 抛出 RuntimeError 使事务回滚，restore_to_version
        抛出 RestoreError(HISTORY_WRITE_FAILED)。
        """
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()
        original = {"title": "v1-data"}

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = "v1"

        resource = {"id": str(rid), "data": {"title": "current"}}
        adapter._resources[str(rid)] = resource

        # SR-017: _do_restore 现在调用 _do_create_history（绕过 Redis 锁）
        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value=original), \
             patch.object(svc, "_do_create_history", return_value=None), \
             patch.object(ChangeLog.objects, "using") as mock_cl_using, \
             patch("apps.collab.service.logger"):
            mock_cache.add.return_value = True
            with pytest.raises(RestoreError) as exc_info:
                svc.restore_to_version(rid, target_vh.id, _editor())

        assert exc_info.value.error_type == RestoreError.HISTORY_WRITE_FAILED
        mock_cl_using.return_value.create.assert_not_called()

    def test_do_restore_raises_when_create_history_returns_none(self):
        """DC-010 回归: _do_restore 内 _do_create_history 返回 None 时抛出 RuntimeError。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = ""

        resource = {"id": str(rid), "data": {}}
        adapter._resources[str(rid)] = resource

        # SR-017: _do_restore 现在调用 _do_create_history（绕过 Redis 锁）
        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"v": 1}), \
             patch.object(svc, "_do_create_history", return_value=None):
            mock_cache.add.return_value = True

            with pytest.raises(RuntimeError, match="_do_create_history returned None"):
                svc._do_restore(rid, target_vh.id, _editor())


# ═══════════════════════════════════════════════════════════
# 4b. diff chain 扁平结构不变量 (DC-009)
# ═══════════════════════════════════════════════════════════


class TestDiffChainFlatStructure:
    """DC-009 回归: 验证 diff 的 base_history 始终指向 snapshot，链深度为 1。"""

    def test_diff_base_history_points_to_snapshot(self):
        """_do_create_history 创建 diff 时 base_history 是最近的 snapshot。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        base_data = {"title": "v1"}
        base_blob = adapter.serialize_snapshot(base_data)
        base_vh = VersionHistory(
            id=uuid.uuid4(),
            resource_type="test",
            resource_id=rid,
            blob=base_blob,
            blob_size=len(base_blob),
            is_snapshot=True,
        )

        with patch("apps.collab.service.cache") as mock_cache, \
             patch.object(VersionHistory, "save"), \
             patch.object(svc, "_base_qs", return_value=MagicMock()), \
             patch.object(svc, "is_too_recent", return_value=False), \
             patch.object(svc, "should_create_snapshot", return_value=False), \
             patch.object(svc, "find_last_snapshot", return_value=base_vh):
            mock_cache.add.return_value = True
            vh = svc.create_history(rid, {"title": "v2"}, _editor())

        assert vh is not None
        assert vh.is_snapshot is False
        assert vh.base_history is base_vh
        assert base_vh.is_snapshot is True

    def test_consecutive_diffs_all_point_to_same_snapshot(self):
        """多次增量 diff 均指向同一个 snapshot 锚点（扁平，非链式）。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        base_data = {"title": "v1"}
        base_blob = adapter.serialize_snapshot(base_data)
        base_vh = VersionHistory(
            id=uuid.uuid4(),
            resource_type="test",
            resource_id=rid,
            blob=base_blob,
            blob_size=len(base_blob),
            is_snapshot=True,
        )

        diffs = []
        for i in range(3):
            with patch("apps.collab.service.cache") as mock_cache, \
                 patch.object(VersionHistory, "save"), \
                 patch.object(svc, "_base_qs", return_value=MagicMock()), \
                 patch.object(svc, "is_too_recent", return_value=False), \
                 patch.object(svc, "should_create_snapshot", return_value=False), \
                 patch.object(svc, "find_last_snapshot", return_value=base_vh):
                mock_cache.add.return_value = True
                vh = svc.create_history(
                    rid, {"title": f"v{i + 2}"}, _editor(),
                )
            assert vh is not None
            diffs.append(vh)

        for d in diffs:
            assert d.is_snapshot is False
            assert d.base_history is base_vh, (
                "diff should point directly to snapshot, not to another diff"
            )


# ═══════════════════════════════════════════════════════════
# 5. cleanup / downsample 互斥
# ═══════════════════════════════════════════════════════════


class TestCleanupDownsampleMutualExclusion:
    """Tasks 通过独立锁 key 各自互斥执行（CC-017：cleanup/downsample 已拆分为独立锁）。"""

    def test_cleanup_uses_cleanup_lock_key(self):
        """cleanup 使用 CLEANUP_LOCK_KEY，downsample 使用 DOWNSAMPLE_LOCK_KEY（CC-017 拆分）。"""
        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False

            cleanup_expired_versions()
            downsample_versions()

            calls = mock_cache.add.call_args_list
            assert len(calls) == 2
            assert calls[0][0][0] == CLEANUP_LOCK_KEY
            assert calls[1][0][0] == DOWNSAMPLE_LOCK_KEY

    def test_lock_values_distinguish_tasks(self):
        """锁值区分任务来源: cleanup='cleanup', downsample='downsample'。"""
        with patch("apps.collab.tasks.cache") as mock_cache:
            mock_cache.add.return_value = False

            cleanup_expired_versions()
            downsample_versions()

            calls = mock_cache.add.call_args_list
            assert calls[0][0][1] == "cleanup"
            assert calls[1][0][1] == "downsample"

    def test_cleanup_lock_held_blocks_cleanup_only(self):
        """cleanup 锁被占用 → cleanup 返回 0，downsample 可独立执行（CC-017 并行）。"""
        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.return_value = False
            mock_svc = MagicMock()
            mock_svc.cleanup_expired_versions.return_value = 5
            MockSvc.return_value = mock_svc

            cleanup_result = cleanup_expired_versions()

        assert cleanup_result == 0

    def test_lock_released_after_success(self):
        """cleanup 任务成功完成后 finally 中释放 CLEANUP_LOCK_KEY。"""
        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.return_value = True
            mock_svc = MagicMock()
            mock_svc.cleanup_expired_versions.return_value = 0
            MockSvc.return_value = mock_svc

            cleanup_expired_versions()

            mock_cache.delete.assert_called_once_with(CLEANUP_LOCK_KEY)

    def test_lock_released_on_internal_error(self):
        """cleanup 内部异常 → finally 中 CLEANUP_LOCK_KEY 仍被释放。"""
        with patch("apps.collab.tasks.cache") as mock_cache, \
             patch("apps.collab.tasks.VersionHistoryService") as MockSvc:
            mock_cache.add.return_value = True
            mock_svc = MagicMock()
            mock_svc.cleanup_expired_versions.side_effect = ValueError("db error")
            MockSvc.return_value = mock_svc

            try:
                cleanup_expired_versions()
            except Exception:
                pass

            mock_cache.delete.assert_called_with(CLEANUP_LOCK_KEY)


# ═══════════════════════════════════════════════════════════
# 6. SR-017 回归: _do_restore 不在事务内执行 Redis IO
# ═══════════════════════════════════════════════════════════


class TestSR017RestoreNoRedisInTransaction:
    """SR-017 回归: _do_restore 调用 _do_create_history 而非 create_history，
    确保 DB 事务内不包含 Redis cache.add/cache.delete 操作。"""

    def test_do_restore_calls_do_create_history_not_create_history(self):
        """_do_restore 直接调用 _do_create_history，绕过 Redis 锁。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = "v1"

        new_vh = MagicMock(spec=VersionHistory)
        new_vh.is_snapshot = True

        resource = {"id": str(rid), "data": {}}
        adapter._resources[str(rid)] = resource

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"v": 1}), \
             patch.object(svc, "_do_create_history", return_value=new_vh) as mock_dch, \
             patch.object(svc, "create_history") as mock_ch, \
             patch.object(ChangeLog.objects, "using"):
            mock_cache.add.return_value = True
            svc.restore_to_version(rid, target_vh.id, _editor())

        mock_dch.assert_called_once()
        mock_ch.assert_not_called()

    def test_do_restore_no_create_history_lock_redis_calls(self):
        """_do_restore 执行期间不调用 create_history 级别的 Redis 锁。

        restore_to_version 本身的 restore_lock 仍使用 cache.add，
        但 _do_restore 内不应再有额外的 cache.add/cache.delete（create_history 锁）。
        """
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)
        rid = uuid.uuid4()

        target_vh = MagicMock()
        target_vh.id = uuid.uuid4()
        target_vh.name = ""

        new_vh = MagicMock(spec=VersionHistory)

        resource = {"id": str(rid), "data": {}}
        adapter._resources[str(rid)] = resource

        with patch("apps.collab.service.cache") as mock_cache, \
             patch("apps.collab.service.transaction"), \
             patch.object(svc, "get_version", return_value=target_vh), \
             patch.object(svc, "rebuild_data", return_value={"v": 1}), \
             patch.object(svc, "_do_create_history", return_value=new_vh), \
             patch.object(ChangeLog.objects, "using"):
            mock_cache.add.return_value = True
            svc.restore_to_version(rid, target_vh.id, _editor())

        # restore_to_version 只调用一次 cache.add（restore_lock），
        # 不应有 create_history_lock 的 cache.add
        restore_lock_key = f"collab:restore_lock:test:{rid}"
        create_lock_key = f"collab:create_history_lock:test:{rid}"

        add_calls = [c[0][0] for c in mock_cache.add.call_args_list]
        assert restore_lock_key in add_calls
        assert create_lock_key not in add_calls


# ═══════════════════════════════════════════════════════════
# 7. DC-019 回归: rebuild_data 链深度限制 + downsample 内存优化
# ═══════════════════════════════════════════════════════════


class TestDC019RebuildDataChainDepthLimit:
    """DC-019 回归: rebuild_data 的 MAX_CHAIN_DEPTH 限制。"""

    def test_chain_exceeding_max_depth_raises_rebuild_error(self):
        """链深度超过 MAX_CHAIN_DEPTH → 抛出 RebuildError(CHAIN_TOO_DEEP)。"""
        from apps.collab.service import MAX_CHAIN_DEPTH, RebuildError

        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        history = MagicMock(spec=VersionHistory)
        history.is_snapshot = False
        history.id = uuid.uuid4()
        history.resource_id = uuid.uuid4()
        history.base_history_id = uuid.uuid4()

        call_count = [0]
        def fake_query_first(*args, **kwargs):
            call_count[0] += 1
            return (False, uuid.uuid4())

        with patch("apps.collab.service.transaction"), \
             patch.object(
                 VersionHistory.objects, "using",
                 return_value=MagicMock(),
             ) as mock_using:
            mock_qs = MagicMock()
            mock_filter = MagicMock()
            mock_filter.values_list.return_value.first = fake_query_first
            mock_qs.filter.return_value = mock_filter
            mock_using.return_value = mock_qs

            with pytest.raises(RebuildError) as exc_info:
                svc.rebuild_data(history)

        assert exc_info.value.error_code == RebuildError.CHAIN_TOO_DEEP
        assert "MAX_CHAIN_DEPTH" in str(exc_info.value)

    def test_normal_chain_depth_one_works(self):
        """链深度为 1（标准扁平结构）→ 正常重建。"""
        adapter = MockAdapter()
        svc = VersionHistoryService(adapter)

        anchor_id = uuid.uuid4()
        diff_id = uuid.uuid4()
        rid = uuid.uuid4()

        base_data = {"title": "v1"}
        diff_data = {"_changes": {"title": "v2"}}

        anchor_vh = MagicMock(spec=VersionHistory)
        anchor_vh.id = anchor_id
        anchor_vh.is_snapshot = True
        anchor_vh.blob = adapter.serialize_snapshot(base_data)

        diff_vh = MagicMock(spec=VersionHistory)
        diff_vh.id = diff_id
        diff_vh.is_snapshot = False
        diff_vh.base_history_id = anchor_id
        diff_vh.resource_id = rid
        diff_vh.blob = adapter.compress_json(diff_data)

        def make_filter_side_effect(entry_map):
            def side_effect(**kwargs):
                mock_qs = MagicMock()
                if "id" in kwargs:
                    entry = entry_map.get(kwargs["id"])
                    if entry and hasattr(entry, 'is_snapshot'):
                        mock_qs.values_list.return_value.first.return_value = (
                            entry.is_snapshot, getattr(entry, 'base_history_id', None)
                        )
                    else:
                        mock_qs.values_list.return_value.first.return_value = None
                elif "id__in" in kwargs:
                    mock_qs.__iter__ = lambda s: iter(
                        [v for k, v in entry_map.items() if k in kwargs["id__in"]]
                    )
                return mock_qs
            return side_effect

        entry_map = {anchor_id: anchor_vh, diff_id: diff_vh}

        with patch("apps.collab.service.transaction"):
            mock_manager = MagicMock()
            mock_manager.filter.side_effect = make_filter_side_effect(entry_map)
            with patch.object(
                VersionHistory.objects, "using", return_value=mock_manager,
            ):
                result = svc.rebuild_data(diff_vh)

        assert result == {"title": "v2"}
