from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("agent_engine", "0021_backfill_execution_run_sequences"),
    ]

    operations = [
        migrations.AddConstraint(
            model_name="executionrun",
            constraint=models.UniqueConstraint(
                fields=("session_id", "sequence"),
                name="uq_run_session_sequence",
            ),
        ),
    ]
