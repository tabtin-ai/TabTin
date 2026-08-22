from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0012_widen_llmusagefact_request_id"),
    ]

    operations = [
        migrations.AlterField(
            model_name="llmrequest",
            name="request_id",
            field=models.CharField(max_length=255, unique=True, verbose_name="请求ID"),
        ),
    ]
