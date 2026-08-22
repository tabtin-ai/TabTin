from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabdata', '0056_retire_hidden_fields_and_record_trash'),
    ]

    operations = [
        migrations.AddField(
            model_name='table',
            name='record_delete_version',
            field=models.PositiveBigIntegerField(
                default=0,
                help_text='最近一次成功物理删除记录时分配的版本，用于要求增量客户端全量刷新',
                verbose_name='记录删除版本',
            ),
        ),
    ]
