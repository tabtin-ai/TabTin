"""TabTin SDK client."""

from __future__ import annotations

import re
from typing import Any, Optional

from tabtin_sdk.http import HttpClient
from tabtin_sdk.table import TableHandle
from tabtin_sdk.types import ApiResponse, SqlQueryResult, TabTinError

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


class Client:
    """
    TabTin SDK client.

    Usage::

        from tabtin_sdk import Client

        client = Client("https://api.example.com", "ttn_xxx_yyy")
        client.init(space_id="space-id")

        # Query
        result = client.table("任务").select("*").eq("状态", "进行中").execute()
        print(result.data.records)

        # Insert
        client.table("任务").insert({"标题": "新任务", "状态": "待处理"})

        # SQL
        result = client.sql("space-id", "SELECT * FROM 任务")

        # If duplicate table names exist across Spaces, pass space_id
        # during init() or use a table UUID directly.

        client.close()
    """

    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 30.0,
    ):
        self._http = HttpClient(base_url, token, timeout=timeout)
        self._table_cache: dict[str, str] = {}
        self._ambiguous_table_names: set[str] = set()
        self._initialized = False

    def init(
        self,
        space_id: Optional[str] = None,
    ) -> Client:
        """
        Initialize by fetching table list. Enables table() by name.

        Optional — you can skip this and use table UUIDs directly.
        """
        self._table_cache.clear()
        self._ambiguous_table_names.clear()
        resp = self.list_tables(space_id=space_id)
        if resp.error:
            raise resp.error
        if resp.data and "tables" in resp.data:
            for t in resp.data["tables"]:
                self._cache_resolved_table(t["name"], t["id"])
        self._initialized = True
        return self

    def table(self, name_or_id: str) -> TableHandle:
        """
        Get a table handle by name or UUID.

        - UUID → used directly
        - Name → resolved from cache (call init() first)
        """
        if _UUID_RE.match(name_or_id):
            return TableHandle(self._http, name_or_id)

        if name_or_id in self._ambiguous_table_names:
            raise ValueError(
                f'Table "{name_or_id}" exists in multiple spaces. '
                "Call client.init(space_id=...) first or use a table UUID."
            )

        cached = self._table_cache.get(name_or_id)
        if cached:
            return TableHandle(self._http, cached)

        if not self._initialized:
            raise ValueError(
                f'Table "{name_or_id}" not found. '
                "Call client.init() first to enable table name lookup, "
                "or use a table UUID."
            )
        available = ", ".join(self._table_cache.keys())
        raise ValueError(
            f'Table "{name_or_id}" not found. Available: {available}'
        )

    def _cache_resolved_table(self, name: str, table_id: str) -> None:
        if name in self._ambiguous_table_names:
            return
        existing = self._table_cache.get(name)
        if existing and existing != table_id:
            self._table_cache.pop(name, None)
            self._ambiguous_table_names.add(name)
            return
        self._table_cache[name] = table_id

    def sql(
        self,
        space_id: Optional[str] = None,
        query: Optional[str] = None,
        params: Optional[list[Any]] = None,
    ) -> ApiResponse[SqlQueryResult]:
        """Execute a read-only SQL query on a Space."""
        if not query:
            raise ValueError("query is required")
        try:
            if not space_id:
                raise ValueError("space_id is required")
            raw = self._http.post(
                f"/api/open/v1/spaces/{space_id}/data/sql/query",
                json={"sql": query, "params": params or []},
            )
            result = SqlQueryResult(
                columns=raw.get("columns", []),
                rows=raw.get("rows", []),
                row_count=raw.get("row_count", 0),
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def sql_execute(
        self,
        space_id: Optional[str] = None,
        query: Optional[str] = None,
        params: Optional[list[Any]] = None,
        *,
        allow_delete: bool = False,
    ) -> ApiResponse[SqlQueryResult]:
        """Execute a write SQL statement on a Space."""
        if not query:
            raise ValueError("query is required")
        try:
            if not space_id:
                raise ValueError("space_id is required")
            raw = self._http.post(
                f"/api/open/v1/spaces/{space_id}/data/sql/execute",
                json={
                    "sql": query,
                    "params": params or [],
                    "allow_delete": allow_delete,
                },
            )
            result = SqlQueryResult(
                columns=raw.get("columns", []),
                rows=raw.get("rows", []),
                row_count=raw.get("row_count", 0),
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def list_spaces(self) -> ApiResponse[dict[str, Any]]:
        """List all Spaces accessible via the current token."""
        try:
            result = self._http.get("/api/open/v1/spaces")
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)

    def list_tables(
        self,
        space_id: Optional[str] = None,
    ) -> ApiResponse[dict[str, Any]]:
        """List tables accessible via the current token.

        When no Space is provided, the client discovers accessible Spaces first
        and then aggregates their tables.
        """
        try:
            if space_id:
                result = self._http.get(
                    f"/api/open/v1/spaces/{space_id}/data/tables"
                )
                return ApiResponse(data=result)

            spaces = self._http.get("/api/open/v1/spaces")
            table_map: dict[str, dict[str, Any]] = {}
            for space in spaces.get("spaces", []):
                tables = self._http.get(
                    f"/api/open/v1/spaces/{space['id']}/data/tables"
                )
                for table in tables.get("tables", []):
                    table_map[table["id"]] = table
            return ApiResponse(data={"tables": list(table_map.values())})
        except TabTinError as e:
            return ApiResponse(error=e)

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http.close()

    def __enter__(self) -> Client:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
