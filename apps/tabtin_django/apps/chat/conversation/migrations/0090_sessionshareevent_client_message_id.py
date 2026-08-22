from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0089_sessionshareresourcegrant_permissions"),
    ]

    operations = [
        migrations.AddField(
            model_name="sessionshareevent",
            name="client_message_id",
            field=models.UUIDField(
                blank=True,
                null=True,
                verbose_name="共享发言客户端消息ID",
            ),
        ),
        migrations.AddConstraint(
            model_name="sessionshareevent",
            constraint=models.UniqueConstraint(
                condition=models.Q(
                    event_type="chatted",
                    client_message_id__isnull=False,
                ),
                fields=("share", "client_message_id"),
                name="uq_share_chatted_client_msg",
            ),
        ),
    ]
