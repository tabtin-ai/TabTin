"""Table handle — returned by client.table('name')."""

from __future__ import annotations

from typing import Any, Optional, Union

from tabtin_sdk.http import HttpClient
from tabtin_sdk.query import QueryBuilder
from tabtin_sdk.storage import StorageClient
from tabtin_sdk.types import ApiResponse, TabTinError


class TableHandle:
    """
    Handle to a single TabData table. Provides fluent CRUD operations.

    Usage::

        table = client.table("任务")
        result = table.select("*").eq("状态", "进行中").execute()
        table.insert({"标题": "新任务"})
    """

    def __init__(self, http: HttpClient, table_id: str):
        self._http = http
        self._table_id = table_id

    @property
    def storage(self) -> StorageClient:
        """Access file storage operations for this table."""
        return StorageClient(self._http, self._table_id)

    def select(self, fields: Union[str, list[str]] = "*") -> QueryBuilder:
        """Start a SELECT query."""
        return QueryBuilder(self._http, self._table_id).select(fields)

    def insert(self, data: Union[dict[str, Any], list[dict[str, Any]]]) -> ApiResponse[dict[str, Any]]:
        """Insert one or more records."""
        records = data if isinstance(data, list) else [data]
        try:
            if len(records) == 1:
                result = self._http.post(
                    f"/api/tabdata/open/v1/tables/{self._table_id}/records",
                    json={"fields": records[0], "field_key_type": "name"},
                )
                return ApiResponse(data={"created_count": 1, "record": result})

            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/batch-create",
                json={
                    "records": [{"fields": r} for r in records],
                    "field_key_type": "name",
                },
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def update(
        self,
        record_id: str,
        fields: dict[str, Any],
    ) -> ApiResponse[dict[str, Any]]:
        """Update a single record by ID."""
        try:
            result = self._http.patch(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/{record_id}",
                json={"fields": fields, "field_key_type": "name"},
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def batch_update(
        self,
        updates: list[dict[str, Any]],
    ) -> ApiResponse[dict[str, Any]]:
        """
        Batch update records.

        Args:
            updates: list of {"id": "record-uuid", "fields": {...}}
        """
        try:
            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/batch-update",
                json={
                    "records": [
                        {"id": u["id"], "fields": u["fields"]}
                        for u in updates
                    ],
                    "field_key_type": "name",
                },
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def upsert(
        self,
        data: Union[dict[str, Any], list[dict[str, Any]]],
        *,
        on_conflict: Union[str, list[str]],
    ) -> ApiResponse[dict[str, Any]]:
        """Upsert — insert or update on conflict."""
        records = data if isinstance(data, list) else [data]
        conflict_fields = [on_conflict] if isinstance(on_conflict, str) else on_conflict
        try:
            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/upsert",
                json={
                    "records": [{"fields": r} for r in records],
                    "upsert_on": conflict_fields,
                    "field_key_type": "name",
                },
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def delete(self, record_ids: Union[str, list[str]]) -> ApiResponse[dict[str, Any]]:
        """Delete one or more records by ID."""
        ids = [record_ids] if isinstance(record_ids, str) else record_ids
        try:
            if len(ids) == 1:
                self._http.delete(
                    f"/api/tabdata/open/v1/tables/{self._table_id}/records/{ids[0]}",
                )
                return ApiResponse(data={"deleted_count": 1})

            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/batch-delete",
                json={"record_ids": ids},
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def field_map(self) -> ApiResponse[dict[str, Any]]:
        """Get field name → field ID mapping."""
        try:
            result = self._http.get(
                f"/api/tabdata/open/v1/tables/{self._table_id}/field-map",
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def aggregate(
        self,
        items: list[dict[str, str]],
    ) -> ApiResponse[list[dict[str, Any]]]:
        """
        Run aggregation queries.

        Args:
            items: list of {"field": "字段名", "function": "sum"|"avg"|"count"|...}
        """
        try:
            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/aggregation",
                json={"items": items, "field_key_type": "name"},
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    # ── RLS (Row Level Security) ────────────────────────

    def list_policies(self) -> ApiResponse[dict[str, Any]]:
        """List all RLS policies and RLS status for this table."""
        try:
            result = self._http.get(
                f"/api/tabdata/open/v1/tables/{self._table_id}/policies",
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def create_policy(
        self,
        name: str,
        condition: dict[str, Any],
        *,
        operation: str = "ALL",
        policy_type: str = "PERMISSIVE",
        apply_to_tokens: bool = True,
        apply_to_jwt: bool = False,
        is_active: bool = True,
    ) -> ApiResponse[dict[str, Any]]:
        """Create an RLS policy on this table."""
        try:
            result = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/policies",
                json={
                    "name": name,
                    "operation": operation,
                    "policy_type": policy_type,
                    "condition": condition,
                    "apply_to_tokens": apply_to_tokens,
                    "apply_to_jwt": apply_to_jwt,
                    "is_active": is_active,
                },
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def update_policy(
        self,
        policy_id: str,
        **kwargs: Any,
    ) -> ApiResponse[dict[str, Any]]:
        """
        Update an RLS policy.

        Args:
            policy_id: Policy UUID
            **kwargs: Fields to update (name, operation, condition, etc.)
        """
        try:
            result = self._http.patch(
                f"/api/tabdata/open/v1/tables/{self._table_id}/policies/{policy_id}",
                json=kwargs,
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def delete_policy(self, policy_id: str) -> ApiResponse[dict[str, Any]]:
        """Delete an RLS policy."""
        try:
            self._http.delete(
                f"/api/tabdata/open/v1/tables/{self._table_id}/policies/{policy_id}",
            )
            return ApiResponse(data={"deleted": True})
        except TabTinError as e:
            return ApiResponse(error=e)

    def set_rls(
        self,
        enabled: bool,
        force: bool = False,
    ) -> ApiResponse[dict[str, Any]]:
        """
        Enable or disable RLS on this table.

        Args:
            enabled: Whether to enable RLS
            force: Whether JWT users (table owner) are also subject to RLS
        """
        try:
            result = self._http.patch(
                f"/api/tabdata/open/v1/tables/{self._table_id}/rls",
                json={"rls_enabled": enabled, "rls_force": force},
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)
