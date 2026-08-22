# ChatSession 显式协作 Project FK（仅 schema）。
# 回填见 0068；勿在本文件 RunPython（ / db-single-pg）。

from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0066_drop_chatsession_space_fk_3266'),
        ('tabtinspace', '0108b_personal_shell_schema_cutover_3266'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='project',
            field=models.ForeignKey(
                blank=True,
                help_text='可选的协作场归属；不代表执行目录或设备。',
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name='chat_sessions',
                to='tabtinspace.project',
                verbose_name='协作 Project',
            ),
        ),
    ]
