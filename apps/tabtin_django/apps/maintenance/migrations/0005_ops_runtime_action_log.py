from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("maintenance", "0004_ops_p1_readonly_permissions"),
    ]

    operations = [
        migrations.CreateModel(
            name="OpsRuntimeActionLog",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("action_type", models.CharField(db_index=True, max_length=40)),
                ("target_type", models.CharField(blank=True, db_index=True, default="", max_length=80)),
                ("target_id", models.CharField(blank=True, db_index=True, default="", max_length=160)),
                ("source", models.CharField(blank=True, db_index=True, default="", max_length=80)),
                ("queue", models.CharField(blank=True, db_index=True, default="", max_length=100)),
                ("task_name", models.CharField(blank=True, default="", max_length=500)),
                ("before_status", models.CharField(blank=True, default="", max_length=80)),
                ("after_status", models.CharField(blank=True, default="", max_length=80)),
                ("ticket_id", models.CharField(blank=True, db_index=True, default="", max_length=100)),
                ("operator_id", models.CharField(blank=True, db_index=True, default="", max_length=36)),
                ("operator_name", models.CharField(blank=True, default="", max_length=255)),
                ("request_payload_sanitized", models.JSONField(blank=True, default=dict)),
                ("result", models.CharField(blank=True, db_index=True, default="", max_length=40)),
                ("error_message", models.TextField(blank=True, default="")),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "Ops Runtime 治理动作日志",
                "verbose_name_plural": "Ops Runtime 治理动作日志",
                "db_table": "ops_runtime_action_log",
                "ordering": ["-created_at"],
                "permissions": [
                    ("runtime_action:retry", "Can retry one runtime object"),
                    ("runtime_action:resolve", "Can resolve one runtime object"),
                    ("runtime_action:cleanup", "Can cleanup runtime terminal failures"),
                ],
            },
        ),
        migrations.AddIndex(
            model_name="opsruntimeactionlog",
            index=models.Index(fields=["action_type", "created_at"], name="ops_rtal_action_time_idx"),
        ),
        migrations.AddIndex(
            model_name="opsruntimeactionlog",
            index=models.Index(fields=["source", "target_id", "created_at"], name="ops_rtal_source_target_idx"),
        ),
        migrations.AddIndex(
            model_name="opsruntimeactionlog",
            index=models.Index(fields=["queue", "created_at"], name="ops_rtal_queue_time_idx"),
        ),
        migrations.CreateModel(
            name="OpsRuntimeResolution",
            fields=[
                ("id", models.BigAutoField(primary_key=True, serialize=False)),
                ("source", models.CharField(db_index=True, max_length=80)),
                ("target_id", models.CharField(db_index=True, max_length=160)),
                ("target_type", models.CharField(blank=True, db_index=True, default="", max_length=80)),
                ("status", models.CharField(db_index=True, default="resolved", max_length=40)),
                ("reason", models.TextField()),
                ("ticket_id", models.CharField(db_index=True, max_length=100)),
                ("resolved_by", models.CharField(blank=True, db_index=True, default="", max_length=36)),
                ("resolved_at", models.DateTimeField()),
            ],
            options={
                "verbose_name": "Ops Runtime 处理覆盖记录",
                "verbose_name_plural": "Ops Runtime 处理覆盖记录",
                "db_table": "ops_runtime_resolution",
                "ordering": ["-resolved_at"],
                "unique_together": {("source", "target_id")},
            },
        ),
        migrations.AddIndex(
            model_name="opsruntimeresolution",
            index=models.Index(fields=["source", "status", "resolved_at"], name="ops_rtr_source_status_idx"),
        ),
        migrations.AddIndex(
            model_name="opsruntimeresolution",
            index=models.Index(fields=["ticket_id", "resolved_at"], name="ops_rtr_ticket_time_idx"),
        ),
    ]
