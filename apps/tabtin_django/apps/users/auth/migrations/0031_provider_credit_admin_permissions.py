from django.db import migrations


PERMISSIONS = [
    (
        "provider_credit:view",
        "查看供应商赠送额度",
        "provider_credit",
        "medium",
        "查看活动、Grant、流水和供应商报表",
    ),
    (
        "provider_credit:operate",
        "运营供应商赠送额度",
        "provider_credit",
        "high",
        "创建活动、手工发放和调整 Grant",
    ),
    (
        "provider_credit:admin",
        "管理供应商赠送额度",
        "provider_credit",
        "critical",
        "修改活动配置、启停活动和撤销 Grant",
    ),
]


def forwards(apps, schema_editor):
    AdminPermission = apps.get_model("users_auth", "AdminPermission")
    AdminRole = apps.get_model("users_auth", "AdminRole")
    AdminRolePermission = apps.get_model("users_auth", "AdminRolePermission")

    created_permissions = {}
    for code, name, category, risk_level, description in PERMISSIONS:
        permission, _ = AdminPermission.objects.update_or_create(
            code=code,
            defaults={
                "name": name,
                "category": category,
                "risk_level": risk_level,
                "description": description,
                "is_active": True,
            },
        )
        created_permissions[code] = permission

    super_admin = AdminRole.objects.filter(code="super_admin").first()
    if super_admin is not None:
        for permission in created_permissions.values():
            AdminRolePermission.objects.get_or_create(
                role=super_admin,
                permission=permission,
            )


def backwards(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0030_backfill_team_member_add_permission"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]

