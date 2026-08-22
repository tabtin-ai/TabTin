from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("integrations_feishu", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="feishuimportjob",
            name="documents",
            field=models.JSONField(blank=True, default=list),
        ),
    ]
