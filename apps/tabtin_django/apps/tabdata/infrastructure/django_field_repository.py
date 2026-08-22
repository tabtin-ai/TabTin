"""
DjangoFieldRepository — IFieldRepository 的 Django ORM 实现

职责：
  - 从 TableField ORM 模型加载字段元数据
  - 转换为纯 Python 的 FieldSchema 值对象
  - 所有数据库操作使用 TABDATA_DB_ALIAS 路由到 PostgreSQL

设计决策：
  - FieldSchema 不包含 TableField 的全部字段，只包含 Handler/Aggregate
    在业务逻辑中需要的元数据子集。
  - db_field_name 填充为 field.id 的无连字符 hex 格式（与 NativeRecordIO
    使用的 PostgreSQL 列名约定一致）。
"""
from __future__ import annotations

from typing import Dict, List, Optional
from uuid import UUID

from django.utils import timezone

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import IFieldRepository
from apps.tabdata.domain.value_objects import FieldSchema
from apps.tabdata.models import TableField
from apps.tabdata.utils.choice_utils import (
    extract_choice_values,
    merge_select_choice_values,
)
from apps.tabdata.utils.field_target_validators import MAX_OPTIONS_COUNT


class DjangoFieldRepository(IFieldRepository):

    def __init__(self, db_alias: str = TABDATA_DB_ALIAS) -> None:
        self._db = db_alias

    def get_fields(self, table_id: UUID) -> List[FieldSchema]:
        qs = (
            TableField.objects
            .using(self._db)
            .filter(table_id=table_id, is_deleted=False)
            .order_by('order')
        )
        return [self._orm_to_schema(f) for f in qs]

    def get_field_by_id(self, field_id: UUID) -> Optional[FieldSchema]:
        try:
            orm_obj = (
                TableField.objects
                .using(self._db)
                .get(id=field_id, is_deleted=False)
            )
        except TableField.DoesNotExist:
            return None
        return self._orm_to_schema(orm_obj)

    def merge_select_choices(
        self,
        table_id: UUID,
        values_by_field_id: Dict[str, List[str]],
    ) -> None:
        """在当前写事务内锁住字段并合并新选项，避免覆盖并发新增值。"""
        if not values_by_field_id:
            return

        fields = list(
            TableField.objects
            .using(self._db)
            .select_for_update()
            .filter(
                table_id=table_id,
                id__in=list(values_by_field_id),
                field_type__in=('select', 'multi_select'),
                is_deleted=False,
            )
            .order_by('id')
        )
        dirty: List[TableField] = []
        now = timezone.now()
        for field in fields:
            new_values = values_by_field_id.get(str(field.id)) or []
            if not new_values:
                continue
            config = dict(field.config or {})
            existing = config.get('choices') or []
            existing_values = extract_choice_values(existing)
            if all(value in existing_values for value in new_values):
                continue
            config['choices'] = merge_select_choice_values(
                existing,
                new_values,
                max_options=MAX_OPTIONS_COUNT,
            )
            field.config = config
            field.updated_at = now
            dirty.append(field)

        if dirty:
            TableField.objects.using(self._db).bulk_update(
                dirty,
                ['config', 'updated_at'],
            )

    @staticmethod
    def _orm_to_schema(orm_obj: TableField) -> FieldSchema:
        """TableField ORM 实例 → FieldSchema 值对象。"""
        return FieldSchema(
            id=orm_obj.id,
            name=orm_obj.name,
            field_type=orm_obj.field_type,
            config=orm_obj.config or {},
            is_primary=orm_obj.is_primary,
            default_value=orm_obj.default_value,
            is_deleted=orm_obj.is_deleted,
            db_field_name=orm_obj.id.hex,
            validation_rules=orm_obj.validation_rules or {},
        )
