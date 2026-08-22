"""
W5-3: MembershipTier 多维基础包额度字段
"""

from django.core.validators import MinValueValidator
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0012_drop_ai_field_from_features'),
    ]

    operations = [
        migrations.AddField(
            model_name='membershiptier',
            name='included_media_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月媒体生成张数',
                help_text='该等级每月包含的图片/视频生成次数',
            ),
        ),
        migrations.AddField(
            model_name='membershiptier',
            name='included_search_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月联网搜索次数',
            ),
        ),
        migrations.AddField(
            model_name='membershiptier',
            name='included_tts_monthly',
            field=models.IntegerField(
                default=0, validators=[MinValueValidator(0)],
                verbose_name='每月TTS字符数',
            ),
        ),
    ]
