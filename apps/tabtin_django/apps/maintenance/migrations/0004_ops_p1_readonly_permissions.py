from django.db import migrations


OPS_READONLY_PERMISSIONS = [
    ("ops_stability:view", "Can view Ops stability overview"),
    ("ops_user:diagnose", "Can diagnose users in Ops console"),
    ("ops_task:view", "Can view Ops task queues"),
    ("ops_realtime:view", "Can view Ops realtime overview"),
    ("ops_collab:view", "Can view Ops collab overview"),
    ("ops_search_outbox:view", "Can view Ops search outbox"),
    ("ops_finance_trace:view", "Can view Ops finance trace"),
    ("ops_audit:view", "Can view Ops audit events"),
    ("ops_beat:view", "Can view Ops beat tasks"),
    ("ops_llm_trace:view", "Can view Ops LLM traces"),
    ("ops_oss_status:view", "Can view Ops OSS status"),
    ("ops_sms_status:view", "Can view Ops SMS status"),
    ("ops_dependency_health:view", "Can view Ops dependency health"),
    ("ops_incident:view", "Can view Ops incident placeholders"),
    ("ops_cost_sla:view", "Can view Ops cost and SLA placeholders"),
]


class Migration(migrations.Migration):
    dependencies = [
        ("maintenance", "0003_rename_workteam_to_organization"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="opstroubleshootquerylog",
            options={
                "verbose_name": "Ops 排障查询日志",
                "verbose_name_plural": "Ops 排障查询日志",
                "ordering": ["-created_at"],
                "permissions": OPS_READONLY_PERMISSIONS,
            },
        ),
    ]
