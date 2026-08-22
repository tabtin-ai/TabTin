"""
Link 字段模块端到端回归测试。

覆盖链路：
1. 基础创建：ManyMany 双向/OneWay 单向、lookupFieldId 自动回退
2. Cell 写入：ManyMany / ManyOne / OneOne / OneMany 各类基数行为
3. 对称字段同步：双向关联的 LinkRecord 与 JSONB 双向一致性
4. Title 传播：目标记录主字段/lookupFieldId 变化后 link cell title 更新
5. 关系类型变更：ManyMany → ManyOne 截断、ManyOne → ManyMany 扩展
6. 单向/双向切换：isOneWay 切换后对称字段创建/删除
7. 目标表变更：foreignTableId 变更的全量数据迁移
8. 基数约束校验：ManyOne/OneOne/OneMany 超限 / 占用冲突
9. 记录删除级联：源/目标记录删除后 LinkRecord 清理与 JSONB 修正
10. Linkable-records 查询：搜索、分页、only_selected、OneMany 占用过滤

运行方式：
    cd apps/tabtin_django
    DJANGO_SETTINGS_MODULE=tabtin.settings_lookup_e2e_test \
      python manage.py test apps.tabdata.tests.test_link_field_e2e -v 2
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional
from unittest.mock import MagicMock, patch
from uuid import UUID

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase

from apps.tabtinspace.models import Organization, Project
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabdata.services.record_service import RecordService
from apps.tabdata.services.table_service import TableService

User = get_user_model()

_NATIVE_IO_PATCH = patch(
    "apps.tabdata.services.record_service.RecordService._native_get_io",
    return_value=MagicMock(name="native_io"),
)
_NATIVE_ADAPTER_IO_PATCH = patch(
    "apps.tabdata.infrastructure.native_io_adapter.NativeRecordIOAdapter._ensure_io",
    return_value=MagicMock(name="native_io"),
)
_NATIVE_UPDATE_PATCH = patch(
    "apps.tabdata.services.record_service.RecordService._native_update_record",
    return_value=None,
)
_NATIVE_DELETE_PATCH = patch(
    "apps.tabdata.services.record_service.RecordService._native_delete_record",
    return_value=None,
)
_NATIVE_SYNC_PATCH = patch(
    "apps.tabdata.services.link_field_service.LinkFieldService._sync_native_cells",
    return_value=None,
)
_DDL_ADD_COLUMN_PATCH = patch(
    "apps.tabdata.native.ddl_manager.DDLManager.add_column",
    return_value=None,
)
_INVALIDATE_RESOLVER_PATCH = patch(
    "apps.tabdata.native.name_resolver.invalidate_resolver",
    return_value=None,
)
_RECORD_QUOTA_PATCH = patch(
    "apps.tabdata.services.record_service.QuotaService",
    MagicMock(return_value=MagicMock(check_quota=MagicMock())),
)


class LinkFieldE2ETest(TransactionTestCase):
    """Link 字段端到端测试"""

    databases = ["default", "postgresql"]

    # ──────────────────────────────────────
    # Fixture helpers
    # ──────────────────────────────────────

    def setUp(self):
        # 全局 mock native 层操作（DDL/IO/sync），只测试纯逻辑
        self._patches = [
            _NATIVE_IO_PATCH,
            _NATIVE_ADAPTER_IO_PATCH,
            _NATIVE_UPDATE_PATCH,
            _NATIVE_DELETE_PATCH,
            _NATIVE_SYNC_PATCH,
            _DDL_ADD_COLUMN_PATCH,
            _INVALIDATE_RESOLVER_PATCH,
            _RECORD_QUOTA_PATCH,
        ]
        for p in self._patches:
            p.start()

        self.user = User.objects.db_manager("default").create_user(
            username="link-e2e-user",
            email="link-e2e@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="LinkE2EOrganization",
            owner=self.user,
        )
        #  后 Table.space_id 仍为兼容列，但宿主必须使用 Project / Workspace。
        self.project = Project.objects.create(
            organization=self.organization,
            name="LinkE2EProject",
        )

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()

    def _create_table(self, name: str) -> Table:
        table = Table.objects.create(
            name=name,
            space_id=self.project.id,
            organization_id=self.organization.id,
            owner_id=str(self.user.id),
        )
        return table

    def _create_table_with_primary(self, name: str) -> Dict[str, Any]:
        table = self._create_table(name)
        primary = TableField.objects.create(
            table=table,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        return {"table": table, "primary": primary}

    def _create_field(
        self,
        *,
        table_id,
        name: str,
        field_type: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> TableField:
        field = TableService(user=self.user).create_field(
            table_id=table_id,
            name=name,
            field_type=field_type,
            options=options or {},
        )
        self.assertIsNotNone(field, f"{field_type} 字段创建失败")
        return field

    def _create_record(
        self, table: Table, data: Dict[str, Any]
    ) -> TableRecord:
        record = TableRecord.objects.create(
            table=table,
            data=data,
            created_by_id=self.user.id,
            updated_by_id=self.user.id,
            order=TableRecord.objects.filter(table=table).count() + 1,
        )
        return record

    def _update_record(self, record_id, data: Dict[str, Any]) -> TableRecord:
        service = RecordService(user=self.user)
        result = service.update_record(record_id=record_id, data=data)
        self.assertIsNotNone(result, "更新记录失败：返回 None（权限或记录不存在）")
        record, error = result
        self.assertIsNone(error, f"更新记录失败：{error}")
        return record

    def _delete_record(self, record_id) -> bool:
        service = RecordService(user=self.user)
        return service.delete_record(record_id=record_id)

    def _refresh(self, obj):
        obj.refresh_from_db()
        return obj

    def _get_cell(self, record: TableRecord, field_id) -> Any:
        """获取记录中指定字段的值"""
        record.refresh_from_db()
        return (record.data or {}).get(str(field_id))

    def _link_count(self, field_id) -> int:
        return LinkRecord.objects.filter(link_field_id=field_id).count()

    # ──────────────────────────────────────
    # 通用 fixture: 创建源表+目标表+字段+记录
    # ──────────────────────────────────────

    def _setup_two_table_fixture(self) -> Dict[str, Any]:
        source = self._create_table_with_primary("Source")
        target = self._create_table_with_primary("Target")

        target_label = TableField.objects.create(
            table=target["table"],
            name="Label",
            field_type="text",
            order=1,
        )
        target_code = TableField.objects.create(
            table=target["table"],
            name="Code",
            field_type="text",
            order=2,
        )

        src_rec = self._create_record(
            source["table"],
            {str(source["primary"].id): "src-1"},
        )
        tgt_a = self._create_record(
            target["table"],
            {
                str(target["primary"].id): "Target-A",
                str(target_label.id): "Label-A",
                str(target_code.id): "A001",
            },
        )
        tgt_b = self._create_record(
            target["table"],
            {
                str(target["primary"].id): "Target-B",
                str(target_label.id): "Label-B",
                str(target_code.id): "B001",
            },
        )
        tgt_c = self._create_record(
            target["table"],
            {
                str(target["primary"].id): "Target-C",
                str(target_label.id): "Label-C",
                str(target_code.id): "C001",
            },
        )

        return {
            "source_table": source["table"],
            "source_primary": source["primary"],
            "target_table": target["table"],
            "target_primary": target["primary"],
            "target_label": target_label,
            "target_code": target_code,
            "src_rec": src_rec,
            "tgt_a": tgt_a,
            "tgt_b": tgt_b,
            "tgt_c": tgt_c,
        }

    # ══════════════════════════════════════
    # 1. 基础创建
    # ══════════════════════════════════════

    def test_create_link_field_bidirectional_with_label_fallback(self):
        """双向 ManyMany link 字段自动回退 lookupFieldId 到 Label 字段"""
        f = self._setup_two_table_fixture()

        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )

        config = link.config or {}
        self.assertEqual(
            config.get("lookupFieldId"),
            str(f["target_label"].id),
            "lookupFieldId 应自动回退到 Label 字段",
        )
        self.assertFalse(config.get("isOneWay", True))
        self.assertIsNotNone(
            config.get("symmetricFieldId"),
            "双向模式应创建对称字段",
        )

        sym_field = TableField.objects.get(
            id=config["symmetricFieldId"], is_deleted=False
        )
        self.assertEqual(sym_field.field_type, "link")
        self.assertEqual(sym_field.table_id, f["target_table"].id)

        sym_config = sym_field.config or {}
        self.assertEqual(sym_config["relationship"], "ManyMany")
        self.assertEqual(sym_config["foreignTableId"], str(f["source_table"].id))
        self.assertEqual(sym_config["symmetricFieldId"], str(link.id))

    def test_create_link_field_oneway(self):
        """单向 link 字段不创建对称字段"""
        f = self._setup_two_table_fixture()

        link = self._create_field(
            table_id=f["source_table"].id,
            name="OneWayRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )
        config = link.config or {}
        self.assertTrue(config.get("isOneWay"))
        self.assertIsNone(config.get("symmetricFieldId"))

    def test_create_link_field_no_label_falls_back_to_primary(self):
        """目标表没有 Label 字段时，lookupFieldId 回退到主字段"""
        source = self._create_table_with_primary("Src-NoLabel")
        target = self._create_table_with_primary("Tgt-NoLabel")

        link = self._create_field(
            table_id=source["table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(target["table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )
        config = link.config or {}
        self.assertEqual(
            config.get("lookupFieldId"),
            str(target["primary"].id),
            "无 Label 字段时应回退到主字段",
        )

    def test_create_link_field_invalid_foreign_table(self):
        """foreignTableId 不存在时创建失败"""
        source = self._create_table_with_primary("Src-BadRef")

        with self.assertRaises(Exception):
            self._create_field(
                table_id=source["table"].id,
                name="BadRel",
                field_type="link",
                options={
                    "foreignTableId": "00000000-0000-0000-0000-000000000000",
                    "relationship": "ManyMany",
                    "isOneWay": True,
                },
            )

    # ══════════════════════════════════════
    # 2. Cell 写入 & 对称同步 (ManyMany)
    # ══════════════════════════════════════

    def test_set_link_cell_many_many_creates_link_records_and_sync(self):
        """ManyMany 写入：创建 LinkRecord + 对称 LinkRecord + JSONB 缓存"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )

        self.assertEqual(self._link_count(link.id), 2)
        self.assertEqual(self._link_count(sym_id), 2)

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsInstance(cell, list)
        self.assertEqual(len(cell), 2)
        cell_ids = {item["id"] for item in cell}
        self.assertEqual(cell_ids, {str(f["tgt_a"].id), str(f["tgt_b"].id)})

        sym_cell_a = self._get_cell(f["tgt_a"], sym_id)
        self.assertIsInstance(sym_cell_a, list)
        self.assertEqual(len(sym_cell_a), 1)
        self.assertEqual(sym_cell_a[0]["id"], str(f["src_rec"].id))

    def test_bulk_create_many_one_link_syncs_title_and_reverse_cell(self):
        """bulk-create 的 link 必须与单条创建一样完整建立双向关联。"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Owner",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": False,
            },
        )
        symmetric_field_id = link.config["symmetricFieldId"]

        records, errors = RecordService(user=self.user).bulk_create_records(
            table_id=f["source_table"].id,
            records_data=[{
                str(f["source_primary"].id): "bulk-created-source",
                str(link.id): [{"id": str(f["tgt_a"].id)}],
            }],
        )

        self.assertEqual(errors, [])
        self.assertEqual(len(records), 1)
        created = records[0]
        created.refresh_from_db()
        f["tgt_a"].refresh_from_db()

        source_cell = (created.data or {}).get(str(link.id))
        self.assertEqual(source_cell, {
            "id": str(f["tgt_a"].id),
            "title": "Label-A",
        })
        self.assertEqual(self._link_count(link.id), 1)

        reverse_cell = (f["tgt_a"].data or {}).get(str(symmetric_field_id))
        self.assertEqual(reverse_cell, [{
            "id": str(created.id),
            "title": "bulk-created-source",
        }])
        self.assertEqual(self._link_count(symmetric_field_id), 1)

    def test_set_link_cell_clear(self):
        """清空 link cell 时删除所有 LinkRecord"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 1)

        self._update_record(f["src_rec"].id, {str(link.id): []})
        self.assertEqual(self._link_count(link.id), 0)
        cell = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(cell, [])

    def test_set_link_cell_duplicate_ids_raises(self):
        """同一 cell 内重复 ID 应报错"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        with self.assertRaises(Exception) as ctx:
            LinkFieldService.set_link_cell(
                link,
                f["src_rec"],
                [str(f["tgt_a"].id), str(f["tgt_a"].id)],
            )
        self.assertIn("重复", str(ctx.exception))

    def test_set_link_cell_nonexistent_target_raises(self):
        """关联不存在的记录应报错"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        with self.assertRaises(ValueError) as ctx:
            LinkFieldService.set_link_cell(
                link,
                f["src_rec"],
                ["00000000-0000-0000-0000-000000000000"],
            )
        self.assertIn("不存在", str(ctx.exception))

    # ══════════════════════════════════════
    # 3. ManyOne / OneOne 基数约束
    # ══════════════════════════════════════

    def test_many_one_single_value_cell(self):
        """ManyOne 关系 cell value 为单值对象"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="ManyOneRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsInstance(cell, dict, "ManyOne cell 应为单值对象")
        self.assertEqual(cell["id"], str(f["tgt_a"].id))

    def test_many_one_rejects_multi_value(self):
        """ManyOne 不接受多值写入"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="ManyOneRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        with self.assertRaises(ValueError) as ctx:
            LinkFieldService.set_link_cell(
                link,
                f["src_rec"],
                [str(f["tgt_a"].id), str(f["tgt_b"].id)],
            )
        self.assertIn("最多关联 1 条记录", str(ctx.exception))

    def test_one_one_rejects_occupied_target(self):
        """OneOne 不允许目标记录被多个源记录关联"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="OneOneRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "OneOne",
                "isOneWay": True,
            },
        )

        src_rec_2 = self._create_record(
            f["source_table"],
            {str(f["source_primary"].id): "src-2"},
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        with self.assertRaises(ValueError) as ctx:
            LinkFieldService.set_link_cell(
                link,
                src_rec_2,
                [str(f["tgt_a"].id)],
            )
        self.assertIn("已被其他记录关联", str(ctx.exception))

    def test_one_many_rejects_occupied_target(self):
        """OneMany 不允许目标记录被多个源记录关联"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="OneManyRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )

        src_rec_2 = self._create_record(
            f["source_table"],
            {str(f["source_primary"].id): "src-2"},
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        with self.assertRaises(ValueError) as ctx:
            LinkFieldService.set_link_cell(
                link,
                src_rec_2,
                [str(f["tgt_a"].id)],
            )
        self.assertIn("已被其他记录关联", str(ctx.exception))

    # ══════════════════════════════════════
    # 4. Title 传播
    # ══════════════════════════════════════

    def test_title_propagation_on_lookup_field_change(self):
        """目标记录的 lookupFieldId 字段变化后 link cell title 更新"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
                "lookupFieldId": str(f["target_label"].id),
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )

        cell_before = self._get_cell(f["src_rec"], link.id)
        titles_before = {item["id"]: item["title"] for item in cell_before}
        self.assertEqual(titles_before[str(f["tgt_a"].id)], "Label-A")

        self._update_record(
            f["tgt_a"].id,
            {str(f["target_label"].id): "Label-A-Updated"},
        )

        cell_after = self._get_cell(f["src_rec"], link.id)
        titles_after = {item["id"]: item["title"] for item in cell_after}
        self.assertEqual(
            titles_after[str(f["tgt_a"].id)],
            "Label-A-Updated",
            "Title 应随 lookupFieldId 字段值变化更新",
        )
        self.assertEqual(titles_after[str(f["tgt_b"].id)], "Label-B")

    def test_title_propagation_bidirectional(self):
        """双向模式下源记录主字段变化也更新对称侧 title"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="BiRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        sym_cell = self._get_cell(f["tgt_a"], sym_id)
        self.assertEqual(sym_cell[0]["title"], "src-1")

        self._update_record(
            f["src_rec"].id,
            {str(f["source_primary"].id): "src-1-renamed"},
        )

        sym_cell_after = self._get_cell(f["tgt_a"], sym_id)
        self.assertEqual(
            sym_cell_after[0]["title"],
            "src-1-renamed",
            "对称侧 title 应随源记录主字段变化更新",
        )

    # ══════════════════════════════════════
    # 5. 关系类型变更
    # ══════════════════════════════════════

    def test_relationship_change_many_many_to_many_one_truncates(self):
        """ManyMany → ManyOne 截断为每条记录只保留 1 条关联"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 2)

        link.refresh_from_db()
        new_config = dict(link.config)
        new_config["relationship"] = "ManyOne"

        LinkFieldService.update_link_field(link, link.config, new_config)
        link.config = new_config
        link.save(update_fields=["config"])

        self.assertEqual(
            self._link_count(link.id), 1, "ManyMany→ManyOne 应截断为 1 条"
        )

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsInstance(cell, dict, "ManyOne cell 应为单值")

    def test_relationship_change_many_one_to_many_many_expands(self):
        """ManyOne → ManyMany：扩展为多值"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["relationship"] = "ManyMany"

        LinkFieldService.update_link_field(link, old_config, new_config)
        link.config = new_config
        link.save(update_fields=["config"])

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsInstance(cell, list, "ManyMany cell 应为列表")
        self.assertEqual(len(cell), 1)

    # ══════════════════════════════════════
    # 6. lookupFieldId 切换 → title 重建
    # ══════════════════════════════════════

    def test_switch_lookup_field_id_rebuilds_titles(self):
        """切换 lookupFieldId 后所有 cell title 按新字段重建"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
                "lookupFieldId": str(f["target_label"].id),
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(cell[0]["title"], "Label-A")

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["lookupFieldId"] = str(f["target_code"].id)

        LinkFieldService.update_link_field(link, old_config, new_config)
        link.config = new_config
        link.save(update_fields=["config"])

        cell_after = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(
            cell_after[0]["title"],
            "A001",
            "切换 lookupFieldId 后 title 应按 Code 字段重建",
        )

    # ══════════════════════════════════════
    # 7. 单向/双向切换
    # ══════════════════════════════════════

    def test_toggle_bidirectional_to_oneway_deletes_symmetric(self):
        """双向→单向：对称字段被删除"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="BiRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]
        self.assertTrue(
            TableField.objects.filter(id=sym_id, is_deleted=False).exists()
        )

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["isOneWay"] = True

        LinkFieldService.update_link_field(link, old_config, new_config)

        self.assertTrue(
            TableField.objects.filter(id=sym_id, is_deleted=True).exists(),
            "对称字段应被软删除",
        )

    def test_toggle_oneway_to_bidirectional_creates_symmetric_and_syncs(self):
        """单向→双向：创建对称字段并同步已有 LinkRecord"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="OneWayRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )
        self.assertIsNone(link.config.get("symmetricFieldId"))

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 1)

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["isOneWay"] = False

        LinkFieldService.update_link_field(link, old_config, new_config)

        link.refresh_from_db()
        sym_id = link.config.get("symmetricFieldId")
        self.assertIsNotNone(sym_id, "应创建新的对称字段")

        sym_link_count = LinkRecord.objects.filter(link_field_id=sym_id).count()
        self.assertEqual(
            sym_link_count, 1, "已有 LinkRecord 应同步到对称字段"
        )

    # ══════════════════════════════════════
    # 8. 目标表变更
    # ══════════════════════════════════════

    def test_foreign_table_change_clears_data_and_creates_new_symmetric(self):
        """foreignTableId 变更后清理旧数据、创建新对称字段"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        old_sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 1)

        new_target = self._create_table_with_primary("NewTarget")

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["foreignTableId"] = str(new_target["table"].id)

        LinkFieldService.update_link_field(link, old_config, new_config)

        self.assertEqual(
            self._link_count(link.id), 0, "旧 LinkRecord 应被清理"
        )
        src_data = self._refresh(f["src_rec"]).data or {}
        self.assertNotIn(str(link.id), src_data, "dashed cell 应被清空")
        self.assertNotIn(link.id.hex, src_data, "hex cell 应被清空")

        self.assertTrue(
            TableField.objects.filter(id=old_sym_id, is_deleted=True).exists(),
            "旧对称字段应被删除",
        )

        link.refresh_from_db()
        new_sym_id = link.config.get("symmetricFieldId")
        if new_sym_id:
            self.assertNotEqual(new_sym_id, old_sym_id)
            self.assertTrue(
                TableField.objects.filter(id=new_sym_id, is_deleted=False).exists()
            )

    def test_foreign_table_change_clears_collab_hex_keyed_cells(self):
        """#6601: 协作落库的 hex key cell 在切换关联表后也必须清空。"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="RelHex",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 1)

        # 模拟 collab persist：只保留 hex key，删掉 dashed（ 约定）
        src = self._refresh(f["src_rec"])
        data = dict(src.data or {})
        dashed = str(link.id)
        hex_key = link.id.hex
        cell = data.pop(dashed, data.pop(hex_key, None))
        self.assertIsNotNone(cell, "预置关联 cell 应存在")
        data[hex_key] = cell
        src.__dict__["data"] = data
        src.save(update_fields=["data"])
        src.refresh_from_db()
        self.assertIn(hex_key, src.data or {})
        self.assertNotIn(dashed, src.data or {})

        new_target = self._create_table_with_primary("NewTargetHex")
        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["foreignTableId"] = str(new_target["table"].id)

        with patch(
            "apps.tabdata.services.collab_service.CollabService.push_cells",
        ) as mock_push:
            LinkFieldService.update_link_field(link, old_config, new_config)

        self.assertEqual(self._link_count(link.id), 0)
        cleared = self._refresh(f["src_rec"]).data or {}
        self.assertNotIn(hex_key, cleared, "hex key 残留即  复现")
        self.assertNotIn(dashed, cleared)

        # 当前会话 UI 依赖显式 null push（缺 key 不会驱动 Y.Doc clear）
        null_pushes = [
            change
            for call in mock_push.call_args_list
            for change in call.kwargs.get("changes", call.args[1] if len(call.args) > 1 else [])
            if change.get("field_id_hex") == hex_key and change.get("value") is None
        ]
        self.assertTrue(null_pushes, "应向 Y.js 推送该字段的 null clear")

    # ══════════════════════════════════════
    # 9. 记录删除级联
    # ══════════════════════════════════════

    def test_delete_source_record_cleans_link_and_updates_symmetric(self):
        """删除源记录后清理 LinkRecord + 更新对称侧 JSONB"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 2)
        self.assertEqual(self._link_count(sym_id), 2)

        self._delete_record(f["src_rec"].id)

        self.assertEqual(
            self._link_count(link.id), 0, "源记录删除后主侧 LinkRecord 清理"
        )
        self.assertEqual(
            self._link_count(sym_id), 0, "源记录删除后对称侧 LinkRecord 清理"
        )

        sym_cell_a = self._get_cell(f["tgt_a"], sym_id)
        self.assertEqual(
            sym_cell_a, [], "对称侧 cell 应更新为空"
        )

    def test_delete_target_record_cleans_link_and_updates_source(self):
        """删除目标记录后清理 LinkRecord + 更新源侧 JSONB"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 2)

        self._delete_record(f["tgt_a"].id)

        self.assertEqual(
            self._link_count(link.id),
            1,
            "目标记录删除后对应 LinkRecord 清理",
        )

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsInstance(cell, list)
        self.assertEqual(len(cell), 1)
        self.assertEqual(cell[0]["id"], str(f["tgt_b"].id))

    # ══════════════════════════════════════
    # 11. Linkable-records 查询
    # ══════════════════════════════════════

    def test_linkable_records_basic_search(self):
        """linkable-records 基础搜索与分页"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
                "lookupFieldId": str(f["target_label"].id),
            },
        )

        records, total = LinkFieldService.get_linkable_records(
            link, search="Label-A", page=1, page_size=10
        )
        self.assertGreaterEqual(total, 1)
        found_ids = {r["id"] for r in records}
        self.assertIn(str(f["tgt_a"].id), found_ids)

    def test_linkable_records_only_selected_preserves_order(self):
        """linkable-records only_selected 保持 selected_record_ids 顺序"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        selected_ids = [str(f["tgt_b"].id), str(f["tgt_a"].id)]
        records, total = LinkFieldService.get_linkable_records(
            link,
            selected_record_ids=selected_ids,
            only_selected=True,
            page=1,
            page_size=10,
        )
        result_ids = [r["id"] for r in records]
        self.assertEqual(
            result_ids,
            selected_ids,
            "only_selected 模式应保持输入顺序",
        )

    def test_linkable_records_excludes_selected_in_candidate_mode(self):
        """候选模式下排除 selected_record_ids"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        records, total = LinkFieldService.get_linkable_records(
            link,
            selected_record_ids=[str(f["tgt_a"].id), str(f["tgt_b"].id)],
            page=1,
            page_size=10,
        )
        result_ids = {r["id"] for r in records}
        self.assertNotIn(str(f["tgt_a"].id), result_ids)
        self.assertNotIn(str(f["tgt_b"].id), result_ids)

    def test_linkable_records_one_many_excludes_occupied_targets(self):
        """OneMany 模式下 linkable-records 排除已被占用的目标记录"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="OneManyRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "OneMany",
                "isOneWay": True,
            },
        )

        src_rec_2 = self._create_record(
            f["source_table"],
            {str(f["source_primary"].id): "src-2"},
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        records, total = LinkFieldService.get_linkable_records(
            link,
            exclude_record_id=str(src_rec_2.id),
            page=1,
            page_size=20,
        )
        result_ids = {r["id"] for r in records}
        self.assertNotIn(
            str(f["tgt_a"].id),
            result_ids,
            "已被占用的目标记录应被过滤",
        )
        self.assertIn(str(f["tgt_b"].id), result_ids)

    # ══════════════════════════════════════
    # 12. 多记录关联与部分更新
    # ══════════════════════════════════════

    def test_partial_update_link_cell_adds_and_removes(self):
        """部分更新：从 [A, B] 变为 [B, C]"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 2)

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_b"].id), str(f["tgt_c"].id)]},
        )

        self.assertEqual(self._link_count(link.id), 2)

        cell = self._get_cell(f["src_rec"], link.id)
        cell_ids = [item["id"] for item in cell]
        self.assertEqual(
            cell_ids,
            [str(f["tgt_b"].id), str(f["tgt_c"].id)],
            "cell 应反映部分更新后的内容和顺序",
        )

    def test_link_cell_order_preserved(self):
        """关联顺序保持输入顺序"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_c"].id), str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )

        cell = self._get_cell(f["src_rec"], link.id)
        cell_ids = [item["id"] for item in cell]
        self.assertEqual(
            cell_ids,
            [str(f["tgt_c"].id), str(f["tgt_a"].id), str(f["tgt_b"].id)],
            "关联顺序应与输入一致",
        )

    # ══════════════════════════════════════
    # 13. 双向关系的对称截断
    # ══════════════════════════════════════

    def test_relationship_change_bidirectional_truncates_both_sides(self):
        """双向 ManyMany → OneOne：双侧都截断"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="BiRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id), str(f["tgt_b"].id)]},
        )
        self.assertEqual(self._link_count(link.id), 2)
        self.assertEqual(self._link_count(sym_id), 2)

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["relationship"] = "OneOne"

        LinkFieldService.update_link_field(link, old_config, new_config)
        link.config = new_config
        link.save(update_fields=["config"])

        self.assertEqual(
            self._link_count(link.id), 1, "主侧截断为 1"
        )

    # ══════════════════════════════════════
    # 14. 自关联（同表关联）
    # ══════════════════════════════════════

    def test_self_referencing_link(self):
        """同表自关联（源表 == 目标表）"""
        source = self._create_table_with_primary("SelfRef")

        rec_a = self._create_record(
            source["table"],
            {str(source["primary"].id): "A"},
        )
        rec_b = self._create_record(
            source["table"],
            {str(source["primary"].id): "B"},
        )

        link = self._create_field(
            table_id=source["table"].id,
            name="Parent",
            field_type="link",
            options={
                "foreignTableId": str(source["table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )

        self._update_record(
            rec_a.id,
            {str(link.id): [str(rec_b.id)]},
        )

        cell = self._get_cell(rec_a, link.id)
        self.assertIsInstance(cell, list)
        self.assertEqual(len(cell), 1)
        self.assertEqual(cell[0]["id"], str(rec_b.id))

    # ══════════════════════════════════════
    # 16. 多源记录共享目标记录
    # ══════════════════════════════════════

    def test_multiple_sources_sharing_target_many_many(self):
        """ManyMany 多个源记录可关联同一目标记录"""
        f = self._setup_two_table_fixture()

        src_2 = self._create_record(
            f["source_table"],
            {str(f["source_primary"].id): "src-2"},
        )

        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        sym_id = link.config["symmetricFieldId"]

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self._update_record(
            src_2.id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )

        self.assertEqual(self._link_count(link.id), 2)

        sym_cell_a = self._get_cell(f["tgt_a"], sym_id)
        self.assertEqual(
            len(sym_cell_a), 2,
            "ManyMany 目标记录的对称 cell 应含 2 个源引用",
        )

    # ══════════════════════════════════════
    # 17. 边界情况
    # ══════════════════════════════════════

    def test_set_link_cell_with_empty_list_on_empty_record(self):
        """空记录设置空关联不报错"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyMany",
                "isOneWay": True,
            },
        )
        self._update_record(f["src_rec"].id, {str(link.id): []})
        cell = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(cell, [])

    def test_many_one_replace_value(self):
        """ManyOne 替换关联目标"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="ManyOneRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        cell = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(cell["id"], str(f["tgt_a"].id))

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_b"].id)]},
        )
        cell = self._get_cell(f["src_rec"], link.id)
        self.assertEqual(
            cell["id"], str(f["tgt_b"].id),
            "ManyOne 替换后应指向新目标",
        )
        self.assertEqual(self._link_count(link.id), 1)

    def test_many_one_clear_to_null(self):
        """ManyOne 清空关联后 cell 为 null"""
        f = self._setup_two_table_fixture()
        link = self._create_field(
            table_id=f["source_table"].id,
            name="ManyOneRel",
            field_type="link",
            options={
                "foreignTableId": str(f["target_table"].id),
                "relationship": "ManyOne",
                "isOneWay": True,
            },
        )

        self._update_record(
            f["src_rec"].id,
            {str(link.id): [str(f["tgt_a"].id)]},
        )
        self._update_record(
            f["src_rec"].id,
            {str(link.id): []},
        )

        cell = self._get_cell(f["src_rec"], link.id)
        self.assertIsNone(cell, "ManyOne 清空后 cell 应为 None")
