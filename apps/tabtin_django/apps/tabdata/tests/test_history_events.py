"""
历史事件与字段级历史明细测试
"""

from unittest.mock import patch

from django.test import TestCase
from django.contrib.auth import get_user_model

from apps.tabtinspace.models import Organization, Space
from apps.tabdata.models import Table, TableField, TableRecord, RecordHistory, RecordHistoryItem
from apps.tabdata.services.import_service import ImportService
from apps.tabdata.services.record_service import RecordService, ORDER_REBALANCE_STEP
from apps.tabdata.services.table_service import TableService
from apps.tabdata.tests.test_undo_redo import (
    _ensure_free_tier,
    _ensure_native_table,
    _ensure_project_membership,
)

User = get_user_model()


class TestRecordHistoryEvents(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        _ensure_free_tier()

        self.user = User.objects.create_user(
            username="history_user",
            email="history_user@example.com",
            password="password123",
        )

        self.organization = Organization.objects.create(
            name="历史测试组织",
            owner=self.user,
        )
        self.organization.members.create(user=self.user, role="owner")

        self.space = Space.objects.create(
            organization=self.organization,
            name="历史测试项目",
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.user,
            role="owner",
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name="历史测试表",
            owner=self.user,
        )
        self.field_title = TableField.objects.create(
            table=self.table,
            name="标题",
            field_type="text",
            config={},
        )
        self.field_count = TableField.objects.create(
            table=self.table,
            name="数量",
            field_type="number",
            config={},
        )
        self.field_ai = TableField.objects.create(
            table=self.table,
            name="AI结果",
            field_type="text",
            config={},
        )
        _ensure_native_table(
            self.space.id, self.table.id,
            [self.field_title, self.field_count, self.field_ai],
        )
        self.record_service = RecordService(user=self.user)
        self.table_service = TableService(user=self.user)

    def test_create_record_emits_single_history_and_items(self):
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                "标题": "创建标题",
                "数量": 10,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        histories = RecordHistory.objects.filter(record=record, action="create")
        self.assertEqual(histories.count(), 1)
        history = histories.first()
        self.assertIsNotNone(history)

        items = list(RecordHistoryItem.objects.filter(history=history))
        self.assertEqual(len(items), 2)
        item_keys = {item.field_key for item in items}
        self.assertEqual(item_keys, {str(self.field_title.id), str(self.field_count.id)})
        for item in items:
            self.assertIsNone(item.before)
            self.assertIsNotNone(item.after)

    def test_update_record_emits_single_update_history_and_field_items(self):
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                "标题": "原始标题",
                "数量": 1,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        # 只验证 update 历史，避免 create 干扰
        RecordHistory.objects.filter(record=record).delete()

        updated_record, error = self.record_service.update_record(
            record_id=record.id,
            data={
                "标题": "更新标题",
                "数量": 2,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(updated_record)

        update_histories = RecordHistory.objects.filter(record=record, action="update")
        self.assertEqual(update_histories.count(), 1)
        update_history = update_histories.first()
        self.assertIsNotNone(update_history)

        items = list(RecordHistoryItem.objects.filter(history=update_history))
        self.assertEqual(len(items), 2)
        keyed_items = {item.field_key: item for item in items}
        self.assertEqual(keyed_items[str(self.field_title.id)].before, "原始标题")
        self.assertEqual(keyed_items[str(self.field_title.id)].after, "更新标题")
        self.assertEqual(keyed_items[str(self.field_count.id)].before, 1)
        self.assertEqual(keyed_items[str(self.field_count.id)].after, 2)

    def test_delete_record_emits_delete_history_item(self):
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                "标题": "待删除",
                "数量": 3,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        # 只验证 delete 历史，避免 create 干扰
        RecordHistory.objects.filter(record=record).delete()

        deleted = self.record_service.delete_record(record.id)
        self.assertTrue(deleted)

        delete_histories = RecordHistory.objects.filter(record=record, action="delete")
        self.assertEqual(delete_histories.count(), 1)
        delete_history = delete_histories.first()
        self.assertIsNotNone(delete_history)

        items = list(RecordHistoryItem.objects.filter(history=delete_history))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].field_key, "_deleted")
        self.assertEqual(items[0].before, False)
        self.assertEqual(items[0].after, True)

    def test_convert_field_type_emits_grouped_update_histories(self):
        record1, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                "标题": "A",
                "数量": 10,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record1)

        record2, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                "标题": "B",
                "数量": 20,
            },
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record2)

        RecordHistory.objects.all().delete()

        result = self.table_service.convert_field_type(
            field_id=self.field_count.id,
            target_type="text",
            target_options={},
        )
        self.assertTrue(result.get("success"))

        histories = list(
            RecordHistory.objects.filter(
                record_id__in=[record1.id, record2.id],
                action="update",
            ).order_by("created_at")
        )
        self.assertEqual(len(histories), 2)

        group_ids = {history.operation_group_id for history in histories}
        self.assertEqual(len(group_ids), 1)
        self.assertIsNotNone(next(iter(group_ids)))

        history_items = RecordHistoryItem.objects.filter(
            history_id__in=[history.id for history in histories],
            field_key=str(self.field_count.id),
        )
        self.assertEqual(history_items.count(), 2)

    def test_reorder_records_emits_grouped_order_histories(self):
        record1, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "R1", "数量": 1},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record1)
        record2, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "R2", "数量": 2},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record2)
        record3, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "R3", "数量": 3},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record3)

        RecordHistory.objects.all().delete()

        updated_records, errors = self.record_service.reorder_records(
            table_id=self.table.id,
            record_ids=[record1.id, record2.id],
            position="end",
        )
        self.assertFalse(errors)
        self.assertEqual(len(updated_records), 2)

        histories = list(
            RecordHistory.objects.filter(
                record_id__in=[record1.id, record2.id],
                action="update",
            ).order_by("created_at")
        )
        self.assertEqual(len(histories), 2)
        group_ids = {history.operation_group_id for history in histories}
        self.assertEqual(len(group_ids), 1)
        self.assertIsNotNone(next(iter(group_ids)))
        for history in histories:
            self.assertIn("_order", history.field_changes)
            self.assertNotEqual(
                history.field_changes["_order"]["old"],
                history.field_changes["_order"]["new"],
            )

        items = RecordHistoryItem.objects.filter(
            history_id__in=[history.id for history in histories],
            field_key="_order",
        )
        self.assertEqual(items.count(), 2)

    @patch("apps.tabdata.services.record_service._sync_records_to_ydoc")
    def test_reorder_records_clears_position_id_only_for_moved_records(self, mock_sync_ydoc):
        record1, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "Position 1", "数量": 1},
        )
        self.assertIsNone(error)
        record2, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "Position 2", "数量": 2},
        )
        self.assertIsNone(error)
        record3, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "Position 3", "数量": 3},
        )
        self.assertIsNone(error)

        TableRecord.objects.filter(id__in=[record1.id, record2.id, record3.id]).update(
            position_id="collab-position",
        )
        mock_sync_ydoc.reset_mock()

        updated_records, errors = self.record_service.reorder_records(
            table_id=self.table.id,
            record_ids=[record1.id],
            anchor_record_id=record2.id,
            position="after",
        )

        self.assertFalse(errors)
        self.assertEqual([record.id for record in updated_records], [record1.id])
        record1.refresh_from_db()
        record2.refresh_from_db()
        record3.refresh_from_db()
        self.assertIsNone(record1.position_id)
        self.assertEqual(record2.position_id, "collab-position")
        self.assertEqual(record3.position_id, "collab-position")
        mock_sync_ydoc.assert_called_once_with(
            self.table.id,
            updated_records,
            fields=[],
            reorder_record_ids=[str(record1.id)],
            source="reorder_records",
        )

    def test_reorder_records_with_group_values_emits_data_field_changes(self):
        record1, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "G1", "数量": 10},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record1)
        record2, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "G2", "数量": 20},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record2)

        RecordHistory.objects.all().delete()

        updated_records, errors = self.record_service.reorder_records(
            table_id=self.table.id,
            record_ids=[record1.id],
            anchor_record_id=record2.id,
            position="after",
            group_values={"数量": 99},
        )
        self.assertFalse(errors)
        self.assertEqual(len(updated_records), 1)

        history = RecordHistory.objects.filter(
            record_id=record1.id,
            action="update",
        ).first()
        self.assertIsNotNone(history)
        self.assertIn("_order", history.field_changes)
        self.assertIn(str(self.field_count.id), history.field_changes)
        self.assertEqual(history.field_changes[str(self.field_count.id)]["old"], 10)
        self.assertEqual(history.field_changes[str(self.field_count.id)]["new"], 99)

    @patch("apps.tabdata.services.record_service._sync_records_to_ydoc")
    def test_rebalance_orders_bumps_version_and_updated_at(self, mock_sync_ydoc):
        record1, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "B1", "数量": 1},
        )
        record2, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "B2", "数量": 2},
        )
        record3, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "B3", "数量": 3},
        )

        self.assertIsNotNone(record1)
        self.assertIsNotNone(record2)
        self.assertIsNotNone(record3)

        # 构造密集 order，强制触发重排更新
        self.table.records.filter(id=record1.id).update(order=1.0, position_id="pos-1")
        self.table.records.filter(id=record2.id).update(order=1.1, position_id="pos-2")
        self.table.records.filter(id=record3.id).update(order=1.2, position_id="pos-3")

        records_before = {
            record.id: record
            for record in self.table.records.filter(
                id__in=[record1.id, record2.id, record3.id],
                is_deleted=False,
            )
        }
        version_before = {record_id: rec.version for record_id, rec in records_before.items()}
        updated_at_before = {record_id: rec.updated_at for record_id, rec in records_before.items()}
        mock_sync_ydoc.reset_mock()

        self.record_service._rebalance_record_orders(self.table.id)

        records_after = list(
            self.table.records.filter(
                id__in=[record1.id, record2.id, record3.id],
                is_deleted=False,
            ).order_by("order")
        )
        self.assertEqual(len(records_after), 3)
        expected_orders = [ORDER_REBALANCE_STEP * index for index in (1, 2, 3)]

        for idx, rec in enumerate(records_after):
            self.assertAlmostEqual(float(rec.order), expected_orders[idx], places=6)
            self.assertGreater(
                rec.version, version_before.get(rec.id) or 0,
                f"rebalance 后 version 应严格递增（record={rec.id}）",
            )
            self.assertNotEqual(rec.updated_at, updated_at_before.get(rec.id))
            self.assertIsNone(rec.position_id)

        # 批量 rebalance 分配的版本号应连续递增
        versions_after = [rec.version for rec in records_after]
        self.assertEqual(
            versions_after,
            list(range(versions_after[0], versions_after[0] + len(versions_after))),
        )
        mock_sync_ydoc.assert_called_once_with(
            self.table.id,
            mock_sync_ydoc.call_args.args[1],
            fields=[],
            rebalance_record_ids=[str(record.id) for record in records_after],
            source="rebalance_record_orders",
        )
        synced_records = mock_sync_ydoc.call_args.args[1]
        self.assertEqual(
            {record.id for record in synced_records},
            {record.id for record in records_after},
        )

    def test_import_csv_create_emits_grouped_create_histories(self):
        service = ImportService(user=self.user)
        RecordHistory.objects.all().delete()

        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content="标题,数量\n导入A,1\n导入B,2\n",
        )
        self.assertEqual(created, 2)
        self.assertEqual(updated, 0)
        self.assertFalse(errors)

        records = list(self.table.records.filter(is_deleted=False))
        imported_ids = [
            record.id
            for record in records
            if record.data.get(str(self.field_title.id)) in {"导入A", "导入B"}
        ]
        self.assertEqual(len(imported_ids), 2)

        histories = list(
            RecordHistory.objects.filter(
                record_id__in=imported_ids,
                action="create",
            )
        )
        self.assertEqual(len(histories), 2)
        group_ids = {history.operation_group_id for history in histories}
        self.assertEqual(len(group_ids), 1)
        self.assertIsNotNone(next(iter(group_ids)))

        items = RecordHistoryItem.objects.filter(
            history_id__in=[history.id for history in histories],
        )
        self.assertEqual(items.count(), 4)

    def test_dv001_merge_window_saves_without_updated_at_field(self):
        """
        回归测试 DV-001：RecordHistory 没有 updated_at 字段，
        _try_merge_with_recent_history 曾在 save(update_fields=["field_changes", "updated_at"])
        时抛出 ValueError，导致 5 秒合并窗口完全失效、历史写入丢失。
        修复后，同用户同记录 5 秒内连续 update 应合并为一条历史，
        保留首次 before 和最新 after。
        """
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "合并前", "数量": 0},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        RecordHistory.objects.filter(record=record).delete()

        updated1, error = self.record_service.update_record(
            record_id=record.id,
            data={"标题": "第一次修改"},
        )
        self.assertIsNone(error)

        updated2, error = self.record_service.update_record(
            record_id=record.id,
            data={"标题": "第二次修改"},
        )
        self.assertIsNone(error)

        update_histories = list(
            RecordHistory.objects.filter(record=record, action="update")
        )
        self.assertEqual(
            len(update_histories), 1,
            "5 秒内同字段连续 update 应合并为 1 条历史",
        )

        history = update_histories[0]
        field_key = str(self.field_title.id)
        self.assertIn(field_key, history.field_changes)
        self.assertEqual(
            history.field_changes[field_key]["old"], "合并前",
            "合并后 before 应保留首次修改的 old 值",
        )
        self.assertEqual(
            history.field_changes[field_key]["new"], "第二次修改",
            "合并后 after 应使用最新的 new 值",
        )

        items = list(RecordHistoryItem.objects.filter(
            history=history, field_key=field_key,
        ))
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].before, "合并前")
        self.assertEqual(items[0].after, "第二次修改")

    def test_import_csv_update_emits_update_history_and_bumps_version(self):
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={"标题": "主键A", "数量": 10},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)
        version_before = record.version

        RecordHistory.objects.filter(record=record).delete()

        service = ImportService(user=self.user)
        created, updated, errors = service.import_from_csv(
            table_id=self.table.id,
            file_content="标题,数量\n主键A,99\n",
            update_existing=True,
            primary_key_field="标题",
        )
        self.assertEqual(created, 0)
        self.assertEqual(updated, 1)
        self.assertFalse(errors)

        record.refresh_from_db()
        self.assertEqual(record.version, version_before + 1)

        history = RecordHistory.objects.filter(record=record, action="update").first()
        self.assertIsNotNone(history)
        self.assertIn(str(self.field_count.id), history.field_changes)
        self.assertEqual(history.field_changes[str(self.field_count.id)]["old"], 10)
        self.assertEqual(history.field_changes[str(self.field_count.id)]["new"], 99.0)
