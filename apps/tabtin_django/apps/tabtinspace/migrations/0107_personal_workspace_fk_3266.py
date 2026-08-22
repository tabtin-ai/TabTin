#  终态 · 个人域资产真 FK · 加字段（步骤 3a/N）
#
# 仅 AddField。Django 会把 ForeignKey 的 CREATE INDEX 推迟到本 migration
# schema_editor.__exit__；若同文件还有 RunPython 回填，索引会在 UPDATE 之后
# 刷出并撞 pending trigger events。
#
# 回填见 0107a；复合索引见 0107b。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    # RunPython 的 FK 回填会留下 deferred trigger events；其后的 CREATE INDEX
    # 必须在独立事务执行，否则 PostgreSQL 会拒绝建索引。
    atomic = False

    dependencies = [
        ('agent', '0001_move_agent_from_tabtinspace'),
        ('tabtinspace', '0106a_collection_project_schema_repair_3266'),
    ]

    operations = [
        migrations.AddField(
            model_name='workspace',
            name='agent',
            field=models.ForeignKey(
                blank=True,
                help_text='个人 Workspace 的默认执行 Agent（由 Space.agent id-reuse 迁入）。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='workspaces',
                to='agent.agent',
                verbose_name='默认执行 Agent',
            ),
        ),
        migrations.AddField(
            model_name='collection',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                help_text='个人文件夹直挂 Workspace；团队文件夹写 project。',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='collections',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AddField(
            model_name='contextitem',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                help_text='个人资产直挂 Workspace；团队资产写 project。',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='context_items',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
    ]
