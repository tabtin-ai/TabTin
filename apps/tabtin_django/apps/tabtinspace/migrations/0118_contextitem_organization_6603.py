# ：ContextItem 新增 Organization 归属通道（组织级云盘裸文件 TabFiles
# upload_to_organization 等 org-only 场景）。
#
# 本文件只 AddField。索引与 CheckConstraint 见后续迁移（对齐 ：
# 回填/DDL 分文件，避免 PG pending trigger events）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0117_merge_project_task_run_preparing_and_workspace_agent'),
    ]

    operations = [
        migrations.AddField(
            model_name='contextitem',
            name='organization',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='context_items',
                to='tabtinspace.organization',
                verbose_name='所属 Organization',
                help_text='组织级资产（不挂 workspace/project）时使用；#6603 org-only。',
            ),
        ),
    ]
