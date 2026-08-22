"""L102: Shadow 比对结果存储表 + Legacy 快照表。

用于 Outbox Shadow 模式下 record-level 真比对。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdata", "0028_checkpoint_rollback_saga"),
    ]

    operations = [
        migrations.CreateModel(
            name="ShadowLegacySnapshot",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=None,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("outbox_task_id", models.CharField(max_length=32)),
                ("table_id", models.UUIDField()),
                ("record_id", models.UUIDField()),
                ("field_id", models.UUIDField()),
                ("legacy_value", models.TextField(blank=True, default="")),
                ("snapshot_at", models.DateTimeField()),
            ],
            options={
                "db_table": "tabdata_shadow_legacy_snapshot",
            },
        ),
        migrations.CreateModel(
            name="ShadowComparison",
            fields=[
                (
                    "id",
                    models.CharField(
                        default=None,
                        editable=False,
                        max_length=32,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("outbox_task_id", models.CharField(max_length=32)),
                ("table_id", models.UUIDField()),
                ("record_id", models.UUIDField()),
                ("field_id", models.UUIDField()),
                ("legacy_value", models.TextField(blank=True, default="")),
                ("outbox_value", models.TextField(blank=True, default="")),
                ("match", models.BooleanField()),
                ("compared_at", models.DateTimeField()),
            ],
            options={
                "db_table": "tabdata_shadow_comparison",
            },
        ),
        migrations.AddIndex(
            model_name="shadowlegacysnapshot",
            index=models.Index(
                fields=["outbox_task_id"],
                name="idx_sls_task",
            ),
        ),
        migrations.AddIndex(
            model_name="shadowcomparison",
            index=models.Index(
                fields=["outbox_task_id"],
                name="idx_shc_task",
            ),
        ),
        migrations.AddIndex(
            model_name="shadowcomparison",
            index=models.Index(
                condition=models.Q(("match", False)),
                fields=["match"],
                name="idx_shc_match",
            ),
        ),
        migrations.AddIndex(
            model_name="shadowcomparison",
            index=models.Index(
                fields=["compared_at"],
                name="idx_shc_compared_at",
            ),
        ),
        migrations.AddIndex(
            model_name="shadowcomparison",
            index=models.Index(
                fields=["table_id", "compared_at"],
                name="idx_shc_table_time",
            ),
        ),
    ]
