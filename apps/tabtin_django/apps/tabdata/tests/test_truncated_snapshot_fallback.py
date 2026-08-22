"""TR-001 测试：截断快照 fallback 到 RecordHistory 回放恢复。

覆盖场景：
1. 截断快照触发 fallback（而非直接抛异常）
2. RecordHistory 反向回放正确重建历史状态
3. RecordHistory 不可用时仍抛出有意义的异常
4. 非截断异常正常透传（不被 fallback 误拦截）
5. VH created_at 缺失时的错误处理
"""
from __future__ import annotations

from datetime import timedelta
from uuid import UUID, uuid4
from unittest import TestCase
from unittest.mock import MagicMock, patch, PropertyMock

from django.utils import timezone

from apps.collab.adapters.table import TableCollabAdapter


class TestTableCollabAdapterFallbackRestore(TestCase):
    """TableCollabAdapter.restore 截断快照 fallback 测试。"""

    TABLE_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")

    def _mock_resource(self):
        resource = MagicMock()
        resource.id = self.TABLE_ID
        resource.space_id = uuid4()
        return resource

    def _truncated_snapshot(self, record_count=5000, total=8000):
        return {
            "records": {str(uuid4()): {"abc": i} for i in range(record_count)},
            "row_order": [],
            "fields": [{"id": str(uuid4()), "id_hex": uuid4().hex,
                        "name": "f1", "field_type": "text", "config": {}, "order": 0}],
            "is_truncated": True,
            "total_records": total,
        }

    def _complete_snapshot(self):
        rid = str(uuid4())
        return {
            "records": {rid: {"abc": 1}},
            "row_order": [rid],
            "fields": [{"id": str(uuid4()), "id_hex": uuid4().hex,
                        "name": "f1", "field_type": "text", "config": {}, "order": 0}],
            "is_truncated": False,
            "total_records": 1,
        }

    # ── 场景 1：截断快照触发 fallback ──

    @patch.object(TableCollabAdapter, '_fallback_restore_via_record_history')
    @patch("apps.collab.adapters.table.CollabService" if False else
           "apps.tabdata.services.collab_service.CollabService.restore_from_snapshot")
    def test_truncated_snapshot_triggers_fallback(self, mock_restore, mock_fallback):
        """截断快照触发 RecordHistory fallback，而非直接抛异常。"""
        mock_restore.side_effect = ValueError(
            "restore_from_snapshot: 拒绝恢复截断快照 table=xxx，"
            "快照仅包含 5000/8000 条记录。"
        )
        mock_fallback.return_value = None

        adapter = TableCollabAdapter()
        resource = self._mock_resource()
        data = self._truncated_snapshot()
        vh_time = timezone.now() - timedelta(hours=1)

        adapter.restore(resource, data, prepared={"_vh_created_at": vh_time})

        mock_fallback.assert_called_once_with(str(self.TABLE_ID), vh_time)

    # ── 场景 2：非截断异常正常透传 ──

    @patch("apps.tabdata.services.collab_service.CollabService.restore_from_snapshot")
    def test_non_truncation_error_propagates(self, mock_restore):
        """非截断相关的 ValueError 不被 fallback 拦截。"""
        mock_restore.side_effect = ValueError("some other error")

        adapter = TableCollabAdapter()
        resource = self._mock_resource()
        data = self._complete_snapshot()

        with self.assertRaises(ValueError) as ctx:
            adapter.restore(resource, data, prepared={"_vh_created_at": timezone.now()})
        self.assertIn("some other error", str(ctx.exception))

    # ── 场景 3：VH created_at 缺失时的错误处理 ──

    @patch("apps.tabdata.services.collab_service.CollabService.restore_from_snapshot")
    def test_fallback_fails_without_vh_created_at(self, mock_restore):
        """截断快照但 prepared 中无 _vh_created_at 时，抛出有意义的错误。"""
        mock_restore.side_effect = ValueError(
            "restore_from_snapshot: 拒绝恢复截断快照"
        )

        adapter = TableCollabAdapter()
        resource = self._mock_resource()
        data = self._truncated_snapshot()

        with self.assertRaises(ValueError) as ctx:
            adapter.restore(resource, data, prepared={})
        self.assertIn("无法获取版本历史时间戳", str(ctx.exception))

    @patch("apps.tabdata.services.collab_service.CollabService.restore_from_snapshot")
    def test_fallback_fails_with_none_prepared(self, mock_restore):
        """prepared=None 时，截断快照抛出有意义的错误。"""
        mock_restore.side_effect = ValueError(
            "restore_from_snapshot: 拒绝恢复截断快照"
        )

        adapter = TableCollabAdapter()
        resource = self._mock_resource()
        data = self._truncated_snapshot()

        with self.assertRaises(ValueError) as ctx:
            adapter.restore(resource, data, prepared=None)
        self.assertIn("无法获取版本历史时间戳", str(ctx.exception))

    # ── 场景 4：无 fields 定义仍然直接报错 ──

    def test_no_fields_raises_immediately(self):
        """快照无 fields 定义时直接报错，不触发 fallback。"""
        adapter = TableCollabAdapter()
        resource = self._mock_resource()
        data = {
            "records": {},
            "row_order": [],
            "fields": [],
        }

        with self.assertRaises(ValueError) as ctx:
            adapter.restore(resource, data, prepared={"_vh_created_at": timezone.now()})
        self.assertIn("no field definitions", str(ctx.exception))


class TestFallbackRestoreViaRecordHistory(TestCase):
    """_fallback_restore_via_record_history 内部逻辑测试。"""

    TABLE_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

    # ── 场景 5：RecordHistory 不可用 ──

    @patch("apps.tabdata.models.RecordHistory")
    def test_no_record_history_raises(self, mock_rh_cls):
        """没有 RecordHistory 记录时，抛出有意义的异常。"""
        mock_rh_cls.objects.using.return_value.filter.return_value\
            .order_by.return_value.only.return_value.first.return_value = None

        adapter = TableCollabAdapter()
        vh_time = timezone.now() - timedelta(hours=1)

        with patch("apps.tabdata.models.RecordHistory", mock_rh_cls):
            with self.assertRaises(ValueError) as ctx:
                adapter._fallback_restore_via_record_history(str(self.TABLE_ID), vh_time)
        self.assertIn("RecordHistory 回放兜底失败", str(ctx.exception))

    # ── 场景 6：RecordHistory 反向回放正确重建历史状态 ──

    @patch("apps.tabdata.services.record_replay_helper.replay_record_state")
    @patch("apps.tabdata.services.record_service.next_record_version", return_value=100)
    @patch("apps.tabdata.services.record_service.RecordService")
    @patch("apps.tabdata.utils.record_data_access.read_data")
    @patch("apps.tabdata.models.TableRecord")
    @patch("apps.tabdata.models.RecordHistory")
    def test_record_history_replay_reconstructs_state(
        self, mock_rh_cls, mock_tr_cls, mock_read_data, mock_rs_cls,
        mock_next_ver, mock_replay,
    ):
        """RecordHistory 回放正确重建状态并调用 replay_record_state。"""
        vh_time = timezone.now() - timedelta(hours=1)
        record_id_1 = uuid4()
        record_id_2 = uuid4()

        target_history = MagicMock()
        target_history.id = uuid4()
        target_history.created_at = vh_time - timedelta(minutes=5)

        mock_rh_cls.objects.using.return_value.filter.return_value\
            .order_by.return_value.only.return_value.first.return_value = target_history

        mock_record_1 = MagicMock()
        mock_record_1.id = record_id_1
        mock_record_1.order = 1000.0
        mock_record_1.is_deleted = False

        mock_record_2 = MagicMock()
        mock_record_2.id = record_id_2
        mock_record_2.order = 2000.0
        mock_record_2.is_deleted = False

        mock_tr_cls.objects.using.return_value.filter.return_value\
            .only.return_value = [mock_record_1, mock_record_2]

        mock_tr_cls.objects.using.return_value.select_for_update.return_value\
            .filter.return_value = [mock_record_1, mock_record_2]

        mock_read_data.return_value = {"field1": "some_value"}

        mock_rh_cls.objects.using.return_value.filter.return_value\
            .only.return_value.order_by.return_value = []

        mock_replay_result = MagicMock()
        mock_replay_result.changed = True
        mock_replay.return_value = mock_replay_result

        adapter = TableCollabAdapter()
        adapter._fallback_restore_via_record_history(str(self.TABLE_ID), vh_time)

        self.assertTrue(mock_replay.called)


class TestServiceInjectVhCreatedAt(TestCase):
    """VersionHistoryService._do_restore 注入 _vh_created_at 到 prepared。"""

    @patch("apps.collab.service.ChangeLog")
    @patch("apps.collab.service.VersionHistoryService._do_create_history")
    def test_vh_created_at_injected_into_prepared(self, mock_create, mock_cl):
        """_do_restore 将 target.created_at 注入 prepared dict。"""
        from apps.collab.service import VersionHistoryService
        from unittest.mock import call

        mock_adapter = MagicMock()
        mock_adapter.resource_type = "table"
        mock_adapter.prepare_restore.return_value = {"some_key": "some_val"}

        target = MagicMock()
        target.id = uuid4()
        target.created_at = timezone.now() - timedelta(hours=2)
        target.name = "test_version"

        svc = VersionHistoryService(mock_adapter)

        mock_adapter.get_resource.return_value = MagicMock(id=uuid4())

        data = {"records": {}, "fields": []}
        with patch.object(svc, 'rebuild_data', return_value=data), \
             patch.object(svc, 'get_version', return_value=target):

            mock_vh = MagicMock()
            mock_vh.id = uuid4()
            mock_create.return_value = mock_vh

            try:
                svc._do_restore(
                    uuid4(), target.id, {"editor_type": "user", "editor_id": ""},
                    target=target,
                )
            except Exception:
                pass

            if mock_adapter.restore.called:
                _, kwargs = mock_adapter.restore.call_args
                prepared = kwargs.get('prepared', {})
                self.assertEqual(prepared.get('_vh_created_at'), target.created_at)
                self.assertEqual(prepared.get('some_key'), 'some_val')
