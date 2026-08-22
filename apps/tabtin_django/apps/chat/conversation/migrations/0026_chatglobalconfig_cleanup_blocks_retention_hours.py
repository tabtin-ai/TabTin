from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0025_chatmessage_client_event_id'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatglobalconfig',
            name='cleanup_blocks_retention_hours',
            field=models.IntegerField(
                default=24,
                verbose_name='blocks_json 完整保留时长(小时)',
                help_text='超过此时长的消息 blocks_json 中 thinking/tool_call 的大字段会被自动瘦身，保留结构化元数据',
            ),
        ),
    ]
