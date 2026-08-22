"""
#6670：目标表字段改名后，源表关联标签应刷新。

覆盖：
1. 单向关联 resolve_link_closure 能从 B 走到 A（incoming 边）
2. CollabService.persist_changes 更新 B 展示字段后重建 A 的 link title
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import TestCase, TransactionTestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import LinkRecord, Table, TableField, TableRecord
from apps.tabdata.services.cascade_service import CascadeService
from apps.tabdata.services.collab_service import CollabService
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent


class ResolveLinkClosureOneWayTest(TestCase):
    """单向关联也必须注册 foreign→self，否则 B 变更找不到 A。"""

    databases = ["default"]

    def setUp(self):
        ctx = create_test_organization_with_agent(prefix="link_closure_6670")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.table_a = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="A",
            owner=self.user,
        )
        self.table_b = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="B",
            owner=self.user,
        )
        self.primary_a = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        self.primary_b = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_b,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        # 单向：无 symmetricFieldId
        self.link_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            name="Rel",
            field_type="link",
            order=1,
            config={
                "foreignTableId": str(self.table_b.id),
                "relationship": "ManyMany",
                "isOneWay": True,
                "lookupFieldId": str(self.primary_b.id),
            },
        )
        self.rec_a = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            data={str(self.primary_a.id): "a1"},
        )
        self.rec_b = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_b,
            data={str(self.primary_b.id): "123"},
        )
        LinkRecord.objects.using(TABDATA_DB_ALIAS).create(
            link_field=self.link_field,
            self_record=self.rec_a,
            foreign_record=self.rec_b,
            order=0,
        )

    def test_one_way_incoming_finds_source_records(self):
        seeds = {str(self.table_b.id): {str(self.rec_b.id)}}
        impacted = {str(self.table_a.id), str(self.table_b.id)}
        result = CascadeService.resolve_link_closure(seeds, impacted)
        self.assertIn(str(self.table_a.id), result)
        self.assertIn(str(self.rec_a.id), result[str(self.table_a.id)])


class CollabPersistLinkTitlePropagationTest(TransactionTestCase):
    """协作落库改 B 展示字段后，A 的 link cell title 必须更新。"""

    databases = ["default"]

    def setUp(self):
        ctx = create_test_organization_with_agent(prefix="link_collab_6670")
        self.user = ctx["user"]
        self.organization = ctx["organization"]
        self.space = ctx["space"]
        self.table_a = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="A-collab",
            owner=self.user,
        )
        self.table_b = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="B-collab",
            owner=self.user,
        )
        self.primary_a = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        self.primary_b = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_b,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        self.link_field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            name="Rel",
            field_type="link",
            order=1,
            config={
                "foreignTableId": str(self.table_b.id),
                "relationship": "ManyMany",
                "isOneWay": True,
                "lookupFieldId": str(self.primary_b.id),
            },
        )
        self.rec_b = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_b,
            data={str(self.primary_b.id): "123"},
        )
        self.rec_a = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table_a,
            data={
                str(self.primary_a.id): "a1",
                str(self.link_field.id): [
                    {"id": str(self.rec_b.id), "title": "123"},
                ],
            },
        )
        LinkRecord.objects.using(TABDATA_DB_ALIAS).create(
            link_field=self.link_field,
            self_record=self.rec_a,
            foreign_record=self.rec_b,
            order=0,
        )

    @patch("apps.tabdata.utils.ydoc_sync.sync_records_to_ydoc")
    @patch("apps.tabdata.services.collab_service.table_event_service.publish_table_update")
    @patch("apps.tabdata.services.collab_service.NativeRecordIO")
    @patch("apps.tabdata.services.link_field_service.LinkFieldService._sync_native_cells")
    def test_collab_persist_refreshes_link_title_on_target_rename(
        self,
        _sync_native,
        native_io_cls,
        _publish,
        mock_ydoc,
    ):
        native_io = MagicMock()
        native_io_cls.return_value = native_io

        result = CollabService.persist_changes(
            table_id=self.table_b.id,
            changed_records={
                str(self.rec_b.id): {self.primary_b.id.hex: "321"},
            },
            new_records={},
            deleted_record_ids=[],
            source="collab_persist",
            editor_type="user",
            editor_id=str(self.user.id),
        )
        self.assertEqual(result["persisted"], 1)

        self.rec_a.refresh_from_db()
        data = self.rec_a.data or {}
        cell = data.get(self.link_field.id.hex) or data.get(str(self.link_field.id))
        self.assertIsInstance(cell, list)
        self.assertEqual(len(cell), 1)
        self.assertEqual(cell[0]["id"], str(self.rec_b.id))
        self.assertEqual(
            cell[0]["title"],
            "321",
            "协作改 B 主字段后，A 关联标签 title 应同步为新值",
        )

        # 对侧 A 表应被推入 Y.Doc，协作端才能即时看到新标签
        ydoc_table_ids = {
            str(call.args[0]) for call in mock_ydoc.call_args_list if call.args
        }
        self.assertIn(str(self.table_a.id), ydoc_table_ids)
