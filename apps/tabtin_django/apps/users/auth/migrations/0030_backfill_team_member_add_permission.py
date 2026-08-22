from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("team_member:add", "直接添加组织成员", "team_member", "high"),
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
    AdminPermission = apps.get_model("users_auth", "AdminPermission")
    AdminPermission.objects.filter(code__in=[c for c, *_ in PERMISSIONS_TO_BACKFILL]).delete()


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0029_user_profile_revision"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
