from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabchat", "0018_resource_access_request"),
    ]

    operations = [
        migrations.AddField(
            model_name="resourceaccessrequest",
            name="source_message_ref",
            field=models.UUIDField(
                blank=True,
                db_index=True,
                help_text="腾讯等消息数据面的稳定 message_ref；本地 Message 不存在时作为来源锚点。",
                null=True,
            ),
        ),
        migrations.AlterField(
            model_name="resourceaccessrequest",
            name="source_message",
            field=models.BigIntegerField(
                blank=True,
                db_column="source_message_id",
                db_index=True,
                help_text="消息数据面的来源 ID；不与 Django Message 表建立外键关系。",
                null=True,
            ),
        ),
    ]
