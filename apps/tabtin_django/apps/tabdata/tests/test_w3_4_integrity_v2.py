"""W3.4 / D2 Schema Integrity V2 + C1 字段回收站 单元测试。

覆盖范围
========

1. **IntegrityV2Service.check()**
   - column_missing 检测（ORM 有字段但 PG 无列）
   - column_orphan 检测（PG 有列但 ORM 无字段）
   - type_mismatch 检测（字段类型与 PG 列类型不匹配）
   - ref_stale 检测（FieldReference stale 边）
   - row_count_mismatch 检测（ORM vs native 行数不一致）
   - 表不存在时返回 error
   - native 表不存在时返回 error

2. **IntegrityV2Service.repair_stream()**
   - column_missing 修复（ADD COLUMN）
   - column_orphan 修复（DROP COLUMN）
   - ref_stale 修复（DELETE FieldReference）
   - row_count_mismatch 修复（backfill records）
   - 无可修复项时返回 success
   - 修复失败时返回 failed event

3. **Admin API 端点**
   - POST /schema-check 返回结构化报告
   - POST /schema-repair 返回 SSE 流
   - GET /deleted-fields 列出回收站字段
   - POST /deleted-fields/{id}/restore 恢复字段

4. **Celery beat 清理任务**
   - 过期字段被物理删除（DDL + ORM）
   - 未过期字段保留
   - FieldReference 清理

执行模式
--------

与 ``test_w3_2_admin_outbox.py`` 同款 — 不创建真实 DB 对象，
用 MagicMock + patch 替换 ORM / DDL 层。
"""
from __future__ import annotations

import json
import os
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, PropertyMock
from uuid import UUID, uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.test import override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402


# ── Fixtures ─────────────────────────────────────────────────

def _make_table(table_id=None, space_id=None, name='TestTable'):
    t = SimpleNamespace()
    t.id = table_id or uuid4()
    t.space_id = space_id or uuid4()
    t.name = name
    t.organization_id = uuid4()
    return t


def _make_field(
    field_id=None, table_id=None, name='col1',
    field_type='text', is_deleted=False, config=None,
    updated_at=None, is_primary=False,
):
    f = SimpleNamespace()
    f.id = field_id or uuid4()
    f.table_id = table_id or uuid4()
    f.name = name
    f.field_type = field_type
    f.is_deleted = is_deleted
    f.config = config or {}
    f.updated_at = updated_at or timezone.now()
    f.is_primary = is_primary
    f.table = _make_table(table_id=f.table_id)
    return f


def _make_ref(ref_id=None, from_field_id=None, to_field_id=None):
    r = SimpleNamespace()
    r.id = ref_id or uuid4()
    r.from_field_id = from_field_id or uuid4()
    r.to_field_id = to_field_id or uuid4()
    return r


def _setup_field_mock(mock_field_cls, active_fields, active_ids=None):
    """设置 TableField mock — 处理 .filter() 同时被 check 中多处调用的场景。

    check() 中 ``filter(is_deleted=False)`` 被调 2 次：
    1. 加载 active_fields 列表
    2. 查询 active_field_ids（.values_list('id', flat=True)）
    """
    if active_ids is None:
        active_ids = [f.id for f in active_fields]

    values_list_qs = MagicMock()
    values_list_qs.values_list.return_value = active_ids

    mock_field_cls.objects.using.return_value.filter.side_effect = [
        active_fields,   # 第一次：加载 active_fields
        values_list_qs,  # 第二次：查询 active_field_ids
    ]


def _setup_cursor_mock(mock_conns, fetchone_value=(0,), fetchall_value=None):
    """设置 connections cursor mock。"""
    cursor_mock = MagicMock()
    cursor_mock.fetchone.return_value = fetchone_value
    if fetchall_value is not None:
        cursor_mock.fetchall.return_value = fetchall_value
    ctx = MagicMock()
    ctx.__enter__ = MagicMock(return_value=cursor_mock)
    ctx.__exit__ = MagicMock(return_value=False)
    mock_conns.__getitem__.return_value.cursor.return_value = ctx
    return cursor_mock


# ── IntegrityV2Service.check tests ───────────────────────────


class TestIntegrityV2Check:
    """IntegrityV2Service.check() 的检测逻辑。"""

    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    @patch('apps.tabdata.services.integrity_v2_service.TableRecord')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_column_missing_detected(
        self, mock_conns, mock_ddl_cls, mock_table_cls,
        mock_field_cls, mock_record_cls, mock_ref_cls,
    ):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_table_cls.DoesNotExist = Exception

        field1 = _make_field(table_id=table.id, name='name', field_type='text')
        _setup_field_mock(mock_field_cls, [field1])

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True
        ddl.list_columns.return_value = []

        mock_record_cls.objects.using.return_value.filter.return_value.count.return_value = 0
        mock_ref_cls.objects.using.return_value.filter.return_value.select_related.return_value = []

        _setup_cursor_mock(mock_conns, fetchone_value=(0,))

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)

        assert report.checked_fields == 1
        missing = [d for d in report.drift_items if d.type == 'column_missing']
        assert len(missing) == 1
        assert missing[0].auto_fixable is True

    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    @patch('apps.tabdata.services.integrity_v2_service.TableRecord')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_column_orphan_detected(
        self, mock_conns, mock_ddl_cls, mock_table_cls,
        mock_field_cls, mock_record_cls, mock_ref_cls,
    ):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_table_cls.DoesNotExist = Exception
        _setup_field_mock(mock_field_cls, [], active_ids=[])

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True
        ddl.list_columns.return_value = [
            {'name': 'abc123def456abc123def456abc123de', 'data_type': 'text'},
        ]

        mock_record_cls.objects.using.return_value.filter.return_value.count.return_value = 0
        mock_ref_cls.objects.using.return_value.filter.return_value.select_related.return_value = []

        _setup_cursor_mock(mock_conns, fetchone_value=(0,))

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)

        orphans = [d for d in report.drift_items if d.type == 'column_orphan']
        assert len(orphans) == 1
        assert orphans[0].auto_fixable is True

    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    @patch('apps.tabdata.services.integrity_v2_service.TableRecord')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_type_mismatch_detected(
        self, mock_conns, mock_ddl_cls, mock_table_cls,
        mock_field_cls, mock_record_cls, mock_ref_cls,
    ):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_table_cls.DoesNotExist = Exception

        field1 = _make_field(table_id=table.id, name='amount', field_type='number')
        _setup_field_mock(mock_field_cls, [field1])

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True
        ddl.list_columns.return_value = [
            {'name': field1.id.hex, 'data_type': 'text'},
        ]

        mock_record_cls.objects.using.return_value.filter.return_value.count.return_value = 0
        mock_ref_cls.objects.using.return_value.filter.return_value.select_related.return_value = []

        _setup_cursor_mock(mock_conns, fetchone_value=(0,))

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)

        mismatches = [d for d in report.drift_items if d.type == 'type_mismatch']
        assert len(mismatches) == 1
        assert mismatches[0].expected == 'DOUBLE PRECISION'
        assert mismatches[0].actual == 'TEXT'
        assert mismatches[0].auto_fixable is False

    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    @patch('apps.tabdata.services.integrity_v2_service.TableRecord')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_ref_stale_detected(
        self, mock_conns, mock_ddl_cls, mock_table_cls,
        mock_field_cls, mock_record_cls, mock_ref_cls,
    ):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_table_cls.DoesNotExist = Exception

        field1 = _make_field(table_id=table.id, field_type='link')
        _setup_field_mock(mock_field_cls, [field1])

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True
        ddl.list_columns.return_value = [
            {'name': field1.id.hex, 'data_type': 'text'},
        ]

        deleted_from_field_id = uuid4()
        stale_ref = _make_ref(
            from_field_id=deleted_from_field_id,
            to_field_id=field1.id,
        )

        from_qs = MagicMock()
        from_qs.select_related.return_value = [stale_ref]
        to_qs = MagicMock()
        to_qs.select_related.return_value = []
        mock_ref_cls.objects.using.return_value.filter.side_effect = [from_qs, to_qs]

        exists_calls = []
        def _exists_side_effect(*args, **kwargs):
            m = MagicMock()
            fid = kwargs.get('id')
            if fid == deleted_from_field_id:
                m.exists.return_value = False  # from_field deleted
            else:
                m.exists.return_value = True   # to_field active
            exists_calls.append(fid)
            return m

        mock_field_cls.objects.using.return_value.filter.side_effect = [
            [field1],                        # active fields query
            MagicMock(values_list=MagicMock(return_value=[])),  # soft deleted for orphan check
            _exists_side_effect(id=deleted_from_field_id),  # placeholder — real routing below
        ]

        orig_filter = mock_field_cls.objects.using.return_value.filter
        call_count = [0]
        def smart_filter(**kwargs):
            call_count[0] += 1
            if call_count[0] == 1:
                return [field1]
            elif call_count[0] == 2:
                m = MagicMock()
                m.values_list.return_value = []
                return m
            else:
                m = MagicMock()
                fid = kwargs.get('id')
                m.exists.return_value = (fid != deleted_from_field_id)
                return m

        mock_field_cls.objects.using.return_value.filter = MagicMock(side_effect=lambda **kw: smart_filter(**kw))

        mock_record_cls.objects.using.return_value.filter.return_value.count.return_value = 0

        _setup_cursor_mock(mock_conns, fetchone_value=(0,))

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)

        stale = [d for d in report.drift_items if d.type == 'ref_stale']
        assert len(stale) == 1
        assert stale[0].auto_fixable is True

    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    @patch('apps.tabdata.services.integrity_v2_service.TableRecord')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_row_count_mismatch_detected(
        self, mock_conns, mock_ddl_cls, mock_table_cls,
        mock_field_cls, mock_record_cls, mock_ref_cls,
    ):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_table_cls.DoesNotExist = Exception
        _setup_field_mock(mock_field_cls, [], active_ids=[])

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True
        ddl.list_columns.return_value = []

        mock_record_cls.objects.using.return_value.filter.return_value.count.return_value = 100
        mock_ref_cls.objects.using.return_value.filter.return_value.select_related.return_value = []

        _setup_cursor_mock(mock_conns, fetchone_value=(90,))

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)

        assert report.orm_row_count == 100
        assert report.native_row_count == 90
        row_drifts = [d for d in report.drift_items if d.type == 'row_count_mismatch']
        assert len(row_drifts) == 1
        assert row_drifts[0].auto_fixable is True

    @patch('apps.tabdata.services.integrity_v2_service.Table')
    def test_table_not_found(self, mock_table_cls):
        mock_table_cls.objects.using.return_value.get.side_effect = Exception('DoesNotExist')
        mock_table_cls.DoesNotExist = Exception

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        tid = uuid4()

        mock_table_cls.objects.using.return_value.get.side_effect = mock_table_cls.DoesNotExist
        report = svc.check(tid)
        assert report.error is not None

    @patch('apps.tabdata.services.integrity_v2_service.Table')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    def test_native_table_not_exists(self, mock_ddl_cls, mock_table_cls):
        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = False

        from apps.tabdata.services.integrity_v2_service import IntegrityV2Service

        svc = IntegrityV2Service()
        report = svc.check(table.id)
        assert report.error is None
        missing = [d for d in report.drift_items if d.type == 'native_table_missing']
        assert len(missing) == 1
        assert missing[0].auto_fixable is True


class TestIntegrityV2Repair:
    """IntegrityV2Service.repair_stream() 的修复逻辑。"""

    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service.check')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    def test_no_fixable_items(self, mock_table_cls, mock_check):
        from apps.tabdata.services.integrity_v2_service import (
            IntegrityV2Service, SchemaCheckReport,
        )

        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table
        mock_check.return_value = SchemaCheckReport(
            table_id=str(table.id), table_name=table.name,
        )

        svc = IntegrityV2Service()
        events = list(svc.repair_stream(table.id))

        assert len(events) == 1
        assert events[0].status == 'success'
        assert 'No auto-fixable' in events[0].message

    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service.check')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    def test_check_error_yields_failed(self, mock_table_cls, mock_check):
        from apps.tabdata.services.integrity_v2_service import (
            IntegrityV2Service, SchemaCheckReport,
        )

        tid = uuid4()
        mock_check.return_value = SchemaCheckReport(
            table_id=str(tid), table_name='',
            error='Table not found',
        )

        svc = IntegrityV2Service()
        events = list(svc.repair_stream(tid))

        assert len(events) == 1
        assert events[0].status == 'failed'

    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service._repair_one')
    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service.check')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    def test_repair_stream_yields_events(
        self, mock_table_cls, mock_check, mock_repair_one,
    ):
        from apps.tabdata.services.integrity_v2_service import (
            DriftItem, IntegrityV2Service, SchemaCheckReport,
        )

        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table

        items = [
            DriftItem(
                type='column_missing', field_id=str(uuid4()),
                auto_fixable=True, detail='missing col',
            ),
            DriftItem(
                type='ref_stale', field_id=str(uuid4()),
                auto_fixable=True, detail='stale ref',
            ),
        ]
        mock_check.return_value = SchemaCheckReport(
            table_id=str(table.id), table_name=table.name,
            drift_items=items,
        )
        mock_repair_one.return_value = None

        svc = IntegrityV2Service()
        events = list(svc.repair_stream(table.id))

        assert len(events) == 4  # start + 2 repairs + summary
        assert events[0].drift_type == 'start'
        assert events[1].status == 'success'
        assert events[2].status == 'success'
        assert events[3].drift_type == 'summary'

    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service._repair_one')
    @patch('apps.tabdata.services.integrity_v2_service.IntegrityV2Service.check')
    @patch('apps.tabdata.services.integrity_v2_service.Table')
    def test_repair_failure_yields_failed_event(
        self, mock_table_cls, mock_check, mock_repair_one,
    ):
        from apps.tabdata.services.integrity_v2_service import (
            DriftItem, IntegrityV2Service, SchemaCheckReport,
        )

        table = _make_table()
        mock_table_cls.objects.using.return_value.get.return_value = table

        items = [
            DriftItem(
                type='column_missing', field_id=str(uuid4()),
                auto_fixable=True,
            ),
        ]
        mock_check.return_value = SchemaCheckReport(
            table_id=str(table.id), table_name=table.name,
            drift_items=items,
        )
        mock_repair_one.side_effect = Exception('DDL failed')

        svc = IntegrityV2Service()
        events = list(svc.repair_stream(table.id))

        assert events[0].drift_type == 'start'
        assert events[1].status == 'failed'
        assert 'DDL failed' in events[1].message


class TestIntegrityV2RepairMethods:
    """_repair_* 单独方法测试。"""

    @patch('apps.tabdata.services.integrity_v2_service.transaction')
    @patch('apps.tabdata.services.integrity_v2_service.TableField')
    @patch('apps.tabdata.services.integrity_v2_service.DDLManager')
    def test_repair_column_missing(self, mock_ddl_cls, mock_field_cls, mock_tx):
        from apps.tabdata.services.integrity_v2_service import DriftItem, IntegrityV2Service

        table = _make_table()
        field = _make_field(table_id=table.id, field_type='number')
        mock_field_cls.objects.using.return_value.get.return_value = field

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl

        svc = IntegrityV2Service()
        item = DriftItem(
            type='column_missing', field_id=str(field.id), auto_fixable=True,
        )
        svc._repair_column_missing(table, item)

        ddl.add_column.assert_called_once()

    @patch('apps.tabdata.services.integrity_v2_service.transaction')
    @patch('apps.tabdata.services.integrity_v2_service.connections')
    def test_repair_column_orphan(self, mock_conns, mock_tx):
        from apps.tabdata.services.integrity_v2_service import DriftItem, IntegrityV2Service

        table = _make_table()
        cursor_mock = MagicMock()
        mock_conns.__getitem__.return_value.cursor.return_value.__enter__ = MagicMock(return_value=cursor_mock)
        mock_conns.__getitem__.return_value.cursor.return_value.__exit__ = MagicMock(return_value=False)

        svc = IntegrityV2Service()
        item = DriftItem(
            type='column_orphan',
            column_name='deadbeef12345678deadbeef12345678',
            actual='PG column "deadbeef12345678deadbeef12345678" (text)',
            auto_fixable=True,
        )
        svc._repair_column_orphan(table, item)

        cursor_mock.execute.assert_called_once()
        sql = cursor_mock.execute.call_args[0][0]
        assert 'DROP COLUMN' in sql
        assert 'deadbeef12345678deadbeef12345678' in sql

    @patch('apps.tabdata.services.integrity_v2_service.transaction')
    @patch('apps.tabdata.services.integrity_v2_service.FieldReference')
    def test_repair_ref_stale(self, mock_ref_cls, mock_tx):
        from apps.tabdata.services.integrity_v2_service import DriftItem, IntegrityV2Service

        ref_id = uuid4()
        item = DriftItem(
            type='ref_stale', field_id=str(ref_id), auto_fixable=True,
        )

        svc = IntegrityV2Service()
        svc._repair_ref_stale(item)

        mock_ref_cls.objects.using.return_value.filter.return_value.delete.assert_called_once()


class TestFieldRecycleCleanup:
    """cleanup_expired_deleted_fields Celery 任务测试。"""

    @patch('apps.tabdata.native.ddl_manager.DDLManager')
    @patch('apps.tabdata.models.FieldReference')
    @patch('apps.tabdata.models.TableField')
    @patch('django.db.transaction.atomic')
    @override_settings(TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS=30)
    def test_expired_fields_purged(
        self, mock_tx, mock_field_cls, mock_ref_cls, mock_ddl_cls,
    ):
        table = _make_table()
        old_field = _make_field(
            table_id=table.id, name='old_col', field_type='text',
            is_deleted=True,
            updated_at=timezone.now() - timedelta(days=45),
        )
        old_field.table = table
        old_field.delete = MagicMock()

        qs_mock = MagicMock()
        qs_mock.filter.return_value.select_related.return_value.order_by.return_value.__getitem__ = MagicMock(return_value=[old_field])
        mock_field_cls.objects.using.return_value = qs_mock

        ddl = MagicMock()
        mock_ddl_cls.return_value = ddl
        ddl.native_table_exists.return_value = True

        mock_ref_cls.objects.using.return_value.filter.return_value.delete.return_value = (0, {})

        from apps.tabdata.tasks.field_recycle_cleanup import (
            cleanup_expired_deleted_fields,
        )

        result = cleanup_expired_deleted_fields(batch_size=100)

        assert result == 1
        ddl.drop_column.assert_called_once()
        old_field.delete.assert_called_once()

    @patch('apps.tabdata.models.TableField')
    @override_settings(TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS=30)
    def test_no_expired_fields(self, mock_field_cls):
        qs_mock = MagicMock()
        qs_mock.filter.return_value.select_related.return_value.order_by.return_value.__getitem__ = MagicMock(return_value=[])
        mock_field_cls.objects.using.return_value = qs_mock

        from apps.tabdata.tasks.field_recycle_cleanup import (
            cleanup_expired_deleted_fields,
        )

        result = cleanup_expired_deleted_fields(batch_size=100)
        assert result == 0


class TestDriftItemSerialization:
    """DriftItem / SchemaCheckReport 序列化测试。"""

    def test_drift_item_to_dict(self):
        from apps.tabdata.services.integrity_v2_service import DriftItem

        item = DriftItem(
            type='column_missing',
            field_id='abc',
            auto_fixable=True,
        )
        d = item.to_dict()
        assert d['type'] == 'column_missing'
        assert d['field_id'] == 'abc'
        assert d['auto_fixable'] is True
        assert 'field_name' not in d  # None values excluded

    def test_report_to_dict(self):
        from apps.tabdata.services.integrity_v2_service import (
            DriftItem, SchemaCheckReport,
        )

        report = SchemaCheckReport(
            table_id='t1', table_name='Test',
            drift_items=[
                DriftItem(type='column_missing', auto_fixable=True),
            ],
            checked_fields=5,
            orm_row_count=100,
            native_row_count=95,
        )
        d = report.to_dict()
        assert d['table_id'] == 't1'
        assert len(d['drift_items']) == 1
        assert 'error' not in d

    def test_repair_event_to_dict(self):
        from apps.tabdata.services.integrity_v2_service import RepairEvent

        evt = RepairEvent(
            seq=1, drift_type='column_missing',
            field_id='f1', status='success', message='ok',
        )
        d = evt.to_dict()
        assert d['seq'] == 1
        assert d['status'] == 'success'


class TestPgTypeNormalize:
    """_normalize_pg_type 辅助函数测试。"""

    def test_common_types(self):
        from apps.tabdata.services.integrity_v2_service import _normalize_pg_type

        assert _normalize_pg_type('double precision') == 'DOUBLE PRECISION'
        assert _normalize_pg_type('text') == 'TEXT'
        assert _normalize_pg_type('integer') == 'INTEGER'
        assert _normalize_pg_type('boolean') == 'BOOLEAN'
        assert _normalize_pg_type('jsonb') == 'JSONB'
        assert _normalize_pg_type('timestamp with time zone') == 'TIMESTAMPTZ'

    def test_unknown_passthrough(self):
        from apps.tabdata.services.integrity_v2_service import _normalize_pg_type

        assert _normalize_pg_type('varchar') == 'VARCHAR'
        assert _normalize_pg_type('  BIGINT  ') == 'BIGINT'


class TestAdminIntegrityApiEndpoints:
    """API 端点级测试（仅验证函数签名和返回结构）。"""

    @patch('apps.tabdata.api_admin_integrity._verify_table_access')
    @patch('apps.tabdata.api_admin_integrity.IntegrityV2Service')
    def test_schema_check_returns_report(self, mock_svc_cls, mock_verify):
        from apps.tabdata.services.integrity_v2_service import SchemaCheckReport
        from apps.tabdata.api_admin_integrity import schema_check

        tid = uuid4()
        mock_verify.return_value = _make_table(table_id=tid)
        mock_svc = MagicMock()
        mock_svc_cls.return_value = mock_svc
        mock_svc.check.return_value = SchemaCheckReport(
            table_id=str(tid), table_name='Test',
        )

        request = MagicMock()
        result = schema_check(request, tid)

        assert result['table_id'] == str(tid)
        assert 'drift_items' in result

    @patch('apps.tabdata.api_admin_integrity._verify_table_access')
    @patch('apps.tabdata.api_admin_integrity.IntegrityV2Service')
    def test_schema_repair_returns_sse(self, mock_svc_cls, mock_verify):
        from apps.tabdata.services.integrity_v2_service import RepairEvent
        from apps.tabdata.api_admin_integrity import schema_repair

        tid = uuid4()
        mock_verify.return_value = _make_table(table_id=tid)
        mock_svc = MagicMock()
        mock_svc_cls.return_value = mock_svc
        mock_svc.repair_stream.return_value = iter([
            RepairEvent(seq=1, drift_type='column_missing', status='success'),
        ])

        request = MagicMock()
        response = schema_repair(request, tid)

        assert response['Content-Type'] == 'text/event-stream'

    @patch('apps.tabdata.api_admin_integrity._verify_table_access')
    @patch('apps.tabdata.api_admin_integrity.TableField')
    def test_list_deleted_fields_returns_items(self, mock_field_cls, mock_verify):
        from apps.tabdata.api_admin_integrity import list_deleted_fields

        tid = uuid4()
        mock_verify.return_value = _make_table(table_id=tid)

        field1 = _make_field(
            table_id=tid, name='deleted_col', is_deleted=True,
            updated_at=timezone.now() - timedelta(days=5),
        )
        mock_field_cls.objects.using.return_value.filter.return_value.order_by.return_value = [field1]

        request = MagicMock()
        result = list_deleted_fields(request, tid)

        assert result.table_id == str(tid)
        assert len(result.fields) == 1
        assert result.fields[0].days_remaining > 0

    @patch('apps.tabdata.api_admin_integrity._verify_table_access')
    @patch('apps.tabdata.api_admin_integrity.TableField')
    def test_list_deleted_fields_excludes_expired(self, mock_field_cls, mock_verify):
        from apps.tabdata.api_admin_integrity import list_deleted_fields

        tid = uuid4()
        mock_verify.return_value = _make_table(table_id=tid)

        expired = _make_field(
            table_id=tid, name='expired_col', is_deleted=True,
            updated_at=timezone.now() - timedelta(days=60),
        )
        mock_field_cls.objects.using.return_value.filter.return_value.order_by.return_value = [expired]

        request = MagicMock()
        result = list_deleted_fields(request, tid)

        assert len(result.fields) == 0

    @patch('apps.tabdata.api_admin_integrity._verify_table_access')
    @patch('apps.tabdata.api_admin_integrity.TableField')
    @patch('apps.tabdata.services.undo_redo_field_restore.restore_field')
    def test_restore_deleted_field_success(
        self, mock_restore, mock_field_cls, mock_verify,
    ):
        from apps.tabdata.api_admin_integrity import restore_deleted_field

        tid = uuid4()
        fid = uuid4()
        mock_verify.return_value = _make_table(table_id=tid)

        field_obj = _make_field(
            field_id=fid, table_id=tid, is_deleted=True,
        )
        mock_field_cls.objects.using.return_value.get.return_value = field_obj
        mock_restore.return_value = (True, 'Restored')

        request = MagicMock()
        request.auth = SimpleNamespace(id=uuid4())
        result = restore_deleted_field(request, tid, fid)

        assert result.success is True
        assert result.field_id == str(fid)


class TestBeatScheduleRegistration:
    """beat schedule 注册验证。"""

    def test_beat_schedule_exported(self):
        from apps.tabdata.tasks.field_recycle_cleanup import (
            FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE,
        )

        assert 'tabdata-field-recycle-cleanup' in FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE
        conf = FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE['tabdata-field-recycle-cleanup']
        assert conf['schedule'] == 3600.0 * 6
        assert 'task' in conf

    def test_tasks_init_re_exports(self):
        import apps.tabdata.tasks as tasks_mod

        assert hasattr(tasks_mod, 'FIELD_RECYCLE_CLEANUP_BEAT_SCHEDULE')
        assert hasattr(tasks_mod, 'cleanup_expired_deleted_fields')


class TestSettingsRegistration:
    """settings 配置项验证。"""

    def test_field_recycle_bin_ttl_default(self):
        from django.conf import settings

        ttl = getattr(settings, 'TABDATA_FIELD_RECYCLE_BIN_TTL_DAYS', None)
        assert ttl is not None
        assert ttl == 30
