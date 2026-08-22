from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("search_provider:delete", "删除搜索 Provider", "model", "high"),
    ("provider:delete", "删除 Provider", "model", "high"),
    ("provider_key:delete", "删除 Provider Key", "model", "high"),
    ("workteam_cleanup:retry", "重试 Workteam 清理任务", "risk_ops", "high"),
    ("platform_config:update", "更新平台配置", "admin_governance", "high"),
]

ROLE_PERMISSION_BINDINGS = {
    "super_admin": {
        "search_provider:delete",
        "provider:delete",
        "provider_key:delete",
        "workteam_cleanup:retry",
        "platform_config:update",
    },
    "model_admin": {
        "search_provider:delete",
        "provider:delete",
        "provider_key:delete",
    },
    "billing_admin": {
        "workteam_cleanup:retry",
    },
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
            if not permission:
                continue
            AdminRolePermission.objects.get_or_create(role=role, permission=permission)


def backwards(apps, schema_editor):
    # 历史环境回填的权限不在回滚时删除，避免影响线上已依赖的权限模型。
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0015_admin_rbac"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
