"""
NativeRecordIO 适配器

包装 native/record_io.py 的 NativeRecordIO，实现 INativeRecordIO 端口。

参数映射：
  - Port.update_record(system_values=) → NativeRecordIO.update_record(system_updates=)
  - Port.delete_record(updated_by: str) → NativeRecordIO.delete_record(updated_by: UUID)
  - Port.bulk_delete_records → 逐条调用 delete_record（原生层无批量删除方法）
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from apps.tabdata.domain.ports import INativeRecordIO
from apps.tabdata.native.record_io import NativeRecordIO

logger = logging.getLogger("tabdata.infrastructure.native_io_adapter")


class NativeRecordIOAdapter(INativeRecordIO):
    """INativeRecordIO 的 Django 实现，委托给 NativeRecordIO。

    支持两种使用方式：
    1. 构造时传入 space_id/table_id（立即可用）
    2. 无参构造 + 后续调用 configure()（延迟初始化，供 Factory 使用）
    """

    def __init__(self, space_id: UUID = None, table_id: UUID = None, *, db_alias: Optional[str] = None):
        self._space_id = space_id
        self._table_id = table_id
        self._db_alias = db_alias
        self._io: Optional[NativeRecordIO] = None
        if space_id is not None and table_id is not None:
            self._build_io()

    def configure(self, *, space_id: UUID, table_id: UUID) -> None:
        """设置或切换目标表。相同 table 不重建实例。"""
        if self._io is not None and self._table_id == table_id and self._space_id == space_id:
            return
        self._space_id = space_id
        self._table_id = table_id
        self._build_io()

    def _build_io(self) -> None:
        kwargs: Dict[str, Any] = {"space_id": self._space_id, "table_id": self._table_id}
        if self._db_alias is not None:
            kwargs["db_alias"] = self._db_alias
        self._io = NativeRecordIO(**kwargs)

    def _ensure_io(self) -> NativeRecordIO:
        if self._io is None:
            raise RuntimeError(
                "NativeRecordIOAdapter 未配置。"
                "请先调用 configure(space_id=..., table_id=...) 或构造时传入参数。"
            )
        return self._io

    # ------------------------------------------------------------------
    # INSERT
    # ------------------------------------------------------------------

    def insert_record(
        self,
        record_id: UUID,
        field_values: Dict,
        system_values: Dict,
    ) -> None:
        self._ensure_io().insert_record(
            record_id=record_id,
            field_values=field_values,
            system_values=system_values or None,
        )

    def bulk_insert_records(self, records: List[Dict]) -> None:
        if records:
            self._ensure_io().bulk_insert_records(records)

    # ------------------------------------------------------------------
    # UPDATE
    # ------------------------------------------------------------------

    def update_record(
        self,
        record_id: UUID,
        field_values: Dict,
        system_values: Dict,
    ) -> None:
        self._ensure_io().update_record(
            record_id=record_id,
            field_values=field_values or None,
            system_updates=system_values or None,
        )

    def bulk_update_records(self, updates: List[Dict]) -> None:
        if updates:
            self._ensure_io().bulk_update_records(updates)

    # ------------------------------------------------------------------
    # DELETE
    # ------------------------------------------------------------------

    def delete_record(
        self,
        record_id: UUID,
        version: int,
        updated_by: Optional[str] = None,
    ) -> None:
        ub: Optional[UUID] = None
        if updated_by:
            try:
                ub = UUID(updated_by)
            except (TypeError, ValueError):
                logger.warning("delete_record 收到无效 updated_by: %s", updated_by)
        self._ensure_io().delete_record(
            record_id=record_id,
            version=version,
            updated_by=ub,
        )

    def bulk_delete_records(
        self,
        record_ids: List[UUID],
        updated_by: Optional[str] = None,
        versions: Optional[Dict[UUID, int]] = None,
    ) -> None:
        ub: Optional[UUID] = None
        if updated_by:
            try:
                ub = UUID(updated_by)
            except (TypeError, ValueError):
                logger.warning("bulk_delete_records 收到无效 updated_by: %s", updated_by)
        for rid in record_ids:
            version = versions.get(rid, 0) if versions else 0
            self._ensure_io().delete_record(
                record_id=rid,
                version=version,
                updated_by=ub,
            )
