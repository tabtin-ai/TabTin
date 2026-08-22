"""
DjangoRecordRepository — IRecordRepository 的 Django ORM 实现

职责：
  - 包装 TableRecord ORM 模型的 CRUD 操作
  - 在 RecordSnapshot 值对象与 TableRecord ORM 模型之间做双向转换
  - 所有数据库操作使用 TABDATA_DB_ALIAS 路由到 PostgreSQL

设计决策：
  - 写入时设置 _skip_record_history = True，阻止 Django Signal 中的历史记录逻辑。
    在 DDD 架构中，历史记录由 RecordHistorySubscriber 通过 EventBus 驱动，
    不再依赖 Signal。step1 阶段两套机制共存，此标记防止重复写入。
  - 读取时通过 read_data() 统一访问层获取数据，优先从原生列缓存读取，
    避免触发已废弃的 JSONField DeprecationWarning。
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional
from uuid import UUID

from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import IRecordRepository
from apps.tabdata.domain.value_objects import RecordSnapshot
from apps.tabdata.models import Table, TableRecord
from apps.tabdata.services.view_version_sync import mark_table_record_delete_version
from apps.tabdata.utils.record_data_access import read_data

logger = logging.getLogger('tabdata.infrastructure.record_repository')


class DjangoRecordRepository(IRecordRepository):

    def __init__(self, db_alias: str = TABDATA_DB_ALIAS) -> None:
        self._db = db_alias

    # ── 写入 ──────────────────────────────────────────────────────

    def insert(self, record: RecordSnapshot) -> None:
        orm_obj = self._snapshot_to_orm(record)
        orm_obj._skip_record_history = True
        try:
            orm_obj.save(using=self._db, force_insert=True)
        finally:
            self._clear_skip_flag(orm_obj)

    def insert_many(self, records: List[RecordSnapshot]) -> None:
        if not records:
            return
        orm_objs = [self._snapshot_to_orm(r) for r in records]
        for obj in orm_objs:
            obj._skip_record_history = True
        TableRecord.objects.using(self._db).bulk_create(orm_objs)

    def update_one(
        self,
        record_id: UUID,
        data: Dict[str, Any],
        version: int,
        updated_by: Optional[str] = None,
    ) -> bool:
        update_values: Dict[str, Any] = {
            'data': data,
            'version': version,
            'updated_at': timezone.now(),
        }
        if updated_by:
            update_values['updated_by_id'] = updated_by

        # 把 is_deleted=False 放进实际 UPDATE 条件，而非先读后写。这样删除
        # tombstone 抢先提交时，迟到修改返回 False，不能再改 tombstone 或发事件。
        affected = TableRecord.objects.using(self._db).filter(
            id=record_id,
            is_deleted=False,
        ).update(**update_values)
        return affected > 0

    def update_many(self, updates: List[Dict[str, Any]]) -> None:
        if not updates:
            return
        for item in updates:
            record_id: UUID = item['record_id']
            data: Dict[str, Any] = item['data']
            version: int = item['version']
            updated_by: Optional[str] = item.get('updated_by')

            orm_obj = TableRecord.objects.using(self._db).get(
                id=record_id, is_deleted=False,
            )
            orm_obj.__dict__['data'] = data
            orm_obj.version = version
            if updated_by:
                orm_obj.updated_by_id = updated_by

            update_fields = ['data', 'version', 'updated_at']
            if updated_by:
                update_fields.append('updated_by_id')

            orm_obj._skip_record_history = True
            try:
                orm_obj.save(using=self._db, update_fields=update_fields)
            finally:
                self._clear_skip_flag(orm_obj)

    # ── 删除 ──────────────────────────────────────────────────────

    def delete(self, record_id: UUID) -> bool:
        deleted_count, _ = TableRecord.objects.using(self._db).filter(
            id=record_id,
            is_deleted=False,
        ).delete()
        return deleted_count > 0

    def delete_many(self, record_ids: List[UUID]) -> None:
        if not record_ids:
            return
        TableRecord.objects.using(self._db).filter(
            id__in=record_ids, is_deleted=False,
        ).delete()

    def mark_delete_version(self, table_id: UUID, version: int) -> None:
        mark_table_record_delete_version(
            table_id=table_id,
            version=version,
            db_alias=self._db,
        )

    # ── 版本分配 ──────────────────────────────────────────────────

    def next_version(self, table_id: UUID, count: int = 1) -> int:
        from apps.tabdata.services.record_service import next_record_version
        return next_record_version(table_id, count)

    # ── 读取 ──────────────────────────────────────────────────────

    def get_by_id(self, record_id: UUID) -> Optional[RecordSnapshot]:
        try:
            orm_obj = TableRecord.objects.using(self._db).get(
                id=record_id, is_deleted=False,
            )
        except TableRecord.DoesNotExist:
            return None
        return self._orm_to_snapshot(orm_obj)

    def get_by_ids(self, record_ids: List[UUID]) -> List[RecordSnapshot]:
        if not record_ids:
            return []
        orm_objs = TableRecord.objects.using(self._db).filter(
            id__in=record_ids, is_deleted=False,
        )
        return [self._orm_to_snapshot(obj) for obj in orm_objs]

    def lock_table(self, table_id: UUID) -> None:
        # 不变量：任何可能同时触及 Record 与 Field 的写事务，首把业务行锁
        # 必须是 Table；拿到此闸门后，内部 Record/Field 次序不再形成跨事务环。
        (
            Table.objects.using(self._db)
            .select_for_update()
            .only('id')
            .get(id=table_id)
        )

    def get_by_id_for_update(self, record_id: UUID) -> Optional[RecordSnapshot]:
        try:
            orm_obj = (
                TableRecord.objects.using(self._db)
                .select_for_update()
                .get(id=record_id, is_deleted=False)
            )
        except TableRecord.DoesNotExist:
            return None
        return self._orm_to_snapshot(orm_obj)

    def get_by_ids_for_update(self, record_ids: List[UUID]) -> List[RecordSnapshot]:
        if not record_ids:
            return []
        orm_objs = (
            TableRecord.objects.using(self._db)
            .select_for_update()
            .filter(id__in=record_ids, is_deleted=False)
            .order_by('id')
        )
        return [self._orm_to_snapshot(obj) for obj in orm_objs]

    # ── 转换 ──────────────────────────────────────────────────────

    @staticmethod
    def _snapshot_to_orm(snapshot: RecordSnapshot) -> TableRecord:
        """RecordSnapshot → TableRecord ORM 实例（未 save）。"""
        return TableRecord(
            id=snapshot.id,
            table_id=snapshot.table_id,
            data=snapshot.formatted_data,
            version=snapshot.version,
            order=snapshot.order_value if snapshot.order_value is not None else 0,
            created_by_id=snapshot.created_by,
            updated_by_id=snapshot.updated_by or snapshot.created_by,
            is_deleted=snapshot.is_deleted,
        )

    @staticmethod
    def _orm_to_snapshot(orm_obj: TableRecord) -> RecordSnapshot:
        """TableRecord ORM 实例 → RecordSnapshot。"""
        data = read_data(orm_obj)
        return RecordSnapshot(
            id=orm_obj.id,
            table_id=orm_obj.table_id,
            formatted_data=dict(data) if data else {},
            version=orm_obj.version or 0,
            created_by=str(orm_obj.created_by_id) if orm_obj.created_by_id else None,
            updated_by=str(orm_obj.updated_by_id) if orm_obj.updated_by_id else None,
            created_at=orm_obj.created_at,
            updated_at=orm_obj.updated_at,
            is_deleted=orm_obj.is_deleted,
            order_value=orm_obj.order,
        )

    @staticmethod
    def _clear_skip_flag(orm_obj: TableRecord) -> None:
        try:
            delattr(orm_obj, '_skip_record_history')
        except AttributeError:
            pass
