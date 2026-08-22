"""字段结构写路径的 Table -> Field 行锁顺序回归。"""
from __future__ import annotations

from contextlib import ContextDecorator
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import SimpleTestCase

from apps.tabdata.exceptions import PrimaryFieldDeleteError
from apps.tabdata.models import Table, TableField
from apps.tabdata.services.table_service import TableService


class _NoopAtomic(ContextDecorator):
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def _noop_atomic(*args, **_kwargs):
    if args and callable(args[0]):
        return _NoopAtomic()(args[0])
    return _NoopAtomic()


def _locking_orm(*, table_id, field, calls):
    """构造最小 ORM 链，并在真正调用 select_for_update 时记录顺序。"""
    table = MagicMock(
        organization_id=uuid4(),
        is_system_table=False,
        schema_version=1,
    )

    table_objects = MagicMock(name="table_objects")
    table_query = table_objects.using.return_value
    locked_table_query = MagicMock(name="locked_table_query")

    def lock_table():
        calls.append("table")
        return locked_table_query

    table_query.select_for_update.side_effect = lock_table
    locked_table_query.get.return_value = table

    field_objects = MagicMock(name="field_objects")
    field_query = field_objects.using.return_value
    field_probe = field_query.filter.return_value
    field_probe.values_list.return_value.first.return_value = table_id
    locked_field_query = MagicMock(name="locked_field_query")

    def lock_field():
        calls.append("field")
        return locked_field_query

    field_query.select_for_update.side_effect = lock_field
    locked_field_query.get.return_value = field
    locked_field_query.filter.return_value = []

    return {
        "table_objects": table_objects,
        "field_objects": field_objects,
        "table_query": table_query,
        "field_query": field_query,
        "locked_table_query": locked_table_query,
        "locked_field_query": locked_field_query,
    }


def _record_locking_orm(*, records, calls):
    """构造会真正迭代待写记录的锁查询，避免同类型快返产生假阳性。"""
    record_objects = MagicMock(name="record_objects")
    record_query = record_objects.using.return_value
    locked_records_query = MagicMock(name="locked_records_query")

    def lock_records():
        calls.append("record")
        return locked_records_query

    record_query.select_for_update.side_effect = lock_records
    ordered_records = locked_records_query.filter.return_value.order_by.return_value
    locked_records_query.filter.return_value.iterator.side_effect = (
        lambda **_kwargs: iter(records)
    )
    ordered_records.iterator.side_effect = lambda **_kwargs: iter(records)
    return record_objects, locked_records_query


class TestFieldWriteLockOrder(SimpleTestCase):
    def _service(self):
        service = TableService(user=MagicMock(id=uuid4()))
        service.check_table_permission = MagicMock(return_value=True)
        service._publish_field_event = MagicMock()
        service._trigger_field_version_history = MagicMock()
        service._increment_schema_version = MagicMock()
        return service

    def test_update_field_locks_table_before_field(self):
        table_id = uuid4()
        field_id = uuid4()
        calls = []
        field = MagicMock(
            id=field_id,
            table_id=table_id,
            name="标题",
            field_type="text",
            config={},
            validation_rules={},
            is_primary=False,
        )
        orm = _locking_orm(table_id=table_id, field=field, calls=calls)
        service = self._service()
        operation_service = MagicMock()
        operation_service.serialize_field.return_value = {}
        service._get_operation_service = MagicMock(return_value=operation_service)

        with (
            patch.object(Table, "objects", orm["table_objects"]),
            patch.object(TableField, "objects", orm["field_objects"]),
            patch(
                "apps.tabdata.services.table_service."
                "assert_organization_resource_write_allowed_optional"
            ),
        ):
            result = TableService.update_field.__wrapped__(service, field_id)

        self.assertIs(result, field)
        self.assertEqual(calls, ["table", "field"])
        orm["locked_table_query"].get.assert_called_once_with(id=table_id)
        orm["locked_field_query"].get.assert_called_once_with(
            id=field_id,
            table_id=table_id,
            is_deleted=False,
        )

    def test_reorder_fields_locks_table_before_fields_without_expected_version(self):
        table_id = uuid4()
        calls = []
        orm = _locking_orm(
            table_id=table_id,
            field=MagicMock(),
            calls=calls,
        )
        service = self._service()
        service._get_operation_service = MagicMock(return_value=MagicMock())

        with (
            patch.object(Table, "objects", orm["table_objects"]),
            patch.object(TableField, "objects", orm["field_objects"]),
        ):
            result = TableService.reorder_fields.__wrapped__(
                service,
                table_id,
                [],
            )

        self.assertTrue(result)
        self.assertEqual(calls, ["table", "field"])
        orm["locked_table_query"].get.assert_called_once_with(id=table_id)
        orm["locked_field_query"].filter.assert_called_once_with(
            id__in=[],
            table_id=table_id,
            is_deleted=False,
        )

    def test_delete_field_locks_table_before_field(self):
        table_id = uuid4()
        field_id = uuid4()
        calls = []
        field = MagicMock(
            id=field_id,
            table_id=table_id,
            name="主字段",
            field_type="text",
            is_primary=True,
        )
        orm = _locking_orm(table_id=table_id, field=field, calls=calls)
        service = self._service()
        operation_service = MagicMock()
        operation_service.serialize_field.return_value = {}
        service._get_operation_service = MagicMock(return_value=operation_service)

        with (
            patch.object(Table, "objects", orm["table_objects"]),
            patch.object(TableField, "objects", orm["field_objects"]),
            patch(
                "apps.tabdata.services.table_service."
                "assert_organization_resource_write_allowed_optional"
            ),
            self.assertRaises(PrimaryFieldDeleteError),
        ):
            TableService.delete_field.__wrapped__(
                service,
                field_id,
                skip_permission_check=True,
            )

        self.assertEqual(calls, ["table", "field"])
        orm["locked_table_query"].get.assert_called_once_with(id=table_id)
        orm["locked_field_query"].get.assert_called_once_with(
            id=field_id,
            table_id=table_id,
        )

    def test_convert_field_type_locks_table_field_and_records_before_bulk_write(self):
        table_id = uuid4()
        field_id = uuid4()
        calls = []
        field = MagicMock(
            id=field_id,
            table_id=table_id,
            field_type="text",
            is_primary=False,
        )
        orm = _locking_orm(table_id=table_id, field=field, calls=calls)
        record = MagicMock(id=uuid4(), table_id=table_id)
        record.__dict__["data"] = {str(field_id): "12"}
        record._rda_cached_data = {str(field_id): "12"}
        record_objects, locked_records_query = _record_locking_orm(
            records=[record],
            calls=calls,
        )
        service = self._service()
        service._preload_record_data_for_fields = MagicMock()
        service._iter_record_batches = MagicMock(return_value=[[record]])
        service._native_field_column_available = MagicMock(return_value=False)
        service._sync_table_records_to_ydoc = MagicMock()

        with (
            patch.object(Table, "objects", orm["table_objects"]),
            patch.object(TableField, "objects", orm["field_objects"]),
            patch("apps.tabdata.services.table_service.TableRecord.objects", record_objects),
            patch(
                "apps.tabdata.services.table_service.convert_to_target_type",
                return_value=(True, 12.0, None),
            ),
            patch(
                "apps.tabdata.services.table_service.next_record_version",
                return_value=2,
            ),
            patch("apps.tabdata.services.table_service.emit_record_history_event"),
            patch(
                "apps.tabdata.services.table_service.transaction.atomic",
                side_effect=_noop_atomic,
            ),
            patch.object(service, "_increment_schema_version"),
            patch.object(service, "_trigger_field_version_history"),
            patch.object(service, "_sync_table_records_to_ydoc"),
            patch("apps.tabdata.services.table_service.transaction.on_commit"),
        ):
            result = TableService.convert_field_type.__wrapped__(
                service,
                field_id,
                "number",
            )

        self.assertTrue(result["success"])
        self.assertEqual(calls, ["table", "field", "record"])
        orm["locked_table_query"].get.assert_called_once_with(id=table_id)
        orm["locked_field_query"].get.assert_called_once_with(
            id=field_id,
            table_id=table_id,
        )
        locked_records_query.filter.assert_called_once_with(
            table_id=table_id,
            is_deleted=False,
        )
        locked_records_query.filter.return_value.order_by.assert_called_once_with("id")
        record_objects.using.return_value.bulk_update.assert_called_once()

    def test_choice_rename_locks_records_before_allocating_versions_and_bulk_write(self):
        table_id = uuid4()
        field_id = uuid4()
        calls = []
        table = MagicMock(id=table_id, space_id=uuid4())
        field = MagicMock(
            id=field_id,
            table_id=table_id,
            name="状态",
            field_type="select",
            config={"choices": []},
        )
        record = MagicMock(id=uuid4(), table_id=table_id)
        record.__dict__["data"] = {str(field_id): "todo"}
        record._rda_cached_data = {str(field_id): "todo"}
        record_objects, locked_records_query = _record_locking_orm(
            records=[record],
            calls=calls,
        )
        table_objects = MagicMock(name="table_objects")
        table_objects.using.return_value.get.return_value = table
        service = self._service()
        service._preload_record_data_for_fields = MagicMock()
        service._iter_record_batches = MagicMock(return_value=[[record]])
        service._native_field_column_available = MagicMock(return_value=False)

        with (
            patch.object(Table, "objects", table_objects),
            patch("apps.tabdata.services.table_service.TableRecord.objects", record_objects),
            patch(
                "apps.tabdata.services.table_service.next_record_version",
                side_effect=lambda *_args, **_kwargs: calls.append("version") or 2,
            ),
            patch("apps.tabdata.services.table_service.emit_record_history_event"),
            patch(
                "apps.tabdata.services.table_service.transaction.atomic",
                side_effect=_noop_atomic,
            ),
            patch(
                "apps.tabdata.utils.ydoc_sync.sync_records_to_ydoc",
            ),
        ):
            affected = service._migrate_select_choice_renames(
                field,
                [{"value": "todo", "label": "待办"}],
                [{"value": "doing", "label": "待办"}],
            )

        self.assertEqual(affected, 1)
        self.assertEqual(calls, ["record", "version"])
        locked_records_query.filter.return_value.order_by.assert_called_once_with("id")
        record_objects.using.return_value.bulk_update.assert_called_once()
