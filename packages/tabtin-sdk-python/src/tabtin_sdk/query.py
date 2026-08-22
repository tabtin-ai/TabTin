"""Fluent query builder for TabData tables."""

from __future__ import annotations

from typing import Any, List, Optional, Union

from tabtin_sdk.http import HttpClient
from tabtin_sdk.types import ApiResponse, RecordListResult, RecordRow, TabTinError


class QueryBuilder:
    """
    Fluent query builder — Supabase-style API.

    Usage::

        result = (
            client.table("任务")
            .select("标题, 状态")
            .eq("状态", "进行中")
            .order("创建时间", ascending=False)
            .limit(10)
            .execute()
        )
    """

    def __init__(self, http: HttpClient, table_id: str):
        self._http = http
        self._table_id = table_id
        self._fields: Optional[list[str]] = None
        self._filters: list[dict[str, Any]] = []
        self._sorts: list[dict[str, str]] = []
        self._page = 1
        self._page_size = 100
        self._search: Optional[str] = None

    def select(self, fields: Union[str, list[str]] = "*") -> QueryBuilder:
        if isinstance(fields, str):
            if fields == "*":
                self._fields = None
            else:
                self._fields = [f.strip() for f in fields.split(",")]
        else:
            self._fields = fields
        return self

    # ── Filter shortcuts ────────────────────────────────

    def eq(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "equals", value)

    def neq(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "not_equals", value)

    def gt(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "greater_than", value)

    def gte(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "greater_than_or_equals", value)

    def lt(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "less_than", value)

    def lte(self, field: str, value: Any) -> QueryBuilder:
        return self._add_filter(field, "less_than_or_equals", value)

    def contains(self, field: str, value: str) -> QueryBuilder:
        return self._add_filter(field, "contains", value)

    def not_contains(self, field: str, value: str) -> QueryBuilder:
        return self._add_filter(field, "not_contains", value)

    def like(self, field: str, pattern: str) -> QueryBuilder:
        return self._add_filter(field, "like", pattern)

    def ilike(self, field: str, pattern: str) -> QueryBuilder:
        return self._add_filter(field, "ilike", pattern)

    def is_in(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "in", values)

    def not_in(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "not_in", values)

    def has_any_of(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "has_any_of", values)

    def has_all_of(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "has_all_of", values)

    def has_none_of(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "has_none_of", values)

    def is_exactly(self, field: str, values: List[Any]) -> QueryBuilder:
        return self._add_filter(field, "is_exactly", values)

    def is_empty(self, field: str) -> QueryBuilder:
        return self._add_filter(field, "is_empty")

    def is_not_empty(self, field: str) -> QueryBuilder:
        return self._add_filter(field, "is_not_empty")

    def _add_filter(self, field: str, operator: str, value: Any = None) -> QueryBuilder:
        self._filters.append({"field": field, "operator": operator, "value": value})
        return self

    # ── Sort ────────────────────────────────────────────

    def order(self, field: str, *, ascending: bool = True) -> QueryBuilder:
        self._sorts.append({"field": field, "order": "asc" if ascending else "desc"})
        return self

    # ── Pagination ──────────────────────────────────────

    def limit(self, count: int) -> QueryBuilder:
        self._page_size = min(count, 2000)
        return self

    def page(self, num: int) -> QueryBuilder:
        self._page = num
        return self

    # ── Search ──────────────────────────────────────────

    def search(self, keyword: str) -> QueryBuilder:
        self._search = keyword
        return self

    # ── Execute ─────────────────────────────────────────

    def execute(self) -> ApiResponse[RecordListResult]:
        body: dict[str, Any] = {
            "field_key_type": "name",
            "page": self._page,
            "page_size": self._page_size,
        }
        if self._fields:
            body["fields"] = self._fields
        if self._filters:
            body["filter"] = {"conjunction": "and", "filterSet": self._filters}
        if self._sorts:
            body["sort"] = self._sorts
        if self._search:
            body["search"] = self._search

        try:
            raw = self._http.post(
                f"/api/tabdata/open/v1/tables/{self._table_id}/records/query",
                json=body,
            )
            records = [
                RecordRow(id=r["id"], fields=r.get("fields", {}))
                for r in raw.get("records", [])
            ]
            result = RecordListResult(
                records=records,
                total=raw.get("total", 0),
                page=raw.get("page", self._page),
                page_size=raw.get("page_size", self._page_size),
                has_more=raw.get("has_more", False),
                latest_version=raw.get("latest_version"),
            )
            return ApiResponse(data=result)
        except TabTinError as e:
            return ApiResponse(error=e)
