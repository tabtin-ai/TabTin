import uuid

import django.db.models.deletion
import django.utils.timezone
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("agent_engine", "0022_execution_run_sequence_constraint"),
    ]

    operations = [
        migrations.CreateModel(
            name="RunHostLease",
            fields=[
                (
                    "run",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        primary_key=True,
                        related_name="host_lease",
                        serialize=False,
                        to="agent_engine.executionrun",
                    ),
                ),
                ("host_id", models.CharField(db_index=True, max_length=128)),
                (
                    "lease_token",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        unique=True,
                    ),
                ),
                ("generation", models.PositiveBigIntegerField(default=1)),
                (
                    "claimed_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                (
                    "last_heartbeat_at",
                    models.DateTimeField(default=django.utils.timezone.now),
                ),
                ("lease_expires_at", models.DateTimeField(db_index=True)),
                ("released_at", models.DateTimeField(blank=True, null=True)),
                (
                    "release_reason",
                    models.CharField(blank=True, max_length=64, null=True),
                ),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "db_table": "agent_engine_run_host_leases",
            },
        ),
        migrations.AddIndex(
            model_name="runhostlease",
            index=models.Index(
                fields=["host_id", "released_at"],
                name="idx_run_lease_host_open",
            ),
        ),
    ]
