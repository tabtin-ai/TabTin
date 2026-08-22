#  终态 · 步骤 2a/N：Project FK schema 切换。
#
# 依赖 0104 已镜像 team_space Space → Project + SpaceMembership → ProjectMembership
# （id-reuse），本步骤只做服务侧 schema：
#
# 1. ``ProjectMemberWorkspace.project`` FK：Space → Project（数据行 project_id 值不变）。
# 2. ``ProjectTask.project`` FK：Space → Project（同上）。
# 3. ``ContextItem`` / ``Collection``：新增 ``project``，``space`` 改为可空。
#
# team_space 壳物理消解见 0105a（与本文件拆事务，避  / ）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0104_project_real_table_3266'),
    ]

    operations = [
        migrations.AlterField(
            model_name='projectmemberworkspace',
            name='project',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='member_workspaces',
                to='tabtinspace.project',
                verbose_name='所属 Project',
            ),
        ),
        migrations.AlterField(
            model_name='projecttask',
            name='project',
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.CASCADE,
                related_name='project_tasks',
                to='tabtinspace.project',
                verbose_name='所属 Project',
            ),
        ),
        migrations.AddField(
            model_name='contextitem',
            name='project',
            field=models.ForeignKey(
                blank=True,
                help_text='团队资产（Task Deliverable 等）直挂 Project；个人资产写 space。',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='context_items',
                to='tabtinspace.project',
                verbose_name='所属 Project',
            ),
        ),
        migrations.AlterField(
            model_name='contextitem',
            name='space',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='context_items',
                to='tabtinspace.space',
                verbose_name='所属 Space',
            ),
        ),
        # 团队 Collection 改挂 Project，避免删 Space 时 CASCADE 清文件夹。
        migrations.AddField(
            model_name='collection',
            name='project',
            field=models.ForeignKey(
                blank=True,
                help_text='团队文件夹直挂 Project；个人文件夹写 space（后续迁 workspace）。',
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='collections',
                to='tabtinspace.project',
                verbose_name='所属 Project',
            ),
        ),
        migrations.AlterField(
            model_name='collection',
            name='space',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='collections',
                to='tabtinspace.space',
                verbose_name='所属 Space',
            ),
        ),
    ]
