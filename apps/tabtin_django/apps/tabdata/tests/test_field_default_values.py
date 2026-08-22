from dataclasses import dataclass
from datetime import datetime, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

from django.db import models
from django.test import SimpleTestCase

from apps.tabdata.domain.aggregates import RecordAggregate
from apps.tabdata.domain.value_objects import FieldSchema
from apps.tabdata.models import TableField
from apps.tabdata.schemas import TableFieldCreate, TableFieldOut
from apps.tabdata.native.agent_sql import AgentSQLExecutor
from apps.tabdata.utils.default_values import (
    apply_record_defaults,
    reconcile_select_default,
    validate_default_value,
)
from apps.tabdata.utils.field_types import deserialize_import_value, format_field_value


@dataclass
class StubField:
    id: UUID
    field_type: str
    default_value: dict | None
    config: dict
    is_multiple_cell_value: bool = False


class FieldDefaultValueTests(SimpleTestCase):
    def test_agent_sql_multi_row_parameters_follow_injected_columns(self):
        sql, params = AgentSQLExecutor._append_insert_columns(
            "INSERT INTO target (a) VALUES (%s), (%s)",
            [1, 2],
            ["b"],
            ["default"],
        )
        self.assertEqual(
            sql,
            'INSERT INTO target (a, "b") VALUES (%s, %s), (%s, %s)',
        )
        self.assertEqual(params, [1, "default", 2, "default"])

    def test_literal_only_applies_when_key_is_missing(self):
        field = StubField(uuid4(), "text", {"mode": "literal", "value": "待处理"}, {})
        missing = {}
        explicit_empty = {field.id.hex: ""}

        apply_record_defaults(missing, [field], is_create=True)
        apply_record_defaults(explicit_empty, [field], is_create=True)

        self.assertEqual(missing[field.id.hex], "待处理")
        self.assertEqual(explicit_empty[field.id.hex], "")

    def test_dynamic_values_have_distinct_lifecycles(self):
        created = StubField(uuid4(), "datetime", {"mode": "created_time"}, {})
        created_date = StubField(uuid4(), "date", {"mode": "created_time"}, {})
        created_date_with_time = StubField(
            uuid4(),
            "date",
            {"mode": "created_time"},
            {"formatting": {"date": "YYYY-MM-DD", "time": "HH:mm:ss", "timeZone": "UTC"}},
        )
        modified = StubField(uuid4(), "datetime", {"mode": "last_modified_time"}, {})
        modified_date_with_time = StubField(
            uuid4(),
            "date",
            {"mode": "last_modified_time"},
            {"formatting": {"date": "YYYY-MM-DD", "time": "HH:mm:ss", "timeZone": "UTC"}},
        )
        now = datetime(2026, 8, 8, 9, 30, tzinfo=timezone.utc)
        data = {modified.id.hex: "user supplied"}

        apply_record_defaults(
            data,
            [created, created_date, created_date_with_time, modified, modified_date_with_time],
            is_create=True,
            now=now,
        )
        self.assertEqual(data[created.id.hex], now.isoformat())
        self.assertEqual(data[created_date.id.hex], "2026-08-08")
        self.assertEqual(data[created_date_with_time.id.hex], now.isoformat())
        self.assertEqual(data[modified.id.hex], now.isoformat())
        self.assertEqual(data[modified_date_with_time.id.hex], now.isoformat())

        later = datetime(2026, 8, 8, 10, 30, tzinfo=timezone.utc)
        apply_record_defaults(
            data,
            [created, created_date, created_date_with_time, modified, modified_date_with_time],
            is_create=False,
            now=later,
        )
        self.assertEqual(data[created.id.hex], now.isoformat())
        self.assertEqual(data[created_date.id.hex], "2026-08-08")
        self.assertEqual(data[created_date_with_time.id.hex], now.isoformat())
        self.assertEqual(data[modified.id.hex], later.isoformat())
        self.assertEqual(data[modified_date_with_time.id.hex], later.isoformat())

    def test_date_only_dynamic_default_uses_field_timezone(self):
        field = StubField(
            uuid4(),
            "date",
            {"mode": "created_time"},
            {
                "formatting": {
                    "date": "YYYY-MM-DD",
                    "time": "None",
                    "timeZone": "Asia/Shanghai",
                }
            },
        )
        data = {}

        apply_record_defaults(
            data,
            [field],
            is_create=True,
            now=datetime(2026, 8, 8, 16, 30, tzinfo=timezone.utc),
        )

        self.assertEqual(data[field.id.hex], "2026-08-09")

    def test_date_field_with_time_format_preserves_default_timestamp(self):
        field = StubField(
            uuid4(),
            "date",
            {"mode": "literal", "value": "2026-08-09T05:52:34Z"},
            {"formatting": {"date": "YYYY/MM/DD", "time": "HH:mm:ss", "timeZone": "UTC"}},
        )
        data = {}

        apply_record_defaults(data, [field], is_create=True)

        self.assertEqual(data[field.id.hex], "2026-08-09T05:52:34+00:00")

    def test_date_field_without_time_format_keeps_legacy_date_only_default(self):
        field = StubField(
            uuid4(),
            "date",
            {"mode": "literal", "value": "2026-08-09T05:52:34Z"},
            {"formatting": {"date": "YYYY/MM/DD", "time": "None", "timeZone": "UTC"}},
        )
        data = {}

        apply_record_defaults(data, [field], is_create=True)

        self.assertEqual(data[field.id.hex], "2026-08-09")

    def test_date_formatting_and_import_preserve_time_when_configured(self):
        config = {"formatting": {"date": "YYYY/MM/DD", "time": "HH:mm:ss", "timeZone": "UTC"}}

        self.assertEqual(
            format_field_value("date", "2026/08/09 13:52:34", config),
            "2026-08-09T13:52:34",
        )

        imported = deserialize_import_value("date", "2026/08/09 13:52:34", config)
        self.assertIsInstance(imported, datetime)
        self.assertEqual(imported.isoformat(), "2026-08-09T13:52:34")

    def test_creator_respects_single_and_multiple_user_fields(self):
        actor_id = str(uuid4())
        single = StubField(uuid4(), "user", {"mode": "creator"}, {})
        multiple = StubField(uuid4(), "user", {"mode": "creator"}, {}, True)
        data = {}

        apply_record_defaults(data, [single, multiple], is_create=True, actor_id=actor_id)

        self.assertEqual(data[single.id.hex], actor_id)
        self.assertEqual(data[multiple.id.hex], [actor_id])

    def test_creator_stays_empty_for_anonymous_actor(self):
        field = StubField(uuid4(), "user", {"mode": "creator"}, {})
        data = {}

        apply_record_defaults(data, [field], is_create=True, actor_id=None)

        self.assertNotIn(field.id.hex, data)

    def test_invalid_mode_and_type_are_rejected(self):
        with self.assertRaisesMessage(ValueError, "动态时间默认值"):
            validate_default_value("text", {"mode": "created_time"})
        with self.assertRaisesMessage(ValueError, "不支持的默认值模式"):
            validate_default_value("text", {"mode": "unknown"})

    def test_percent_and_currency_literal_defaults_are_normalized_away_and_not_applied(self):
        for field_type in ("percent", "currency"):
            with self.subTest(field_type=field_type):
                self.assertIsNone(
                    validate_default_value(field_type, {"mode": "literal", "value": 100})
                )
                with self.assertRaisesMessage(ValueError, "固定默认值缺少 value"):
                    validate_default_value(field_type, {"mode": "literal"})

                field = StubField(uuid4(), field_type, {"mode": "literal", "value": 100}, {})
                data = {}
                apply_record_defaults(data, [field], is_create=True)

                self.assertNotIn(field.id.hex, data)

    def test_form_metadata_does_not_expose_retired_numeric_defaults(self):
        from apps.tabdata.api_form import _serialize_form_meta

        fields = [
            SimpleNamespace(
                id=uuid4(),
                name=field_type,
                field_type=field_type,
                config={},
                is_primary=False,
                default_value={"mode": "literal", "value": 100},
            )
            for field_type in ("percent", "currency", "number")
        ]
        view = SimpleNamespace(
            config={},
            column_meta={},
            visible_fields=[],
            field_order=[],
            name="Form",
            description="",
        )
        share = SimpleNamespace(share_id="share-id", has_password=False)

        metadata = _serialize_form_meta(share, fields, view)
        defaults_by_type = {
            field["field_type"]: field["default_value"]
            for field in metadata["fields"]
        }

        self.assertIsNone(defaults_by_type["percent"])
        self.assertIsNone(defaults_by_type["currency"])
        self.assertEqual(
            defaults_by_type["number"],
            {"mode": "literal", "value": 100},
        )

    def test_select_rename_and_delete_reconcile_literal_default(self):
        renamed = reconcile_select_default(
            {"mode": "literal", "value": ["待办", "已删除"]},
            ["待办", "已删除"],
            ["进行中"],
            multiple=True,
        )
        self.assertEqual(renamed, {"mode": "literal", "value": ["进行中"]})

    def test_default_value_contract_does_not_block_empty_records(self):
        now = datetime.now(timezone.utc)
        orm_field = TableField(
            id=uuid4(),
            table_id=uuid4(),
            name="标题",
            field_type="text",
            default_value={"mode": "literal", "value": "默认标题"},
            created_at=now,
            updated_at=now,
        )
        response = TableFieldOut.from_orm(orm_field)
        self.assertEqual(response.default_value, {"mode": "literal", "value": "默认标题"})

        field_schema = FieldSchema(
            id=orm_field.id,
            name=orm_field.name,
            field_type=orm_field.field_type,
            config={},
        )
        snapshot, _event = RecordAggregate.create_new(
            table_id=orm_field.table_id,
            data={},
            fields=[field_schema],
            user_id=str(uuid4()),
        )
        self.assertEqual(snapshot.formatted_data, {})

    def test_unknown_persisted_field_types_fall_back_to_text_but_are_not_creatable(self):
        now = datetime.now(timezone.utc)
        for field_type in (
            "datetime",
            "formula",
            "rollup",
            "lookup",
            "auto_number",
            "nested_list",
            "future_unknown_type",
        ):
            orm_field = TableField(
                id=uuid4(),
                table_id=uuid4(),
                name=f"旧字段-{field_type}",
                field_type=field_type,
                created_at=now,
                updated_at=now,
            )

            response = TableFieldOut.from_orm(orm_field)

            self.assertEqual(response.field_type, "text")
            with self.assertRaises(ValueError):
                TableFieldCreate(
                    table_id=orm_field.table_id,
                    name=f"新字段-{field_type}",
                    field_type=field_type,
                )
