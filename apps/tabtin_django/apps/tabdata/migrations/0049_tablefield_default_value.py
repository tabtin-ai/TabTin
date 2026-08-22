from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("tabdata", "0048_alter_table_space_id")]

    operations = [
        migrations.AddField(
            model_name="tablefield",
            name="default_value",
            field=models.JSONField(blank=True, default=None, help_text="统一字段默认值：literal / created_time / last_modified_time / creator", null=True, verbose_name="默认值"),
        ),
    ]
