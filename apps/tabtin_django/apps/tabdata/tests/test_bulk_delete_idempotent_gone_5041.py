"""#5041：bulk-delete Phase 1 将「已不存在」与「无权限」拆开。

活跃行不存在 → 幂等成功（进 deleted_record_ids，无 error）；
有活跃行但无 editor → 失败（明确无权限文案）。
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from django.test import TestCase

from apps.tabdata.exceptions import RecordVersionConflictError
from apps.tabdata.services.record_service import RecordService


class TestBulkDeleteIdempotentGone5041(TestCase):
    def _service(self) -> RecordService:
        svc = RecordService(user=SimpleNamespace(id="user-1"))
        svc._set_last_bulk_operation_stats = MagicMock()
        svc._build_bulk_operation_stats = MagicMock(return_value={})
        return svc

    def test_missing_active_records_are_idempotent_success(self):
        gone_a = uuid4()
        gone_b = uuid4()
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records_qs,
        ):
            records_qs.using.return_value.filter.return_value = []
            deleted_count, errors, deleted_ids, failed_ids = svc.bulk_delete_records(
                [gone_a, gone_b]
            )

        self.assertEqual(deleted_count, 2)
        self.assertEqual(errors, [])
        self.assertEqual(set(deleted_ids), {str(gone_a), str(gone_b)})
        self.assertEqual(failed_ids, [])

    def test_active_record_without_editor_permission_fails(self):
        table_id = uuid4()
        record_id = uuid4()
        active = SimpleNamespace(id=record_id, table_id=table_id)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=False),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records_qs,
        ):
            records_qs.using.return_value.filter.return_value = [active]
            deleted_count, errors, deleted_ids, failed_ids = svc.bulk_delete_records(
                [record_id]
            )

        self.assertEqual(deleted_count, 0)
        self.assertEqual(failed_ids, [str(record_id)])
        self.assertEqual(deleted_ids, [])
        self.assertEqual(len(errors), 1)
        self.assertIn("无权限", errors[0])
        self.assertNotIn("不存在", errors[0])

    def test_mix_gone_and_forbidden(self):
        table_id = uuid4()
        gone_id = uuid4()
        forbidden_id = uuid4()
        active = SimpleNamespace(id=forbidden_id, table_id=table_id)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=False),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records_qs,
        ):
            records_qs.using.return_value.filter.return_value = [active]
            deleted_count, errors, deleted_ids, failed_ids = svc.bulk_delete_records(
                [gone_id, forbidden_id]
            )

        self.assertEqual(deleted_count, 1)
        self.assertEqual(deleted_ids, [str(gone_id)])
        self.assertEqual(failed_ids, [str(forbidden_id)])
        self.assertEqual(len(errors), 1)
        self.assertIn("无权限", errors[0])

    def test_delete_record_missing_active_is_idempotent_true(self):
        from apps.tabdata.models import TableRecord

        svc = self._service()
        with patch(
            "apps.tabdata.services.record_service.TableRecord.objects"
        ) as records_qs:
            records_qs.using.return_value.get.side_effect = TableRecord.DoesNotExist
            ok = svc.delete_record(uuid4())

        self.assertTrue(ok)

    def test_concurrent_delete_conflict_is_idempotent_after_tombstone(self):
        record_id = uuid4()
        table_id = uuid4()
        active = SimpleNamespace(id=record_id, table_id=table_id)
        table = SimpleNamespace(id=table_id, organization_id=uuid4(), rls_enabled=False)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records,
            patch("apps.tabdata.services.record_service.Table.objects") as tables,
            patch("apps.tabdata.services.record_service.assert_organization_resource_write_allowed_optional"),
            patch("apps.tabdata.handlers.RecordHandlerFactory.delete_handler") as factory,
        ):
            records.using.return_value.get.return_value = active
            records.using.return_value.filter.return_value.exists.return_value = True
            records.using.return_value.filter.return_value.aggregate.return_value = {
                "max_version": 0,
            }
            tables.using.return_value.only.return_value.get.return_value = table
            factory.return_value.handle.side_effect = RecordVersionConflictError(
                record_id,
                expected_version=1,
            )

            ok = svc.delete_record(record_id)

        self.assertTrue(ok)
        records.using.return_value.filter.assert_any_call(
            id=record_id,
            is_deleted=True,
        )

    def test_concurrent_delete_before_handler_read_is_idempotent(self):
        record_id = uuid4()
        table_id = uuid4()
        active = SimpleNamespace(id=record_id, table_id=table_id)
        table = SimpleNamespace(id=table_id, organization_id=uuid4(), rls_enabled=False)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records,
            patch("apps.tabdata.services.record_service.Table.objects") as tables,
            patch("apps.tabdata.services.record_service.assert_organization_resource_write_allowed_optional"),
            patch("apps.tabdata.handlers.RecordHandlerFactory.delete_handler") as factory,
        ):
            records.using.return_value.get.return_value = active
            records.using.return_value.filter.return_value.exists.return_value = True
            records.using.return_value.filter.return_value.aggregate.return_value = {
                "max_version": 0,
            }
            tables.using.return_value.only.return_value.get.return_value = table
            factory.return_value.handle.return_value = False

            ok = svc.delete_record(record_id)

        self.assertTrue(ok)

    def test_delete_service_forwards_expected_version_to_handler_context(self):
        record_id = uuid4()
        table_id = uuid4()
        active = SimpleNamespace(id=record_id, table_id=table_id)
        table = SimpleNamespace(id=table_id, organization_id=uuid4(), rls_enabled=False)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records,
            patch("apps.tabdata.services.record_service.Table.objects") as tables,
            patch("apps.tabdata.services.record_service.assert_organization_resource_write_allowed_optional"),
            patch("apps.tabdata.handlers.RecordHandlerFactory.delete_handler") as factory,
        ):
            records.using.return_value.get.return_value = active
            records.using.return_value.filter.return_value.aggregate.return_value = {
                "max_version": 0,
            }
            tables.using.return_value.only.return_value.get.return_value = table
            factory.return_value.handle.return_value = True

            ok = svc.delete_record(record_id, expected_version=9)

        self.assertTrue(ok)
        context = factory.return_value.handle.call_args.args[0]
        self.assertEqual(context.expected_version, 9)

    def test_concurrent_edit_conflict_still_propagates_for_active_record(self):
        record_id = uuid4()
        table_id = uuid4()
        active = SimpleNamespace(id=record_id, table_id=table_id)
        table = SimpleNamespace(id=table_id, organization_id=uuid4(), rls_enabled=False)
        svc = self._service()

        with (
            patch.object(RecordService, "check_table_permission", return_value=True),
            patch("apps.tabdata.services.record_service.TableRecord.objects") as records,
            patch("apps.tabdata.services.record_service.Table.objects") as tables,
            patch("apps.tabdata.services.record_service.assert_organization_resource_write_allowed_optional"),
            patch("apps.tabdata.handlers.RecordHandlerFactory.delete_handler") as factory,
        ):
            records.using.return_value.get.return_value = active
            records.using.return_value.filter.return_value.exists.return_value = False
            tables.using.return_value.only.return_value.get.return_value = table
            conflict = RecordVersionConflictError(record_id, expected_version=1)
            factory.return_value.handle.side_effect = conflict

            with self.assertRaises(RecordVersionConflictError) as raised:
                svc.delete_record(record_id)

        self.assertIs(raised.exception, conflict)
