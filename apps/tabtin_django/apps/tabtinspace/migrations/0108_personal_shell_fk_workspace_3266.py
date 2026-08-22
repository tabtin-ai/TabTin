#  终态 · 个人壳表加 workspace FK（步骤 4a/N）
#
# 仅 AddField。勿与 RunPython 同文件——FK 自动 CREATE INDEX 在
# schema_editor.__exit__ 刷出，会晚于同 migration 内的回填。
#
# 回填见 0108a；Drop space / 重建约束见 0108b。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0107b_personal_workspace_fk_indexes_3266'),
    ]

    operations = [
        migrations.AddField(
            model_name='spaceappsettings',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='app_settings',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AddField(
            model_name='spacepermission',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='permissions',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
        migrations.AddField(
            model_name='spacemembership',
            name='workspace',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.CASCADE,
                related_name='memberships',
                to='tabtinspace.workspace',
                verbose_name='所属 Workspace',
            ),
        ),
    ]
