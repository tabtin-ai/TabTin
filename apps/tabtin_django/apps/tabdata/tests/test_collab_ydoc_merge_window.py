"""
A4-L1: CollabYDocSubscriber 合并窗口 + originId 单元测试

验证：
1. 合并窗口 = 0 时直接推送（无合并）
2. 合并窗口 > 0 时同一 table 的变更在窗口内合并
3. 不同 table 的变更各自独立窗口
4. buffer 超阈值时立即 flush
5. origin_id 正确传递到 push_cells
6. _get_origin_id 从 thread_context 提取 user_id
"""
import time
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import TestCase, override_settings

from apps.tabdata.subscribers.collab_ydoc import (
    _MergeWindowManager,
    _get_origin_id,
    _MERGE_WINDOW_FLUSH_THRESHOLD,
)


class MergeWindowManagerTest(TestCase):
    """_MergeWindowManager 合并逻辑"""

    def setUp(self):
        self.mgr = _MergeWindowManager()
        self.table_id = uuid4()
        self.table_key = str(self.table_id)
        self.changes_a = [
            {"record_id": "r1", "field_id_hex": "f1", "value": "v1"},
        ]
        self.changes_b = [
            {"record_id": "r2", "field_id_hex": "f2", "value": "v2"},
        ]

    def tearDown(self):
        self.mgr.flush_all()

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_window_zero_immediate_push(self, mock_push, _mock_skip):
        """窗口=0 时每次 add 立即 flush"""
        self.mgr.add(self.table_key, self.table_id, self.changes_a, "user-1")
        mock_push.assert_called_once()
        args = mock_push.call_args
        self.assertEqual(args.kwargs["table_id"], self.table_id)
        self.assertEqual(args.kwargs["origin_id"], "user-1")
        self.assertEqual(len(args.kwargs["changes"]), 1)

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_window_merges_changes(self, mock_push, _mock_skip):
        """窗口>0 时同一 table 的变更合并"""
        self.mgr.add(self.table_key, self.table_id, self.changes_a, "user-1")
        self.mgr.add(self.table_key, self.table_id, self.changes_b, "user-1")
        mock_push.assert_not_called()

        self.mgr.flush_all()
        mock_push.assert_called_once()
        pushed_changes = mock_push.call_args.kwargs["changes"]
        self.assertEqual(len(pushed_changes), 2)

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_different_tables_independent(self, mock_push, _mock_skip):
        """不同 table 各自独立窗口"""
        table_id_2 = uuid4()
        table_key_2 = str(table_id_2)

        self.mgr.add(self.table_key, self.table_id, self.changes_a, "user-1")
        self.mgr.add(table_key_2, table_id_2, self.changes_b, "user-2")

        self.mgr.flush_all()
        self.assertEqual(mock_push.call_count, 2)

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_threshold_immediate_flush(self, mock_push, _mock_skip):
        """buffer 超阈值时立即 flush（分批推送）"""
        big_changes = [
            {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
            for i in range(_MERGE_WINDOW_FLUSH_THRESHOLD)
        ]
        self.mgr.add(self.table_key, self.table_id, big_changes, "user-1")
        # _COLLAB_PUSH_BATCH_SIZE=200, 500 changes → 3 batches
        self.assertTrue(mock_push.called)
        total_pushed = sum(
            len(call.kwargs["changes"]) for call in mock_push.call_args_list
        )
        self.assertEqual(total_pushed, _MERGE_WINDOW_FLUSH_THRESHOLD)

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=50)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_timer_fires_after_window(self, mock_push, _mock_skip):
        """窗口到期后 timer 自动 flush"""
        self.mgr.add(self.table_key, self.table_id, self.changes_a, "user-1")
        mock_push.assert_not_called()

        time.sleep(0.15)
        mock_push.assert_called_once()

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_origin_id_multi_source_downgrades_to_empty(self, mock_push, _mock_skip):
        """W3.2 D1-5 P1-1 修(产品/用户视角 Review):同窗口多 origin → 降级为空串。

        旧行为(last-wins)在不同用户 push 80ms 内交错时会让一方被错误归因；
        新行为统一降级,
        前端 fallback 走默认 CRDT 渲染(数据正确,语义降级)。
        """
        self.mgr.add(self.table_key, self.table_id, self.changes_a, "user-1")
        self.mgr.add(self.table_key, self.table_id, self.changes_b, "user-2")

        self.mgr.flush_all()
        self.assertEqual(mock_push.call_args.kwargs["origin_id"], "")

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    def test_pending_count(self):
        """pending_count 正确反映 buffer 大小"""
        self.assertEqual(self.mgr.pending_count(self.table_key), 0)


class GetOriginIdTest(TestCase):
    """_get_origin_id 从上下文提取"""

    @patch("apps.services.common.thread_context.get_current_user_id", return_value="uid-123")
    def test_returns_user_id_from_thread_context(self, _mock):
        self.assertEqual(_get_origin_id(), "uid-123")

    @patch("apps.services.common.thread_context.get_current_user_id", return_value=None)
    @patch("apps.tabdata.request_context.get_current_window_id", return_value="win-456")
    def test_fallback_to_window_id(self, _mock_win, _mock_uid):
        self.assertEqual(_get_origin_id(), "win-456")

    @patch("apps.services.common.thread_context.get_current_user_id", return_value=None)
    @patch("apps.tabdata.request_context.get_current_window_id", return_value=None)
    def test_returns_empty_when_no_context(self, _mock_win, _mock_uid):
        self.assertEqual(_get_origin_id(), "")
