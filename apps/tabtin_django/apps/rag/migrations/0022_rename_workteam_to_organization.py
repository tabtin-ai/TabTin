"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('rag', '0021_add_embedding_model_traceability'),
    ]

    operations = [
        migrations.RenameField(model_name='tableembedding', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='recordembedding', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='embeddingtask', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='skillembedding', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='documentembedding', old_name='workteam_id', new_name='organization_id'),
        migrations.RenameField(model_name='codechunkembedding', old_name='workteam_id', new_name='organization_id'),
    ]
