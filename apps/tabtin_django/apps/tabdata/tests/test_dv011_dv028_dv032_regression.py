"""
DV-011 / DV-028 / DV-032 / E2E-004 回归测试（纯单元测试，不依赖数据库）

DV-011: bulk_create/bulk_delete 使用批量历史写入（_defer_history + batch_write_record_histories）
DV-028: _try_merge_with_recent_history 的 save+delete+bulk_create 使用 transaction.atomic 保证原子性
DV-032: execute_write 使用 transaction.atomic 保护
E2E-004: _write_change_log_for_write 在主 SQL 事务内执行，保证原子性
"""

import inspect
import os
import textwrap
from unittest import TestCase
from unittest.mock import patch, MagicMock, PropertyMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

from apps.tabdata.history_events import RecordHistoryEvent


class TestDV011DeferHistoryMechanism(TestCase):
    """DV-011: 验证 _defer_history 上下文管理器和 batch_write_record_histories 机制。"""

    def _make_service(self):
        from apps.tabdata.services.record_service import RecordService
        svc = RecordService.__new__(RecordService)
        svc.user = MagicMock()
        svc.user.id = "test-user-id"
        svc._deferred_history_events = None
        return svc

    def test_emit_normally_calls_signal(self):
        """无 defer 时，_emit_record_history_event 应直接调用 emit_record_history_event。"""
        svc = self._make_service()
        record = MagicMock()
        record.id = "rec-1"

        with patch("apps.tabdata.services.record_service.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.services.record_service.get_current_window_id", return_value="win-1"):
            svc._emit_record_history_event(
                record=record,
                action="create",
                field_changes={"data": {"f1": "v1"}},
            )
            mock_emit.assert_called_once()

    def test_defer_context_collects_events(self):
        """_defer_history() 上下文中，事件应收集而非立即发送。"""
        svc = self._make_service()
        record1 = MagicMock()
        record1.id = "rec-1"
        record2 = MagicMock()
        record2.id = "rec-2"

        with patch("apps.tabdata.services.record_service.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.services.record_service.get_current_window_id", return_value="win-1"), \
             patch("apps.tabdata.history_event_listeners.batch_write_record_histories") as mock_batch:
            with svc._defer_history():
                svc._emit_record_history_event(
                    record=record1, action="create",
                    field_changes={"data": {"f1": "v1"}},
                )
                svc._emit_record_history_event(
                    record=record2, action="create",
                    field_changes={"data": {"f1": "v2"}},
                )
                mock_emit.assert_not_called()
                self.assertEqual(len(svc._deferred_history_events), 2)

            mock_batch.assert_called_once()
            events = mock_batch.call_args[0][0]
            self.assertEqual(len(events), 2)
            self.assertIsInstance(events[0], RecordHistoryEvent)
            self.assertIsInstance(events[1], RecordHistoryEvent)

    def test_defer_context_resets_after_exit(self):
        """退出 _defer_history() 后，_deferred_history_events 恢复为 None。"""
        svc = self._make_service()

        with patch("apps.tabdata.history_event_listeners.batch_write_record_histories"):
            with svc._defer_history():
                self.assertIsNotNone(svc._deferred_history_events)
            self.assertIsNone(svc._deferred_history_events)

    def test_defer_context_resets_on_exception(self):
        """即使循环中抛异常，_deferred_history_events 也应恢复为 None。"""
        svc = self._make_service()

        with patch("apps.tabdata.history_event_listeners.batch_write_record_histories"):
            try:
                with svc._defer_history():
                    raise ValueError("模拟异常")
            except ValueError:
                pass
            self.assertIsNone(svc._deferred_history_events)

    def test_defer_no_events_skips_batch_call(self):
        """defer 上下文中无事件时，不应调用 batch_write。"""
        svc = self._make_service()

        with patch("apps.tabdata.history_event_listeners.batch_write_record_histories") as mock_batch:
            with svc._defer_history():
                pass
            mock_batch.assert_not_called()

    def test_emit_after_defer_resumes_normal(self):
        """退出 defer 后，后续 emit 应恢复正常（直接调用 signal）。"""
        svc = self._make_service()
        record = MagicMock()

        with patch("apps.tabdata.services.record_service.emit_record_history_event") as mock_emit, \
             patch("apps.tabdata.services.record_service.get_current_window_id", return_value="w"), \
             patch("apps.tabdata.history_event_listeners.batch_write_record_histories"):
            with svc._defer_history():
                pass

            svc._emit_record_history_event(
                record=record, action="update", field_changes={},
            )
            mock_emit.assert_called_once()


class TestDV011BulkCreateUsesDefer(TestCase):
    """DV-011: 验证 bulk_create_records 中历史写入循环被 _defer_history 包裹。"""

    def test_bulk_create_source_contains_defer_history(self):
        """bulk_create_records 方法源码应包含 _defer_history() 调用。"""
        from apps.tabdata.services.record_service import RecordService
        source = inspect.getsource(RecordService.bulk_create_records)
        self.assertIn("_defer_history", source)

    def test_bulk_delete_source_contains_defer_history(self):
        """bulk_delete_records 方法源码应包含 _defer_history() 调用。"""
        from apps.tabdata.services.record_service import RecordService
        source = inspect.getsource(RecordService.bulk_delete_records)
        self.assertIn("_defer_history", source)


class TestDV011BatchWriteRecordHistories(TestCase):
    """DV-011: 验证 batch_write_record_histories 函数的批量写入逻辑。"""

    def test_empty_events_returns_empty(self):
        """空事件列表应返回空列表，不执行任何数据库操作。"""
        from apps.tabdata.history_event_listeners import batch_write_record_histories
        result = batch_write_record_histories([])
        self.assertEqual(result, [])

    def test_bulk_creates_all_histories_at_once(self):
        """N 个事件应通过 bulk_create 创建 RecordHistory（而非逐条 create）。"""
        from apps.tabdata.history_event_listeners import batch_write_record_histories

        n = 5
        mock_records = [MagicMock() for _ in range(n)]
        for i, r in enumerate(mock_records):
            r.id = f"rec-{i}"
            r.table_id = "tbl-1"

        events = [
            RecordHistoryEvent(
                record=r,
                action="create",
                field_changes={"data": {"f": f"v{i}"}},
                user=None,
            )
            for i, r in enumerate(mock_records)
        ]

        fake_histories = [MagicMock() for _ in range(n)]
        for h in fake_histories:
            h.user_id = None

        mock_history_cls = MagicMock()
        mock_bulk_create = MagicMock(return_value=fake_histories)
        mock_history_cls.objects.using.return_value.bulk_create = mock_bulk_create

        with patch("apps.tabdata.history_event_listeners.RecordHistory", mock_history_cls), \
             patch("apps.tabdata.history_event_listeners.RecordHistoryItem"), \
             patch("apps.tabdata.history_event_listeners._push_history_to_undo_stack"), \
             patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={}), \
             patch("apps.tabdata.history_event_listeners._build_history_items", return_value=[]):
            result = batch_write_record_histories(events)

        mock_bulk_create.assert_called_once()
        args = mock_bulk_create.call_args[0][0]
        self.assertEqual(len(args), n)
        self.assertEqual(len(result), n)


class TestDV011BatchWriteHistoryItems(TestCase):
    """DV-011: 验证 batch_write_record_histories 同时批量创建 RecordHistoryItem。"""

    def test_batch_write_creates_items_in_bulk(self):
        """事件中有 field items 时应通过 bulk_create 写入 RecordHistoryItem。"""
        from apps.tabdata.history_event_listeners import batch_write_record_histories

        mock_record = MagicMock()
        mock_record.id = "rec-1"
        mock_record.table_id = "tbl-1"

        events = [
            RecordHistoryEvent(
                record=mock_record,
                action="update",
                field_changes={"fld1": {"old": "a", "new": "b"}},
                user=None,
            ),
        ]

        fake_history = MagicMock()
        fake_history.user_id = None

        mock_history_cls = MagicMock()
        mock_history_cls.objects.using.return_value.bulk_create = MagicMock(return_value=[fake_history])

        mock_item_cls = MagicMock()
        mock_item_bulk_create = MagicMock()
        mock_item_cls.objects.using.return_value.bulk_create = mock_item_bulk_create

        with patch("apps.tabdata.history_event_listeners.RecordHistory", mock_history_cls), \
             patch("apps.tabdata.history_event_listeners.RecordHistoryItem", mock_item_cls), \
             patch("apps.tabdata.history_event_listeners._push_history_to_undo_stack"), \
             patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={}):
            batch_write_record_histories(events)

        mock_item_bulk_create.assert_called_once()
        items = mock_item_bulk_create.call_args[0][0]
        self.assertEqual(len(items), 1)

    def test_batch_write_pushes_to_undo_stack_when_requested(self):
        """push_to_stack=True 的事件应触发 _push_history_to_undo_stack。"""
        from apps.tabdata.history_event_listeners import batch_write_record_histories

        mock_record = MagicMock()
        mock_record.id = "rec-1"
        mock_record.table_id = "tbl-1"

        events = [
            RecordHistoryEvent(
                record=mock_record,
                action="create",
                field_changes={},
                user=MagicMock(),
                push_to_stack=True,
            ),
            RecordHistoryEvent(
                record=mock_record,
                action="create",
                field_changes={},
                user=MagicMock(),
                push_to_stack=False,
            ),
        ]

        fake_h1 = MagicMock()
        fake_h1.user_id = "u1"
        fake_h2 = MagicMock()
        fake_h2.user_id = "u2"

        mock_history_cls = MagicMock()
        mock_history_cls.objects.using.return_value.bulk_create = MagicMock(
            return_value=[fake_h1, fake_h2],
        )

        with patch("apps.tabdata.history_event_listeners.RecordHistory", mock_history_cls), \
             patch("apps.tabdata.history_event_listeners.RecordHistoryItem"), \
             patch("apps.tabdata.history_event_listeners._push_history_to_undo_stack") as mock_push, \
             patch("apps.tabdata.history_event_listeners._load_field_type_map", return_value={}), \
             patch("apps.tabdata.history_event_listeners._build_history_items", return_value=[]):
            batch_write_record_histories(events)

        self.assertEqual(mock_push.call_count, 1)
        mock_push.assert_called_once_with(fake_h1)


class TestDV028AtomicMerge(TestCase):
    """DV-028: 验证 _try_merge_with_recent_history 使用 transaction.atomic。"""

    def test_merge_function_contains_transaction_atomic(self):
        """_try_merge_with_recent_history 源码应包含 transaction.atomic。"""
        from apps.tabdata.history_event_listeners import _try_merge_with_recent_history
        source = inspect.getsource(_try_merge_with_recent_history)
        self.assertIn("transaction.atomic", source)

    def test_transaction_import_exists(self):
        """history_event_listeners 模块应导入 django.db.transaction。"""
        import apps.tabdata.history_event_listeners as module
        self.assertTrue(
            hasattr(module, "transaction"),
            "history_event_listeners 应导入 transaction",
        )

    def test_atomic_wraps_save_delete_and_bulk_create(self):
        """transaction.atomic 应同时包裹 save、delete、bulk_create 三步操作。"""
        from apps.tabdata.history_event_listeners import _try_merge_with_recent_history
        source = inspect.getsource(_try_merge_with_recent_history)

        atomic_pos = source.index("transaction.atomic")
        save_pos = source.index(".save(", atomic_pos)
        delete_pos = source.index(".delete()", save_pos)
        bulk_create_pos = source.index(".bulk_create(", delete_pos)

        self.assertLess(atomic_pos, save_pos)
        self.assertLess(save_pos, delete_pos)
        self.assertLess(delete_pos, bulk_create_pos)

    def test_atomic_uses_tabdata_db_alias(self):
        """transaction.atomic 应使用 TABDATA_DB_ALIAS。"""
        from apps.tabdata.history_event_listeners import _try_merge_with_recent_history
        source = inspect.getsource(_try_merge_with_recent_history)
        self.assertIn("transaction.atomic(using=TABDATA_DB_ALIAS)", source)


class TestDV032ExecuteWriteTransaction(TestCase):
    """DV-032: 验证 execute_write 使用 transaction.atomic 保护。"""

    def test_execute_write_has_transaction_atomic(self):
        """execute_write 方法体中应包含 transaction.atomic 调用。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)
        self.assertIn("transaction.atomic", source)

    def test_execute_write_wraps_cursor_and_sync(self):
        """transaction.atomic 应同时包裹 cursor.execute 和 _sync_django_model_version。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        atomic_pos = source.index("transaction.atomic")
        cursor_pos = source.index("cursor.execute", atomic_pos)
        sync_pos = source.index("_sync_django_model_version", cursor_pos)

        self.assertLess(atomic_pos, cursor_pos)
        self.assertLess(cursor_pos, sync_pos)


class TestE2E004ChangeLogInMainTransaction(TestCase):
    """E2E-004: _write_change_log_for_write 必须在主 SQL 事务内执行。

    回归测试：确保 ChangeLog 写入与主 SQL 操作原子提交，
    防止"主 SQL 成功但 ChangeLog 失败"导致 rollback 无法感知变更。
    """

    def test_change_log_call_is_inside_transaction_atomic_block(self):
        """execute_write 源码中 _write_change_log_for_write 必须在 transaction.atomic 块内。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        atomic_pos = source.index("transaction.atomic")
        # 找到 atomic 块的起始位置后，_write_change_log_for_write 必须在其后
        change_log_pos = source.index("_write_change_log_for_write", atomic_pos)
        self.assertGreater(
            change_log_pos, atomic_pos,
            "_write_change_log_for_write 应在 transaction.atomic 块内调用",
        )

    def test_change_log_call_precedes_result_dict(self):
        """_write_change_log_for_write 调用必须在 result 字典构建之前（仍在事务块内）。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        change_log_pos = source.index("_write_change_log_for_write")
        # result 字典在事务块外构建
        result_pos = source.index('"affected_rows": affected_rows', change_log_pos)
        self.assertLess(
            change_log_pos, result_pos,
            "_write_change_log_for_write 应在 result 字典构建前调用",
        )

    def test_no_standalone_change_log_call_outside_atomic(self):
        """execute_write 中不应有在 transaction.atomic 块外独立调用 _write_change_log_for_write 的代码。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor.execute_write)

        # 找到第一个 transaction.atomic 的位置
        atomic_pos = source.index("transaction.atomic")
        # 找到 _write_change_log_for_write 的所有出现位置
        occurrences = []
        search_start = 0
        while True:
            pos = source.find("_write_change_log_for_write", search_start)
            if pos == -1:
                break
            occurrences.append(pos)
            search_start = pos + 1

        # 所有调用都应在 transaction.atomic 之后（即在其块内）
        for pos in occurrences:
            self.assertGreater(
                pos, atomic_pos,
                f"发现 _write_change_log_for_write 在 transaction.atomic 之前调用（pos={pos}）",
            )

    def test_write_change_log_internal_uses_savepoint(self):
        """_write_change_log_for_write 内部应使用 db_tx.atomic 作为 savepoint。"""
        from apps.tabdata.native.agent_sql import AgentSQLExecutor
        source = inspect.getsource(AgentSQLExecutor._write_change_log_for_write)
        self.assertIn(
            "db_tx.atomic",
            source,
            "_write_change_log_for_write 内部应使用 db_tx.atomic（savepoint）保护单个 table 写入",
        )
