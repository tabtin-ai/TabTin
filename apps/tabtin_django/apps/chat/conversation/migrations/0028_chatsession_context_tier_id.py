from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0027_chatmessage_blocks_trimmed_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='chatsession',
            name='context_tier_id',
            field=models.CharField(
                max_length=64, blank=True, default='',
                verbose_name='上下文档位ID',
                help_text='用户主动选择的上下文档位（如 1M 长上下文）；留空走模型默认档。',
            ),
        ),
    ]
