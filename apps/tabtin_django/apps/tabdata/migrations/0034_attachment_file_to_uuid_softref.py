"""v0.1 宪法 §5.1（2026-05-07 收尾）：``AttachmentReference.file`` 和
``AttachmentUpload.file_record`` FK → UUIDField 软引用。

== 背景 ==

tabdata 在 PG / oss.FileRecord 在 MySQL。原 ``ForeignKey(db_constraint=False)``
反向 cascade 跨库会爆：

    FileRecord.delete()
      → Django Collector 用 'default' (MySQL) alias 反向查 tabdata_attachment_*
      → MySQL 上没有这些表（在 PG）
      → ProgrammingError

同时影响 OSS rollback 路径（``apps/tabdata/api_open_storage.py:317`` 的
``file_record.delete()`` 静默失败 → OSS bucket 孤儿对象累积）。

== 修复 ==

FK → UUIDField 软引用 + ``@property`` accessor：
- ``AttachmentReference.file`` （原 CASCADE） + ``AttachmentUpload.file_record`` （原 SET_NULL）
- 原 cascade 语义改由 ``apps/services/oss/signals.py:cascade_tabdata_attachments_on_file_delete``
  在 FileRecord ``pre_delete`` 主动维护

== Constraint 调整 ==

``AttachmentReference.Meta.constraints`` 里的 ``UniqueConstraint(fields=['record',
'field', 'file'])`` 改为 ``fields=['record', 'field', 'file_id']``——同名约束
``uniq_active_attachment_reference`` 在 DB 上不需要重建（column 名 ``file_id``
不变，仅 ORM state 字段引用换名）。
"""

from django.db import migrations, models
from django.db.models import Q


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0033_add_percent_currency_choices"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                # ── AttachmentUpload.file_record FK → UUIDField ──
                migrations.RemoveField(
                    model_name="attachmentupload",
                    name="file_record",
                ),
                migrations.AddField(
                    model_name="attachmentupload",
                    name="file_record_id",
                    field=models.UUIDField(
                        blank=True,
                        db_index=True,
                        null=True,
                        verbose_name="上传生成的文件 ID",
                        help_text="软引用 oss.FileRecord.id（v0.1 §5.1）",
                    ),
                ),
                # ── AttachmentReference.file FK → UUIDField ──
                # constraint 引用 file 字段，先 RemoveConstraint 再 RemoveField
                migrations.RemoveConstraint(
                    model_name="attachmentreference",
                    name="uniq_active_attachment_reference",
                ),
                migrations.RemoveField(
                    model_name="attachmentreference",
                    name="file",
                ),
                migrations.AddField(
                    model_name="attachmentreference",
                    name="file_id",
                    field=models.UUIDField(
                        db_index=True,
                        verbose_name="文件记录 ID",
                        help_text="软引用 oss.FileRecord.id（v0.1 §5.1）",
                    ),
                ),
                migrations.AddConstraint(
                    model_name="attachmentreference",
                    constraint=models.UniqueConstraint(
                        fields=["record", "field", "file_id"],
                        condition=Q(is_deleted=False),
                        name="uniq_active_attachment_reference",
                    ),
                ),
                # 旧 implicit index ``tabdata_att_file_id_c3aa35_idx`` 用 fields=['file', ...]，
                # 改 fields=['file_id', ...] 同名 hash 实际不变，但 state 元数据要切。
                # SeparateDatabaseAndState 下 DB 物理 index 不动（column 名 file_id 不变）。
                migrations.RemoveIndex(
                    model_name="attachmentreference",
                    name="tabdata_att_file_id_c3aa35_idx",
                ),
                migrations.AddIndex(
                    model_name="attachmentreference",
                    index=models.Index(
                        fields=["file_id", "is_deleted"],
                        name="tabdata_att_file_id_c3aa35_idx",
                    ),
                ),
            ],
            database_operations=[],
        ),
    ]
