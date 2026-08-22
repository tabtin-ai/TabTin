"""
UX-4: Change show_per_message_cost default from True to False (opt-in).
"""

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('billing', '0020_member_budget_verbose_names'),
    ]

    operations = [
        migrations.AlterField(
            model_name='billingruntimeconfig',
            name='show_per_message_cost',
            field=models.BooleanField(
                default=False,
                help_text='是否在前端 assistant 消息底部展示本条消息消耗的点券数，管理员可开启（opt-in）',
                verbose_name='展示每条消息费用',
            ),
        ),
    ]
