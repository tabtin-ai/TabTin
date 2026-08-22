from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("billing", "0017_storage_eod_snapshot"),
    ]

    operations = [
        migrations.AddField(
            model_name="billingruntimeconfig",
            name="show_per_message_cost",
            field=models.BooleanField(
                default=True,
                help_text="是否在前端 assistant 消息底部展示本条消息消耗的点券数，管理员可关闭以减轻成员费用焦虑",
                verbose_name="展示每条消息费用",
            ),
        ),
    ]
