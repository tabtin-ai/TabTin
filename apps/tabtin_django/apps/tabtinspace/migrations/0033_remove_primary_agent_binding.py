from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0032_primary_agent_binding"),
    ]

    operations = [
        migrations.DeleteModel(
            name="PrimaryAgentBinding",
        ),
    ]
