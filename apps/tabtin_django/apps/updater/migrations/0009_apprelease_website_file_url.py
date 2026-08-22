from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("updater", "0008_clientversionpolicy_soft_prompt_enabled"),
    ]

    operations = [
        migrations.AddField(
            model_name="apprelease",
            name="website_file_url",
            field=models.URLField(
                blank=True,
                default="",
                help_text="官网手动下载安装包地址 (CDN)；mac 为 .dmg，win 可空并回退 file_url",
            ),
        ),
    ]
