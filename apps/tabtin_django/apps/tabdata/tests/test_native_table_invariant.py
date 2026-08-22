import uuid
from datetime import date, datetime, timezone
from unittest.mock import MagicMock, patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError, connections
from django.test import TestCase

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.models import Table, TableField, TableRecord
from apps.tabdata.models_connector import DataConnector
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.services.collab_service import CollabService
from apps.tabdata.services.connector_service import ConnectorService
from apps.tabdata.services.connectors.base import ExternalColumn
from apps.tabdata.services.table_service import TableService
from apps.tabtinspace.models import Space, Organization

User = get_user_model()


class DateColumnTypeDriftTest(TestCase):
    databases = ["default", "postgresql"]

    def test_alter_date_column_repairs_physical_type_drift(self):
        partition_id = uuid.uuid4()
        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        config = {
            "formatting": {
                "date": "YYYY/MM/DD",
                "time": "HH:mm:ss",
                "timeZone": "Asia/Shanghai",
            }
        }
        ddl = DDLManager()
        ddl.ensure_schema(partition_id)
        ddl.create_native_table(partition_id, table_id)
        ddl.add_column(partition_id, table_id, field_id, "date")
        record_id = uuid.uuid4()
        qualified = (
            f'"{ddl.schema_name(partition_id)}".'
            f'"{ddl.table_name(table_id)}"'
        )
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'INSERT INTO {qualified} ("__id", "{field_id.hex}") VALUES (%s, %s)',
                [record_id, "2026-08-09"],
            )

        changed = ddl.alter_column_type(
            partition_id,
            table_id,
            field_id,
            "date",
            "date",
            config=config,
            old_config=config,
        )

        columns = {column["name"]: column for column in ddl.list_columns(partition_id, table_id)}
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'SELECT "{field_id.hex}" FROM {qualified} WHERE "__id" = %s',
                [record_id],
            )
            stored_value = cursor.fetchone()[0]
        self.assertTrue(changed)
        self.assertEqual(columns[field_id.hex]["data_type"], "timestamp with time zone")
        self.assertEqual(stored_value, datetime(2026, 8, 8, 16, tzinfo=timezone.utc))

    def test_timestamp_to_date_uses_configured_timezone(self):
        partition_id = uuid.uuid4()
        table_id = uuid.uuid4()
        field_id = uuid.uuid4()
        time_config = {
            "formatting": {
                "date": "YYYY/MM/DD",
                "time": "HH:mm:ss",
                "timeZone": "Asia/Shanghai",
            }
        }
        date_config = {
            "formatting": {
                "date": "YYYY/MM/DD",
                "time": "None",
                "timeZone": "Asia/Shanghai",
            }
        }
        ddl = DDLManager()
        ddl.ensure_schema(partition_id)
        ddl.create_native_table(partition_id, table_id)
        ddl.add_column(partition_id, table_id, field_id, "date", config=time_config)
        record_id = uuid.uuid4()
        qualified = f'"{ddl.schema_name(partition_id)}"."{ddl.table_name(table_id)}"'
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'INSERT INTO {qualified} ("__id", "{field_id.hex}") VALUES (%s, %s)',
                [record_id, datetime(2026, 8, 8, 16, 30, tzinfo=timezone.utc)],
            )

        changed = ddl.alter_column_type(
            partition_id,
            table_id,
            field_id,
            "date",
            "date",
            config=date_config,
            old_config=time_config,
        )

        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'SELECT "{field_id.hex}" FROM {qualified} WHERE "__id" = %s',
                [record_id],
            )
            stored_value = cursor.fetchone()[0]
        self.assertTrue(changed)
        self.assertEqual(stored_value, date(2026, 8, 9))


class NativeTableInvariantTest(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        self.user = User.objects.create_user(
            username="native_table_invariant_user",
            email="native_table_invariant@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Native Invariant Organization",
            owner=self.user,
        )
        self.space = Space.objects.create(
            organization=self.organization,
            name="Native Invariant Space",
            type="team",
        )

    def test_build_snapshot_recreates_missing_native_table(self):
        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="孤儿表快照自愈",
            owner=self.user,
        )
        field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            name="标题",
            field_type="text",
            order=0,
        )

        ddl = DDLManager()
        self.assertFalse(ddl.native_table_exists(self.space.id, table.id))

        snapshot = CollabService.build_snapshot(table.id)

        self.assertEqual(snapshot["table_id"], str(table.id))
        self.assertEqual(snapshot["records"], {})
        self.assertTrue(ddl.native_table_exists(self.space.id, table.id))
        self.assertTrue(ddl.column_exists(self.space.id, table.id, field.id))

    def test_build_snapshot_backfills_existing_orm_records_before_reading_native(self):
        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="非空孤儿表快照自愈",
            owner=self.user,
        )
        field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            name="标题",
            field_type="text",
            order=0,
        )
        record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            data={field.id.hex: "不能丢的 ORM 数据"},
            order=1000,
        )

        ddl = DDLManager()
        self.assertFalse(ddl.native_table_exists(self.space.id, table.id))

        snapshot = CollabService.build_snapshot(table.id)

        self.assertIn(str(record.id), snapshot["records"])
        self.assertEqual(
            snapshot["records"][str(record.id)][field.id.hex],
            "不能丢的 ORM 数据",
        )
        self.assertEqual(snapshot["row_order"], [str(record.id)])

    def test_connector_import_creates_native_table_for_active_table(self):
        connector = DataConnector(
            organization_id=self.organization.id,
            space_id=self.space.id,
            connector_type="postgresql",
            name="测试连接器",
            created_by=self.user,
            config_encrypted="mocked-in-test",
        )
        connector.save(using=TABDATA_DB_ALIAS)

        fake_instance = MagicMock()
        fake_instance.discover_columns.return_value = [
            ExternalColumn(name="id", data_type="int4", is_primary_key=True),
            ExternalColumn(name="title", data_type="text"),
        ]

        with (
            patch("apps.users.membership.services.quota_service.check_quota_safe"),
            patch.object(
                ConnectorService,
                "_get_connector_instance",
                return_value=fake_instance,
            ),
        ):
            result = ConnectorService(user=self.user).import_tables(
                str(connector.id),
                [{"schema": "public", "table": "external_orders", "sync_mode": "mirror"}],
            )

        table_id = uuid.UUID(result[0]["table_id"])
        table = Table.objects.using(TABDATA_DB_ALIAS).get(id=table_id)
        fields = list(
            TableField.objects.using(TABDATA_DB_ALIAS).filter(
                table_id=table.id, is_deleted=False,
            )
        )

        ddl = DDLManager()
        self.assertTrue(ddl.native_table_exists(self.space.id, table.id))
        for field in fields:
            self.assertTrue(ddl.column_exists(self.space.id, table.id, field.id))
        fake_instance.close.assert_called_once_with()

    def test_connector_full_sync_writes_created_rows_to_native_snapshot(self):
        from apps.tabdata.tasks.connector_tasks import _full_sync

        table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="连接器同步表",
            owner=self.user,
            source_type=Table.SOURCE_MIRROR,
        )
        field = TableField.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            name="标题",
            field_type="text",
            order=0,
        )
        DDLManager().ensure_columns_synced(self.space.id, table.id, [field])
        old_record = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=table,
            data={str(field.id): "旧行"},
            created_by=self.user,
            updated_by=self.user,
        )
        ddl = DDLManager()
        qualified = (
            f'"{ddl.schema_name(self.space.id)}".'
            f'"{ddl.table_name(table.id)}"'
        )
        with connections[TABDATA_DB_ALIAS].cursor() as cursor:
            cursor.execute(
                f'INSERT INTO {qualified} ("__id", "{field.id.hex}") VALUES (%s, %s)',
                [old_record.id, "旧行"],
            )

        connector = MagicMock()
        connector.query.side_effect = [
            ([{"ext_title": "预检"}], 1),
            ([{"ext_title": "同步行"}], 1),
        ]
        mapping = MagicMock()
        mapping.id = uuid.uuid4()
        mapping.table_id = table.id
        mapping.connector.created_by = self.user
        mapping.connector.organization_id = self.organization.id

        _full_sync(
            connector,
            mapping,
            "public",
            "external_orders",
            {"ext_title": str(field.id)},
        )

        snapshot = CollabService.build_snapshot(table.id)
        values = [
            record[field.id.hex]
            for record in snapshot["records"].values()
            if field.id.hex in record
        ]
        self.assertEqual(values, ["同步行"])
        old_record.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertTrue(old_record.is_deleted)

    @patch("apps.tabdata.services.table_service.QuotaService")
    @patch.object(TableService, "check_space_permission", return_value=True)
    @patch("apps.tabdata.services.table_service.DDLManager")
    def test_create_table_rolls_back_metadata_when_native_table_creation_fails(
        self,
        mock_ddl_cls,
        _mock_permission,
        mock_quota_cls,
    ):
        mock_quota_cls.return_value.check_quota.return_value = None
        mock_ddl = MagicMock()
        mock_ddl.create_native_table.side_effect = DatabaseError("native ddl failed")
        mock_ddl_cls.return_value = mock_ddl

        table_name = f"DDL失败回滚-{uuid.uuid4()}"

        with self.assertRaises(DatabaseError):
            TableService(user=self.user).create_table(
                space_id=self.space.id,
                name=table_name,
            )

        self.assertFalse(
            Table.objects.using(TABDATA_DB_ALIAS).filter(name=table_name).exists()
        )
