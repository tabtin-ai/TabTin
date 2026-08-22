from __future__ import annotations

import json
from contextlib import nullcontext
from types import SimpleNamespace
from uuid import uuid4

from django.test import override_settings

from apps.tabdata.native import ddl_manager as ddl_manager_module
from apps.tabdata.native.community_capabilities import CommunitySchemaOperations, resolve_column_capability
from apps.tabdata.native.ddl_manager import DDLManager
from apps.tabdata.native.pg_type_map import FIELD_TYPE_TO_PG_TYPE, get_pg_default


class _Cursor:
    def __init__(self) -> None:
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, statement, parameters=None) -> None:
        self.calls.append((statement, parameters))

    def fetchone(self):
        return (True,)


class _Connection:
    def __init__(self) -> None:
        self.recorder = _Cursor()

    def cursor(self) -> _Cursor:
        return self.recorder


def test_typed_capability_client_never_accepts_identifiers_or_sql() -> None:
    connection = _Connection()
    operations = CommunitySchemaOperations(connection)
    partition_id, table_id, field_id = uuid4(), uuid4(), uuid4()

    operations.ensure_schema(partition_id)
    operations.create_table(partition_id, table_id, [{
        "field_id": str(field_id),
        "pg_type": "JSONB",
        "default_kind": "empty_json_array",
    }])

    assert connection.recorder.calls == [
        ("SELECT tabtin_capability.native_ensure_schema(%s)", [partition_id]),
        (
            "SELECT tabtin_capability.native_create_table(%s, %s, %s::jsonb)",
            [partition_id, table_id, json.dumps([{
                "field_id": str(field_id),
                "pg_type": "JSONB",
                "default_kind": "empty_json_array",
            }], separators=(",", ":"), sort_keys=True)],
        ),
    ]


def test_every_current_native_field_type_has_a_closed_capability_value() -> None:
    default_kinds = {None: "none", "false": "false", "'[]'::jsonb": "empty_json_array"}
    for field_type, expected_pg_type in FIELD_TYPE_TO_PG_TYPE.items():
        pg_type, default_kind = resolve_column_capability(field_type, None)
        assert pg_type == expected_pg_type
        assert default_kind == default_kinds[get_pg_default(field_type, None)]

    assert resolve_column_capability("date", {"formatting": {"time": "HH:mm"}}) == (
        "TIMESTAMPTZ",
        "none",
    )


def test_community_initial_table_fields_use_one_capability_call(monkeypatch) -> None:
    connection = _Connection()
    monkeypatch.setattr(ddl_manager_module, "connections", {"isolated": connection})
    monkeypatch.setattr(ddl_manager_module.transaction, "atomic", lambda **_kwargs: nullcontext())
    fields = [
        SimpleNamespace(id=uuid4(), field_type="text", config={}),
        SimpleNamespace(id=uuid4(), field_type="checkbox", config={}),
        SimpleNamespace(id=uuid4(), field_type="multi_select", config={}),
    ]

    with override_settings(TABTIN_EDITION="community"):
        DDLManager(db_alias="isolated").create_native_table(uuid4(), uuid4(), extra_fields=fields)

    statements = [statement for statement, _ in connection.recorder.calls]
    assert statements == ["SELECT tabtin_capability.native_create_table(%s, %s, %s::jsonb)"]
    assert all("CREATE TABLE" not in statement for statement in statements)


def test_saas_ddl_path_remains_direct(monkeypatch) -> None:
    connection = _Connection()
    monkeypatch.setattr(ddl_manager_module, "connections", {"isolated": connection})
    monkeypatch.setattr(ddl_manager_module.transaction, "atomic", lambda **_kwargs: nullcontext())
    monkeypatch.setattr(ddl_manager_module.transaction, "on_commit", lambda callback, **_kwargs: callback())
    ddl_manager_module._ENSURED_SCHEMAS.clear()

    with override_settings(TABTIN_EDITION="saas"):
        DDLManager(db_alias="isolated").ensure_schema(uuid4())

    statements = [statement for statement, _ in connection.recorder.calls]
    assert any("CREATE SCHEMA IF NOT EXISTS" in statement for statement in statements)
    assert all("tabtin_capability" not in statement for statement in statements)
