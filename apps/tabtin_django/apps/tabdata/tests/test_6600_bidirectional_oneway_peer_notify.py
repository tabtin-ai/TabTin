"""#6600：双向关联改单向后，对端对称字段删除须通知对端表客户端。

根因：``_cleanup_symmetric_field`` 已软删对端字段，但不递增对端
``schema_version``、不发 ``delete_field`` WS，客户端继续用旧 field map。

运行：
    cd apps/tabtin_django
    USE_SQLITE_FOR_TESTS=0 DJANGO_SETTINGS_MODULE=tabtin.settings_tabdata_test \\
      python manage.py test apps.tabdata.tests.test_6600_bidirectional_oneway_peer_notify -v 2
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import TransactionTestCase

from apps.tabdata.models import Table, TableField
from apps.tabdata.services.link_field_service import LinkFieldService
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.tests.fixtures import create_test_organization_with_agent


_NATIVE_IO_PATCH = patch(
    "apps.tabdata.services.record_service.RecordService._native_get_io",
    return_value=MagicMock(name="native_io"),
)
_NATIVE_UPDATE_PATCH = patch(
    "apps.tabdata.services.record_service.RecordService._native_update_record",
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
_DDL_DROP_COLUMN_PATCH = patch(
    "apps.tabdata.native.ddl_manager.DDLManager.drop_column",
    return_value=None,
)
_INVALIDATE_RESOLVER_PATCH = patch(
    "apps.tabdata.native.name_resolver.invalidate_resolver",
    return_value=None,
)
_TABLE_SERVICE_NATIVE_PATCH = patch.object(
    TableService,
    "_native_add_column",
    return_value=None,
)
_YDOC_SYNC_PATCH = patch.object(
    TableService,
    "_sync_table_records_to_ydoc",
    return_value=None,
)


class BidirectionalOnewayPeerNotifyTest(TransactionTestCase):
    """双向→单向：对端表必须收到 schema/WS 删除通知。"""

    databases = ["default", "postgresql"]

    def setUp(self):
        self._patches = [
            _NATIVE_IO_PATCH,
            _NATIVE_UPDATE_PATCH,
            _NATIVE_SYNC_PATCH,
            _DDL_ADD_COLUMN_PATCH,
            _DDL_DROP_COLUMN_PATCH,
            _INVALIDATE_RESOLVER_PATCH,
            _TABLE_SERVICE_NATIVE_PATCH,
            _YDOC_SYNC_PATCH,
        ]
        for p in self._patches:
            p.start()

        fixture = create_test_organization_with_agent(
            prefix="link6600",
            organization_name="Link6600Organization",
            space_name="Link6600Project",
        )
        self.user = fixture["user"]
        self.organization = fixture["organization"]
        self.space = fixture["space"]

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()

    def _create_table_with_primary(self, name: str) -> tuple[Table, TableField]:
        table = Table.objects.create(
            name=name,
            space_id=self.space.id,
            organization_id=self.organization.id,
            owner_id=str(self.user.id),
        )
        primary = TableField.objects.create(
            table=table,
            name="Name",
            field_type="text",
            is_primary=True,
            order=0,
        )
        return table, primary

    def test_toggle_bidirectional_to_oneway_notifies_peer_table(self):
        source, _ = self._create_table_with_primary("Members")
        target, _ = self._create_table_with_primary("Projects")

        link = TableService(user=self.user).create_field(
            table_id=source.id,
            name="Project",
            field_type="link",
            options={
                "foreignTableId": str(target.id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        self.assertIsNotNone(link)
        sym_id = link.config["symmetricFieldId"]
        self.assertTrue(
            TableField.objects.filter(id=sym_id, is_deleted=False).exists(),
        )

        target.refresh_from_db()
        schema_before = target.schema_version

        with patch(
            "apps.tabdata.services.link_field_service.table_event_service.publish_field_change"
        ) as mock_publish:
            updated = TableService(user=self.user).update_field(
                field_id=link.id,
                options={
                    "foreignTableId": str(target.id),
                    "relationship": "ManyMany",
                    "isOneWay": True,
                },
            )

        self.assertIsNotNone(updated)
        self.assertTrue(
            TableField.objects.filter(id=sym_id, is_deleted=True).exists(),
            "对称字段应被软删除",
        )

        target.refresh_from_db()
        self.assertGreater(
            target.schema_version,
            schema_before,
            "对端表 schema_version 必须递增，否则客户端继续用旧 field map",
        )

        peer_delete_calls = [
            c for c in mock_publish.call_args_list
            if c.kwargs.get("action") == "delete_field"
            and str(sym_id) in (c.kwargs.get("field_ids") or [])
        ]
        self.assertTrue(
            peer_delete_calls,
            f"应对对端对称字段发布 delete_field，实际调用: {mock_publish.call_args_list}",
        )
        self.assertEqual(
            str(peer_delete_calls[0].args[0]),
            str(target.id),
            "delete_field 事件应发到对端表",
        )

    def _create_bidirectional_link(self) -> tuple[Table, Table, TableField, str]:
        source, _ = self._create_table_with_primary("Src")
        target, _ = self._create_table_with_primary("Tgt")
        third, _ = self._create_table_with_primary("Third")
        self._third_table = third
        link = TableService(user=self.user).create_field(
            table_id=source.id,
            name="Rel",
            field_type="link",
            options={
                "foreignTableId": str(target.id),
                "relationship": "ManyMany",
                "isOneWay": False,
            },
        )
        self.assertIsNotNone(link)
        sym_id = link.config["symmetricFieldId"]
        return source, target, link, sym_id

    def test_delete_link_field_notifies_peer_table(self):
        """删除双向 link 字段时，对端对称字段清理也须通知对端表。"""
        _source, target, link, sym_id = self._create_bidirectional_link()
        target.refresh_from_db()
        schema_before = target.schema_version

        with patch(
            "apps.tabdata.services.link_field_service.table_event_service.publish_field_change"
        ) as mock_publish:
            ok = TableService(user=self.user).delete_field(field_id=link.id)

        self.assertTrue(ok)
        self.assertTrue(TableField.objects.filter(id=sym_id, is_deleted=True).exists())
        target.refresh_from_db()
        self.assertGreater(target.schema_version, schema_before)
        peer_delete_calls = [
            c for c in mock_publish.call_args_list
            if c.kwargs.get("action") == "delete_field"
            and str(sym_id) in (c.kwargs.get("field_ids") or [])
        ]
        self.assertTrue(peer_delete_calls)
        self.assertEqual(str(peer_delete_calls[0].args[0]), str(target.id))

    def test_foreign_table_change_notifies_old_peer_table(self):
        """换目标表时，旧对端对称字段清理须通知旧对端表。"""
        _source, old_target, link, old_sym_id = self._create_bidirectional_link()
        new_target = self._third_table
        old_target.refresh_from_db()
        schema_before = old_target.schema_version

        link.refresh_from_db()
        old_config = dict(link.config)
        new_config = dict(link.config)
        new_config["foreignTableId"] = str(new_target.id)

        with patch(
            "apps.tabdata.services.link_field_service.table_event_service.publish_field_change"
        ) as mock_publish:
            LinkFieldService.update_link_field(
                link, old_config, new_config, user=self.user,
            )

        self.assertTrue(
            TableField.objects.filter(id=old_sym_id, is_deleted=True).exists(),
        )
        old_target.refresh_from_db()
        self.assertGreater(old_target.schema_version, schema_before)
        peer_delete_calls = [
            c for c in mock_publish.call_args_list
            if c.kwargs.get("action") == "delete_field"
            and str(old_sym_id) in (c.kwargs.get("field_ids") or [])
        ]
        self.assertTrue(peer_delete_calls)
        self.assertEqual(str(peer_delete_calls[0].args[0]), str(old_target.id))
