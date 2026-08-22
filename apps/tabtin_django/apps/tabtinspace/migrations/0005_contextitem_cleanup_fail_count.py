from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0004_device_add_busy_status'),
    ]

    operations = [
        migrations.AddField(
            model_name='contextitem',
            name='cleanup_fail_count',
            field=models.PositiveSmallIntegerField(
                default=0,
                help_text='TrashCleaner 永久删除失败时递增，超过阈值后跳过常规清理',
                verbose_name='清理失败次数',
            ),
        ),
    ]
