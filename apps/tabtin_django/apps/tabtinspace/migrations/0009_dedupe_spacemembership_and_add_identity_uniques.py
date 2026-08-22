from django.db import migrations, models
from django.db.models import Count


def _first_non_empty(rows, field_name, default):
    for row in rows:
        value = getattr(row, field_name)
        if value not in (None, "", {}, [], ()):
            return value
    return default


def _dedupe_identity_memberships(apps, schema_editor, identity_field: str) -> None:
    db_alias = schema_editor.connection.alias
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")

    duplicate_groups = (
        SpaceMembership.objects.using(db_alias)
        .filter(**{f"{identity_field}__isnull": False})
        .values("space_id", identity_field)
        .annotate(row_count=Count("id"))
        .filter(row_count__gt=1)
    )

    for group in duplicate_groups.iterator():
        rows = list(
            SpaceMembership.objects.using(db_alias)
            .filter(
                space_id=group["space_id"],
                **{identity_field: group[identity_field]},
            )
            .order_by("-is_active", "-updated_at", "-joined_at", "-id")
        )
        if len(rows) <= 1:
            continue

        canonical = rows[0]
        joined_candidates = [row.joined_at for row in rows if row.joined_at]
        updated_candidates = [row.updated_at for row in rows if row.updated_at]

        SpaceMembership.objects.using(db_alias).filter(id=canonical.id).update(
            role=canonical.role,
            permissions=_first_non_empty(rows, "permissions", canonical.permissions or {}),
            is_active=any(row.is_active for row in rows),
            role_label=_first_non_empty(rows, "role_label", canonical.role_label or ""),
            responsibility=_first_non_empty(rows, "responsibility", canonical.responsibility or ""),
            persona_override=_first_non_empty(rows, "persona_override", canonical.persona_override or ""),
            joined_at=min(joined_candidates) if joined_candidates else canonical.joined_at,
            updated_at=max(updated_candidates) if updated_candidates else canonical.updated_at,
        )

        duplicate_ids = [row.id for row in rows[1:]]
        if duplicate_ids:
            SpaceMembership.objects.using(db_alias).filter(id__in=duplicate_ids).delete()


def dedupe_space_memberships(apps, schema_editor) -> None:
    _dedupe_identity_memberships(apps, schema_editor, "agent_id")
    _dedupe_identity_memberships(apps, schema_editor, "user_id")


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0008_alter_contextitem_space_and_more"),
    ]

    operations = [
        migrations.RunPython(
            dedupe_space_memberships,
            migrations.RunPython.noop,
        ),
        migrations.AddConstraint(
            model_name="spacemembership",
            constraint=models.UniqueConstraint(
                fields=("space", "agent"),
                condition=models.Q(agent__isnull=False),
                name="ctx_sm_space_agent_unique",
            ),
        ),
        migrations.AddConstraint(
            model_name="spacemembership",
            constraint=models.UniqueConstraint(
                fields=("space", "user"),
                condition=models.Q(user__isnull=False),
                name="ctx_sm_space_user_unique",
            ),
        ),
    ]
