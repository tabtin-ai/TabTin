from django.db import migrations, models
import django.utils.timezone


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0033_external_contact_control_plane"),
    ]

    operations = [
        migrations.AlterField(
            model_name="conversationagentworkspace",
            name="bound_at",
            field=models.DateTimeField(default=django.utils.timezone.now),
        ),
    ]
