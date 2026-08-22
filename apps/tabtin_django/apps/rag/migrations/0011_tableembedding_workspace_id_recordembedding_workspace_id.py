# Generated for DA-004 fix: 为 TableEmbedding/RecordEmbedding 添加顶层 workspace_id 字段
# 用于数据库索引高效过滤，与 DocumentEmbedding 设计对齐
# metadata.workspace_id 作为兼容冗余字段继续存在

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0010_alter_documentembedding_status_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='tableembedding',
            name='workspace_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 workspace 过滤；与 metadata.workspace_id 保持同步',
                null=True,
                verbose_name='工作空间ID',
            ),
        ),
        migrations.AddField(
            model_name='recordembedding',
            name='workspace_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余顶层字段，用于高效按 workspace 过滤；与 metadata.workspace_id 保持同步',
                null=True,
                verbose_name='工作空间ID',
            ),
        ),
    ]
