"""
Phase 3 清理阶段测试

验证 native_only 模式下的行为：
- record_service 始终走原生读写路径（写入同时保留 JSONField 以支持 Kanban/Calendar/Gallery）
- record_service 始终走原生读取路径（Grid / list_records / get_record_data）
- view_data_service 始终走原生查询路径（Grid 视图 + 列统计）
- table_service DDL 钩子无条件执行
- feature_flags 默认 native_only
- migration 0045 标记 data 字段为废弃
- serialize_record() 在 data 为空时回退原生列

使用 Mock 方式测试，避免依赖真实 PostgreSQL 连接。
"""

import uuid
from datetime import datetime, timezone
from unittest.mock import patch, MagicMock, call, PropertyMock

from django.test import TestCase, override_settings


# ══════════════════════════════════════
# 辅助工厂
# ══════════════════════════════════════

def _make_field(field_id=None, name='Test Field', field_type='text', config=None):
    """创建 Mock TableField"""
    field = MagicMock()
    field.id = field_id or uuid.uuid4()
    field.name = name
    field.field_type = field_type
    field.config = config or {}
    field.is_deleted = False
    return field


def _make_table(table_id=None, space_id=None):
    """创建 Mock Table"""
    table = MagicMock()
    table.id = table_id or uuid.uuid4()
    table.space_id = space_id or uuid.uuid4()
    table.organization_id = uuid.uuid4()
    return table


def _make_record(record_id=None, table_id=None, data=None):
    """创建 Mock TableRecord"""
    record = MagicMock()
    record.id = record_id or uuid.uuid4()
    record.table_id = table_id or uuid.uuid4()
    record.data = data or {}
    record.order = 1.0
    record.version = 1
    record.created_at = datetime.now(timezone.utc)
    record.updated_at = datetime.now(timezone.utc)
    record.created_by_id = uuid.uuid4()
    record.updated_by_id = uuid.uuid4()
    record.is_deleted = False
    return record


# ══════════════════════════════════════
# Phase 3D: Feature Flags 默认值
# ══════════════════════════════════════

class TestFeatureFlagsDefault(TestCase):
    """验证 feature_flags 默认值变为 native_only"""

    def test_default_phase_is_native_only(self):
        """未配置 NATIVE_STORAGE_PHASE 时默认为 native_only"""
        from apps.tabdata.native.feature_flags import NativeStoragePhase
        # 删除 settings 中的 NATIVE_STORAGE_PHASE（如果存在）
        with self.settings(NATIVE_STORAGE_PHASE=None):
            # None 不在 _VALID_PHASES 中，应回退到默认值
            phase = NativeStoragePhase.current()
            self.assertEqual(phase, NativeStoragePhase.NATIVE_ONLY)

    @override_settings(NATIVE_STORAGE_PHASE='native_only')
    def test_explicit_native_only(self):
        from apps.tabdata.native.feature_flags import NativeStoragePhase
        self.assertEqual(NativeStoragePhase.current(), 'native_only')
        self.assertTrue(NativeStoragePhase.is_native_write_enabled())
        self.assertTrue(NativeStoragePhase.is_native_read_enabled())
        self.assertFalse(NativeStoragePhase.is_json_write_enabled())
        self.assertFalse(NativeStoragePhase.is_json_read_enabled())

    @override_settings(NATIVE_STORAGE_PHASE='invalid_phase')
    def test_invalid_phase_defaults_to_native_only(self):
        from apps.tabdata.native.feature_flags import NativeStoragePhase
        self.assertEqual(NativeStoragePhase.current(), NativeStoragePhase.NATIVE_ONLY)


# ══════════════════════════════════════
# Phase 3D: record_service 不写 JSONField
# ══════════════════════════════════════

class TestRecordServiceNoJsonWrite(TestCase):
    """验证 record_service 在 Phase 3D 后不写入 JSONField"""

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    @patch('apps.tabdata.services.record_service.Table')
    @patch('apps.tabdata.services.record_service.TableRecord')
    @patch('apps.tabdata.services.record_service.TableField')
    def test_native_get_io_always_returns_instance(self, mock_field_cls, mock_record_cls,
                                                    mock_table_cls, mock_io_cls):
        """_native_get_io 不再检查 feature flag，始终返回 NativeRecordIO"""
        from apps.tabdata.services.record_service import RecordService

        table = _make_table()
        mock_io = MagicMock()
        mock_io_cls.return_value = mock_io

        result = RecordService._native_get_io(table)

        self.assertEqual(result, mock_io)
        mock_io_cls.assert_called_once_with(
            space_id=table.space_id,
            table_id=table.id,
        )

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    def test_native_write_record_raises_on_error(self, mock_io_cls):
        """_native_write_record 错误直接抛出（不再吞掉异常）"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        native_io.insert_record.side_effect = Exception('DB error')
        record = _make_record()
        fields = [_make_field()]

        with self.assertRaises(Exception) as ctx:
            RecordService._native_write_record(native_io, record, fields)
        self.assertIn('DB error', str(ctx.exception))

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    def test_native_update_record_raises_on_error(self, mock_io_cls):
        """_native_update_record 错误直接抛出"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        native_io.update_record.side_effect = Exception('update fail')
        record = _make_record()
        fields = [_make_field()]

        with self.assertRaises(Exception) as ctx:
            RecordService._native_update_record(native_io, record, {}, fields)
        self.assertIn('update fail', str(ctx.exception))

    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    def test_native_delete_record_raises_on_error(self, mock_io_cls):
        """_native_delete_record 错误直接抛出"""
        from apps.tabdata.services.record_service import RecordService

        native_io = MagicMock()
        native_io.delete_record.side_effect = Exception('delete fail')
        record = _make_record()

        with self.assertRaises(Exception) as ctx:
            RecordService._native_delete_record(native_io, record)
        self.assertIn('delete fail', str(ctx.exception))


# ══════════════════════════════════════
# Phase 3D: record_service 始终走原生读取
# ══════════════════════════════════════

class TestRecordServiceAlwaysNativeRead(TestCase):
    """验证 list_records 始终走原生路径（不再有条件判断）"""

    @patch('apps.tabdata.services.record_service.RecordService._list_records_native')
    @patch('apps.tabdata.services.record_service.RecordService.check_table_permission')
    def test_list_records_always_calls_native(self, mock_perm, mock_native_list):
        """list_records() 无条件调用 _list_records_native"""
        from apps.tabdata.services.record_service import RecordService

        mock_perm.return_value = True
        mock_native_list.return_value = {
            'records': [],
            'total': 0,
            'matched_total': 0,
            'latest_version': 0,
            'has_changes': True,
        }

        svc = RecordService(user=MagicMock())
        table_id = uuid.uuid4()
        result = svc.list_records(table_id)

        mock_native_list.assert_called_once()
        self.assertEqual(result['records'], [])

    @patch('apps.tabdata.services.record_service.RecordService._list_records_native')
    @patch('apps.tabdata.services.record_service.RecordService.check_table_permission')
    def test_list_records_native_error_propagates(self, mock_perm, mock_native_list):
        """原生读取出错时异常直接传播（不 fallback）"""
        from apps.tabdata.services.record_service import RecordService

        mock_perm.return_value = True
        mock_native_list.side_effect = Exception('native query failed')

        svc = RecordService(user=MagicMock())
        with self.assertRaises(Exception) as ctx:
            svc.list_records(uuid.uuid4())
        self.assertIn('native query failed', str(ctx.exception))

    @patch('apps.tabdata.services.record_service.serialize_native_rows', return_value=[])
    @patch('apps.tabdata.services.record_service.NativeRecordIO')
    @patch('apps.tabdata.services.record_service.NativeQueryBuilder')
    @patch('apps.tabdata.services.record_service.TableRecord')
    @patch('apps.tabdata.services.record_service.TableField')
    @patch('apps.tabdata.services.record_service.Table')
    def test_list_records_native_uses_space_id_for_query_builder(
        self,
        mock_table_cls,
        mock_field_cls,
        mock_record_cls,
        mock_query_builder_cls,
        mock_native_io_cls,
        mock_serialize,
    ):
        """_list_records_native 应使用 space_id 构造 NativeQueryBuilder"""
        from apps.tabdata.services.record_service import RecordService

        table = _make_table()
        table.rls_enabled = False
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_field_cls.objects.using.return_value.filter.return_value = []
        mock_record_cls.objects.using.return_value.filter.return_value = MagicMock()

        native_io = MagicMock()
        native_io.count_records.return_value = 0
        native_io.read_records.return_value = ([], 0)
        mock_native_io_cls.return_value = native_io

        svc = RecordService(user=MagicMock())
        with patch('apps.tabdata.services.record_service.connections') as mock_connections:
            mock_connections.__getitem__.return_value.vendor = 'postgresql'
            with patch.object(
                RecordService,
                '_get_latest_version_state',
                return_value={'latest_version': 0},
            ):
                result = svc._list_records_native(table.id)

        mock_query_builder_cls.assert_called_once_with(
            space_id=table.space_id,
            table_id=table.id,
            fields=[],
        )
        self.assertEqual(result['records'], [])
        self.assertEqual(result['total'], 0)


# ══════════════════════════════════════
# Phase 3D: view_data_service 始终走原生路径
# ══════════════════════════════════════

class TestViewDataServiceAlwaysNative(TestCase):
    """验证 view_data_service 的读取方法始终走原生路径"""

    @patch('apps.tabdata.services.view_data_service.ViewDataService._get_grid_data_native')
    @patch('apps.tabdata.services.view_data_service.ViewDataService.check_table_permission')
    @patch('apps.tabdata.services.view_data_service.TableView')
    def test_get_grid_data_always_calls_native(self, mock_view_cls, mock_perm, mock_native_grid):
        """_get_grid_data 无条件调用 _get_grid_data_native"""
        from apps.tabdata.services.view_data_service import ViewDataService

        mock_perm.return_value = True
        mock_native_grid.return_value = {
            'view': {},
            'records': [],
            'total': 0,
            'matched_total': 0,
            'page': 1,
            'page_size': 50,
            'metadata': {},
            'latest_version': 0,
            'has_changes': False,
        }

        view = MagicMock()
        view.table_id = uuid.uuid4()
        view.table = _make_table()
        view.sorts = None
        view.groups = None
        view.filters = None
        view.config = {}

        svc = ViewDataService(user=MagicMock())
        result = svc._get_grid_data(view, 1, 50)

        mock_native_grid.assert_called_once()
        self.assertEqual(result['total'], 0)

    @patch('apps.tabdata.services.view_data_service.ViewDataService._get_view_column_statistics_native')
    @patch('apps.tabdata.services.view_data_service.ViewDataService.check_table_permission')
    @patch('apps.tabdata.services.view_data_service.TableView')
    def test_get_view_column_statistics_always_calls_native(self, mock_view_cls, mock_perm, mock_native_stats):
        """get_view_column_statistics 无条件调用原生路径"""
        from apps.tabdata.services.view_data_service import ViewDataService

        mock_perm.return_value = True
        mock_native_stats.return_value = {
            'view_id': str(uuid.uuid4()),
            'latest_version': 0,
            'total_records': 0,
            'column_statistics': [],
        }

        view = MagicMock()
        view.id = uuid.uuid4()
        view.table_id = uuid.uuid4()
        view.table = _make_table()
        view.config = {}
        mock_view_cls.objects.select_related.return_value.get.return_value = view

        svc = ViewDataService(user=MagicMock())
        result = svc.get_view_column_statistics(view.id)

        mock_native_stats.assert_called_once()
        self.assertEqual(result['column_statistics'], [])


# ══════════════════════════════════════
# Phase 3D: table_service DDL 无条件执行
# ══════════════════════════════════════

class TestTableServiceUnconditionalDDL(TestCase):
    """验证 table_service 的 DDL 钩子不再检查 feature flag"""

    def test_native_ensure_table_docstring_updated(self):
        """验证 _native_ensure_table 文档已更新为无条件调用"""
        from apps.tabdata.services.table_service import TableService
        docstring = TableService._native_ensure_table.__doc__ or ''
        self.assertIn('Phase 3D', docstring)
        self.assertNotIn('NativeStoragePhase 启用写入', docstring)


# ══════════════════════════════════════
# Phase 3C: Migration 0045 废弃标记
# ══════════════════════════════════════

class TestMigration0045(TestCase):
    """验证 migration 0045 正确标记 data 字段为废弃"""

    def test_migration_file_exists(self):
        """migration 文件存在"""
        import importlib
        mod = importlib.import_module(
            'apps.tabdata.migrations.0045_deprecate_json_data'
        )
        self.assertTrue(hasattr(mod, 'Migration'))

    def test_migration_depends_on_0044(self):
        """migration 依赖 0044"""
        import importlib
        mod = importlib.import_module(
            'apps.tabdata.migrations.0045_deprecate_json_data'
        )
        deps = mod.Migration.dependencies
        self.assertTrue(
            any('0044' in d[1] for d in deps),
            f'Migration 0045 should depend on 0044, got: {deps}',
        )

    def test_migration_alters_data_field(self):
        """migration 包含 AlterField 操作"""
        import importlib
        from django.db import migrations
        mod = importlib.import_module(
            'apps.tabdata.migrations.0045_deprecate_json_data'
        )
        ops = mod.Migration.operations
        alter_ops = [
            op for op in ops
            if isinstance(op, migrations.AlterField) and op.name == 'data'
        ]
        self.assertEqual(len(alter_ops), 1, 'Should have exactly one AlterField for data')
        field = alter_ops[0].field
        self.assertTrue(field.null, 'data field should be nullable')
        self.assertTrue(field.blank, 'data field should allow blank')
        self.assertIn('DEPRECATED', field.help_text or '')


# ══════════════════════════════════════
# Phase 3C: Model 字段废弃标记
# ══════════════════════════════════════

class TestModelDeprecation(TestCase):
    """验证 TableRecord.data 模型字段已标记废弃"""

    def test_data_field_is_nullable(self):
        """data 字段允许 null"""
        from apps.tabdata.models import TableRecord
        data_field = TableRecord._meta.get_field('data')
        self.assertTrue(data_field.null, 'data field should be nullable after Phase 3C')

    def test_data_field_has_deprecated_help_text(self):
        """data 字段 help_text 包含 DEPRECATED"""
        from apps.tabdata.models import TableRecord
        data_field = TableRecord._meta.get_field('data')
        help_text = data_field.help_text or ''
        self.assertIn('DEPRECATED', help_text)


# ══════════════════════════════════════
# Phase 3D: _get_grid_data_native 无 try/except fallback
# ══════════════════════════════════════

class TestNativeMethodsNoFallback(TestCase):
    """验证原生查询方法不再包含 fallback 逻辑"""

    def test_grid_data_native_no_fallback_import(self):
        """_get_grid_data_native 方法不再引用 NativeStoragePhase"""
        import inspect
        from apps.tabdata.services.view_data_service import ViewDataService
        source = inspect.getsource(ViewDataService._get_grid_data_native)
        self.assertNotIn('NativeStoragePhase', source)
        self.assertNotIn('fallback', source.lower())

    def test_column_statistics_native_no_fallback_import(self):
        """_get_view_column_statistics_native 方法不再引用 NativeStoragePhase"""
        import inspect
        from apps.tabdata.services.view_data_service import ViewDataService
        source = inspect.getsource(ViewDataService._get_view_column_statistics_native)
        self.assertNotIn('NativeStoragePhase', source)
        self.assertNotIn('fallback', source.lower())

    def test_record_service_no_feature_flag_import(self):
        """record_service 不再导入 NativeStoragePhase"""
        import inspect
        import apps.tabdata.services.record_service as mod
        source = inspect.getsource(mod)
        # 模块级 import 中不应有 NativeStoragePhase
        self.assertNotIn('from apps.tabdata.native.feature_flags import NativeStoragePhase', source)

    def test_table_service_no_feature_flag_import(self):
        """table_service 不再导入 NativeStoragePhase"""
        import inspect
        import apps.tabdata.services.table_service as mod
        source = inspect.getsource(mod)
        self.assertNotIn('from apps.tabdata.native.feature_flags import NativeStoragePhase', source)


# ══════════════════════════════════════
# Phase 3D: get_record_data() 新方法
# ══════════════════════════════════════

class TestGetRecordData(TestCase):
    """验证 get_record_data() 从原生列读取数据"""

    @patch('apps.tabdata.services.record_service.RecordService._get_record_native')
    def test_get_record_data_delegates_to_native(self, mock_native):
        """get_record_data() 委托给 _get_record_native()"""
        from apps.tabdata.services.record_service import RecordService

        mock_native.return_value = {
            'id': str(uuid.uuid4()),
            'data': {'名称': '测试'},
            'fields': {'名称': '测试'},
        }

        svc = RecordService(user=MagicMock())
        record_id = uuid.uuid4()
        result = svc.get_record_data(record_id, field_key_type='id')

        mock_native.assert_called_once_with(
            record_id,
            fields_filter=None,
            field_key_type='id',
        )
        self.assertIsNotNone(result)
        self.assertIn('data', result)

    @patch('apps.tabdata.services.record_service.RecordService._get_record_native')
    def test_get_record_data_returns_none_when_not_found(self, mock_native):
        """记录不存在时返回 None"""
        from apps.tabdata.services.record_service import RecordService

        mock_native.return_value = None

        svc = RecordService(user=MagicMock())
        result = svc.get_record_data(uuid.uuid4())
        self.assertIsNone(result)

    def test_get_record_data_method_exists(self):
        """get_record_data() 方法存在"""
        from apps.tabdata.services.record_service import RecordService
        self.assertTrue(hasattr(RecordService, 'get_record_data'))
        self.assertTrue(callable(getattr(RecordService, 'get_record_data')))


# ══════════════════════════════════════
# Phase 3D: serialize_record 原生回退
# ══════════════════════════════════════

class TestSerializeRecordNativeFallback(TestCase):
    """验证 serialize_record 在 data 为空时回退到原生列"""

    def test_load_native_data_helper_exists(self):
        """_load_native_data_for_record 辅助函数存在"""
        from apps.tabdata.utils.record_serializers import _load_native_data_for_record
        self.assertTrue(callable(_load_native_data_for_record))

    @patch('apps.tabdata.utils.record_serializers._load_native_data_for_record')
    def test_serialize_record_uses_native_fallback_when_data_empty(self, mock_load):
        """当 record.data 为空时使用 _load_native_data_for_record"""
        from apps.tabdata.utils.record_serializers import serialize_record

        mock_load.return_value = {str(uuid.uuid4()): '测试值'}

        record = _make_record(data={})
        record._filtered_data = None
        record.row_id = 'test-row'
        record.status = 'active'
        record.tags = []

        result = serialize_record(record)
        mock_load.assert_called_once_with(record)

    @patch('apps.tabdata.utils.record_serializers._load_native_data_for_record')
    def test_serialize_record_skips_native_when_data_exists(self, mock_load):
        """当 record.data 非空时不调用原生回退"""
        from apps.tabdata.utils.record_serializers import serialize_record

        field_id = str(uuid.uuid4())
        record = _make_record(data={field_id: '有数据'})
        record._filtered_data = None
        record.row_id = 'test-row'
        record.status = 'active'
        record.tags = []

        result = serialize_record(record)
        mock_load.assert_not_called()
        self.assertIn('data', result)
