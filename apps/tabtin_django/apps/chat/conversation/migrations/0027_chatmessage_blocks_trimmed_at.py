from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0026_chatglobalconfig_cleanup_blocks_retention_hours'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatmessage',
            name='blocks_trimmed_at',
            field=models.DateTimeField(
                null=True, blank=True, default=None, db_index=True,
                verbose_name='blocks_json 瘦身时间',
                help_text='非空表示 blocks_json 已被定时任务瘦身（thinking/tool_call 大字段已清空）',
            ),
        ),
    ]
