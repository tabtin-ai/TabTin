"""
EmbeddingTask 增加 workspace_id 冗余字段，用于快速按 workspace 过滤任务。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0003_documentembedding'),
    ]

    operations = [
        migrations.AddField(
            model_name='embeddingtask',
            name='workspace_id',
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text='冗余字段，用于快速按 workspace 过滤任务',
                null=True,
                verbose_name='工作空间ID',
            ),
        ),
    ]
