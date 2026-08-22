# ChatContext 协作 Project 投影 FK（仅 schema）。
# 回填见 0070；勿在本文件 RunPython（ / db-single-pg）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0068_chatsession_project_backfill'),
        ('tabtinspace', '0108b_personal_shell_schema_cutover_3266'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatcontext',
            name='current_project',
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='+',
                to='tabtinspace.project',
                verbose_name='当前协作 Project',
            ),
        ),
    ]
