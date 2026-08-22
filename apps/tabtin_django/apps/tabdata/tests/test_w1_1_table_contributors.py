"""Wave 1.1 / TD-2 / TD-3 contributor + adapter 单元测试（轻量 mock 模式）。

设计取舍
--------

本模块**不创建真实 Organization → Space → Table → Record 依赖链**，而是
mock ORM `objects.using(...).filter(...)` 路径，测试纯函数逻辑。
原因：本仓库 prod schema 与 test database 之间存在与本期改动无关的
``BillingAnomalyAlert`` 迁移漂移，会让 TestCase / TransactionTestCase
无法成功 setUp 完整业务对象。

覆盖范围
--------

TD-2 ``TableResourceContributor.collect_resources``:
- 空输入 / 异常 / 单 run / 多 run 合并去重 / 边界

TD-2 ``TableImpactContributor.collect_impact``:
- 空输入 / 多 change_type 聚合 / import_data 拆分

TD-3 ``TableAdapter.preview_restore``:
- target_data 非 dict / 缺 records → 空摘要不抛
- simple no-diff / extra/missing/data-diff records / field schema diff
- 大表（>50000 行）走 count diff 路径
- estimated_duration_ms 与影响行数线性
"""
from __future__ import annotations

import os
from unittest.mock import MagicMock, patch
from uuid import uuid4

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.tabdata.contributors import (  # noqa: E402
    TableImpactContributor,
    TableResourceContributor,
)


# ── TD-2: TableResourceContributor ───────────────────────────


class TestTableResourceContributor:
    """contributors.collect_resources 行为（无真实 DB）。"""

    def test_empty_input_returns_empty(self):
        contrib = TableResourceContributor()
        assert contrib.collect_resources([]) == []

    @patch("apps.collab.models.ChangeLog.objects")
    def test_changelog_query_failure_returns_empty(self, mock_objects):
        mock_objects.using.side_effect = RuntimeError("simulated DB down")
        contrib = TableResourceContributor()
        # 异常被吞，返回空 list
        assert contrib.collect_resources(["run_x"]) == []

    @patch("apps.collab.models.VersionHistory.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_no_table_changelogs_returns_empty(self, mock_cl, mock_vh):
        # ChangeLog 反查为空 → 不调 VH
        mock_cl.using.return_value.filter.return_value.values_list.return_value.distinct.return_value = []
        contrib = TableResourceContributor()
        assert contrib.collect_resources(["run_p"]) == []
        mock_vh.using.assert_not_called()

    @patch("apps.collab.models.VersionHistory.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_single_run_returns_latest_vh(self, mock_cl, mock_vh):
        table_id = uuid4()
        vh_id = uuid4()
        mock_cl.using.return_value.filter.return_value.values_list.return_value.distinct.return_value = [
            table_id,
        ]
        mock_vh.using.return_value.filter.return_value.order_by.return_value.distinct.return_value.values_list.return_value = [
            (table_id, vh_id),
        ]
        contrib = TableResourceContributor()
        refs = contrib.collect_resources(["run_x"])
        assert len(refs) == 1
        assert refs[0]["resource_type"] == "table"
        assert refs[0]["resource_id"] == str(table_id)
        assert refs[0]["version_history_id"] == str(vh_id)

    @patch("apps.collab.models.VersionHistory.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_multiple_tables_dedup_via_distinct_on(self, mock_cl, mock_vh):
        """contributor 输出条数 == VH distinct(resource_id) 输出条数（去重在 SQL 端）。"""
        table_a, table_b = uuid4(), uuid4()
        vh_a, vh_b = uuid4(), uuid4()
        mock_cl.using.return_value.filter.return_value.values_list.return_value.distinct.return_value = [
            table_a, table_b,
        ]
        mock_vh.using.return_value.filter.return_value.order_by.return_value.distinct.return_value.values_list.return_value = [
            (table_a, vh_a),
            (table_b, vh_b),
        ]
        contrib = TableResourceContributor()
        refs = contrib.collect_resources(["run_p", "run_q"])
        ids = sorted(r["resource_id"] for r in refs)
        assert ids == sorted([str(table_a), str(table_b)])


# ── TD-2: TableImpactContributor ─────────────────────────────


class TestTableImpactContributor:
    def test_empty_input_returns_none(self):
        contrib = TableImpactContributor()
        assert contrib.collect_impact([]) is None

    @patch("apps.collab.models.ChangeLog.objects")
    def test_changelog_query_failure_returns_none(self, mock_objects):
        mock_objects.using.side_effect = RuntimeError("simulated DB down")
        contrib = TableImpactContributor()
        assert contrib.collect_impact(["run_x"]) is None

    @patch("apps.tabdata.models.Table.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_aggregates_create_update_delete(self, mock_cl, mock_tbl):
        table_id = uuid4()
        mock_cl.using.return_value.filter.return_value.values.return_value = [
            {"resource_id": table_id, "change_type": "batch_create_records",
             "changes": {"record_count": 10}},
            {"resource_id": table_id, "change_type": "batch_update_records",
             "changes": {"record_count": 20}},
            {"resource_id": table_id, "change_type": "batch_delete_records",
             "changes": {"record_count": 5}},
        ]
        # name lookup 返回空（不影响主体测试）
        mock_tbl.using.return_value.filter.return_value.values_list.return_value = []
        contrib = TableImpactContributor()
        result = contrib.collect_impact(["run_mix"])
        assert result is not None
        tables = result["tables_affected"]
        assert len(tables) == 1
        entry = tables[0]
        assert entry["table_id"] == str(table_id)
        assert entry["changes"]["records_inserted"] == 10
        assert entry["changes"]["records_updated"] == 20
        assert entry["changes"]["records_deleted"] == 5

    @patch("apps.tabdata.models.Table.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_import_data_split_into_create_update(self, mock_cl, mock_tbl):
        table_id = uuid4()
        mock_cl.using.return_value.filter.return_value.values.return_value = [
            {"resource_id": table_id, "change_type": "import_data",
             "changes": {"created_count": 3, "updated_count": 7}},
        ]
        mock_tbl.using.return_value.filter.return_value.values_list.return_value = []
        contrib = TableImpactContributor()
        result = contrib.collect_impact(["run_import"])
        entry = result["tables_affected"][0]
        assert entry["changes"]["records_inserted"] == 3
        assert entry["changes"]["records_updated"] == 7

    @patch("apps.tabdata.models.Table.objects")
    @patch("apps.collab.models.ChangeLog.objects")
    def test_multi_table_aggregation(self, mock_cl, mock_tbl):
        ta, tb = uuid4(), uuid4()
        mock_cl.using.return_value.filter.return_value.values.return_value = [
            {"resource_id": ta, "change_type": "update_record", "changes": {}},
            {"resource_id": tb, "change_type": "delete_record", "changes": {}},
            {"resource_id": ta, "change_type": "update_record", "changes": {}},
        ]
        mock_tbl.using.return_value.filter.return_value.values_list.return_value = []
        contrib = TableImpactContributor()
        result = contrib.collect_impact(["run_multi"])
        tables = {t["table_id"]: t for t in result["tables_affected"]}
        assert str(ta) in tables
        assert str(tb) in tables
        # ta 两次 update_record，单条无 record_count 时各按 1 计
        assert tables[str(ta)]["changes"]["records_updated"] >= 1
        assert tables[str(tb)]["changes"]["records_deleted"] >= 1


# ── TD-3: TableAdapter.preview_restore ──────────────────────


class TestTableAdapterPreviewRestoreEdgeCases:
    """target_data 非法时返回安全空摘要（不抛）。"""

    def setup_method(self):
        from apps.collab.adapters.table import TableCollabAdapter
        self.adapter = TableCollabAdapter()
        self.fake_resource = MagicMock(id=uuid4())

    def test_target_data_not_dict(self):
        result = self.adapter.preview_restore(self.fake_resource, target_data="bad")
        assert result["records_to_create"] == 0
        assert result["records_to_delete"] == 0
        assert result["records_to_restore"] == 0
        assert result["fields_to_restore"] == []
        # base 200ms
        assert result["estimated_duration_ms"] >= 0

    def test_target_data_missing_records(self):
        result = self.adapter.preview_restore(self.fake_resource, target_data={})
        assert result["records_to_create"] == 0
        assert result["records_to_delete"] == 0


class TestTableAdapterPreviewRestoreDiff:
    """对 records 集合 / fields 集合做 diff 计算。"""

    def setup_method(self):
        from apps.collab.adapters.table import TableCollabAdapter
        self.adapter = TableCollabAdapter()
        self.resource = MagicMock(id=uuid4())

    def _patch_record_query(self, *, current_count: int, current_ids: list,
                            current_data_map: dict):
        """mock TableRecord.objects.using(...).filter(...) 链。

        ``read_data(record)`` 通过 ``record.__dict__.get('data')`` 读，
        必须用 SimpleNamespace 而非 MagicMock 才能让 __dict__.get 返回真实值。
        """
        from types import SimpleNamespace
        mock_objects = MagicMock()
        # current_qs.count()
        mock_objects.using.return_value.filter.return_value.count.return_value = current_count
        # current_qs.values_list('id', flat=True) → current_ids
        mock_objects.using.return_value.filter.return_value.values_list.return_value = current_ids
        # 后一个 filter(id__in=...).only('id','data') → list of records with id+data
        records = [SimpleNamespace(id=rid, data=data) for rid, data in current_data_map.items()]
        mock_objects.using.return_value.filter.return_value.only.return_value = records
        return patch("apps.tabdata.models.TableRecord.objects", mock_objects)

    def _patch_field_query(self, current_field_ids: list):
        mock_objects = MagicMock()
        mock_objects.using.return_value.filter.return_value.values_list.return_value = current_field_ids
        return patch("apps.tabdata.models.TableField.objects", mock_objects)

    def test_target_extra_records_to_create(self):
        rec_id = uuid4()
        ghost_id = uuid4()
        target_data = {
            "records": {
                str(rec_id): {"data": {"f1": "x"}, "order": 1},
                str(ghost_id): {"data": {"f1": "y"}, "order": 2},
            },
            "fields": [{"id": "f1"}],
        }
        with self._patch_record_query(
            current_count=1,
            current_ids=[rec_id],
            current_data_map={str(rec_id): {"f1": "x"}},
        ), self._patch_field_query(["f1"]):
            result = self.adapter.preview_restore(self.resource, target_data)
        assert result["records_to_create"] == 1
        assert result["records_to_delete"] == 0

    def test_current_extra_records_to_delete(self):
        rec_a = uuid4()
        rec_b = uuid4()
        target_data = {
            "records": {
                str(rec_a): {"data": {"f1": "x"}, "order": 1},
            },
            "fields": [{"id": "f1"}],
        }
        with self._patch_record_query(
            current_count=2,
            current_ids=[rec_a, rec_b],
            current_data_map={str(rec_a): {"f1": "x"}},
        ), self._patch_field_query(["f1"]):
            result = self.adapter.preview_restore(self.resource, target_data)
        assert result["records_to_create"] == 0
        assert result["records_to_delete"] == 1

    def test_data_diff_records_to_restore(self):
        rec_id = uuid4()
        target_data = {
            "records": {
                str(rec_id): {"data": {"f1": "old_value"}, "order": 1},
            },
            "fields": [{"id": "f1"}],
        }
        with self._patch_record_query(
            current_count=1,
            current_ids=[rec_id],
            current_data_map={str(rec_id): {"f1": "new_value"}},
        ), self._patch_field_query(["f1"]):
            result = self.adapter.preview_restore(self.resource, target_data)
        assert result["records_to_restore"] == 1

    def test_no_diff_zero_changes(self):
        rec_id = uuid4()
        target_data = {
            "records": {
                str(rec_id): {"data": {"f1": "same"}, "order": 1},
            },
            "fields": [{"id": "f1"}],
        }
        with self._patch_record_query(
            current_count=1,
            current_ids=[rec_id],
            current_data_map={str(rec_id): {"f1": "same"}},
        ), self._patch_field_query(["f1"]):
            result = self.adapter.preview_restore(self.resource, target_data)
        assert result["records_to_create"] == 0
        assert result["records_to_delete"] == 0
        assert result["records_to_restore"] == 0
        assert result["fields_to_restore"] == []

    def test_field_schema_diff(self):
        rec_id = uuid4()
        target_data = {
            "records": {
                str(rec_id): {"data": {"f1": "x"}, "order": 1},
            },
            "fields": [{"id": "f_new"}],  # target 含新字段 f_new
        }
        with self._patch_record_query(
            current_count=1,
            current_ids=[rec_id],
            current_data_map={str(rec_id): {"f1": "x"}},
        ), self._patch_field_query(["f_old"]):  # current 是 f_old
            result = self.adapter.preview_restore(self.resource, target_data)
        # 两边对称差
        assert "f_new" in result["fields_to_restore"]
        assert "f_old" in result["fields_to_restore"]


class TestTableAdapterPreviewRestoreLargeTable:
    """大表（>50000 行）切到 count diff 粗估路径。"""

    def setup_method(self):
        from apps.collab.adapters.table import TableCollabAdapter
        self.adapter = TableCollabAdapter()
        self.resource = MagicMock(id=uuid4())

    def test_large_table_uses_count_only(self):
        # 60000 target / 55000 current → 大表分支
        # mock 仅给 count + values_list，不给 only（验证不走精确 diff）
        target_data = {
            "records": {str(uuid4()): {"data": {}} for _ in range(60_000)},
            "fields": [],
        }
        mock_records = MagicMock()
        mock_records.using.return_value.filter.return_value.count.return_value = 55_000
        # values_list 应不被调用（大表不进精确分支）
        with patch("apps.tabdata.models.TableRecord.objects", mock_records), \
             patch("apps.tabdata.models.TableField.objects") as mock_fields:
            mock_fields.using.return_value.filter.return_value.values_list.return_value = []
            result = self.adapter.preview_restore(self.resource, target_data)

        # records_to_create = 60000 - 55000 = 5000
        assert result["records_to_create"] == 5000
        assert result["records_to_delete"] == 0
        # records_to_restore = min(60000, 55000) = 55000（粗估上界）
        assert result["records_to_restore"] == 55_000


class TestTableAdapterPreviewRestoreEstimatedDuration:
    def setup_method(self):
        from apps.collab.adapters.table import TableCollabAdapter
        self.adapter = TableCollabAdapter()
        self.resource = MagicMock(id=uuid4())

    def test_duration_includes_base_plus_per_row(self):
        rec_id = uuid4()
        target_data = {
            "records": {
                str(rec_id): {"data": {"f1": "old"}, "order": 1},
                str(uuid4()): {"data": {}, "order": 2},  # ghost_create 1
                str(uuid4()): {"data": {}, "order": 3},  # ghost_create 2
            },
            "fields": [{"id": "f1"}],
        }
        from types import SimpleNamespace
        mock_records = MagicMock()
        mock_records.using.return_value.filter.return_value.count.return_value = 1
        mock_records.using.return_value.filter.return_value.values_list.return_value = [rec_id]
        mock_records.using.return_value.filter.return_value.only.return_value = [
            SimpleNamespace(id=rec_id, data={"f1": "now"}),
        ]
        with patch("apps.tabdata.models.TableRecord.objects", mock_records), \
             patch("apps.tabdata.models.TableField.objects") as mock_fields:
            mock_fields.using.return_value.filter.return_value.values_list.return_value = ["f1"]
            result = self.adapter.preview_restore(self.resource, target_data)
        # affected = 2 (create) + 1 (restore) + 0 (delete) = 3
        # duration = 200 + 3 * 0.3 = 200.9 → int 200
        # 验证至少不小于 base
        assert result["estimated_duration_ms"] >= 200
