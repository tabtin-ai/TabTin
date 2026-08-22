"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('maintenance', '0002_ops_troubleshoot_query_log'),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[],
            state_operations=[
                migrations.RenameField(
                    model_name='opstroubleshootquerylog',
                    old_name='target_workteam_id',
                    new_name='target_organization_id',
                ),
                migrations.AlterField(
                    model_name='opstroubleshootquerylog',
                    name='target_organization_id',
                    field=models.CharField(
                        max_length=100,
                        blank=True,
                        default="",
                        db_column="target_workteam_id",
                    ),
                ),
            ],
        ),
    ]
