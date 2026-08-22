from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("notification", "0012_devicepushregistration_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="notification",
            name="dedupe_key",
            field=models.CharField(
                blank=True,
                help_text="仅新通知链路写入；包含接收人维度，历史通知保持 NULL。",
                max_length=160,
                null=True,
                unique=True,
                verbose_name="投递幂等键",
            ),
        ),
    ]
