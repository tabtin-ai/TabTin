from __future__ import annotations

from datetime import datetime, timezone as dt_timezone
import inspect
from uuid import UUID
from unittest import TestCase
from unittest.mock import patch, MagicMock

from apps.tabdata.services.collab_service import (
    CollabService,
    _collect_row_order_ghost_ids,
    _normalize_row_order_ids,
    _resolve_new_record_orders_from_row_order,
    _row_order_reorders_existing_records,
)
from apps.tabdata.services.record_service import ORDER_REBALANCE_STEP


class TestCollabServiceQueryGuards(TestCase):
    def test_build_snapshot_only_queries_unarchived_table(self):
        table_id = UUID("11111111-1111-1111-1111-111111111111")

        with patch("apps.tabdata.services.collab_service.Table.objects.using") as using_mock:
            using_mock.return_value.filter.return_value.first.return_value = None
            with self.assertRaises(ValueError):
                CollabService.build_snapshot(table_id)

        using_mock.return_value.filter.assert_called_once_with(id=table_id, is_archived=False)

    @patch("apps.tabdata.native.query_builder.NativeQueryBuilder")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.collab_service.DDLManager")
    @patch("apps.tabdata.services.collab_service.TableField.objects.using")
    @patch("apps.tabdata.services.collab_service.Table.objects.using")
    def test_build_snapshot_syncs_native_columns_before_reading(
        self, table_using, field_using, ddl_manager_cls, native_io_cls, _query_builder_cls,
    ):
        table_id = UUID("55555555-5555-5555-5555-555555555555")
        space_id = UUID("66666666-6666-6666-6666-666666666666")

        table = MagicMock()
        table.id = table_id
        table.space_id = space_id
        table.name = "Percent Table"
        table.record_version_seq = 7
        table.schema_version = 3
        table_using.return_value.filter.return_value.first.return_value = table

        percent_field = MagicMock()
        percent_field.id = UUID("77777777-7777-7777-7777-777777777777")
        percent_field.name = "Percent"
        percent_field.field_type = "percent"
        percent_field.config = {}
        percent_field.order = 1
        fields = [percent_field]
        field_using.return_value.filter.return_value.order_by.return_value = fields

        ddl_synced = {"value": False}

        def _sync_columns(*args, **kwargs):
            ddl_synced["value"] = True
            return (1, 0)

        ddl_manager_cls.return_value.ensure_columns_synced.side_effect = _sync_columns

        def _read_records(*args, **kwargs):
            self.assertTrue(
                ddl_synced["value"],
                "collab snapshot must sync native columns before SELECT",
            )
            return ([], 0)

        native_io_cls.return_value.read_records.side_effect = _read_records

        snapshot = CollabService.build_snapshot(table_id)

        ddl_manager_cls.return_value.ensure_columns_synced.assert_called_once_with(
            space_id, table_id, fields,
        )
        native_io_cls.return_value.read_records.assert_called_once()
        read_kwargs = native_io_cls.return_value.read_records.call_args.kwargs
        self.assertEqual(
            read_kwargs.get("order_by"),
            ('"__order" ASC, "__created_at" ASC, "__id" ASC', []),
        )
        self.assertEqual(snapshot["table_id"], str(table_id))
        self.assertEqual(snapshot["fields"][0]["field_type"], "percent")

    def test_persist_changes_only_queries_unarchived_table(self):
        table_id = UUID("22222222-2222-2222-2222-222222222222")

        with patch("apps.tabdata.services.collab_service.Table.objects.using") as using_mock:
            using_mock.return_value.filter.return_value.first.return_value = None
            with self.assertRaises(ValueError):
                CollabService.persist_changes(
                    table_id,
                    changed_records={},
                    new_records={},
                    deleted_record_ids=[],
                )

        using_mock.return_value.filter.assert_called_once_with(id=table_id, is_archived=False)


class CollabRowOrderDriftTests(TestCase):
    def _record(self, record_id: str, order: float, created_at: datetime):
        record = MagicMock()
        record.id = UUID(record_id)
        record.order = order
        record.created_at = created_at
        return record

    def test_appending_new_record_does_not_reorder_existing_rows(self):
        r1 = "11111111-1111-1111-1111-111111111111"
        r2 = "22222222-2222-2222-2222-222222222222"
        new_id = "33333333-3333-3333-3333-333333333333"
        existing_records = {
            r1: self._record(r1, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            r2: self._record(r2, 3000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
        }
        row_order = _normalize_row_order_ids([r1, new_id, r2])

        self.assertFalse(
            _row_order_reorders_existing_records(row_order, existing_records, set())
        )

        new_orders = _resolve_new_record_orders_from_row_order(
            row_order,
            existing_records,
            {new_id},
            set(),
        )
        self.assertEqual(new_orders[new_id], 2000.0)

    def test_moving_existing_record_is_detected_as_reorder(self):
        r1 = "11111111-1111-1111-1111-111111111111"
        r2 = "22222222-2222-2222-2222-222222222222"
        existing_records = {
            r1: self._record(r1, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            r2: self._record(r2, 2000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
        }

        self.assertTrue(
            _row_order_reorders_existing_records([r2, r1], existing_records, set())
        )

    def test_duplicate_order_uses_creation_order_not_id_for_stability(self):
        later_id = "11111111-1111-1111-1111-111111111111"
        earlier_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        existing_records = {
            later_id: self._record(later_id, 1000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
            earlier_id: self._record(earlier_id, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
        }

        self.assertFalse(
            _row_order_reorders_existing_records(
                [earlier_id, later_id],
                existing_records,
                set(),
            )
        )

    def test_new_record_between_duplicate_order_rows_requires_rewrite(self):
        first_id = "11111111-1111-1111-1111-111111111111"
        second_id = "22222222-2222-2222-2222-222222222222"
        new_id = "33333333-3333-3333-3333-333333333333"
        existing_records = {
            first_id: self._record(first_id, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            second_id: self._record(second_id, 1000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
        }

        self.assertTrue(
            _row_order_reorders_existing_records(
                [first_id, new_id, second_id],
                existing_records,
                set(),
            )
        )

    def test_multiple_new_records_between_duplicate_order_rows_require_rewrite(self):
        first_id = "11111111-1111-1111-1111-111111111111"
        second_id = "22222222-2222-2222-2222-222222222222"
        new_a = "33333333-3333-3333-3333-333333333333"
        new_b = "44444444-4444-4444-4444-444444444444"
        existing_records = {
            first_id: self._record(first_id, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            second_id: self._record(second_id, 1000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
        }

        self.assertTrue(
            _row_order_reorders_existing_records(
                [first_id, new_a, new_b, second_id],
                existing_records,
                set(),
            )
        )

    def test_duplicate_order_append_and_prepend_do_not_force_rewrite(self):
        first_id = "11111111-1111-1111-1111-111111111111"
        second_id = "22222222-2222-2222-2222-222222222222"
        new_id = "33333333-3333-3333-3333-333333333333"
        existing_records = {
            first_id: self._record(first_id, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            second_id: self._record(second_id, 1000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
        }

        self.assertFalse(
            _row_order_reorders_existing_records(
                [first_id, second_id, new_id],
                existing_records,
                set(),
            )
        )
        self.assertFalse(
            _row_order_reorders_existing_records(
                [new_id, first_id, second_id],
                existing_records,
                set(),
            )
        )

    def test_deleted_records_do_not_anchor_new_record_rewrite_detection(self):
        left_id = "11111111-1111-1111-1111-111111111111"
        deleted_id = "22222222-2222-2222-2222-222222222222"
        right_id = "33333333-3333-3333-3333-333333333333"
        new_id = "44444444-4444-4444-4444-444444444444"
        existing_records = {
            left_id: self._record(left_id, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
            deleted_id: self._record(deleted_id, 1000.0, datetime(2026, 1, 2, tzinfo=dt_timezone.utc)),
            right_id: self._record(right_id, 2000.0, datetime(2026, 1, 3, tzinfo=dt_timezone.utc)),
        }

        self.assertFalse(
            _row_order_reorders_existing_records(
                [left_id, deleted_id, new_id, right_id],
                existing_records,
                {deleted_id},
            )
        )

    def test_new_records_append_after_last_anchor_without_wall_clock_order(self):
        r1 = "11111111-1111-1111-1111-111111111111"
        new_a = "22222222-2222-2222-2222-222222222222"
        new_b = "33333333-3333-3333-3333-333333333333"
        existing_records = {
            r1: self._record(r1, 1000.0, datetime(2026, 1, 1, tzinfo=dt_timezone.utc)),
        }

        new_orders = _resolve_new_record_orders_from_row_order(
            [r1, new_a, new_b],
            existing_records,
            {new_a, new_b},
            set(),
        )

        self.assertEqual(new_orders[new_a], 1000.0 + ORDER_REBALANCE_STEP)
        self.assertEqual(new_orders[new_b], 1000.0 + ORDER_REBALANCE_STEP * 2)

    def test_insert_after_title_three_keeps_adjacent_order_on_clean_table(self):
        """干净表：插在标题「3」后应落在 3 与下一行之间，而不是沉底到 1024。"""
        title_3 = "33333333-3333-3333-3333-333333333333"
        title_5 = "55555555-5555-5555-5555-555555555555"
        new_id = "99999999-9999-9999-9999-999999999999"
        existing_records = {
            title_3: self._record(title_3, 3000.0, datetime(2026, 1, 3, tzinfo=dt_timezone.utc)),
            title_5: self._record(title_5, 5000.0, datetime(2026, 1, 5, tzinfo=dt_timezone.utc)),
        }

        new_orders = _resolve_new_record_orders_from_row_order(
            [title_3, new_id, title_5],
            existing_records,
            {new_id},
            set(),
        )

        self.assertEqual(new_orders[new_id], 4000.0)
        self.assertNotEqual(new_orders[new_id], ORDER_REBALANCE_STEP)

    def test_ghost_soft_deleted_anchor_is_detected_and_hint_avoids_silent_1024(self):
        """ORM 已软删但仍出现在 row_order 时，应检出幽灵锚点；用 hint 后不再静默 1024。"""
        ghost_title_3 = "64437f7f-6f65-4063-8195-7aedff24c023"
        right_id = "55555555-5555-5555-5555-555555555555"
        new_id = "99d0422d-4185-4459-94e2-07dbb2b22f80"
        existing_records = {
            right_id: self._record(right_id, 5000.0, datetime(2026, 1, 5, tzinfo=dt_timezone.utc)),
        }
        row_order = [ghost_title_3, new_id, right_id]

        ghosts = _collect_row_order_ghost_ids(
            row_order,
            existing_records,
            {new_id},
            set(),
        )
        self.assertEqual(ghosts, [ghost_title_3])

        silent = _resolve_new_record_orders_from_row_order(
            row_order,
            existing_records,
            {new_id},
            set(),
        )
        # 没有 hint 时只能看到右侧 5000，会落到 5000-1024；若右侧也不存在才会是裸 1024。
        # 这里构造「左右皆无活跃锚点」验证裸 1024：
        silent_both_missing = _resolve_new_record_orders_from_row_order(
            [ghost_title_3, new_id],
            {},
            {new_id},
            set(),
        )
        self.assertEqual(silent_both_missing[new_id], ORDER_REBALANCE_STEP)

        hinted = _resolve_new_record_orders_from_row_order(
            row_order,
            existing_records,
            {new_id},
            set(),
            anchor_order_hints={ghost_title_3: 3000.0},
        )
        self.assertEqual(hinted[new_id], 4000.0)
        self.assertNotEqual(hinted[new_id], silent[new_id])


class TestTableServiceNativeColumnErrors(TestCase):
    def test_native_add_column_propagates_unknown_native_field_type(self):
        from apps.tabdata.native.pg_type_map import UnknownNativeFieldTypeError
        from apps.tabdata.services.table_service import TableService

        table_id = UUID("88888888-8888-8888-8888-888888888888")
        space_id = UUID("99999999-9999-9999-9999-999999999999")

        field = MagicMock()
        field.id = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
        field.field_type = "unsupported_new_type"
        field.config = {}

        mock_table = MagicMock()
        mock_table.space_id = space_id

        service = TableService.__new__(TableService)

        with patch("apps.tabdata.models.Table") as table_cls, \
             patch("apps.tabdata.services.table_service.DDLManager") as ddl_manager_cls:
            table_cls.objects.using.return_value.get.return_value = mock_table
            ddl_manager_cls.return_value.add_column.side_effect = UnknownNativeFieldTypeError(
                "missing mapping",
            )

            with self.assertRaises(UnknownNativeFieldTypeError):
                service._native_add_column(table_id, field)


class ViewGridFallbackOrderTests(TestCase):
    def test_orm_fallback_does_not_reverse_creation_order_for_duplicate_orders(self):
        from apps.tabdata.services.view_grid_service import get_grid_data_orm_compat

        source = inspect.getsource(get_grid_data_orm_compat)

        self.assertIn("order_by('order', 'created_at', 'id')", source)
        self.assertNotIn("order_by('order', '-created_at')", source)


class RestoreFromSnapshotSelectForUpdateTests(TestCase):
    """CMS-013: restore_from_snapshot 必须使用 select_for_update 防止 TOCTOU 并发竞态。"""

    def test_restore_source_uses_atomic_and_select_for_update(self):
        """源码级检查：restore_from_snapshot 必须包含 transaction.atomic 和 select_for_update。"""
        source = inspect.getsource(CollabService.restore_from_snapshot)
        self.assertIn("transaction.atomic", source,
                       "restore_from_snapshot must use transaction.atomic")
        self.assertIn("select_for_update", source,
                       "restore_from_snapshot must use select_for_update to lock rows")

    @patch("apps.tabdata.services.collab_service.table_event_service")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.collab_service.next_record_version", return_value=42)
    @patch("apps.tabdata.services.collab_service.TableField")
    @patch("apps.tabdata.services.collab_service.TableRecord")
    @patch("apps.tabdata.services.collab_service.Table")
    @patch("apps.tabdata.services.collab_service.transaction")
    def test_restore_acquires_row_lock_on_existing_records(
        self, mock_txn, mock_table_model, mock_record_model,
        mock_field_model, mock_next_ver, mock_native_io, mock_event_svc,
    ):
        """restore_from_snapshot 在读取 existing_ids 时必须调用 select_for_update()。"""
        table_id = UUID("33333333-3333-3333-3333-333333333333")

        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.space_id = UUID("44444444-4444-4444-4444-444444444444")
        mock_table_model.objects.using.return_value.filter.return_value.first.return_value = mock_table

        mock_field_model.objects.using.return_value.filter.return_value = []

        mock_qs = MagicMock()
        mock_select_for_update_qs = MagicMock()
        mock_select_for_update_qs.values_list.return_value = []
        mock_qs.select_for_update.return_value = mock_select_for_update_qs
        mock_record_model.objects.using.return_value.filter.return_value = mock_qs

        mock_txn.atomic.return_value.__enter__ = MagicMock()
        mock_txn.atomic.return_value.__exit__ = MagicMock(return_value=False)

        CollabService.restore_from_snapshot(table_id, {"records": {}, "row_order": []})

        mock_qs.select_for_update.assert_called_once()
        mock_select_for_update_qs.values_list.assert_called_once_with("id", flat=True)
