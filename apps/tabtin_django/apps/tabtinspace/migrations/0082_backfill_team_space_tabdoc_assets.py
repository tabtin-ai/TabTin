from __future__ import annotations

from django.db import migrations


def backfill_team_space_tabdoc_assets(apps, schema_editor):
    ContextItem = apps.get_model("tabtinspace", "ContextItem")
    Space = apps.get_model("tabtinspace", "Space")

    team_space_ids = set(
        Space.objects.filter(type="team_space").values_list("id", flat=True)
    )
    if not team_space_ids:
        return

    items = ContextItem.objects.filter(
        space_id__in=team_space_ids,
        item_type="tabdoc",
        is_archived=False,
        trashed_at__isnull=True,
    )
    for item in items.iterator():
        metadata = dict(item.metadata or {})
        if metadata.get("asset_kind") == "tabdoc":
            continue
        metadata["asset_kind"] = "tabdoc"
        metadata["asset_source"] = {
            "kind": "ai_deliverable",
            "member_user_id": "",
            "actor_user_id": "",
            "conversation_origin": {},
            "run_origin": {},
        }
        item.metadata = metadata
        item.save(update_fields=["metadata", "updated_at"])


class Migration(migrations.Migration):
    dependencies = [
        ("tabtinspace", "0081_spaceactivityevent_channel_events"),
    ]

    operations = [
        migrations.RunPython(
            backfill_team_space_tabdoc_assets,
            migrations.RunPython.noop,
        ),
    ]
