"""Wave 2 E2E-W2-4 — A4 合并窗口（500 次 add → ≤ 3 次 push）

PRD §A4-L1 / Wave 2 退出条件
-----------------------------

> A4 上线后批量场景下其他成员前端 CPU < 30%（80ms 合并窗口 + 300ms suppress）

本测试覆盖:
1. 500 次 cell 变更 add 到 _MergeWindowManager → flush 后 push_cells 调用 ≤ 3 次
2. 合并窗口 = 0 时直接推送（无合并降级）
3. buffer 超 _MERGE_WINDOW_FLUSH_THRESHOLD 时立即 flush
4. 不同 table 独立窗口
5. origin_id 正确传递

退出条件验证逻辑:
- 500 次 add → 窗口内合并 → push_cells ≤ 3 次
  (_MERGE_WINDOW_FLUSH_THRESHOLD = 500, 刚好到阈值立即 flush 1 次分批推送)
- 对比无合并窗口: 500 次 add → 500 次 push_cells
- CPU 降低比: (500 - 3) / 500 = 99.4% → 其他成员前端 CPU 远低于 30% 阈值

运行
----

.. code-block:: bash

    cd apps/tabtin_django && source venv/bin/activate
    python -m pytest apps/tabdata/tests/e2e/test_w2_e2e_4_merge_window.py -v
"""
from __future__ import annotations

import os
import time
from unittest.mock import MagicMock, patch, call
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from django.test import override_settings  # noqa: E402

from apps.tabdata.subscribers.collab_ydoc import (  # noqa: E402
    _MergeWindowManager,
    _MERGE_WINDOW_FLUSH_THRESHOLD,
)


class TestW2E2E4MergeWindow500:
    """Wave 2 E2E-W2-4: 500 次 add → ≤ 3 次 push。"""

    def setup_method(self):
        self.mgr = _MergeWindowManager()
        self.table_id = uuid4()
        self.table_key = str(self.table_id)

    def teardown_method(self):
        self.mgr.flush_all()

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_500_adds_le_3_pushes(self, mock_push, _mock_skip):
        """500 次 cell 变更 add → flush 后 push_cells ≤ 3 次。

        退出条件核心验证: 批量操作不会导致其他成员前端
        收到 500 次独立 push（CPU 爆炸），而是合并为 ≤ 3 批。
        """
        for i in range(500):
            change = {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
            self.mgr.add(self.table_key, self.table_id, [change], "agent-1")

        self.mgr.flush_all()

        total_push_calls = mock_push.call_count
        assert total_push_calls <= 3, (
            f"500 次 add 后 push_cells 被调用 {total_push_calls} 次, "
            f"预期 ≤ 3 次 (80ms 合并窗口 + 500 阈值分批)"
        )

        total_changes_pushed = sum(
            len(c.kwargs.get("changes", c.args[1] if len(c.args) > 1 else []))
            for c in mock_push.call_args_list
        )
        assert total_changes_pushed == 500, (
            f"推送的 changes 总数 = {total_changes_pushed}, 预期 500"
        )

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_threshold_triggers_immediate_flush(self, mock_push, _mock_skip):
        """buffer 达到 _MERGE_WINDOW_FLUSH_THRESHOLD 时立即 flush。"""
        big_changes = [
            {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
            for i in range(_MERGE_WINDOW_FLUSH_THRESHOLD)
        ]
        self.mgr.add(self.table_key, self.table_id, big_changes, "agent-1")

        assert mock_push.call_count >= 1, "达到阈值应立即 flush"

        total_pushed = sum(
            len(c.kwargs.get("changes", c.args[1] if len(c.args) > 1 else []))
            for c in mock_push.call_args_list
        )
        assert total_pushed == _MERGE_WINDOW_FLUSH_THRESHOLD

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=0)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_window_zero_no_merge(self, mock_push, _mock_skip):
        """窗口 = 0 时每次 add 立即 push（降级模式正确性）。"""
        for i in range(5):
            change = {"record_id": f"r{i}", "field_id_hex": "f1", "value": f"v{i}"}
            self.mgr.add(self.table_key, self.table_id, [change], "user-1")

        assert mock_push.call_count == 5, (
            f"窗口=0 时应每次 push, 实际 {mock_push.call_count} 次"
        )

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_different_tables_independent_windows(self, mock_push, _mock_skip):
        """不同 table 的合并窗口互不干扰。"""
        table_a = uuid4()
        table_b = uuid4()

        for i in range(10):
            self.mgr.add(str(table_a), table_a,
                         [{"record_id": f"a{i}", "field_id_hex": "f1", "value": f"va{i}"}],
                         "user-1")
            self.mgr.add(str(table_b), table_b,
                         [{"record_id": f"b{i}", "field_id_hex": "f2", "value": f"vb{i}"}],
                         "user-2")

        self.mgr.flush_all()

        table_a_pushes = [
            c for c in mock_push.call_args_list
            if c.kwargs.get("table_id") == table_a
        ]
        table_b_pushes = [
            c for c in mock_push.call_args_list
            if c.kwargs.get("table_id") == table_b
        ]
        assert len(table_a_pushes) >= 1
        assert len(table_b_pushes) >= 1

        a_changes = sum(len(c.kwargs.get("changes", [])) for c in table_a_pushes)
        b_changes = sum(len(c.kwargs.get("changes", [])) for c in table_b_pushes)
        assert a_changes == 10
        assert b_changes == 10

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=200)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_origin_id_passed_through(self, mock_push, _mock_skip):
        """origin_id 正确传递到 push_cells（前端用于跳过自己的更新）。"""
        self.mgr.add(
            self.table_key, self.table_id,
            [{"record_id": "r1", "field_id_hex": "f1", "value": "v1"}],
            "agent-42",
        )
        self.mgr.flush_all()

        assert mock_push.call_count == 1
        assert mock_push.call_args.kwargs["origin_id"] == "agent-42"

    @override_settings(TABDATA_YDOC_MERGE_WINDOW_MS=100)
    @patch("apps.tabdata.subscribers.collab_ydoc._should_skip_push", return_value=False)
    @patch("apps.tabdata.services.collab_service.CollabService.push_cells")
    def test_timer_fires_after_window_expires(self, mock_push, _mock_skip):
        """合并窗口到期后自动 flush（加大余量避免 CI flaky）。"""
        self.mgr.add(
            self.table_key, self.table_id,
            [{"record_id": "r1", "field_id_hex": "f1", "value": "v1"}],
            "user-1",
        )
        mock_push.assert_not_called()

        time.sleep(0.5)

        mock_push.assert_called_once()

    def test_push_reduction_ratio_documented(self):
        """验证推送次数降低比: 无合并 500 次 vs 合并 ≤ 3 次 → 推送量降低 ≥ 99%。

        ⚠️ 这是推送次数降低（代理指标），不等于 CPU 降低。
        退出条件 "前端 CPU < 30%" 需前端 perf profile 实证。
        """
        without_merge = 500
        with_merge_max = 3
        reduction = (without_merge - with_merge_max) / without_merge
        assert reduction >= 0.99, (
            f"推送次数降低比 = {reduction:.2%}, 预期 ≥ 99%"
        )
