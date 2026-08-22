from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, SimpleTestCase, TestCase
from django.db import connections

from apps.tabdata.request_context import clear_request_context, set_current_window_id
from apps.tabdata.models import Table, TableField, TableView
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.services.table_service import TableService
from apps.tabdata.services.undo_redo_service import UndoRedoService
from apps.tabdata.services.view_service import ViewService
from apps.tabtinspace.models import Agent, Space, SpaceMembership, Organization
from apps.users.membership.models import MembershipTier

User = get_user_model()


def _ensure_free_tier() -> None:
    MembershipTier.objects.update_or_create(
        tier_type='free',
        defaults={
            'name': '免费版',
            'description': 'undo/redo 结构操作测试自动初始化',
            'max_tables': -1,
            'max_records_per_table': -1,
            'max_api_calls_per_day': -1,
            'max_crawl_tasks_per_day': -1,
            'features': {},
            'sort_order': 0,
            'is_active': True,
        }
    )


def _bind_project_role(organization: Organization, project: Space, user: User, role: str) -> None:
    agent, _ = Agent.objects.get_or_create(
        organization=organization,
        user=user,
        defaults={
            'name': user.get_display_name(),
            'type': 'human',
            'is_active': True,
        },
    )
    SpaceMembership.objects.update_or_create(
        workspace=project,
        agent=agent,
        defaults={'role': role, 'is_active': True},
    )


class TestUndoRedoStructureOperations(TestCase):
    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username='structure-owner',
            email='structure-owner@example.com',
            password='password123',
        )
        self.organization = Organization.objects.create(name='结构操作测试空间', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')
        self.space = Space.objects.create(
            organization=self.organization,
            name='结构操作测试项目',
            type="team",
        )
        _bind_project_role(self.organization, self.space, self.user, 'owner')
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='结构操作表',
            owner=self.user,
        )
        ddl = DDLManager(db_alias="default")
        ddl.ensure_schema(self.space.id)
        ddl.create_native_table(self.space.id, self.table.id)
        self.table_service = TableService(user=self.user)
        self.view_service = ViewService(user=self.user)
        self.undo_service = UndoRedoService(user=self.user)
        self._has_view_column_meta = self._check_view_column_meta()

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def _clear_stack(self, window_id: str):
        user_id = str(self.user.id)
        table_id = str(self.table.id)
        self.undo_service.stack_service._clear_stack(
            self.undo_service.stack_service._undo_key(user_id, table_id, window_id)
        )
        self.undo_service.stack_service._clear_stack(
            self.undo_service.stack_service._redo_key(user_id, table_id, window_id)
        )

    def _check_view_column_meta(self) -> bool:
        with connections['postgresql'].cursor() as cursor:
            cursor.execute(
                """
                SELECT 1
                FROM information_schema.columns
                WHERE table_name = 'tabdata_view' AND column_name = 'column_meta'
                LIMIT 1
                """
            )
            return cursor.fetchone() is not None

    def test_field_create_undo_redo_via_structure_operation(self):
        window_id = 'win-structure-field'
        set_current_window_id(window_id)
        self._clear_stack(window_id)

        field = self.table_service.create_field(
            table_id=self.table.id,
            name='状态',
            field_type='text',
        )
        self.assertIsNotNone(field)
        self.assertFalse(field.is_deleted)

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = scoped_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertTrue(undo_stack)
        self.assertEqual(undo_stack[0].get('name'), 'createFields')

        with patch.object(
            scoped_service,
            '_execute_undo',
            side_effect=AssertionError('structured operation 不应进入 DB history undo replay'),
        ):
            success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'createFields')

        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        with patch.object(
            scoped_service,
            '_execute_redo',
            side_effect=AssertionError('structured operation 不应进入 DB history redo replay'),
        ):
            success, error, operations = scoped_service.redo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'createFields')

        field.refresh_from_db()
        self.assertFalse(field.is_deleted)

    def test_field_delete_undo_uses_same_window_operation_stack(self):
        window_id = 'win-structure-delete-field'
        set_current_window_id(window_id)

        field = self.table_service.create_field(
            table_id=self.table.id,
            name='可撤回字段',
            field_type='text',
        )
        self._clear_stack(window_id)

        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            deleted = self.table_service.delete_field(field.id)

        self.assertTrue(deleted)
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = scoped_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertTrue(undo_stack)
        self.assertEqual(undo_stack[0].get('name'), 'deleteFields')

        success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'deleteFields')

        field.refresh_from_db()
        self.assertFalse(field.is_deleted)

    def test_field_delete_undo_reports_failure_and_keeps_operation_on_restore_error(self):
        """根因 #1+#2 回归：restore 全部失败时 undo 必须返回失败（不假成功），
        且弹出的 deleteFields 操作要回栈，字段保持已删除、可修复后重试。"""
        window_id = 'win-structure-restore-fail'
        set_current_window_id(window_id)

        field = self.table_service.create_field(
            table_id=self.table.id,
            name='恢复失败字段',
            field_type='text',
        )
        self._clear_stack(window_id)

        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            deleted = self.table_service.delete_field(field.id)
        self.assertTrue(deleted)
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)

        # 模拟 restore 全部失败（如软删期间另建同名字段）：restored 为空 + errors 非空
        def _all_fail(payloads, **kwargs):
            return [], [(str(p.get('id')), '当前表已存在同名字段') for p in payloads]

        with patch(
            'apps.tabdata.services.undo_redo_field_restore.restore_fields',
            side_effect=_all_fail,
        ):
            success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)

        # 不能假成功
        self.assertFalse(success)
        self.assertIsNotNone(error)
        self.assertIn('同名字段', error)
        self.assertFalse(operations)

        # 字段保持已删除
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        # 操作已回栈，仍可再次撤销（修复前置条件后重试）
        retry_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = retry_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertTrue(undo_stack)
        self.assertEqual(undo_stack[0].get('name'), 'deleteFields')

        # 不再 mock，重试 → 真正恢复成功
        success, error, operations = retry_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        field.refresh_from_db()
        self.assertFalse(field.is_deleted)

    def test_field_delete_undo_falls_back_to_global_window(self):
        """window 未就绪时删除落到全局(__global__)栈，带具体窗口的 Ctrl+Z 应能
        通过全局回退找到并恢复——复现「删除字段撤销提示失败但字段可恢复」的线上现象。"""
        # 删除时 window 未就绪（None）→ 操作进 __global__ 栈
        set_current_window_id(None)
        field = self.table_service.create_field(
            table_id=self.table.id,
            name='全局回退字段',
            field_type='text',
        )
        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            deleted = self.table_service.delete_field(field.id)
        self.assertTrue(deleted)
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        # 撤销时带上了具体 window（前端此时 getWindowId 已就绪）
        window_id = 'win-ready-after-delete'
        scoped_service = UndoRedoService(user=self.user, window_id=window_id)

        # 该窗口自己的栈为空，但全局栈有可撤项 → 按钮应点亮（回退）
        _ops, total = scoped_service.get_undo_stack_page(table_id=self.table.id, limit=5)
        self.assertGreaterEqual(total, 1)

        success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'deleteFields')

        field.refresh_from_db()
        self.assertFalse(field.is_deleted)

        # redo 也应能通过全局回退命中（next 操作被推回全局 redo 栈）
        success, error, operations = scoped_service.redo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

    def test_field_delete_undo_does_not_cross_window(self):
        window_a = 'win-structure-delete-a'
        window_b = 'win-structure-delete-b'
        set_current_window_id(window_a)

        field = self.table_service.create_field(
            table_id=self.table.id,
            name='窗口隔离字段',
            field_type='text',
        )
        self._clear_stack(window_a)
        self._clear_stack(window_b)

        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            deleted = self.table_service.delete_field(field.id)

        self.assertTrue(deleted)

        other_window_service = UndoRedoService(user=self.user, window_id=window_b)
        success, error, operations = other_window_service.undo_table_operation(table_id=self.table.id)
        self.assertFalse(success)
        self.assertIsNotNone(error)
        self.assertFalse(operations)

        field.refresh_from_db()
        self.assertTrue(field.is_deleted)

        same_window_service = UndoRedoService(user=self.user, window_id=window_a)
        success, error, operations = same_window_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)

        field.refresh_from_db()
        self.assertFalse(field.is_deleted)

    def test_view_update_undo_redo_via_structure_operation(self):
        if not self._has_view_column_meta:
            self.skipTest('当前测试库缺少 tabdata_view.column_meta，跳过视图结构操作测试')

        window_id = 'win-structure-view'
        set_current_window_id(window_id)
        self._clear_stack(window_id)

        view = self.view_service.create_view(
            table_id=self.table.id,
            name='默认视图',
            view_type='grid',
        )
        self.assertIsNotNone(view)

        self._clear_stack(window_id)
        updated = self.view_service.update_view(
            view_id=view.id,
            name='重命名视图',
        )
        self.assertIsNotNone(updated)
        updated.refresh_from_db()
        self.assertEqual(updated.name, '重命名视图')

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = scoped_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertTrue(undo_stack)
        self.assertEqual(undo_stack[0].get('name'), 'updateView')

        success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'updateView')

        updated.refresh_from_db()
        self.assertEqual(updated.name, '默认视图')

        success, error, operations = scoped_service.redo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'updateView')

        updated.refresh_from_db()
        self.assertEqual(updated.name, '重命名视图')

    def test_view_delete_undo_restores_created_by_uuid(self):
        """#4044：删除视图后 Ctrl+Z 应恢复视图，且 created_by 保留 UUID 字符串。"""
        if not self._has_view_column_meta:
            self.skipTest('当前测试库缺少 tabdata_view.column_meta，跳过视图结构操作测试')

        window_id = 'win-structure-view-delete'
        set_current_window_id(window_id)
        self._clear_stack(window_id)

        keep = self.view_service.create_view(
            table_id=self.table.id,
            name='保留视图',
            view_type='grid',
        )
        self.assertIsNotNone(keep)
        doomed = self.view_service.create_view(
            table_id=self.table.id,
            name='待删视图',
            view_type='grid',
        )
        self.assertIsNotNone(doomed)
        doomed_id = doomed.id
        self.assertEqual(str(doomed.created_by_id), str(self.user.id))

        self._clear_stack(window_id)
        deleted = self.view_service.delete_view(doomed_id)
        self.assertTrue(deleted)
        self.assertFalse(TableView.objects.filter(id=doomed_id).exists())

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = scoped_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertTrue(undo_stack)
        self.assertEqual(undo_stack[0].get('name'), 'deleteView')

        success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success, error)
        self.assertIsNone(error)
        self.assertTrue(operations)
        self.assertEqual(operations[0].get('name'), 'deleteView')

        restored = TableView.objects.get(id=doomed_id)
        self.assertEqual(restored.name, '待删视图')
        self.assertEqual(str(restored.created_by_id), str(self.user.id))

    def test_reorder_views_generates_single_structure_operation(self):
        if not self._has_view_column_meta:
            self.skipTest('当前测试库缺少 tabdata_view.column_meta，跳过视图结构操作测试')

        window_id = 'win-structure-reorder'
        set_current_window_id(window_id)
        self._clear_stack(window_id)

        view_a = self.view_service.create_view(
            table_id=self.table.id,
            name='A',
            view_type='grid',
        )
        view_b = self.view_service.create_view(
            table_id=self.table.id,
            name='B',
            view_type='grid',
        )
        self.assertIsNotNone(view_a)
        self.assertIsNotNone(view_b)
        self._clear_stack(window_id)

        success = self.view_service.reorder_views(
            table_id=self.table.id,
            view_orders=[
                {'view_id': str(view_a.id), 'order': 1},
                {'view_id': str(view_b.id), 'order': 0},
            ],
        )
        self.assertTrue(success)

        scoped_service = UndoRedoService(user=self.user, window_id=window_id)
        undo_stack = scoped_service.get_undo_stack(table_id=self.table.id, limit=5)
        self.assertEqual(len(undo_stack), 1)
        self.assertEqual(undo_stack[0].get('name'), 'updateView')
        self.assertEqual(undo_stack[0].get('action_display'), '重排视图')

        success, error, operations = scoped_service.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        self.assertTrue(operations)

        view_a.refresh_from_db()
        view_b.refresh_from_db()
        self.assertEqual(view_a.order, 0)
        self.assertEqual(view_b.order, 1)


class TestFieldDeletePreservesCellData(TestCase):
    """#3227：软删字段不再物理 DROP native 列 —— 删字段 → Ctrl+Z 撤销后，
    单元格数据必须原样回来（旧实现即时 DROP COLUMN 销毁数据，撤销只给回空列）。"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.user = User.objects.create_user(
            username='celldata-owner',
            email='celldata-owner@example.com',
            password='password123',
        )
        self.organization = Organization.objects.create(name='单元格保留测试空间', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')
        self.space = Space.objects.create(
            organization=self.organization, name='单元格保留测试项目', type="team",
        )
        _bind_project_role(self.organization, self.space, self.user, 'owner')
        self.table = Table.objects.create(
            space_id=self.space.id, organization_id=self.space.organization_id,
            name='单元格保留表', owner=self.user,
        )
        self.ddl = DDLManager(db_alias="default")
        self.ddl.ensure_schema(self.space.id)
        self.ddl.create_native_table(self.space.id, self.table.id)
        self.table_service = TableService(user=self.user)

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def _native_fqn(self):
        return DDLManager.qualified_table_name(self.space.id, self.table.id)

    def _column_exists(self, col_hex: str) -> bool:
        fqn = self._native_fqn()
        tbl = fqn.split('.')[-1].replace('"', '')
        with connections['default'].cursor() as c:
            c.execute(
                "SELECT 1 FROM information_schema.columns "
                "WHERE table_name=%s AND column_name=%s",
                [tbl, col_hex],
            )
            return c.fetchone() is not None

    def _read_cell(self, col_hex: str, row_id: str):
        fqn = self._native_fqn()
        with connections['default'].cursor() as c:
            c.execute(f'SELECT "{col_hex}" FROM {fqn} WHERE "__id"=%s', [row_id])
            row = c.fetchone()
            return row[0] if row else None

    def test_delete_then_undo_preserves_cell_value(self):
        window_id = 'win-celldata'
        set_current_window_id(window_id)

        field = self.table_service.create_field(
            table_id=self.table.id, name='数据保留', field_type='text',
        )
        col_hex = field.id.hex
        self.assertTrue(self._column_exists(col_hex))

        # 写一行真实数据到 native 列（系统列均有默认值）
        fqn = self._native_fqn()
        with connections['default'].cursor() as c:
            c.execute(
                f'INSERT INTO {fqn} ("{col_hex}") VALUES (%s) RETURNING "__id"::text',
                ['keep-me'],
            )
            row_id = c.fetchone()[0]
        self.assertEqual(self._read_cell(col_hex, row_id), 'keep-me')

        # 删除字段 —— 关键断言：native 列 + 数据不被物理销毁
        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            self.assertTrue(self.table_service.delete_field(field.id))
        field.refresh_from_db()
        self.assertTrue(field.is_deleted)
        self.assertTrue(
            self._column_exists(col_hex),
            'softdelete 不应物理 DROP native 列',
        )
        self.assertEqual(
            self._read_cell(col_hex, row_id), 'keep-me',
            'softdelete 后单元格数据必须保留',
        )

        # Ctrl+Z 撤销 —— 字段回来且数据原样
        scoped = UndoRedoService(user=self.user, window_id=window_id)
        success, error, ops = scoped.undo_table_operation(table_id=self.table.id)
        self.assertTrue(success)
        self.assertIsNone(error)
        field.refresh_from_db()
        self.assertFalse(field.is_deleted)
        self.assertTrue(self._column_exists(col_hex))
        self.assertEqual(
            self._read_cell(col_hex, row_id), 'keep-me',
            '撤销删除后单元格数据必须原样回来',
        )


class TestSchemaMetaResyncDetection(SimpleTestCase):
    """根因 #4：字段/视图结构 undo/redo 命中的操作应触发 collab 重同步检测。"""

    def test_detects_field_structure_operations(self):
        from apps.tabdata.api_undo_redo import _histories_touch_schema_meta

        for name in ('deleteFields', 'createFields', 'updateFields',
                     'createView', 'deleteView', 'updateView'):
            self.assertTrue(
                _histories_touch_schema_meta([{'name': name}]),
                f'{name} 应被判定为 schema 结构变化',
            )

    def test_ignores_non_schema_operations(self):
        from apps.tabdata.api_undo_redo import _histories_touch_schema_meta

        self.assertFalse(_histories_touch_schema_meta([]))
        self.assertFalse(_histories_touch_schema_meta(None))
        self.assertFalse(_histories_touch_schema_meta([{'name': 'pasteSelection'}]))
        self.assertFalse(_histories_touch_schema_meta([{'name': 'updateRecordsOrder'}]))
        # 记录级历史是 ORM 对象（非 dict），不触发 schema 重同步
        self.assertFalse(_histories_touch_schema_meta([object()]))


class TestFieldDeleteUndoTriggersCollabResync(TestCase):
    """根因 #4：删除字段后 Ctrl+Z 撤销成功，API 层必须通知 collab-live
    重同步，否则内存 Y.Doc 过期 meta 会把刚恢复的字段再删一次。"""

    databases = ['default', 'postgresql']

    def setUp(self):
        _ensure_free_tier()
        self.factory = RequestFactory()
        self.user = User.objects.create_user(
            username='resync-owner',
            email='resync-owner@example.com',
            password='password123',
        )
        self.organization = Organization.objects.create(name='重同步测试空间', owner=self.user)
        self.organization.members.create(user=self.user, role='owner')
        self.space = Space.objects.create(
            organization=self.organization,
            name='重同步测试项目',
            type="team",
        )
        _bind_project_role(self.organization, self.space, self.user, 'owner')
        self.table = Table.objects.create(
            space_id=self.space.id,
            organization_id=self.space.organization_id,
            name='重同步表',
            owner=self.user,
        )
        ddl = DDLManager(db_alias="default")
        ddl.ensure_schema(self.space.id)
        ddl.create_native_table(self.space.id, self.table.id)
        self.table_service = TableService(user=self.user)

    def tearDown(self):
        clear_request_context()
        super().tearDown()

    def _make_request(self, window_id: str):
        request = self.factory.post('/fake', **{'HTTP_X_WINDOW_ID': window_id})
        request.auth = self.user
        request.api_token = None
        return request

    def test_undo_field_delete_calls_resync(self):
        from apps.tabdata import api_undo_redo

        window_id = 'win-resync-delete'
        set_current_window_id(window_id)
        field = self.table_service.create_field(
            table_id=self.table.id,
            name='待恢复字段',
            field_type='text',
        )
        with patch('apps.tabdata.tasks.import_export_tasks.clear_lookup_caches_after_field_delete.delay'):
            self.assertTrue(self.table_service.delete_field(field.id))

        request = self._make_request(window_id)
        with patch.object(api_undo_redo, '_resync_collab_after_schema_change') as mock_resync:
            status, _body = api_undo_redo.undo_table_operation(request, self.table.id)

        self.assertEqual(status, 200)
        mock_resync.assert_called_once_with(self.table.id)
        field.refresh_from_db()
        self.assertFalse(field.is_deleted)
