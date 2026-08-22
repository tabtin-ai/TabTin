"""
TabData 信号处理器

自动化业务逻辑：
1. 表格删除/归档时更新统计
2. 字段变更时更新统计

注意：TableRecord 相关的 signal（行数更新、历史记录写入）已迁移到 DDD 事件驱动体系：
  - 行数 → subscribers/row_count.py (RowCountSubscriber)
  - 历史 → subscribers/record_history.py (RecordHistorySubscriber)
  - RAG  → subscribers/rag_index.py (RAGIndexSubscriber)
  非 DDD 路径通过 subscribers/_utils.py 的补偿函数（refresh_table_row_count /
  notify_record_changed_for_rag）显式触发，不再依赖 Django signal。
"""

from django.db.models.signals import post_save, post_delete, pre_save
from django.dispatch import receiver
from django.utils import timezone
import logging

from .constants import TABDATA_DB_ALIAS
from .models import Table, TableField

logger = logging.getLogger(__name__)


def _refresh_table_counts(table_instance):
    """原子更新 Space 和 Organization 的 table_count，避免并发竞态。"""
    from apps.tabtinspace.models import Organization

    # ：Space.table_count 已随表 DROP；host 侧不再维护冗余计数。

    if table_instance.organization_id:
        Organization.objects.filter(id=table_instance.organization_id).update(
            table_count=Table.objects.using(TABDATA_DB_ALIAS).filter(
                organization_id=table_instance.organization_id, is_archived=False,
            ).count()
        )


@receiver(post_save, sender=Table)
def update_table_counts(sender, instance, created, **kwargs):
    """
    表格创建/恢复归档时更新 Space 和组织的表格计数（原子 update）
    """
    if created or (hasattr(instance, '_archived_changed') and instance._archived_changed):
        try:
            _refresh_table_counts(instance)
        except Exception as e:
            logger.error("更新表格计数失败: %s", e, exc_info=True)


@receiver(post_delete, sender=Table)
def decrease_table_counts(sender, instance, **kwargs):
    """
    表格删除时更新 Space 和组织的表格计数（原子 update）
    """
    try:
        _refresh_table_counts(instance)
    except Exception as e:
        logger.error("更新表格计数失败: %s", e, exc_info=True)


def _update_table_field_count(table):
    """更新表格的字段数量统计（原子更新）"""
    try:
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=table.id).update(
            field_count=table.fields.filter(is_deleted=False).count()
        )
    except Exception as e:
        logger.error("更新表格字段计数失败: %s", e, exc_info=True)


@receiver(pre_save, sender=TableField)
def track_field_delete_change(sender, instance, **kwargs):
    """跟踪字段删除状态变化"""
    if instance.pk:
        try:
            old_instance = TableField.objects.using(TABDATA_DB_ALIAS).get(pk=instance.pk)
            instance._deleted_changed = (old_instance.is_deleted != instance.is_deleted)
        except TableField.DoesNotExist:
            instance._deleted_changed = False
    else:
        instance._deleted_changed = False


@receiver(post_save, sender=TableField)
def update_table_field_count(sender, instance, created, **kwargs):
    """字段新增或删除状态变更时刷新表格字段计数"""
    if created or getattr(instance, '_deleted_changed', False):
        _update_table_field_count(instance.table)


@receiver(post_delete, sender=TableField)
def decrease_table_field_count(sender, instance, **kwargs):
    """字段物理删除时刷新表格字段计数"""
    _update_table_field_count(instance.table)


@receiver(pre_save, sender=Table)
def track_archive_change(sender, instance, **kwargs):
    """
    跟踪表格归档状态变化
    """
    if instance.pk:
        try:
            old_instance = Table.objects.using(TABDATA_DB_ALIAS).get(pk=instance.pk)
            instance._archived_changed = (old_instance.is_archived != instance.is_archived)
        except Table.DoesNotExist:
            instance._archived_changed = False
    else:
        instance._archived_changed = False


# ════════════════════════════════════════════════════════════════════════════
#  v0.1 §5.1 跨库 cascade —— FileRecord ↔ Attachment*（声明引用方负责清理）
# ════════════════════════════════════════════════════════════════════════════
#
# 1. **位置**：cascade 写在「声明跨库引用的 app」即 tabdata（不是被引用方 oss）。
#    避免 oss 反向 import tabdata.models 造成 layer 越界。
# 2. **AttachmentReference cascade 走软删**：业务侧 ``attachment_service.py:remove_reference``
#    走 ``mark_deleted()`` 软删保留审计，cascade 必须对齐——否则用户感知"附件神秘消失"。
# 3. **AttachmentUpload cascade 走 SET_NULL**：保留 upload 任务记录便于排障。
#
# 由 install_softref_cascade factory 一行注册，自动套：
#   - post_delete + transaction.on_commit（主事务 rollback 时不脏写对端库）
#   - 异常吞 warning（孤儿数据由 reconcile_softrefs 命令兜底）
#   - 回填 SoftRefRegistry on_orphan_action

from apps.services.common.cross_db_softref import install_softref_cascade

# AttachmentReference.file 仍是跨生命周期软引用——删 FileRecord 时**软删**引用行
# （置 is_deleted=True 保留审计 + dangling ref）。这是物理 FK 的 on_delete 表达不了的语义
# （FK 只能 cascade/null/restrict，不能"标记行"），故保留为 UUIDField 软引用 + 本 cascade 信号。
install_softref_cascade(
    target_model="oss.FileRecord",
    holder_app_label="tabdata",
    holder_model="AttachmentReference",
    id_attr="file_id",
    action="soft_delete",
    soft_delete_extra_filter={"is_deleted": False},
    soft_delete_set_fields={"is_deleted": True, "deleted_at": timezone.now},
    log_prefix="[tabdata]",
)

# 单库治理（M3b）：AttachmentUpload.file_record / upload_task 已恢复为同库物理 FK
# （on_delete=SET_NULL / CASCADE），删除语义由 Django Collector + DB 约束承载，
# 原 install_softref_cascade(set_null) / (cascade) 两条信号随之退役。

