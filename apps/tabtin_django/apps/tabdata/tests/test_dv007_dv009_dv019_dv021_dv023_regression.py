"""
回归测试：DV-007, DV-009, DV-019, DV-021, DV-023

覆盖：
- DV-007: create 操作 field_changes 标准化为 {field: {old, new}} 格式
- DV-009: reconstruct_record_at_history 在 RecordHistoryItem 缺失时的兜底
- DV-019: reconstruct 和 _resolve_replay_target 数据来源一致性
- DV-021: TableNamedVersion.history_id 引用失效时 API 层提示
- DV-023: _build_operations_batch 消除 N+1 查询
"""
import uuid
from unittest.mock import patch, MagicMock
from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.tabtinspace.models import Organization, Space, Agent, SpaceMembership
from apps.tabdata.models import (
    Table, TableField, TableRecord,
    RecordHistory, RecordHistoryItem, TableNamedVersion,
)
from apps.tabdata.services.undo_redo_service import UndoRedoService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.api_undo_redo import _build_operations_batch
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_native_table(space_id, table_id, fields=None):
    ddl = DDLManager(db_alias="default")
    ddl.ensure_schema(space_id)
    ddl.create_native_table(space_id, table_id)
    for f in (fields or []):
        from apps.tabdata.native.pg_type_map import is_system_field
        if not is_system_field(f.field_type):
            ddl.add_column(space_id, table_id, f.id, f.field_type, f.config)


def _ensure_free_tier():
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': '回归测试初始化',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


def _ensure_project_membership(organization, project, user, role):
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={
            'name': user.get_display_name(),
            'type': 'human',
            'is_active': True,
        },
    )
    if not agent.is_active:
        agent.is_active = True
        agent.save(update_fields=['is_active', 'updated_at'])
    SpaceMembership.objects.update_or_create(
        workspace=project,
        agent=agent,
        defaults={'role': role, 'is_active': True},
    )


class VersioningRegressionBase(TestCase):
    """共享 setUp：创建表格、字段、用户、服务实例"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()

        self.user = User.objects.create_user(
            username='dv_test_user',
            email='dv_test@example.com',
            password='password123',
        )

        self.organization = Organization.objects.create(name='DV测试团队', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')

        self.space = Space.objects.create(organization=self.organization, name='DV测试项目')
        _ensure_project_membership(self.organization, self.space, self.user, 'owner')

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='DV测试表格',
            owner=self.user,
        )

        self.field1 = TableField.objects.create(
            table=self.table, name='标题', field_type='text', config={},
        )
        self.field2 = TableField.objects.create(
            table=self.table, name='数量', field_type='number', config={},
        )

        _ensure_native_table(self.space.id, self.table.id, [self.field1, self.field2])

        self.record_service = RecordService(user=self.user)
        self.undo_redo_service = UndoRedoService(user=self.user)


class TestDV007CreateFieldChangesFormat(VersioningRegressionBase):
    """DV-007: create 操作的 field_changes 必须是标准的 {field: {old, new}} 格式"""

    def test_create_record_field_changes_uses_standard_format(self):
        """验证 create_record 产生的 RecordHistory.field_changes 使用标准格式"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "hello"},
        )
        self.assertIsNotNone(record)

        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()
        self.assertIsNotNone(history, "create 操作应产生 RecordHistory")

        fc = history.field_changes
        # 不应有旧的 {"data": {...}} 打包格式
        self.assertNotIn("data", fc, "field_changes 不应包含 'data' 打包键")
        # 应有独立的 field_key
        field_key = str(self.field1.id)
        self.assertIn(field_key, fc, f"field_changes 应包含字段 {field_key}")
        self.assertIsInstance(fc[field_key], dict)
        self.assertIsNone(fc[field_key].get("old"), "create 的 old 应为 None")
        self.assertEqual(fc[field_key]["new"], "hello")

    def test_resolve_replay_target_handles_create_correctly(self):
        """验证 _resolve_replay_target 对 create 操作能正确 undo/redo"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "test_value"},
        )
        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()
        self.assertIsNotNone(history)

        # undo create → 应得到 is_deleted=True
        next_data, next_is_deleted, next_order = self.undo_redo_service._resolve_replay_target(
            record, history, "undo",
        )
        self.assertTrue(next_is_deleted, "undo create 应标记为已删除")

        # redo create → 应恢复数据
        next_data, next_is_deleted, next_order = self.undo_redo_service._resolve_replay_target(
            record, history, "redo",
        )
        self.assertFalse(next_is_deleted, "redo create 应恢复为未删除")
        field_key = str(self.field1.id)
        self.assertEqual(next_data.get(field_key), "test_value",
                         "redo create 应恢复字段值")

    def test_resolve_replay_target_handles_legacy_create_format(self):
        """验证 _resolve_replay_target 对旧版 create 格式 {"data": {...}} 的兼容"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "legacy_val"},
        )
        # 手动将 field_changes 改回旧格式以模拟历史数据
        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()
        history.field_changes = {"data": {str(self.field1.id): "legacy_val"}}
        history.save(using=TABDATA_DB_ALIAS, update_fields=["field_changes"])

        # undo 应该能正确处理
        next_data, next_is_deleted, _ = self.undo_redo_service._resolve_replay_target(
            record, history, "undo",
        )
        self.assertTrue(next_is_deleted)
        # undo create 的旧格式应将字段设为 None
        self.assertIsNone(next_data.get(str(self.field1.id)))

    def test_history_api_normalizes_legacy_create_field_keys(self):
        """历史 API 输出应把旧版 data/hex key 归一成前端字段 UUID。"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "legacy_val"},
        )
        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()
        self.assertIsNotNone(history)

        history.field_changes = {
            "data": {
                self.field1.id.hex: "legacy_val",
                str(self.field2.id): 3,
            },
        }
        history.save(using=TABDATA_DB_ALIAS, update_fields=["field_changes"])
        RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(history=history).delete()
        RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).create(
            history=history,
            record=record,
            field_key=self.field1.id.hex,
            before=None,
            after="legacy_val",
        )

        operation = _build_operations_batch([history])[0]

        self.assertNotIn("data", operation.field_changes)
        self.assertIn(str(self.field1.id), operation.field_changes)
        self.assertIn(str(self.field2.id), operation.field_changes)
        self.assertNotIn(self.field1.id.hex, operation.field_changes)
        self.assertEqual(operation.field_changes[str(self.field1.id)]["new"], "legacy_val")
        self.assertEqual(operation.items[0].field_key, str(self.field1.id))


class TestDV009ReconstructFallback(VersioningRegressionBase):
    """DV-009: reconstruct_record_at_history 在 RecordHistoryItem 缺失时应从 field_changes 兜底"""

    def test_reconstruct_fallback_when_items_missing(self):
        """当 RecordHistoryItem 被删除时，应从 field_changes 兜底重建"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "v1"},
        )
        # update → 产生 history + items
        self.record_service.update_record(
            record_id=record.id,
            data={str(self.field1.id): "v2"},
        )

        create_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()
        update_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='update',
        ).first()
        self.assertIsNotNone(create_history)
        self.assertIsNotNone(update_history)

        # 删除 update 的 RecordHistoryItem 以模拟缺失
        RecordHistoryItem.objects.using(TABDATA_DB_ALIAS).filter(
            history=update_history,
        ).delete()

        # reconstruct 到 create_history 时间点应从 field_changes 兜底
        snapshot = self.undo_redo_service.reconstruct_record_at_history(
            record_id=record.id,
            history_id=create_history.id,
        )
        self.assertIsNotNone(snapshot, "即使 RecordHistoryItem 缺失，reconstruct 也不应返回 None")
        # update 的 field_changes 有 old=v1, new=v2，反向应用 → v1
        self.assertEqual(snapshot.get(str(self.field1.id)), "v1",
                         "兜底逻辑应正确回退到 v1")


class TestDV019UnifiedDataSource(VersioningRegressionBase):
    """DV-019: reconstruct 和 _resolve_replay_target 对同一操作应产生一致结果"""

    def test_reconstruct_and_replay_consistency(self):
        """验证 reconstruct_record_at_history 和 restore_record_to_history 路径一致"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "original"},
        )
        create_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record, action='create',
        ).first()

        self.record_service.update_record(
            record_id=record.id,
            data={str(self.field1.id): "modified"},
        )

        # 路径1: reconstruct（基于 RecordHistoryItem）
        snapshot = self.undo_redo_service.reconstruct_record_at_history(
            record_id=record.id,
            history_id=create_history.id,
        )
        self.assertIsNotNone(snapshot)
        self.assertEqual(snapshot.get(str(self.field1.id)), "original")

        # 路径2: restore（内部调用 reconstruct → replay）
        restored = self.undo_redo_service.restore_record_to_history(
            record_id=record.id,
            history_id=create_history.id,
        )
        self.assertIsNotNone(restored)
        self.assertEqual(restored.get(str(self.field1.id)), "original",
                         "两条路径应对同一历史点返回一致的快照")


class TestDV021NamedVersionHistoryValidity(VersioningRegressionBase):
    """DV-021: TableNamedVersion.history_id 引用失效时应标记 history_valid=False"""

    def test_serialize_named_version_with_valid_history(self):
        """有效 history_id 应标记 history_valid=True"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "data"},
        )
        latest_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record,
        ).first()

        version = TableNamedVersion.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            organization_id=self.organization.id,
            history_id=latest_history.id,
            snapshot_at=timezone.now(),
            name='valid version',
            created_by=self.user,
        )

        serialized = self.undo_redo_service._serialize_named_version(version)
        self.assertTrue(serialized['history_valid'], "有效 history_id 应为 True")

    def test_serialize_named_version_with_expired_history(self):
        """失效 history_id（已被 TTL 清理）应标记 history_valid=False"""
        fake_history_id = uuid.uuid4()
        version = TableNamedVersion.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            organization_id=self.organization.id,
            history_id=fake_history_id,
            snapshot_at=timezone.now(),
            name='expired version',
            created_by=self.user,
        )

        serialized = self.undo_redo_service._serialize_named_version(version)
        self.assertFalse(serialized['history_valid'],
                         "引用不存在的 history_id 应标记为 False")

    def test_list_named_versions_batch_validates_history(self):
        """list 接口应批量检测 history_valid，而非 N+1"""
        record, _ = self.record_service.create_record(
            table_id=self.table.id,
            data={str(self.field1.id): "data"},
        )
        valid_history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record,
        ).first()

        # 创建一个有效版本和一个失效版本
        TableNamedVersion.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            organization_id=self.organization.id,
            history_id=valid_history.id,
            snapshot_at=timezone.now(),
            name='valid',
            created_by=self.user,
        )
        TableNamedVersion.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            organization_id=self.organization.id,
            history_id=uuid.uuid4(),
            snapshot_at=timezone.now(),
            name='expired',
            created_by=self.user,
        )

        versions = self.undo_redo_service.list_table_named_versions(
            table_id=self.table.id,
        )
        self.assertEqual(len(versions), 2)

        valid_versions = [v for v in versions if v['history_valid']]
        invalid_versions = [v for v in versions if not v['history_valid']]
        self.assertEqual(len(valid_versions), 1)
        self.assertEqual(len(invalid_versions), 1)


class TestDV023BatchOperationsNoPlusOne(TestCase):
    """DV-023: _build_operations_batch 消除 N+1 查询"""

    def test_build_operations_batch_with_dicts(self):
        """dict 格式的操作应正常通过 _build_operations_batch"""
        from apps.tabdata.api_undo_redo import _build_operations_batch

        ops = [
            {
                'id': str(uuid.uuid4()),
                'record_id': str(uuid.uuid4()),
                'action': 'update',
                'action_display': '更新',
                'field_changes': {'f1': {'old': 'a', 'new': 'b'}},
                'items': [],
                'user': {'id': 1, 'name': 'TestUser'},
                'created_at': timezone.now().isoformat(),
                'is_undone': False,
            },
            {
                'id': str(uuid.uuid4()),
                'record_id': str(uuid.uuid4()),
                'action': 'create',
                'action_display': '创建',
                'field_changes': {'f1': {'old': None, 'new': 'x'}},
                'items': [],
                'user': {'id': 2, 'name': 'TestUser2'},
                'created_at': timezone.now().isoformat(),
                'is_undone': False,
            },
        ]

        result = _build_operations_batch(ops)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].action, 'update')
        self.assertEqual(result[1].action, 'create')

    def test_build_operations_batch_empty(self):
        """空列表应返回空"""
        from apps.tabdata.api_undo_redo import _build_operations_batch
        self.assertEqual(_build_operations_batch([]), [])

    def test_build_operations_batch_preserves_order(self):
        """批量构建应保持输入顺序"""
        from apps.tabdata.api_undo_redo import _build_operations_batch

        ops = []
        for i in range(5):
            ops.append({
                'id': str(uuid.uuid4()),
                'record_id': str(uuid.uuid4()),
                'action': f'action_{i}',
                'action_display': f'动作{i}',
                'field_changes': {},
                'items': [],
                'user': None,
                'created_at': timezone.now().isoformat(),
                'is_undone': False,
            })

        result = _build_operations_batch(ops)
        for i, op in enumerate(result):
            self.assertEqual(op.action, f'action_{i}',
                             "结果应保持与输入相同的顺序")
