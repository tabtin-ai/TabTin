from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("ops_beat:view", "查看 Beat 定时任务", "risk_ops", "medium"),
    ("ops_llm_trace:view", "查看 LLM Trace", "risk_ops", "medium"),
    ("ops_oss_status:view", "查看 OSS 业务状态", "risk_ops", "medium"),
    ("ops_sms_status:view", "查看 SMS 业务状态", "risk_ops", "medium"),
    ("ops_dependency_health:view", "查看业务依赖健康", "risk_ops", "medium"),
    ("ops_incident:view", "查看 Incident 影响面占位", "risk_ops", "medium"),
    ("ops_cost_sla:view", "查看成本 / SLA 占位", "risk_ops", "medium"),
]

ROLE_PERMISSION_BINDINGS = {
    "super_admin": {code for code, *_ in PERMISSIONS_TO_BACKFILL},
}


def forwards(apps, schema_editor):
    AdminPermission = apps.get_model("users_auth", "AdminPermission")
    AdminRole = apps.get_model("users_auth", "AdminRole")
    AdminRolePermission = apps.get_model("users_auth", "AdminRolePermission")

    permission_by_code = {}
    for code, name, category, risk_level in PERMISSIONS_TO_BACKFILL:
        permission, _ = AdminPermission.objects.update_or_create(
            code=code,
            defaults={
                "name": name,
                "category": category,
                "risk_level": risk_level,
                "is_active": True,
            },
        )
        permission_by_code[code] = permission

    for role_code, permission_codes in ROLE_PERMISSION_BINDINGS.items():
        role = AdminRole.objects.filter(code=role_code).first()
        if not role:
            continue
        for permission_code in permission_codes:
            permission = permission_by_code.get(permission_code)
            if permission:
                AdminRolePermission.objects.get_or_create(role=role, permission=permission)


def backwards(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        (
            "users_auth",
            "0024_rename_users_auth__worktea_d77dd7_idx_users_auth__organiz_606ddd_idx_and_more",
        ),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
