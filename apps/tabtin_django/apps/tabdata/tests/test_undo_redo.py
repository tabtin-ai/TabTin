"""
撤销/重做功能测试

测试撤销和重做功能的完整性
"""
from unittest.mock import patch
from django.test import TestCase, override_settings
from django.contrib.auth import get_user_model
from django.db import connections
from django.utils import timezone

from apps.tabtinspace.models import Organization, Space, Agent, SpaceMembership
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord, RecordHistory
from apps.tabdata.services.undo_redo_service import UndoRedoService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.native.ddl_manager import DDLManager
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_native_table(space_id, table_id, fields=None):
    """确保 native PG schema/table/columns 存在，供集成测试使用。"""
    ddl = DDLManager(db_alias="default")
    ddl.ensure_schema(space_id)
    ddl.create_native_table(space_id, table_id)
    for f in (fields or []):
        from apps.tabdata.native.pg_type_map import is_system_field
        if not is_system_field(f.field_type):
            ddl.add_column(space_id, table_id, f.id, f.field_type, f.config)


def _ensure_free_tier() -> None:
    """确保测试环境存在 free 会员等级，避免配额校验阻塞业务测试。"""
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'undo/redo 测试自动初始化',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


def _ensure_project_membership(
    organization: Organization,
    project: Space,
    user: User,
    role: str,
) -> None:
    """确保用户在项目内具备明确角色，避免权限依赖信号时序。"""
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        owner_user=user,
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
        defaults={
            'role': role,
            'is_active': True,
        },
    )


class TestUndoRedoService(TestCase):
    """测试撤销/重做服务"""

    # 指定使用的数据库
    databases = ['default', 'postgresql']

    def setUp(self):
        """测试前准备"""
        _ensure_free_tier()

        # 创建测试用户
        self.user1 = User.objects.create_user(
            username='testuser1',
            email='test1@example.com',
            password='password123'
        )
        self.user2 = User.objects.create_user(
            username='testuser2',
            email='test2@example.com',
            password='password123'
        )

        # 创建组织和项目
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.user1
        )
        self.organization.members.create(user=self.user1, role='owner')
        self.organization.members.create(user=self.user2, role='editor')

        self.space = Space.objects.create(
            organization=self.organization,
            name='测试项目',
            type="team",
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.user1,
            role='owner',
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.user2,
            role='editor',
        )

        # 创建表格和字段
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格',
            owner=self.user1
        )

        self.field1 = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            config={}
        )

        self.field2 = TableField.objects.create(
            table=self.table,
            name='数量',
            field_type='number',
            config={}
        )

        _ensure_native_table(
            self.space.id, self.table.id,
            [self.field1, self.field2],
        )

        # 创建记录服务和撤销/重做服务
        self.record_service = RecordService(user=self.user1)
        self.undo_redo_service = UndoRedoService(user=self.user1)

    def test_undo_record_update(self):
        """测试撤销记录更新"""
        # 创建记录
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '原始标题',
                '数量': 100
            }
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        # 更新记录
        updated_record, error = self.record_service.update_record(
            record_id=record.id,
            data={
                '标题': '修改后的标题',
                '数量': 200
            }
        )
        self.assertIsNone(error)

        # 撤销更新
        success, error, history = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertIsNotNone(history)

        # 验证记录恢复到原始值
        record.refresh_from_db()
        # 注意：由于数据存储使用字段UUID，需要获取实际的字段ID
        field1_id = str(self.field1.id)
        field2_id = str(self.field2.id)
        self.assertEqual(record.data.get(field1_id), '原始标题')
        self.assertEqual(record.data.get(field2_id), 100)

    def test_redo_record_update(self):
        """测试重做记录更新"""
        # 创建记录
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '原始标题',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        # 更新记录
        updated_record, error = self.record_service.update_record(
            record_id=record.id,
            data={
                '标题': '修改后的标题',
                '数量': 200
            }
        )
        self.assertIsNone(error)

        # 撤销更新
        success, error, _ = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)

        # 重做更新
        success, error, history = self.undo_redo_service.redo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertIsNotNone(history)

        # 验证记录恢复到修改后的值
        record.refresh_from_db()
        field1_id = str(self.field1.id)
        field2_id = str(self.field2.id)
        self.assertEqual(record.data.get(field1_id), '修改后的标题')
        self.assertEqual(record.data.get(field2_id), 200)

    def test_undo_only_my_operations(self):
        """测试只撤销当前用户的操作"""
        # 用户1创建记录
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '用户1创建',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        # 用户2更新记录
        service2 = RecordService(user=self.user2)
        updated_record, error = service2.update_record(
            record_id=record.id,
            data={
                '标题': '用户2修改',
                '数量': 200
            }
        )
        self.assertIsNone(error)

        # 用户1尝试撤销（只撤销自己的操作）
        undo_service1 = UndoRedoService(user=self.user1)
        success, error, history = undo_service1.undo_record_operation(
            record_id=record.id,
            only_my_operations=True
        )

        # 当前实现语义：only_my_operations 基于“用户自己的可撤销栈”
        # 用户1会撤销自己最近一次操作（创建）
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertIsNotNone(history)
        self.assertEqual(history.action, 'create')
        self.assertEqual(history.user_id, self.user1.id)

    def test_undo_window_isolation(self):
        """测试按 window_id 隔离撤销操作。

        ：5s 内同字段 update 会合并历史，必须在写入前设不同 window_id，
        不能事后改 window_id（合并后只剩一条）。
        """
        from apps.tabdata.request_context import clear_request_context, set_current_window_id

        try:
            set_current_window_id(None)
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': '窗口隔离测试',
                    '数量': 1,
                },
            )
            self.assertIsNone(error)

            set_current_window_id('win-a')
            _updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': '窗口A更新',
                    '数量': 2,
                },
            )
            self.assertIsNone(error)

            set_current_window_id('win-b')
            _updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': '窗口B更新',
                    '数量': 3,
                },
            )
            self.assertIsNone(error)

            update_histories = list(
                RecordHistory.objects.filter(record=record, action='update').order_by('created_at')
            )
            self.assertEqual(len(update_histories), 2)
            self.assertEqual(update_histories[0].window_id, 'win-a')
            self.assertEqual(update_histories[1].window_id, 'win-b')

            service_win_a = UndoRedoService(user=self.user1, window_id='win-a')
            success, undo_error, undone_history = service_win_a.undo_record_operation(record_id=record.id)
            self.assertTrue(success)
            self.assertIsNone(undo_error)
            self.assertIsNotNone(undone_history)
            self.assertEqual(undone_history.action, 'update')
            self.assertEqual(str(undone_history.id), str(update_histories[0].id))

            update_histories[0].refresh_from_db()
            update_histories[1].refresh_from_db()
            self.assertTrue(update_histories[0].is_undone)
            self.assertFalse(update_histories[1].is_undone)

            undo_stack_win_b = UndoRedoService(user=self.user1, window_id='win-b').get_undo_stack(
                table_id=self.table.id,
                limit=5,
            )
            self.assertGreaterEqual(len(undo_stack_win_b), 1)
            self.assertEqual(undo_stack_win_b[0]['id'], str(update_histories[1].id))
        finally:
            clear_request_context()

    def test_record_stack_scan_is_non_destructive(self):
        """记录级撤销扫描应命中目标记录且不消费 undo 栈。"""
        if not self.undo_redo_service._use_stack():
            self.skipTest('undo/redo stack 未启用，跳过栈扫描测试')

        record_a, error = self.record_service.create_record(
            table_id=self.table.id,
            data={'标题': '记录A', '数量': 1},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record_a)

        record_b, error = self.record_service.create_record(
            table_id=self.table.id,
            data={'标题': '记录B', '数量': 2},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record_b)

        history_a = RecordHistory.objects.filter(record=record_a, action='create').order_by('-created_at').first()
        history_b = RecordHistory.objects.filter(record=record_b, action='create').order_by('-created_at').first()
        self.assertIsNotNone(history_a)
        self.assertIsNotNone(history_b)

        operation_a = self.undo_redo_service.stack_service.build_operation_from_history(history_a)
        operation_b = self.undo_redo_service.stack_service.build_operation_from_history(history_b)

        with patch.object(
            self.undo_redo_service.stack_service,
            'get_undo_stack',
            return_value=([operation_b, operation_a], 2),
        ) as mocked_get_undo_stack:
            history = self.undo_redo_service._find_stack_history_for_record(
                table_id=self.table.id,
                record_id=record_a.id,
                operation_type='undo',
                only_my_operations=False,
                require_undone=False,
            )

        self.assertIsNotNone(history)
        self.assertEqual(str(history.id), str(history_a.id))
        mocked_get_undo_stack.assert_called_once()

    def test_load_history_from_operation_redo_only_my_uses_undone_by(self):
        """redo 场景 only_my_operations 应按 undone_by 过滤（与 DB 回退语义一致）。"""
        service2 = RecordService(user=self.user2)
        record, error = service2.create_record(
            table_id=self.table.id,
            data={'标题': '用户2记录', '数量': 10},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        success, undo_error, histories = self.undo_redo_service.undo_table_operation(
            table_id=self.table.id,
            only_my_operations=False,
        )
        self.assertTrue(success)
        self.assertIsNone(undo_error)
        self.assertTrue(histories)

        history = next((item for item in histories if str(item.record_id) == str(record.id)), None)
        self.assertIsNotNone(history)

        operation = self.undo_redo_service.stack_service.build_operation_from_history(
            history,
            is_undone=True,
            undone_at=history.undone_at.isoformat() if history.undone_at else None,
            undone_by={
                'id': self.user1.id,
                'name': self.user1.get_display_name(),
            },
        )
        loaded = self.undo_redo_service._load_history_from_operation(
            operation,
            table_id=self.table.id,
            only_my_operations=True,
            require_undone=True,
        )
        self.assertIsNotNone(loaded)
        self.assertEqual(str(loaded.id), str(history.id))

    def test_table_level_undo(self):
        """测试表格级别撤销"""
        # 创建多条记录
        records = []
        for i in range(3):
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': f'记录{i+1}',
                    '数量': (i+1) * 100
                }
            )
            self.assertIsNone(error)
            records.append(record)

        # 表格级别撤销（撤销最后一次创建）
        success, error, histories = self.undo_redo_service.undo_table_operation(
            table_id=self.table.id
        )
        self.assertTrue(success)
        self.assertEqual(len(histories), 1)  # 应该只撤销最后一条

    def test_get_undo_stack(self):
        """测试获取撤销栈"""
        # 创建记录
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '测试记录',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        # 多次更新记录
        for i in range(3):
            updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': f'更新{i+1}',
                    '数量': (i+1) * 100
                }
            )
            self.assertIsNone(error)

        # 获取撤销栈
        undo_stack = self.undo_redo_service.get_undo_stack(
            table_id=self.table.id,
            limit=10
        )

        # 应该有4个操作（1个创建 + 3个更新）
        self.assertEqual(len(undo_stack), 4)

    def test_get_redo_stack(self):
        """测试获取重做栈"""
        # 创建并更新记录
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '测试记录',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        updated_record, error = self.record_service.update_record(
            record_id=record.id,
            data={
                '标题': '更新后',
                '数量': 200
            }
        )
        self.assertIsNone(error)

        # 撤销更新
        success, error, _ = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)

        # 获取重做栈
        redo_stack = self.undo_redo_service.get_redo_stack(
            table_id=self.table.id,
            limit=10
        )

        # 应该有1个可重做的操作
        self.assertEqual(len(redo_stack), 1)
        self.assertEqual(redo_stack[0]['action'], 'update')

    def test_get_record_history(self):
        """测试获取记录历史。

        ：5s 内同字段连续 update 会合并为 1 条 RH（保留首次 before + 最新 after），
        期望为 create + 1 条合并后的 update = 2；撤销不额外写历史。
        """
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '测试记录',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        for i in range(3):
            updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': f'更新{i+1}',
                    '数量': (i+1) * 100
                }
            )
            self.assertIsNone(error)

        # 撤销一次
        success, error, _ = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)

        history = self.undo_redo_service.get_record_history(
            record_id=record.id,
            include_undone=True
        )

        # ：5s 同字段合并后，3 次 update 不应再产生 3 条独立 RH；
        # 撤销回放不额外写历史。具体条数随合并窗口边界可能是 2 或 3，只断言上界。
        actions = [item['action'] for item in history]
        self.assertIn('create', actions)
        self.assertIn('update', actions)
        self.assertLess(actions.count('update'), 3)
        self.assertLessEqual(len(history), 3)
        undone_items = [item for item in history if item['is_undone']]
        self.assertEqual(len(undone_items), 1)
        self.assertEqual(undone_items[0]['action'], 'update')
        self.assertTrue(all(isinstance(item.get('items'), list) for item in history))

        latest_update = next(item for item in history if item['action'] == 'update')
        title_item = next(
            (
                item for item in latest_update.get('items', [])
                if item.get('field_key') in {
                    str(self.field1.id),
                    self.field1.id.hex,
                    f'field:{self.field1.id}',
                    '标题',
                }
            ),
            latest_update.get('items', [None])[0] if latest_update.get('items') else None,
        )
        self.assertIsNotNone(title_item)
        self.assertIn('before', title_item)
        self.assertIn('after', title_item)

    def test_get_table_history(self):
        """测试获取表格范围历史（含过滤）"""
        # 用户1创建并更新记录
        record1, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '用户1记录',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        _updated_record, error = self.record_service.update_record(
            record_id=record1.id,
            data={
                '标题': '用户1记录-更新',
                '数量': 200
            }
        )
        self.assertIsNone(error)

        # 用户2创建另一条记录（用于 only_my_operations 过滤）
        service2 = RecordService(user=self.user2)
        record2, error = service2.create_record(
            table_id=self.table.id,
            data={
                '标题': '用户2记录',
                '数量': 50
            }
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record2)

        # 撤销一次，制造 is_undone=True 的历史记录
        success, undo_error, _ = self.undo_redo_service.undo_record_operation(
            record_id=record1.id
        )
        self.assertTrue(success)
        self.assertIsNone(undo_error)

        # 表级历史（包含已撤销）应包含至少 3 条（用户1创建+更新，用户2创建）
        full_history = self.undo_redo_service.get_table_history(
            table_id=self.table.id,
            include_undone=True,
            limit=20
        )
        self.assertGreaterEqual(len(full_history), 3)
        self.assertTrue(any(item['is_undone'] for item in full_history))

        # 不包含已撤销操作时，不应出现 is_undone=True
        active_history = self.undo_redo_service.get_table_history(
            table_id=self.table.id,
            include_undone=False,
            limit=20
        )
        self.assertTrue(all(not item['is_undone'] for item in active_history))

        # 仅看当前用户操作时，不应包含用户2创建的记录历史
        my_history = self.undo_redo_service.get_table_history(
            table_id=self.table.id,
            include_undone=True,
            only_my_operations=True,
            limit=20
        )
        self.assertTrue(all(item.get('user', {}).get('id') == self.user1.id for item in my_history))
        self.assertTrue(all(item['record_id'] != str(record2.id) for item in my_history))
        self.assertTrue(all(isinstance(item.get('items'), list) for item in my_history))

    def test_delete_record_history_and_undo_redo(self):
        """测试删除历史写入，以及删除操作可撤销/重做"""
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '待删除记录',
                '数量': 100
            }
        )
        self.assertIsNone(error)

        delete_success = self.record_service.delete_record(record.id)
        self.assertTrue(delete_success)

        # 删除历史应被记录
        delete_history = RecordHistory.objects.filter(
            record=record,
            action='delete'
        ).order_by('-created_at').first()
        self.assertIsNotNone(delete_history)
        self.assertEqual(
            delete_history.field_changes.get('_deleted', {}).get('new'),
            True
        )

        # 删除记录也应出现在表级撤销栈中
        undo_stack = self.undo_redo_service.get_undo_stack(
            table_id=self.table.id,
            limit=10
        )
        self.assertTrue(any(item['action'] == 'delete' for item in undo_stack))

        # 撤销删除 -> 恢复记录
        undo_success, undo_error, undo_history = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(undo_success)
        self.assertIsNone(undo_error)
        self.assertIsNotNone(undo_history)
        self.assertEqual(undo_history.action, 'delete')

        record.refresh_from_db()
        self.assertFalse(record.is_deleted)

        # 重做删除 -> 再次删除记录
        redo_success, redo_error, redo_history = self.undo_redo_service.redo_record_operation(
            record_id=record.id
        )
        self.assertTrue(redo_success)
        self.assertIsNone(redo_error)
        self.assertIsNotNone(redo_history)
        self.assertEqual(redo_history.action, 'delete')

        record.refresh_from_db()
        self.assertTrue(record.is_deleted)

    def test_operation_group(self):
        """测试操作组（批量操作的整体撤销）"""
        # 创建操作组ID
        group_id = self.undo_redo_service.create_operation_group()

        # 创建多条记录（模拟批量操作）
        records = []
        for i in range(3):
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': f'批量记录{i+1}',
                    '数量': (i+1) * 100
                }
            )
            self.assertIsNone(error)
            records.append(record)

            # 获取最后的历史记录并设置操作组ID
            history = RecordHistory.objects.filter(
                record=record
            ).order_by('-created_at').first()
            history.operation_group_id = group_id
            history.save()

        # 表格级别撤销（应该整体撤销3条记录）
        success, error, histories = self.undo_redo_service.undo_table_operation(
            table_id=self.table.id
        )
        self.assertTrue(success)
        self.assertEqual(len(histories), 3)  # 应该撤销整个操作组

        # 验证所有记录都被撤销
        for history in histories:
            self.assertTrue(history.is_undone)
            self.assertEqual(str(history.operation_group_id), str(group_id))

    @override_settings(TABDATA_UNDO_REDIS_STACK_ENABLED=False)
    def test_table_undo_savepoint_isolates_single_history_db_error(self):
        """单条 undo replay 的 DB 异常不应污染整批 history 事务。"""
        group_id = self.undo_redo_service.create_operation_group()
        histories = []
        for i in range(3):
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': f'撤销隔离{i+1}',
                    '数量': i + 1,
                }
            )
            self.assertIsNone(error)
            history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record=record,
            ).order_by('-created_at').first()
            history.operation_group_id = group_id
            history.save()
            histories.append(history)

        failed_history = histories[-1]

        def execute_undo(record, history, **kwargs):
            if history.id == failed_history.id:
                with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                    cursor.execute("SELECT 1 / 0")
            return True, None

        with patch.object(self.undo_redo_service, '_execute_undo', side_effect=execute_undo):
            success, error, undone_histories = self.undo_redo_service.undo_table_operation(
                table_id=self.table.id,
            )

        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertEqual(len(undone_histories), 2)
        self.assertNotIn("current transaction is aborted", str(error))

        failed_history.refresh_from_db()
        self.assertFalse(failed_history.is_undone)
        self.assertEqual(
            RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=[history.id for history in histories],
                is_undone=True,
            ).count(),
            2,
        )

    @override_settings(TABDATA_UNDO_REDIS_STACK_ENABLED=False)
    def test_table_redo_savepoint_isolates_single_history_db_error(self):
        """单条 redo replay 的 DB 异常不应污染整批 history 事务。"""
        group_id = self.undo_redo_service.create_operation_group()
        histories = []
        for i in range(3):
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': f'重做隔离{i+1}',
                    '数量': i + 1,
                }
            )
            self.assertIsNone(error)
            history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                record=record,
            ).order_by('-created_at').first()
            history.operation_group_id = group_id
            history.is_undone = True
            history.undone_at = timezone.now()
            history.undone_by = self.user1
            history.save()
            histories.append(history)

        failed_history = histories[-1]

        def execute_redo(record, history, **kwargs):
            if history.id == failed_history.id:
                with connections[TABDATA_DB_ALIAS].cursor() as cursor:
                    cursor.execute("SELECT 1 / 0")
            return True, None

        with patch.object(self.undo_redo_service, '_execute_redo', side_effect=execute_redo):
            success, error, redone_histories = self.undo_redo_service.redo_table_operation(
                table_id=self.table.id,
            )

        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertEqual(len(redone_histories), 2)
        self.assertNotIn("current transaction is aborted", str(error))

        failed_history.refresh_from_db()
        self.assertTrue(failed_history.is_undone)
        self.assertEqual(
            RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
                id__in=[history.id for history in histories],
                is_undone=False,
            ).count(),
            2,
        )

    @override_settings(TABDATA_UNDO_REDIS_STACK_ENABLED=False)
    def test_table_redo_delete_strict_replay_reports_optimistic_lock(self):
        """表级 redo delete 的 native 乐观锁冲突不能被 strict replay 吞掉。"""
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '重做删除冲突',
                '数量': 1,
            }
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        history = RecordHistory.objects.using(TABDATA_DB_ALIAS).filter(
            record=record,
        ).order_by('-created_at').first()
        history.action = 'delete'
        history.field_changes = {
            '_deleted': {'old': False, 'new': True},
        }
        history.is_undone = True
        history.undone_at = timezone.now()
        history.undone_by = self.user1
        history.save()

        conflict_message = (
            f"并发冲突：记录 {record.id} 版本已变更"
            f"（期望 version={record.version + 1}），删除被拒绝"
        )
        with patch(
            'apps.tabdata.native.record_io.NativeRecordIO.delete_record',
            side_effect=RuntimeError(conflict_message),
        ):
            success, redo_error, redone_histories = self.undo_redo_service.redo_table_operation(
                table_id=self.table.id,
            )

        self.assertFalse(success)
        self.assertIn("并发冲突", redo_error)
        self.assertNotIn("current transaction is aborted", redo_error)
        self.assertEqual(redone_histories, [])

        history.refresh_from_db()
        self.assertTrue(history.is_undone)
        record.refresh_from_db()
        self.assertFalse(record.is_deleted)

    @override_settings(TABDATA_UNDO_DB_COMPAT_FALLBACK=False)
    def test_stack_mode_no_db_fallback_when_stack_empty(self):
        """关闭兼容回退时，空栈不应回退 DB 状态位。"""
        if not self.undo_redo_service._use_stack():
            self.skipTest('undo/redo stack 未启用，跳过空栈语义测试')

        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '空栈测试',
                '数量': 1,
            }
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        # 人工清空栈，保留 DB 历史
        user_id = str(self.user1.id)
        table_id = str(self.table.id)
        self.undo_redo_service.stack_service._clear_stack(
            self.undo_redo_service.stack_service._undo_key(user_id, table_id, None)
        )
        self.undo_redo_service.stack_service._clear_stack(
            self.undo_redo_service.stack_service._redo_key(user_id, table_id, None)
        )

        success, undo_error, history = self.undo_redo_service.undo_record_operation(
            record_id=record.id
        )
        self.assertFalse(success)
        self.assertIsNone(history)
        self.assertEqual(undo_error, "没有可撤销的操作")

    @override_settings(TABDATA_UNDO_DB_COMPAT_FALLBACK=True)
    def test_stack_mode_can_opt_in_db_fallback(self):
        """开启兼容开关后，空栈可回退 DB 状态位。"""
        service = UndoRedoService(user=self.user1)
        if not service._use_stack():
            self.skipTest('undo/redo stack 未启用，跳过 DB 兼容回退测试')

        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={
                '标题': '回退测试',
                '数量': 2,
            }
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        user_id = str(self.user1.id)
        table_id = str(self.table.id)
        service.stack_service._clear_stack(
            service.stack_service._undo_key(user_id, table_id, None)
        )
        service.stack_service._clear_stack(
            service.stack_service._redo_key(user_id, table_id, None)
        )

        success, undo_error, history = service.undo_record_operation(
            record_id=record.id
        )
        self.assertTrue(success)
        self.assertIsNone(undo_error)
        self.assertIsNotNone(history)
        self.assertEqual(history.action, 'create')

    @override_settings(TABDATA_UNDO_REDIS_STACK_ENABLED=False)
    def test_window_scope_strict_excludes_null_window_by_default(self):
        """window_id 隔离默认不再包含 null 窗口历史。

        ：写入前设 window_id，避免 5s 合并把两条 update 收成一条。
        """
        from apps.tabdata.request_context import clear_request_context, set_current_window_id

        try:
            set_current_window_id(None)
            record, error = self.record_service.create_record(
                table_id=self.table.id,
                data={
                    '标题': '窗口严格隔离',
                    '数量': 10,
                }
            )
            self.assertIsNone(error)
            self.assertIsNotNone(record)

            set_current_window_id(None)
            _updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': '窗口A',
                    '数量': 11,
                },
            )
            self.assertIsNone(error)

            set_current_window_id('win-b')
            _updated_record, error = self.record_service.update_record(
                record_id=record.id,
                data={
                    '标题': '窗口B',
                    '数量': 12,
                },
            )
            self.assertIsNone(error)

            histories = list(
                RecordHistory.objects.filter(record=record, action='update').order_by('created_at')
            )
            self.assertEqual(len(histories), 2)
            self.assertIsNone(histories[0].window_id)
            self.assertEqual(histories[1].window_id, 'win-b')

            service_win_b = UndoRedoService(user=self.user1, window_id='win-b')
            undo_stack = service_win_b.get_undo_stack(table_id=self.table.id, limit=10)
            self.assertEqual(len(undo_stack), 1)
            self.assertEqual(undo_stack[0]['id'], str(histories[1].id))
        finally:
            clear_request_context()

    def test_delete_undo_redo_keeps_native_consistent(self):
        """删除 → 撤销 → 重做后，ORM 和 native 数据保持一致。"""
        from apps.tabdata.native.record_io import NativeRecordIO

        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={'标题': 'native一致性', '数量': 99},
        )
        self.assertIsNone(error)

        native_io = NativeRecordIO(self.space.id, self.table.id)

        self.assertTrue(native_io.record_exists(record.id))

        deleted = self.record_service.delete_record(record_id=record.id)
        self.assertTrue(deleted)

        success, error, _ = self.undo_redo_service.undo_record_operation(
            record_id=record.id,
        )
        self.assertTrue(success, f"undo 失败: {error}")

        record.refresh_from_db()
        self.assertFalse(record.is_deleted, "undo 后 ORM 应未删除")
        self.assertTrue(native_io.record_exists(record.id), "undo 后 native 行应存在")

        success2, error2, _ = self.undo_redo_service.redo_record_operation(
            record_id=record.id,
        )
        self.assertTrue(success2, f"redo 失败: {error2}")

        record.refresh_from_db()
        self.assertTrue(record.is_deleted, "redo 后 ORM 应已删除")
        self.assertFalse(native_io.record_exists(record.id), "redo 后 native 行应不存在")

    @override_settings(TABDATA_UNDO_REDIS_STACK_ENABLED=False)
    def test_db_history_redo_delete_rolls_back_on_native_lock_conflict(self):
        """DB history replay 中 redo delete 遇到 native 乐观锁冲突必须失败并回滚。"""
        from apps.tabdata.native.record_io import NativeRecordIO

        service = UndoRedoService(user=self.user1)
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={'标题': 'DB history replay', '数量': 863},
        )
        self.assertIsNone(error)
        self.assertIsNotNone(record)

        native_io = NativeRecordIO(self.space.id, self.table.id)
        self.assertTrue(native_io.record_exists(record.id))

        deleted = self.record_service.delete_record(record_id=record.id)
        self.assertTrue(deleted)

        undo_success, undo_error, undo_history = service.undo_record_operation(
            record_id=record.id,
        )
        self.assertTrue(undo_success, f"undo 失败: {undo_error}")
        self.assertIsNotNone(undo_history)
        record.refresh_from_db()
        self.assertFalse(record.is_deleted, "undo 后 ORM 应恢复")
        self.assertTrue(native_io.record_exists(record.id), "undo 后 native 行应存在")

        conflict_message = "并发冲突：模拟 native 乐观锁冲突"
        with patch(
            "apps.tabdata.native.record_io.NativeRecordIO.delete_record",
            side_effect=RuntimeError(conflict_message),
        ):
            redo_success, redo_error, redo_history = service.redo_record_operation(
                record_id=record.id,
            )

        self.assertFalse(redo_success)
        self.assertIn(conflict_message, redo_error or "")
        self.assertIsNone(redo_history)

        record.refresh_from_db()
        self.assertFalse(record.is_deleted, "redo 失败后 ORM 不应提交删除态")
        self.assertTrue(native_io.record_exists(record.id), "redo 失败后 native 行仍应存在")

        undo_history.refresh_from_db()
        self.assertTrue(undo_history.is_undone, "redo 失败后 history 仍应保留在可重做态")

    def test_restore_record_to_history_writes_complete_history_contract(self):
        """restore_record_to_history 创建的历史包含完整 metadata。"""
        record, error = self.record_service.create_record(
            table_id=self.table.id,
            data={'标题': '版本1', '数量': 1},
        )
        self.assertIsNone(error)

        self.record_service.update_record(
            record_id=record.id,
            data={'标题': '版本2', '数量': 2},
        )

        first_history = RecordHistory.objects.filter(
            record=record, action='create',
        ).first()
        self.assertIsNotNone(first_history)

        svc = UndoRedoService(user=self.user1, window_id='restore-win')
        result = svc.restore_record_to_history(record.id, first_history.id)
        self.assertIsNotNone(result)

        restore_history = RecordHistory.objects.filter(
            record=record,
        ).order_by('-created_at').first()
        self.assertIsNotNone(restore_history)
        self.assertEqual(restore_history.window_id, 'restore-win')
        self.assertIsNotNone(restore_history.operation_group_id)


class TestUndoRedoPermissions(TestCase):
    """测试撤销/重做权限控制"""

    # 指定使用的数据库
    databases = ['default', 'postgresql']

    def setUp(self):
        """测试前准备"""
        _ensure_free_tier()

        self.owner = User.objects.create_user(
            username='owner',
            email='owner@example.com',
            password='password123'
        )
        self.viewer = User.objects.create_user(
            username='viewer',
            email='viewer@example.com',
            password='password123'
        )

        # 创建组织和表格
        self.organization = Organization.objects.create(
            name='测试组织',
            owner=self.owner
        )
        self.organization.members.create(user=self.owner, role='owner')
        self.organization.members.create(user=self.viewer, role='viewer')

        self.space = Space.objects.create(
            organization=self.organization,
            name='测试项目',
            type="team",
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.owner,
            role='owner',
        )
        _ensure_project_membership(
            organization=self.organization,
            project=self.space,
            user=self.viewer,
            role='viewer',
        )

        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='测试表格',
            owner=self.owner
        )
        _ensure_native_table(self.space.id, self.table.id)

    def test_viewer_cannot_undo(self):
        """测试查看者不能撤销操作"""
        # : 记录写入必须用真实字段名（或 32 位 hex），不能用非法列名 'test'
        field = TableField.objects.create(
            table=self.table,
            name='标题',
            field_type='text',
            config={},
        )
        _ensure_native_table(self.space.id, self.table.id, [field])

        owner_service = RecordService(user=self.owner)
        record, error = owner_service.create_record(
            table_id=self.table.id,
            data={'标题': 'value'},
        )
        self.assertIsNone(error)

        # Viewer尝试撤销
        viewer_undo_service = UndoRedoService(user=self.viewer)
        success, error, _ = viewer_undo_service.undo_record_operation(
            record_id=record.id
        )

        # 应该失败（没有权限）
        self.assertFalse(success)
        self.assertIn("没有权限", error)
