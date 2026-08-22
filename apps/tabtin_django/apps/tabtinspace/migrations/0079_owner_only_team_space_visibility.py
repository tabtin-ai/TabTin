from django.db import migrations


def reset_team_spaces_to_owner_only(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    Space = apps.get_model("tabtinspace", "Space")
    SpaceMembership = apps.get_model("tabtinspace", "SpaceMembership")

    team_spaces = (
        Space.objects.using(db_alias)
        .filter(type="team_space")
        .select_related("workteam")
    )
    for space in team_spaces.iterator():
        Space.objects.using(db_alias).filter(id=space.id).update(visibility="private")

        owner_user_id = getattr(space.workteam, "owner_id", None)
        active_memberships = SpaceMembership.objects.using(db_alias).filter(
            space_id=space.id,
            is_active=True,
        )
        if owner_user_id:
            active_memberships.exclude(user_id=owner_user_id).update(is_active=False)
        else:
            active_memberships.exclude(role="owner").update(is_active=False)
        if not owner_user_id:
            continue

        membership, _created = SpaceMembership.objects.using(db_alias).get_or_create(
            space_id=space.id,
            user_id=owner_user_id,
            defaults={"role": "owner", "is_active": True},
        )
        updates = []
        if membership.role != "owner":
            membership.role = "owner"
            updates.append("role")
        if not membership.is_active:
            membership.is_active = True
            updates.append("is_active")
        if updates:
            membership.save(using=db_alias, update_fields=updates)


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0078_spaceactivityevent"),
    ]

    operations = [
        migrations.RunPython(
            reset_team_spaces_to_owner_only,
            migrations.RunPython.noop,
        ),
    ]
