from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0083_session_share_per_card_grants"),
    ]

    operations = [
        migrations.AlterField(
            model_name="sessionshare",
            name="card_message_id",
            field=models.BigIntegerField(
                blank=True,
                help_text="腾讯会话内消息序号，仅用于展示与诊断。",
                null=True,
                verbose_name="IM 卡片消息序号",
            ),
        ),
        migrations.AddField(
            model_name="sessionshare",
            name="card_message_ref",
            field=models.UUIDField(
                blank=True,
                help_text="tabtin-im 发送回执对应的稳定 MessageRef，用于原消息刷新。",
                null=True,
                unique=True,
                verbose_name="IM 卡片稳定消息引用",
            ),
        ),
    ]
