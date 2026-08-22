from django.db import migrations


LEGACY_SYSTEM_ROLE_CODES = {
    "billing_admin",
    "support_agent",
    "model_admin",
    "risk_admin",
    "finance_viewer",
    "auditor",
}


def forwards(apps, schema_editor):
    AdminRole = apps.get_model("users_auth", "AdminRole")

    # 仅保留 super_admin 作为系统角色，其余历史内置系统角色直接删除。
    AdminRole.objects.filter(code__in=LEGACY_SYSTEM_ROLE_CODES).delete()
    AdminRole.objects.filter(code="super_admin").update(is_system=True, is_active=True)


def backwards(apps, schema_editor):
    return


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0018_backfill_admin_role_crud_permissions"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
