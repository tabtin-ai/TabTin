from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("llm", "0040_kimi_cny_pricing_alignment"),
    ]

    operations = [
        migrations.AddField(
            model_name="llmprovider",
            name="default_base_url",
            field=models.URLField(
                blank=True,
                default="",
                help_text="仅用于创建模型时预填；模型运行时以自身 base_url 为准。",
                verbose_name="默认端点 URL",
            ),
        ),
    ]
