# Generated manually for Admin Ops P0 governance.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("maintenance", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="OpsTroubleshootQueryLog",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("actor_user_id", models.CharField(blank=True, db_index=True, default="", max_length=36)),
                ("actor_admin_account_id", models.CharField(blank=True, default=None, max_length=36, null=True)),
                ("query_type", models.CharField(db_index=True, max_length=80)),
                ("target_user_id", models.CharField(blank=True, default="", max_length=36)),
                ("target_workteam_id", models.CharField(blank=True, default="", max_length=100)),
                ("target_entity_type", models.CharField(blank=True, default="", max_length=80)),
                ("target_entity_id", models.CharField(blank=True, default="", max_length=160)),
                ("reason", models.TextField()),
                ("ticket_id", models.CharField(blank=True, default="", max_length=100)),
                ("time_range_start", models.DateTimeField(blank=True, null=True)),
                ("time_range_end", models.DateTimeField(blank=True, null=True)),
                ("ip", models.GenericIPAddressField(blank=True, null=True)),
                ("user_agent", models.TextField(blank=True, default="")),
                ("request_id", models.CharField(blank=True, default="", max_length=128)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "Ops 排障查询日志",
                "verbose_name_plural": "Ops 排障查询日志",
                "db_table": "ops_troubleshoot_query_log",
                "ordering": ["-created_at"],
                "permissions": [
                    ("ops_stability:view", "Can view Ops stability overview"),
                    ("ops_user:diagnose", "Can diagnose users in Ops console"),
                    ("ops_task:view", "Can view Ops task queues"),
                    ("ops_realtime:view", "Can view Ops realtime overview"),
                    ("ops_collab:view", "Can view Ops collab overview"),
                    ("ops_search_outbox:view", "Can view Ops search outbox"),
                    ("ops_finance_trace:view", "Can view Ops finance trace"),
                    ("ops_audit:view", "Can view Ops audit events"),
                ],
            },
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["actor_admin_account_id", "created_at"], name="ops_tql_actor_time_idx"),
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["target_user_id", "created_at"], name="ops_tql_user_time_idx"),
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["target_entity_type", "target_entity_id", "created_at"], name="ops_tql_entity_time_idx"),
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["created_at"], name="ops_tql_created_idx"),
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["ticket_id"], name="ops_tql_ticket_idx"),
        ),
        migrations.AddIndex(
            model_name="opstroubleshootquerylog",
            index=models.Index(fields=["request_id"], name="ops_tql_request_idx"),
        ),
    ]
