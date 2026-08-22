from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("table:delete", "归档表格", "risk_ops", "high"),
    ("table:restore", "恢复表格", "risk_ops", "high"),
    ("table:repair", "修复表格索引", "risk_ops", "high"),
    ("doc:delete", "归档文档", "risk_ops", "high"),
    ("doc:restore", "恢复文档", "risk_ops", "high"),
    ("slide:delete", "归档演示文稿", "risk_ops", "high"),
    ("slide:restore", "恢复演示文稿", "risk_ops", "high"),
    ("asset:delete", "删除 OSS 文件", "risk_ops", "high"),
    ("asset:repair", "修复 OSS 文件归属", "risk_ops", "high"),
]

ROLE_PERMISSION_BINDINGS = {
    "super_admin": {
        "table:delete",
        "table:restore",
        "table:repair",
        "doc:delete",
        "doc:restore",
        "slide:delete",
        "slide:restore",
        "asset:delete",
        "asset:repair",
    },
    "risk_admin": {
        "table:delete",
        "table:restore",
        "table:repair",
        "doc:delete",
        "doc:restore",
        "slide:delete",
        "slide:restore",
        "asset:delete",
        "asset:repair",
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
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0016_backfill_stage41_permissions"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
