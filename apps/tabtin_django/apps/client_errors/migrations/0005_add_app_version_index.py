from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("client_errors", "0004_release"),
    ]

    operations = [
        migrations.AlterField(
            model_name="clienterrorevent",
            name="app_version",
            field=models.CharField(
                "应用版本", max_length=64, blank=True, default="", db_index=True
            ),
        ),
    ]
