"""M3b（单库治理）：AttachmentUpload.upload_task / file_record 从跨库 UUIDField
软引用恢复为同库物理 FK（指向 oss.UploadTask / oss.FileRecord）。

注：AttachmentReference.file 不在此列——它走 soft_delete（删 FileRecord 时把引用行
置 is_deleted=True 保留审计 + dangling ref），物理 FK 的 on_delete 表达不了该语义，
故保持 UUIDField 软引用 + tabdata/signals.py 的 soft_delete cascade 信号。

数据安全：SeparateDatabaseAndState——upload_task_id / file_record_id 列与数据原样保留，
DB 侧只新增 FK 约束（列类型已匹配）。on_delete 对齐原 cascade 信号语义：
  - upload_task → CASCADE（删 UploadTask 连带删 AttachmentUpload，NOT NULL）
  - file_record → SET_NULL（删 FileRecord 置空，保留 upload 任务记录）
复合索引 (upload_task_id, status) 物理改名到稳定名 tabd_attup_task_status_idx，使
state 与物理一致。vendor 守卫到 PostgreSQL（dual 下 tabdata/oss 异库无法建跨库约束）。
"""

from django.db import migrations, models
import django.db.models.deletion


_OLD_IDX = "tabdata_att_upload__17ebf6_idx"
_NEW_IDX = "tabd_attup_task_status_idx"
_FKS = [
    # (column, ref_table, on_delete_sql, constraint_name)
    ("upload_task_id", "services_oss_upload_task", "CASCADE", "tabd_attup_upload_task_id_fk_oss_upload_task"),
    ("file_record_id", "services_oss_file_record", "SET NULL", "tabd_attup_file_record_id_fk_oss_file_record"),
]


def add_oss_fks(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        # 复合索引改名到稳定名，使物理与 state 对齐（原为 unnamed 自动名）。
        cursor.execute(
            f'ALTER INDEX IF EXISTS "{_OLD_IDX}" RENAME TO "{_NEW_IDX}"'
        )
        for column, ref_table, on_delete, cname in _FKS:
            cursor.execute("SELECT 1 FROM pg_constraint WHERE conname = %s", [cname])
            if cursor.fetchone():
                continue
            cursor.execute(
                f'ALTER TABLE "tabdata_attachment_upload" ADD CONSTRAINT "{cname}" '
                f'FOREIGN KEY ("{column}") REFERENCES "{ref_table}" ("id") '
                f"ON DELETE {on_delete}"
            )


def drop_oss_fks(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        for _column, _ref, _od, cname in _FKS:
            cursor.execute(f'ALTER TABLE "tabdata_attachment_upload" DROP CONSTRAINT IF EXISTS "{cname}"')
        cursor.execute(f'ALTER INDEX IF EXISTS "{_NEW_IDX}" RENAME TO "{_OLD_IDX}"')


class Migration(migrations.Migration):

    dependencies = [
        ('oss', '0011_add_file_hash_workteam_status_index'),
        ('tabdata', '0037_alter_attachmentreference_created_by_and_more'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RemoveIndex(model_name='attachmentupload', name=_OLD_IDX),
                migrations.RemoveField(model_name='attachmentupload', name='upload_task_id'),
                migrations.RemoveField(model_name='attachmentupload', name='file_record_id'),
                migrations.AddField(
                    model_name='attachmentupload',
                    name='upload_task',
                    field=models.ForeignKey(
                        db_column='upload_task_id', help_text='上传任务（oss.UploadTask）',
                        on_delete=django.db.models.deletion.CASCADE, related_name='+',
                        to='oss.uploadtask', verbose_name='OSS上传任务',
                    ),
                ),
                migrations.AddField(
                    model_name='attachmentupload',
                    name='file_record',
                    field=models.ForeignKey(
                        blank=True, db_column='file_record_id', help_text='上传生成的文件（oss.FileRecord）',
                        null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='+',
                        to='oss.filerecord', verbose_name='上传生成的文件',
                    ),
                ),
                migrations.AddIndex(
                    model_name='attachmentupload',
                    index=models.Index(fields=['upload_task', 'status'], name=_NEW_IDX),
                ),
            ],
            database_operations=[
                migrations.RunPython(add_oss_fks, drop_oss_fks),
            ],
        ),
    ]
