from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0064_space_first_shadow_space_cleanup"),
    ]

    operations = [
        migrations.AlterField(
            model_name="space",
            name="type",
            field=models.CharField(
                choices=[("bot", "Bot")],
                default="bot",
                max_length=20,
                verbose_name="Space 类型",
            ),
        ),
    ]
