from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("admin_role:create", "创建后台角色", "admin_governance", "high"),
    ("admin_role:delete", "删除后台角色", "admin_governance", "high"),
]

SYSTEM_ROLE_CODES = {
    "super_admin",
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

    # 保底纠偏：确保内置角色被标记为系统角色，避免前端写保护被绕过。
    AdminRole.objects.filter(code__in=SYSTEM_ROLE_CODES).update(is_system=True, is_active=True)

    super_admin = AdminRole.objects.filter(code="super_admin").first()
    if super_admin:
        for permission in permission_by_code.values():
            AdminRolePermission.objects.get_or_create(role=super_admin, permission=permission)


def backwards(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0017_backfill_stage41_batch2_permissions"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
