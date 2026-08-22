"""
Phase 1 双写测试

验证原生列存储双写钩子的正确性：
- 创建表 → 验证 native table 存在 + 系统列正确
- 创建字段 → 验证 native column 存在 + 类型正确
- 创建记录 → 验证 JSON 和 native 列数据一致
- 更新记录 → 验证双方同步
- 删除记录 → 验证原生表行被删除
- 回填 → 验证历史数据迁移正确
- 读取 → 验证仍从 JSONField 返回（dual_write 阶段）

使用 Mock 方式测试钩子逻辑，避免依赖真实 PostgreSQL 连接。
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from unittest.mock import patch, MagicMock, call, ANY

from django.test import TestCase, override_settings

from apps.tabdata.native.feature_flags import NativeStoragePhase
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.record_io import NativeRecordIO
from apps.tabdata.native.value_converter import (
    python_to_pg,
    convert_record_for_insert,
)
from apps.tabdata.native.backfill_service import BackfillService


# ══════════════════════════════════════
# Feature Flag 与钩子触发测试
# ══════════════════════════════════════

class TestNativeWriteEnabled(TestCase):
    """测试 NativeStoragePhase 在各阶段的行为"""

    @override_settings(NATIVE_STORAGE_PHASE='disabled')
    def test_disabled_phase_no_native_write(self):
        """disabled 阶段不启用原生写入"""
        self.assertFalse(NativeStoragePhase.is_native_write_enabled())
        self.assertFalse(NativeStoragePhase.should_write_native(uuid.uuid4()))

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    def test_dual_write_enables_native_write(self):
        """dual_write 阶段启用原生写入"""
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    def test_dual_write_still_reads_json(self):
        """dual_write 阶段仍从 JSON 读取"""
        self.assertTrue(NativeStoragePhase.is_json_read_enabled())
        self.assertFalse(NativeStoragePhase.is_native_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='switch_read')
    def test_switch_read_reads_native(self):
        """switch_read 阶段从原生列读取"""
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='native_only')
    def test_native_only_no_json_write(self):
        """native_only 阶段不写 JSON"""
        self.assertFalse(NativeStoragePhase.is_json_write_enabled())
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())


# ══════════════════════════════════════
# Table DDL 钩子测试
# ══════════════════════════════════════

class TestTableDDLHooks(TestCase):
    """测试 table_service.py 中的 DDL 钩子"""

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    @patch('apps.tabdata.services.table_service.DDLManager')
    def test_native_ensure_table_calls_ddl(self, MockDDLManager):
        """_native_ensure_table 调用 DDLManager 的正确方法"""
        from apps.tabdata.services.table_service import TableService

        mock_ddl = MagicMock()
        MockDDLManager.return_value = mock_ddl

        project_id = uuid.uuid4()
        table_id = uuid.uuid4()

        # 模拟字段对象
        field1 = MagicMock()
        field1.id = uuid.uuid4()
        field1.field_type = 'text'
        field1.config = {}

        field2 = MagicMock()
        field2.id = uuid.uuid4()
        field2.field_type = 'number'
        field2.config = {}

        field3 = MagicMock()
        field3.id = uuid.uuid4()
        field3.field_type = 'created_time'  # 系统字段，不应创建列
        field3.config = {}

        service = TableService.__new__(TableService)

        with patch('apps.tabdata.services.table_service.NativeStoragePhase'):
            with patch('apps.tabdata.models.NativeTableStatus') as MockStatus:
                MockStatus.objects = MagicMock()
                service._native_ensure_table(project_id, table_id, [field1, field2, field3])

        # 验证 DDL 调用
        mock_ddl.ensure_schema.assert_called_once_with(project_id)
        mock_ddl.create_native_table.assert_called_once_with(project_id, table_id)

        # 只有非系统字段才添加列
        add_column_calls = mock_ddl.add_column.call_args_list
        self.assertEqual(len(add_column_calls), 2)  # field1(text) + field2(number)

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    @patch('apps.tabdata.services.table_service.DDLManager')
    def test_native_drop_table_calls_ddl(self, MockDDLManager):
        """_native_drop_table 调用 drop_native_table"""
        from apps.tabdata.services.table_service import TableService

        mock_ddl = MagicMock()
        MockDDLManager.return_value = mock_ddl

        project_id = uuid.uuid4()
        table_id = uuid.uuid4()

        service = TableService.__new__(TableService)

        with patch('apps.tabdata.models.NativeTableStatus') as MockStatus:
            MockStatus.objects = MagicMock()
            service._native_drop_table(project_id, table_id)

        mock_ddl.drop_native_table.assert_called_once_with(project_id, table_id)


# ══════════════════════════════════════
# Field DDL 钩子测试
# ══════════════════════════════════════

class TestFieldDDLHooks(TestCase):
    """测试字段创建/修改时的 DDL 钩子"""

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    @patch('apps.tabdata.services.table_service.DDLManager')
    def test_native_add_column(self, MockDDLManager):
        """_native_add_column 调用 DDLManager.add_column"""
        from apps.tabdata.services.table_service import TableService

        mock_ddl = MagicMock()
        MockDDLManager.return_value = mock_ddl

        table_id = uuid.uuid4()
        project_id = uuid.uuid4()

        field = MagicMock()
        field.id = uuid.uuid4()
        field.field_type = 'text'
        field.config = {}

        service = TableService.__new__(TableService)

        mock_table = MagicMock()
        mock_table.project_id = project_id

        with patch('apps.tabdata.models.Table') as MockTable:
            MockTable.objects.select_related.return_value.get.return_value = mock_table
            service._native_add_column(table_id, field)

        mock_ddl.add_column.assert_called_once_with(
            project_id, table_id, field.id, 'text', {},
        )

    @override_settings(NATIVE_STORAGE_PHASE='dual_write')
    @patch('apps.tabdata.services.table_service.DDLManager')
    def test_native_alter_column_type(self, MockDDLManager):
        """_native_alter_column_type 调用 DDLManager.alter_column_type"""
        from apps.tabdata.services.table_service import TableService

        mock_ddl = MagicMock()
        MockDDLManager.return_value = mock_ddl

        table_id = uuid.uuid4()
        project_id = uuid.uuid4()
        field_id = uuid.uuid4()

        service = TableService.__new__(TableService)

        mock_table = MagicMock()
        mock_table.project_id = project_id

        with patch('apps.tabdata.models.Table') as MockTable:
            MockTable.objects.select_related.return_value.get.return_value = mock_table
            service._native_alter_column_type(
                table_id, field_id, 'text', 'number', config=None,
            )

        mock_ddl.alter_column_type.assert_called_once_with(
            project_id, table_id, field_id, 'number', 'text', None,
        )


# ══════════════════════════════════════
# Record 双写钩子测试
# ══════════════════════════════════════

class TestRecordDualWrite(TestCase):
    """测试 record_service.py 中的双写钩子"""

    def _make_mock_record(self, record_id=None, table_id=None):
        """创建模拟记录对象"""
        record = MagicMock()
        record.id = record_id or uuid.uuid4()
        record.table_id = table_id or uuid.uuid4()
        record.data = {
            str(uuid.uuid4()): 'test value',
            str(uuid.uuid4()): 42,
        }
        record.order = 1024.0
        record.version = 1
        record.created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.updated_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.created_by_id = uuid.uuid4()
        record.updated_by_id = uuid.uuid4()
        return record

    def _make_mock_fields(self, field_ids=None):
        """创建模拟字段列表"""
        if field_ids is None:
            field_ids = [uuid.uuid4(), uuid.uuid4()]

        fields = []
        for fid in field_ids:
            f = MagicMock()
            f.id = fid
            f.field_type = 'text'
            f.config = {}
            fields.append(f)
        return fields

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    @patch('apps.tabdata.services.record_service.NativeStoragePhase')
    def test_native_get_io_disabled(self, MockPhase, MockIO):
        """disabled 阶段返回 None"""
        from apps.tabdata.services.record_service import RecordService

        MockPhase.should_write_native.return_value = False

        mock_table = MagicMock()
        mock_table.id = uuid.uuid4()

        result = RecordService._native_get_io(mock_table)
        self.assertIsNone(result)
        MockIO.assert_not_called()

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    @patch('apps.tabdata.services.record_service.NativeStoragePhase')
    def test_native_get_io_enabled(self, MockPhase, MockIO):
        """双写启用时返回 NativeRecordIO 实例"""
        from apps.tabdata.services.record_service import RecordService

        MockPhase.should_write_native.return_value = True
        mock_io = MagicMock()
        MockIO.return_value = mock_io

        mock_table = MagicMock()
        mock_table.id = uuid.uuid4()
        mock_table.project_id = uuid.uuid4()

        result = RecordService._native_get_io(mock_table)
        self.assertEqual(result, mock_io)

    def test_native_write_record_calls_insert(self):
        """_native_write_record 调用 insert_record"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        record = self._make_mock_record()
        fields = self._make_mock_fields()

        RecordService._native_write_record(native_io, record, fields)
        native_io.insert_record.assert_called_once()

        # 验证调用参数
        call_kwargs = native_io.insert_record.call_args
        self.assertEqual(call_kwargs[1]['record_id'], record.id)

    def test_native_update_record_calls_update(self):
        """_native_update_record 调用 update_record"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        record = self._make_mock_record()
        fields = self._make_mock_fields()
        updated_data = {'field1': 'new_value'}

        RecordService._native_update_record(native_io, record, updated_data, fields)
        native_io.update_record.assert_called_once()

    def test_native_delete_record_calls_delete(self):
        """_native_delete_record 调用 delete_record"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        record = self._make_mock_record()

        RecordService._native_delete_record(native_io, record)
        native_io.delete_record.assert_called_once_with(
            record_id=record.id,
            version=int(record.version),
            updated_by=record.updated_by_id,
        )

    def test_native_write_record_handles_exception(self):
        """_native_write_record 异常时不抛出（仅 warn）"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        native_io.insert_record.side_effect = Exception("DB error")
        record = self._make_mock_record()
        fields = self._make_mock_fields()

        # 不应抛出异常
        RecordService._native_write_record(native_io, record, fields)


# ══════════════════════════════════════
# 回填服务测试
# ══════════════════════════════════════

class TestBackfillService(TestCase):
    """测试 BackfillService"""

    def test_build_native_row(self):
        """_build_native_row 构建正确的原生行"""
        field_id = uuid.uuid4()
        record = MagicMock()
        record.id = uuid.uuid4()
        record.order = 1024.0
        record.version = 5
        record.created_at = datetime(2024, 6, 1, tzinfo=timezone.utc)
        record.updated_at = datetime(2024, 6, 2, tzinfo=timezone.utc)
        record.created_by_id = uuid.uuid4()
        record.updated_by_id = uuid.uuid4()
        record.data = {str(field_id): 'hello world'}

        field = MagicMock()
        field.id = field_id
        field.field_type = 'text'
        field.config = {}

        row = BackfillService._build_native_row(record, [field])

        self.assertEqual(row['__id'], record.id)
        self.assertEqual(row['__order'], 1024.0)
        self.assertEqual(row['__version'], 5)
        self.assertEqual(row['__created_at'], record.created_at)
        self.assertEqual(row[field_id.hex], 'hello world')

    def test_build_native_row_handles_missing_data(self):
        """_build_native_row 处理缺失字段数据"""
        field_id = uuid.uuid4()
        record = MagicMock()
        record.id = uuid.uuid4()
        record.order = 0
        record.version = 1
        record.created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.updated_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.created_by_id = None
        record.updated_by_id = None
        record.data = {}  # 空数据

        field = MagicMock()
        field.id = field_id
        field.field_type = 'text'
        field.config = {}

        row = BackfillService._build_native_row(record, [field])

        # 缺失的字段不应在 row 中
        self.assertNotIn(field_id.hex, row)
        # 系统列应存在
        self.assertIn('__id', row)
        self.assertIn('__order', row)

    def test_build_native_row_number_conversion(self):
        """_build_native_row 正确转换数字类型"""
        field_id = uuid.uuid4()
        record = MagicMock()
        record.id = uuid.uuid4()
        record.order = 0
        record.version = 1
        record.created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.updated_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.created_by_id = None
        record.updated_by_id = None
        record.data = {str(field_id): 42.5}

        field = MagicMock()
        field.id = field_id
        field.field_type = 'number'
        field.config = {}

        row = BackfillService._build_native_row(record, [field])

        self.assertAlmostEqual(row[field_id.hex], 42.5)

    def test_build_native_row_checkbox_conversion(self):
        """_build_native_row 正确转换布尔类型"""
        field_id = uuid.uuid4()
        record = MagicMock()
        record.id = uuid.uuid4()
        record.order = 0
        record.version = 1
        record.created_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.updated_at = datetime(2024, 1, 1, tzinfo=timezone.utc)
        record.created_by_id = None
        record.updated_by_id = None
        record.data = {str(field_id): True}

        field = MagicMock()
        field.id = field_id
        field.field_type = 'checkbox'
        field.config = {}

        row = BackfillService._build_native_row(record, [field])

        self.assertTrue(row[field_id.hex])


# ══════════════════════════════════════
# 值转换在双写场景的一致性测试
# ══════════════════════════════════════

class TestValueConverterDualWriteConsistency(TestCase):
    """验证值转换器在双写场景下的一致性"""

    def test_text_roundtrip(self):
        """文本值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        original = 'Hello World'
        pg_val = python_to_pg(original, 'text')
        api_val = pg_to_python(pg_val, 'text')
        self.assertEqual(api_val, original)

    def test_number_roundtrip(self):
        """数字值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        original = 42.5
        pg_val = python_to_pg(original, 'number')
        api_val = pg_to_python(pg_val, 'number')
        self.assertAlmostEqual(api_val, original)

    def test_checkbox_roundtrip(self):
        """布尔值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        for original in (True, False):
            pg_val = python_to_pg(original, 'checkbox')
            api_val = pg_to_python(pg_val, 'checkbox')
            self.assertEqual(api_val, original)

    def test_date_roundtrip(self):
        """日期值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        original = '2024-06-15'
        pg_val = python_to_pg(original, 'date')
        api_val = pg_to_python(pg_val, 'date')
        self.assertEqual(api_val, '2024-06-15')

    def test_none_roundtrip(self):
        """None 值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        for field_type in ('text', 'number', 'checkbox', 'date', 'multi_select'):
            pg_val = python_to_pg(None, field_type)
            self.assertIsNone(pg_val)
            api_val = pg_to_python(None, field_type)
            self.assertIsNone(api_val)

    def test_select_roundtrip(self):
        """选择值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        original = '进行中'
        pg_val = python_to_pg(original, 'select')
        api_val = pg_to_python(pg_val, 'select')
        self.assertEqual(api_val, original)

    def test_rating_roundtrip(self):
        """评分值双写一致性"""
        from apps.tabdata.native.value_converter import pg_to_python

        original = 4
        pg_val = python_to_pg(original, 'rating')
        api_val = pg_to_python(pg_val, 'rating')
        self.assertEqual(api_val, original)

    def test_convert_record_for_insert(self):
        """批量转换 record 数据"""
        field_id = uuid.uuid4()
        field = MagicMock()
        field.id = field_id
        field.field_type = 'text'
        field.config = {}

        field_values = {str(field_id): 'test_value'}
        result = convert_record_for_insert(field_values, [field])

        self.assertIn(field_id.hex, result)
        self.assertEqual(result[field_id.hex], 'test_value')


# ══════════════════════════════════════
# 管理命令测试
# ══════════════════════════════════════

class TestNativeBackfillCommand(TestCase):
    """测试 native_backfill 管理命令"""

    def test_command_import(self):
        """management command 可导入"""
        from apps.tabdata.management.commands.native_backfill import Command
        cmd = Command()
        self.assertIsNotNone(cmd)
        self.assertIn('回填', cmd.help)
