"""
AttachmentService 适配器

包装 services/attachment_service.py 的 AttachmentService，实现 IAttachmentService 端口。

参数转换：
  - RecordSnapshot → TableRecord ORM（按 record.id 从 DB 加载）
  - AttachmentService 是实例级服务（继承 BaseService，需要 user），
    适配器在构造时接受 user 并持有内部实例。
"""

from __future__ import annotations

import logging
from typing import List, Optional
from uuid import UUID

from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.domain.ports import IAttachmentService
from apps.tabdata.domain.value_objects import RecordSnapshot

logger = logging.getLogger("tabdata.infrastructure.attachment_adapter")


class DjangoAttachmentAdapter(IAttachmentService):
    """IAttachmentService 的 Django 实现，委托给 AttachmentService。"""

    def __init__(self, user=None):
        """
        Args:
            user: Django User 实例（传递给 AttachmentService 用于
                  FileUsage.add_usage 的 user_id 记录）。
        """
        self._user = user

    def _get_svc(self):
        from apps.tabdata.services.attachment_service import AttachmentService
        return AttachmentService(user=self._user)

    def sync_record_attachments(self, record: RecordSnapshot) -> None:
        """同步记录中的附件引用关系。

        AttachmentService.sync_record_attachments 接受 TableRecord ORM 实例，
        此处从 DB 加载后委托。仅写 DB 引用关系，不做 OSS 网络调用。
        """
        from apps.tabdata.models import TableRecord

        try:
            orm_record = TableRecord.objects.using(TABDATA_DB_ALIAS).select_related(
                "table"
            ).get(id=record.id)
        except TableRecord.DoesNotExist:
            logger.warning(
                "sync_record_attachments 跳过：记录 %s 不存在", record.id,
            )
            return

        self._get_svc().sync_record_attachments(record=orm_record)

    def cleanup_record_attachments(self, record_id: UUID) -> None:
        """记录软删除后批量清理其所有活跃附件引用。"""
        self._get_svc().cleanup_record_attachments(record_id=record_id)

    def cleanup_records_attachments_batch(self, record_ids: List[UUID]) -> None:
        """批量记录软删除后一次性清理所有活跃附件引用。"""
        self._get_svc().cleanup_records_attachments_batch(record_ids=record_ids)

    def cleanup_field_attachments(self, table_id: UUID, field_id: UUID) -> None:
        """字段删除时批量清理该字段所有活跃附件引用。"""
        self._get_svc().cleanup_field_attachments(table_id=table_id, field_id=field_id)
