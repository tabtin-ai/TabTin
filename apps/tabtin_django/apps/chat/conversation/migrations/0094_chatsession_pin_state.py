from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0093_chatmessagewithdrawevent"),
    ]

    operations = [
        migrations.AddField(
            model_name="chatsession",
            name="is_pinned",
            field=models.BooleanField(default=False, verbose_name="是否置顶"),
        ),
        migrations.AddField(
            model_name="chatsession",
            name="pinned_at",
            field=models.DateTimeField(blank=True, null=True, verbose_name="置顶时间"),
        ),
    ]
