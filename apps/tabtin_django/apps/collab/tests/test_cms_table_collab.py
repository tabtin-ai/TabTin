"""
CMS-010 / CMS-012 回归测试

CMS-010: restore_from_snapshot 对已删除字段值的静默跳过行为
  - 快照中含已删除字段的 field_id_hex 值 → restore 后被跳过
  - 快照中活跃字段值 → 正常恢复
  - 确认此行为是明确的设计决策（非数据丢失）

CMS-012: 字段 CRUD 后 _increment_schema_version 触发机制
  - 字段创建 → schema_version +1
  - 字段更新（改名/改配置） → schema_version +1
  - 字段删除 → schema_version +1
  - 无字段变更 → schema_version 不变
"""
import os
import uuid
from unittest.mock import MagicMock, call, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.db.models import F  # noqa: E402


def _make_mock_field(name, field_type="text", is_deleted=False, config=None):
    """创建 mock TableField 对象。"""
    field = MagicMock()
    field.id = uuid.uuid4()
    field.name = name
    field.field_type = field_type
    field.is_deleted = is_deleted
    field.config = config or {}
    field.order = 0
    return field


def _make_mock_table(table_id=None, space_id=None):
    """创建 mock Table 对象。"""
    table = MagicMock()
    table.id = table_id or uuid.uuid4()
    table.space_id = space_id or uuid.uuid4()
    table.is_archived = False
    table.record_version_seq = 0
    return table


# ═══════════════════════════════════════════════════════════
# CMS-010: restore_from_snapshot schema 一致性
# ═══════════════════════════════════════════════════════════


class TestRestoreSnapshotSchemaConsistency:
    """
    CMS-010: restore_from_snapshot 使用当前活跃字段的 field_map_hex
    过滤快照数据。快照中已被删除字段的值会被静默跳过。

    此行为是明确的设计决策：
    - 恢复的目标是"将记录数据还原到快照时的状态"
    - 但字段结构以当前数据库为准（已删字段不可恢复）
    - 静默跳过而非报错，因为字段删除是正常操作
    """

    def _setup_mocks(self, table, active_fields, existing_record_ids=None):
        """
        统一配置 restore_from_snapshot 所需的 mock。

        返回 (patches_dict, mock_create_calls) 方便断言。
        """
        existing_record_ids = existing_record_ids or set()

        # 收集 create / update 调用中的 data 参数
        create_data_capture = []
        update_data_capture = []

        def capture_create(**kwargs):
            create_data_capture.append(kwargs.get("data", {}))
            return MagicMock(id=kwargs.get("id", uuid.uuid4()))

        def capture_update(**kwargs):
            update_data_capture.append(kwargs)
            return 1

        field_map_hex = {f.id.hex: f for f in active_fields}

        patches = {
            "table_filter": patch(
                "apps.tabdata.services.collab_service.Table.objects"
            ),
            "field_filter": patch(
                "apps.tabdata.services.collab_service.TableField.objects"
            ),
            "record_objs": patch(
                "apps.tabdata.services.collab_service.TableRecord.objects"
            ),
            "native_io": patch(
                "apps.tabdata.services.collab_service.NativeRecordIO"
            ),
            "next_version": patch(
                "apps.tabdata.services.collab_service.next_record_version",
                return_value=100,
            ),
            "event_svc": patch(
                "apps.tabdata.services.collab_service.table_event_service"
            ),
            "python_to_pg": patch(
                "apps.tabdata.services.collab_service.python_to_pg",
                side_effect=lambda v, ft, cfg: v,
            ),
            "transaction": patch(
                "apps.tabdata.services.collab_service.transaction"
            ),
        }

        return patches, create_data_capture, update_data_capture, field_map_hex

    def _enter_patches(self, patches, table, active_fields, existing_ids):
        """进入所有 patch context 并配置 mock 返回值。"""
        mocks = {}
        for k, p in patches.items():
            mocks[k] = p.start()

        # Table.objects.using(...).filter(...).first() → table
        table_using = MagicMock()
        table_filter = MagicMock()
        table_filter.first.return_value = table
        table_using.filter.return_value = table_filter
        mocks["table_filter"].using.return_value = table_using

        # TableField.objects.using(...).filter(...) → active_fields
        field_using = MagicMock()
        field_using.filter.return_value = active_fields
        mocks["field_filter"].using.return_value = field_using

        # TableRecord.objects.using(...) 多次调用
        record_using = MagicMock()
        existing_id_uuids = {uuid.UUID(rid) if isinstance(rid, str) else rid for rid in existing_ids}
        existing_id_strs = {str(rid) for rid in existing_ids}

        # .filter(table=..., is_deleted=False).values_list("id", flat=True)
        values_list_qs = MagicMock()
        values_list_qs.values_list.return_value = existing_id_uuids

        # .filter(table=..., id__in=...).update(is_deleted=True) for to_delete
        delete_qs = MagicMock()
        delete_qs.update.return_value = 0

        # .filter(id=...).update(...) for to_update
        update_qs = MagicMock()
        update_qs.update.return_value = 1

        def record_filter_dispatch(**kwargs):
            if "is_deleted" in kwargs and "values_list" not in str(kwargs):
                qs = MagicMock()
                qs.values_list.return_value = existing_id_uuids
                return qs
            return MagicMock()

        record_using.filter.side_effect = record_filter_dispatch
        record_using.create.side_effect = lambda **kw: MagicMock(id=kw.get("id"))
        mocks["record_objs"].using.return_value = record_using

        mocks["native_io"].return_value = MagicMock()

        # transaction.atomic context manager
        mocks["transaction"].atomic.return_value.__enter__ = MagicMock()
        mocks["transaction"].atomic.return_value.__exit__ = MagicMock(return_value=False)

        return mocks, record_using

    def _stop_patches(self, patches):
        for p in patches.values():
            p.stop()

    def test_deleted_field_values_silently_skipped_on_create(self):
        """
        快照包含 3 个字段值（A, B, C），但字段 B 已被删除。
        restore_from_snapshot 恢复新记录时，字段 B 的值应被静默跳过。
        """
        table = _make_mock_table()
        field_a = _make_mock_field("字段A")
        field_b = _make_mock_field("字段B", is_deleted=True)
        field_c = _make_mock_field("字段C", field_type="number")

        active_fields = [field_a, field_c]  # field_b 已删，不在活跃列表中

        record_id = str(uuid.uuid4())
        snapshot_data = {
            "records": {
                record_id: {
                    field_a.id.hex: "值A",
                    field_b.id.hex: "值B（已删字段）",
                    field_c.id.hex: 42,
                },
            },
            "row_order": [record_id],
        }

        patches, _, _, _ = self._setup_mocks(table, active_fields)
        mocks, record_using = self._enter_patches(patches, table, active_fields, set())

        try:
            from apps.tabdata.services.collab_service import CollabService

            result = CollabService.restore_from_snapshot(table.id, snapshot_data)

            assert result["created"] == 1

            create_calls = record_using.create.call_args_list
            assert len(create_calls) == 1

            created_data = create_calls[0][1]["data"]
            assert field_a.id.hex in created_data, "活跃字段 A 的值应存在"
            assert created_data[field_a.id.hex] == "值A"
            assert field_c.id.hex in created_data, "活跃字段 C 的值应存在"
            assert created_data[field_c.id.hex] == 42
            assert field_b.id.hex not in created_data, (
                "已删除字段 B 的值不应出现在恢复后的记录中"
            )
        finally:
            self._stop_patches(patches)

    def test_all_active_fields_preserved(self):
        """
        所有字段均为活跃状态时，快照中全部字段值都应被恢复。
        """
        table = _make_mock_table()
        field_a = _make_mock_field("字段A")
        field_b = _make_mock_field("字段B")
        field_c = _make_mock_field("字段C", field_type="number")

        active_fields = [field_a, field_b, field_c]

        record_id = str(uuid.uuid4())
        snapshot_data = {
            "records": {
                record_id: {
                    field_a.id.hex: "A值",
                    field_b.id.hex: "B值",
                    field_c.id.hex: 100,
                },
            },
            "row_order": [record_id],
        }

        patches, _, _, _ = self._setup_mocks(table, active_fields)
        mocks, record_using = self._enter_patches(patches, table, active_fields, set())

        try:
            from apps.tabdata.services.collab_service import CollabService

            CollabService.restore_from_snapshot(table.id, snapshot_data)

            create_calls = record_using.create.call_args_list
            assert len(create_calls) == 1

            created_data = create_calls[0][1]["data"]
            assert created_data[field_a.id.hex] == "A值"
            assert created_data[field_b.id.hex] == "B值"
            assert created_data[field_c.id.hex] == 100
        finally:
            self._stop_patches(patches)

    def test_snapshot_with_only_deleted_fields_creates_empty_data(self):
        """
        极端场景：快照记录的所有非系统字段都已被删除，恢复后记录存在但 data 为空。
        """
        table = _make_mock_table()
        field_deleted = _make_mock_field("已删字段", is_deleted=True)

        active_fields = []  # 没有活跃字段

        record_id = str(uuid.uuid4())
        snapshot_data = {
            "records": {
                record_id: {
                    field_deleted.id.hex: "无用值",
                },
            },
            "row_order": [record_id],
        }

        patches, _, _, _ = self._setup_mocks(table, active_fields)
        mocks, record_using = self._enter_patches(patches, table, active_fields, set())

        try:
            from apps.tabdata.services.collab_service import CollabService

            result = CollabService.restore_from_snapshot(table.id, snapshot_data)

            assert result["created"] == 1
            create_calls = record_using.create.call_args_list
            created_data = create_calls[0][1]["data"]
            assert created_data == {}, "所有字段都已删除时，data 应为空字典"
        finally:
            self._stop_patches(patches)

    def test_system_fields_skipped_regardless(self):
        """快照中 __ 前缀系统字段始终被跳过，不进入 orm_data。"""
        table = _make_mock_table()
        field_a = _make_mock_field("字段A")
        active_fields = [field_a]

        record_id = str(uuid.uuid4())
        snapshot_data = {
            "records": {
                record_id: {
                    "__order": 1000,
                    "__version": 5,
                    field_a.id.hex: "内容",
                },
            },
            "row_order": [record_id],
        }

        patches, _, _, _ = self._setup_mocks(table, active_fields)
        mocks, record_using = self._enter_patches(patches, table, active_fields, set())

        try:
            from apps.tabdata.services.collab_service import CollabService

            CollabService.restore_from_snapshot(table.id, snapshot_data)

            create_calls = record_using.create.call_args_list
            created_data = create_calls[0][1]["data"]
            assert "__order" not in created_data
            assert "__version" not in created_data
            assert created_data[field_a.id.hex] == "内容"
        finally:
            self._stop_patches(patches)

    def test_multiple_records_mixed_deleted_fields(self):
        """
        多条记录场景：部分记录含已删字段值，每条记录独立过滤。
        """
        table = _make_mock_table()
        field_a = _make_mock_field("字段A")
        field_deleted = _make_mock_field("已删字段", is_deleted=True)
        active_fields = [field_a]

        r1_id = str(uuid.uuid4())
        r2_id = str(uuid.uuid4())
        snapshot_data = {
            "records": {
                r1_id: {
                    field_a.id.hex: "R1值",
                    field_deleted.id.hex: "R1已删值",
                },
                r2_id: {
                    field_a.id.hex: "R2值",
                },
            },
            "row_order": [r1_id, r2_id],
        }

        patches, _, _, _ = self._setup_mocks(table, active_fields)
        mocks, record_using = self._enter_patches(patches, table, active_fields, set())

        try:
            from apps.tabdata.services.collab_service import CollabService

            result = CollabService.restore_from_snapshot(table.id, snapshot_data)

            assert result["created"] == 2

            create_calls = record_using.create.call_args_list
            all_created_data = [c[1]["data"] for c in create_calls]

            for data in all_created_data:
                assert field_deleted.id.hex not in data, (
                    "任何记录都不应包含已删字段的值"
                )
                assert field_a.id.hex in data
        finally:
            self._stop_patches(patches)


# ═══════════════════════════════════════════════════════════
# CMS-012: 字段 CRUD 后 schema_version 递增
# ═══════════════════════════════════════════════════════════


class TestSchemaVersionIncrementMechanism:
    """
    CMS-012: 验证 _increment_schema_version 的触发机制。

    _increment_schema_version 在字段创建/删除/改名/配置变更/重排时调用，
    使 SDK 客户端通过版本号判断 field map 缓存是否过期。

    注意：schema_version 递增不自动触发版本历史快照创建。
    版本历史由 collab-live 的 onStore 链路在 persist 成功后触发。
    此测试验证的是递增调用链路，而非版本历史创建。
    """

    # @transaction.atomic 装饰器在类定义时绑定到真实 transaction 函数，
    # 模块级 patch 无法拦截。通过 mock Atomic 上下文管理器为 no-op 解决。

    def setup_method(self):
        self._p1 = patch(
            "django.db.transaction.Atomic.__enter__", return_value=None
        )
        self._p2 = patch(
            "django.db.transaction.Atomic.__exit__", return_value=False
        )
        self._p1.start()
        self._p2.start()

    def teardown_method(self):
        self._p1.stop()
        self._p2.stop()

    def test_increment_schema_version_sql_correctness(self):
        """_increment_schema_version 使用 F() 表达式原子递增。"""
        from apps.tabdata.services.table_service import TableService

        table_id = uuid.uuid4()

        with patch("apps.tabdata.services.table_service.Table.objects") as mock_objects:
            mock_using = MagicMock()
            mock_filter = MagicMock()
            mock_objects.using.return_value = mock_using
            mock_using.filter.return_value = mock_filter

            TableService._increment_schema_version(table_id)

            mock_using.filter.assert_called_once_with(id=table_id)
            mock_filter.update.assert_called_once()

            update_kwargs = mock_filter.update.call_args[1]
            assert "schema_version" in update_kwargs
            # 验证 F('schema_version') + 1 表达式
            expr = update_kwargs["schema_version"]
            assert hasattr(expr, "resolve_expression"), (
                "schema_version 应使用 F() 表达式（原子递增），"
                "而非直接赋值"
            )

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._refresh_field_count")
    @patch("apps.tabdata.services.table_service.TableService._auto_add_field_to_views")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._native_add_column")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_create_field_calls_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_native,
        mock_publish,
        mock_views,
        mock_refresh,
        mock_increment,
        mock_tx,
    ):
        """create_field 成功后应调用 _increment_schema_version。"""
        table_id = uuid.uuid4()
        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.is_system_table = False

        mock_table_using = MagicMock()
        mock_table_using.get.return_value = mock_table
        mock_table_objs.using.return_value = mock_table_using

        mock_field = MagicMock()
        mock_field.id = uuid.uuid4()
        mock_field.table_id = table_id
        mock_field.field_type = "text"

        mock_field_using = MagicMock()
        mock_field_using.filter.return_value = MagicMock(count=MagicMock(return_value=0))
        mock_field_using.create.return_value = mock_field
        mock_field_objs.using.return_value = mock_field_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)
        svc.create_field(table_id, "新字段", "text")

        mock_increment.assert_called_once_with(table_id)

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._sync_table_records_to_ydoc")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_update_field_name_calls_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_sync,
        mock_publish,
        mock_increment,
        mock_tx,
    ):
        """字段改名后应调用 _increment_schema_version。"""
        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.name = "旧名称"
        mock_field.field_type = "text"
        mock_field.is_primary = False
        mock_field.config = {}

        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.is_system_table = False
        mock_table.space_id = uuid.uuid4()

        mock_field_using = MagicMock()
        mock_field_using.get.return_value = mock_field
        mock_field_objs.using.return_value = mock_field_using

        mock_table_using = MagicMock()
        mock_table_using.get.return_value = mock_table
        mock_table_objs.using.return_value = mock_table_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)
        svc.update_field(field_id=field_id, name="新名称")

        mock_increment.assert_called_once_with(table_id)

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._sync_table_records_to_ydoc")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_update_field_options_calls_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_sync,
        mock_publish,
        mock_increment,
        mock_tx,
    ):
        """字段配置变更后应调用 _increment_schema_version。"""
        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.name = "选项字段"
        mock_field.field_type = "select"
        mock_field.is_primary = False
        mock_field.config = {"choices": ["A"]}

        mock_field_using = MagicMock()
        mock_field_using.get.return_value = mock_field
        mock_field_objs.using.return_value = mock_field_using

        mock_table_using = MagicMock()
        mock_table_using.get.return_value = MagicMock(
            id=table_id, is_system_table=False
        )
        mock_table_objs.using.return_value = mock_table_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)
        svc.update_field(field_id=field_id, options={"choices": ["A", "B"]})

        mock_increment.assert_called_once_with(table_id)

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService._sync_table_records_to_ydoc")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_update_field_description_only_skips_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_sync,
        mock_publish,
        mock_increment,
        mock_tx,
    ):
        """仅修改描述（不改名不改配置）时不应触发 schema_version 递增。"""
        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.name = "不变字段"
        mock_field.field_type = "text"
        mock_field.is_primary = False
        mock_field.config = {}

        mock_field_using = MagicMock()
        mock_field_using.get.return_value = mock_field
        mock_field_objs.using.return_value = mock_field_using

        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.is_system_table = False
        mock_table.space_id = uuid.uuid4()
        mock_table_using = MagicMock()
        mock_table_using.get.return_value = mock_table
        mock_table_objs.using.return_value = mock_table_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)
        svc.update_field(field_id=field_id, description="新描述")

        mock_increment.assert_not_called()

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._refresh_field_count")
    @patch("apps.tabdata.services.table_service.TableService._remove_field_from_views")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_delete_field_calls_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_publish,
        mock_remove_views,
        mock_refresh,
        mock_increment,
        mock_tx,
    ):
        """字段删除后应调用 _increment_schema_version。"""
        field_id = uuid.uuid4()
        table_id = uuid.uuid4()

        mock_field = MagicMock()
        mock_field.id = field_id
        mock_field.table_id = table_id
        mock_field.name = "待删字段"
        mock_field.field_type = "text"
        mock_field.is_primary = False
        mock_field.is_deleted = False

        mock_table = MagicMock()
        mock_table.id = table_id
        mock_table.is_system_table = False

        mock_field_using = MagicMock()
        mock_field_using.get.return_value = mock_field
        mock_field_objs.using.return_value = mock_field_using

        mock_table_using = MagicMock()
        mock_table_using.get.return_value = mock_table
        mock_table_objs.using.return_value = mock_table_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)

        with patch(
            "apps.tabdata.services.table_service.LookupFieldService",
            create=True,
        ):
            svc.delete_field(field_id)

        mock_increment.assert_called_once_with(table_id)

    @patch("apps.tabdata.services.table_service.transaction")
    @patch("apps.tabdata.services.table_service.TableService._increment_schema_version")
    @patch("apps.tabdata.services.table_service.TableService._publish_field_event")
    @patch("apps.tabdata.services.table_service.TableService.check_table_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.TableField.objects")
    @patch("apps.tabdata.services.table_service.Table.objects")
    def test_reorder_fields_calls_increment(
        self,
        mock_table_objs,
        mock_field_objs,
        mock_perm,
        mock_publish,
        mock_increment,
        mock_tx,
    ):
        """字段重排后应调用 _increment_schema_version。"""
        table_id = uuid.uuid4()
        f1_id = uuid.uuid4()
        f2_id = uuid.uuid4()

        mock_f1 = MagicMock()
        mock_f1.id = f1_id
        mock_f1.order = 0
        mock_f2 = MagicMock()
        mock_f2.id = f2_id
        mock_f2.order = 1

        mock_field_using = MagicMock()
        locked_qs = MagicMock()
        locked_qs.__iter__ = MagicMock(return_value=iter([mock_f1, mock_f2]))
        locked_qs.__len__ = MagicMock(return_value=2)
        mock_field_using.select_for_update.return_value = MagicMock(
            filter=MagicMock(return_value=locked_qs)
        )
        mock_field_using.filter.return_value = [mock_f1, mock_f2]
        mock_field_using.bulk_update = MagicMock()
        mock_field_objs.using.return_value = mock_field_using

        from apps.tabdata.services.table_service import TableService

        user = MagicMock()
        user.id = uuid.uuid4()
        svc = TableService(user=user)
        svc.reorder_fields(
            table_id=table_id,
            field_orders=[
                {"field_id": str(f1_id), "sort_order": 1},
                {"field_id": str(f2_id), "sort_order": 0},
            ],
        )

        mock_increment.assert_called_once_with(table_id)


class TestSchemaVersionNotLinkedToVersionHistory:
    """
    CMS-012 补充：确认 schema_version 递增与版本历史创建是解耦的。

    _increment_schema_version 仅执行 Table.schema_version += 1，
    不触发 VersionHistoryService.create_history。
    版本历史由 collab-live onStore 链路异步触发。
    """

    def test_increment_does_not_import_version_history(self):
        """_increment_schema_version 不依赖版本历史模块。"""
        import inspect

        from apps.tabdata.services.table_service import TableService

        source = inspect.getsource(TableService._increment_schema_version)
        assert "VersionHistory" not in source
        assert "create_history" not in source

    def test_increment_is_static_method(self):
        """_increment_schema_version 是静态方法，无 self 依赖。"""
        from apps.tabdata.services.table_service import TableService

        assert isinstance(
            TableService.__dict__["_increment_schema_version"],
            staticmethod,
        )
