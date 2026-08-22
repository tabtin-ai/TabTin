"""Typed client for the Community PostgreSQL capability boundary.

The callable surface is intentionally closed: callers provide domain UUIDs
and enum-like values, never SQL fragments, schema names, table names, column
names, role names, or index names.
"""

from __future__ import annotations

import json
from uuid import UUID

from .pg_type_map import get_pg_default, get_pg_type


_DEFAULT_KINDS = {
    None: "none",
    "false": "false",
    "'[]'::jsonb": "empty_json_array",
}


def resolve_column_capability(field_type: str, config: dict | None) -> tuple[str, str]:
    pg_type = get_pg_type(field_type, config)
    if pg_type is None:
        raise ValueError(f"field type has no native column: {field_type}")
    default = get_pg_default(field_type, config)
    try:
        default_kind = _DEFAULT_KINDS[default]
    except KeyError as exc:
        raise ValueError(f"unsupported Community field default: {field_type}") from exc
    return pg_type, default_kind


class _CapabilityClient:
    def __init__(self, connection) -> None:
        self.connection = connection

    def _call(self, statement: str, parameters: list) -> bool:
        with self.connection.cursor() as cursor:
            cursor.execute(statement, parameters)
            row = cursor.fetchone()
        return bool(row and row[0])


class CommunitySchemaOperations(_CapabilityClient):
    def ensure_schema(self, partition_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_ensure_schema(%s)",
            [partition_id],
        )

    def create_table(
        self,
        partition_id: UUID,
        table_id: UUID,
        field_specs: list[dict[str, str]],
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_create_table(%s, %s, %s::jsonb)",
            [
                partition_id,
                table_id,
                json.dumps(field_specs, separators=(",", ":"), sort_keys=True),
            ],
        )

    def drop_table(self, partition_id: UUID, table_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_drop_table(%s, %s)",
            [partition_id, table_id],
        )

    def add_column(
        self,
        partition_id: UUID,
        table_id: UUID,
        field_id: UUID,
        *,
        pg_type: str,
        default_kind: str,
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_add_column(%s, %s, %s, %s, %s)",
            [partition_id, table_id, field_id, pg_type, default_kind],
        )

    def drop_column(
        self,
        partition_id: UUID,
        table_id: UUID,
        field_id: UUID,
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_drop_column(%s, %s, %s)",
            [partition_id, table_id, field_id],
        )

    def alter_column_type(
        self,
        partition_id: UUID,
        table_id: UUID,
        field_id: UUID,
        *,
        target_type: str,
        timezone: str | None,
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.native_alter_column_type(%s, %s, %s, %s, %s)",
            [partition_id, table_id, field_id, target_type, timezone],
        )


class CommunityRecordIndexOperations(_CapabilityClient):
    def create_search_index(self, table_id: UUID, field_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.record_create_search_index(%s, %s)",
            [table_id, field_id],
        )

    def drop_search_index(self, table_id: UUID, field_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.record_drop_search_index(%s, %s)",
            [table_id, field_id],
        )

    def drop_search_indexes(self, table_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.record_drop_search_indexes(%s)",
            [table_id],
        )

    def create_sort_index(self, table_id: UUID, field_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.record_create_sort_index(%s, %s)",
            [table_id, field_id],
        )


class CommunityReadonlyRoleOperations(_CapabilityClient):
    def create(
        self,
        space_id: UUID,
        organization_id: UUID,
        password: str,
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.readonly_role_create(%s, %s, %s)",
            [space_id, organization_id, password],
        )

    def rotate(
        self,
        space_id: UUID,
        organization_id: UUID,
        password: str,
    ) -> bool:
        return self._call(
            "SELECT tabtin_capability.readonly_role_rotate(%s, %s, %s)",
            [space_id, organization_id, password],
        )

    def drop(self, space_id: UUID, organization_id: UUID) -> bool:
        return self._call(
            "SELECT tabtin_capability.readonly_role_drop(%s, %s)",
            [space_id, organization_id],
        )
