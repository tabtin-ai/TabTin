"""
LinkFieldService 适配器

包装 services/link_field_service.py 的 LinkFieldService，实现 ILinkService 端口。

参数转换：
  - FieldSchema → TableField ORM（按 field.id 从 DB 加载）
  - RecordSnapshot → TableRecord ORM（按 record.id 从 DB 加载）
  - 返回值 List[Dict[str, Any]] → List[Dict[str, str]]（类型已兼容）
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import ILinkService
from apps.tabdata.domain.value_objects import FieldSchema, RecordSnapshot

logger = logging.getLogger("tabdata.infrastructure.link_service_adapter")


def _load_table_field(field_id: UUID):
    """从 DB 加载 TableField ORM 实例。不存在时抛 ValueError。"""
    from apps.tabdata.models import TableField
    try:
        return TableField.objects.using(TABDATA_DB_ALIAS).get(id=field_id)
    except TableField.DoesNotExist:
        raise ValueError(f"TableField {field_id} 不存在，无法执行 Link 操作")


def _load_table_record(record_id: UUID):
    """从 DB 加载 TableRecord ORM 实例。不存在时抛 ValueError。"""
    from apps.tabdata.models import TableRecord
    try:
        return TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=record_id)
    except TableRecord.DoesNotExist:
        raise ValueError(f"TableRecord {record_id} 不存在，无法执行 Link 操作")


class DjangoLinkServiceAdapter(ILinkService):
    """ILinkService 的 Django 实现，委托给 LinkFieldService classmethods。"""

    def set_link_cell(
        self,
        field: FieldSchema,
        record: RecordSnapshot,
        linked_ids: List[str],
    ) -> Any:
        """设置 Link 字段的关联值。

        LinkFieldService.set_link_cell 接受 TableField + TableRecord，
        此处从 DB 加载 ORM 对象后委托。
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        orm_field = _load_table_field(field.id)
        orm_record = _load_table_record(record.id)
        return LinkFieldService.set_link_cell(
            field=orm_field,
            record=orm_record,
            new_linked_ids=linked_ids,
        )

    def cleanup_record_links(self, record: RecordSnapshot) -> List[Dict[str, Any]]:
        """清理记录的所有 Link 关系。

        LinkFieldService.cleanup_record_links 接受 TableRecord，
        返回受影响记录的字段级 payload。
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        orm_record = _load_table_record(record.id)
        return LinkFieldService.cleanup_record_links(record=orm_record)

    def propagate_title_change(
        self,
        record: RecordSnapshot,
        new_title: str,
    ) -> List[Dict[str, str]]:
        """主字段变化时传播 Link Title 缓存更新。

        LinkFieldService.propagate_title_change 接受 TableRecord + new_title，
        返回 [{table_id: str, record_id: str}]。
        """
        from apps.tabdata.services.link_field_service import LinkFieldService

        orm_record = _load_table_record(record.id)
        return LinkFieldService.propagate_title_change(
            record=orm_record,
            new_title=new_title,
        )
