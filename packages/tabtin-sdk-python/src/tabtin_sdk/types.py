"""Core types for the TabTin SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Generic, Optional, TypeVar

T = TypeVar("T")


class TabTinError(Exception):
    """Error returned by the TabTin API."""

    def __init__(
        self,
        message: str,
        status: int = 0,
        code: str = "UNKNOWN",
        detail: Optional[str] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        self.detail = detail


@dataclass
class ApiResponse(Generic[T]):
    """Standard response wrapper — mirrors Supabase {data, error} pattern."""

    data: Optional[T] = None
    error: Optional[TabTinError] = None


@dataclass
class RecordRow:
    id: str
    fields: dict[str, Any]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class RecordListResult:
    records: list[RecordRow]
    total: int = 0
    page: int = 1
    page_size: int = 100
    has_more: bool = False
    latest_version: Optional[int] = None


@dataclass
class SqlQueryResult:
    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
