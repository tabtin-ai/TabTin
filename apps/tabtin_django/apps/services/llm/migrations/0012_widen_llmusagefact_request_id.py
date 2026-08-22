from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0011_llmprovider_capability_domain"),
    ]

    operations = [
        migrations.AlterField(
            model_name="llmusagefact",
            name="request_id",
            field=models.CharField(
                db_index=True,
                max_length=255,
                unique=True,
                verbose_name="请求ID",
            ),
        ),
    ]
