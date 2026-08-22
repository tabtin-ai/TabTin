from django.db import migrations
from django.db.models import Q


FORWARD_PREFIX_RENAMES = [
    ("workteam_cleanup:", "organization_cleanup:"),
    ("workteam:", "organization:"),
]

REVERSE_PREFIX_RENAMES = [
    (new_prefix, old_prefix)
    for old_prefix, new_prefix in FORWARD_PREFIX_RENAMES
]


def _rewrite_code(code, prefix_renames):
    for source_prefix, target_prefix in prefix_renames:
        if code.startswith(source_prefix):
            return f"{target_prefix}{code[len(source_prefix):]}"
    return code


def _normalize_name(name):
    if not name:
        return name
    return name.replace("Workteam", "Organization")


def _merge_permission_into_target(AdminRolePermission, source_permission_id, target_permission_id):
    role_ids = list(
        AdminRolePermission.objects.filter(permission_id=source_permission_id).values_list(
            "role_id",
            flat=True,
        )
    )
    for role_id in role_ids:
        AdminRolePermission.objects.get_or_create(
            role_id=role_id,
            permission_id=target_permission_id,
        )
    AdminRolePermission.objects.filter(permission_id=source_permission_id).delete()


def _apply_permission_code_renames(apps, prefix_renames):
    AdminPermission = apps.get_model("users_auth", "AdminPermission")
    AdminRolePermission = apps.get_model("users_auth", "AdminRolePermission")

    query = Q()
    for source_prefix, _ in prefix_renames:
        query |= Q(code__startswith=source_prefix)

    legacy_permissions = list(AdminPermission.objects.filter(query).order_by("code"))
    for permission in legacy_permissions:
        target_code = _rewrite_code(permission.code, prefix_renames)
        if target_code == permission.code:
            continue

        target_permission = AdminPermission.objects.filter(code=target_code).first()
        if target_permission and target_permission.id != permission.id:
            _merge_permission_into_target(
                AdminRolePermission=AdminRolePermission,
                source_permission_id=permission.id,
                target_permission_id=target_permission.id,
            )
            permission.delete()
            continue

        updates = {
            "code": target_code,
        }
        if target_code.startswith("organization:") and permission.category == "workteam":
            updates["category"] = "organization"
        normalized_name = _normalize_name(permission.name)
        if normalized_name != permission.name:
            updates["name"] = normalized_name

        AdminPermission.objects.filter(id=permission.id).update(**updates)

    # 兜底：历史数据里可能已是 organization:* 但 category 仍是 workteam。
    if any(target_prefix.startswith("organization:") for _, target_prefix in prefix_renames):
        AdminPermission.objects.filter(
            code__startswith="organization:",
            category="workteam",
        ).update(category="organization")


def forwards(apps, schema_editor):
    _apply_permission_code_renames(apps, FORWARD_PREFIX_RENAMES)


def backwards(apps, schema_editor):
    _apply_permission_code_renames(apps, REVERSE_PREFIX_RENAMES)


class Migration(migrations.Migration):
    dependencies = [
        ("users_auth", "0025_backfill_ops_p1_readonly_permissions"),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
