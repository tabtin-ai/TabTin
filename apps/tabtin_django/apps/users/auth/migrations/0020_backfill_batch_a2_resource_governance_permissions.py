from django.db import migrations


PERMISSIONS_TO_BACKFILL = [
    ("trash:restore", "恢复回收站资源", "risk_ops", "high"),
    ("trash:delete", "永久删除回收站资源", "risk_ops", "critical"),
    ("trash:cleanup", "强制清理回收站", "risk_ops", "critical"),
    ("doc:permission_update", "更新文档权限覆盖", "risk_ops", "high"),
    ("share:list", "查看分享链接", "risk_ops", "medium"),
    ("share:revoke", "撤销分享链接", "risk_ops", "high"),
    ("mail:update_status", "更新邮件账户状态", "risk_ops", "high"),
    ("device:view", "查看客户端设备", "risk_ops", "medium"),
    ("device:block", "封禁客户端设备", "risk_ops", "critical"),
    ("device:unblock", "恢复客户端设备", "risk_ops", "high"),
    ("session:view", "查看客户端 Session", "risk_ops", "medium"),
    ("session:revoke", "吊销客户端 Session", "risk_ops", "critical"),
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

    role = AdminRole.objects.filter(code="super_admin").first()
    if not role:
        return
    for permission_code in ROLE_PERMISSION_BINDINGS["super_admin"]:
        permission = permission_by_code.get(permission_code)
        if permission:
            AdminRolePermission.objects.get_or_create(role=role, permission=permission)


def backwards(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0019_keep_only_super_admin_system_role"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
