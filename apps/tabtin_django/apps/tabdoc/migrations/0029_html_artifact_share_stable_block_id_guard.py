# Data-only forward repair for environments that applied the old 0026 which could
# persist position-alias block_ids (auto_{index}). Schema guard is in 0030 .

from __future__ import annotations

from django.db import migrations


def _iter_stable_html_block_ids(pm_json) -> list[str]:
    if not isinstance(pm_json, dict):
        return []
    content = pm_json.get("content")
    if not isinstance(content, list):
        return []
    ids: list[str] = []
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        block_id = str(attrs.get("blockId") or "").strip()
        if not block_id or block_id.startswith("auto_"):
            continue
        ids.append(block_id)
    return ids


def deactivate_unstable_active_shares(apps, schema_editor):
    """Deactivate active shares whose block_id is empty, auto_*, missing, or duplicated.

    Keeps the original ``block_id`` value for audit; only flips ``is_active``.
    Does not rewrite Document.description_json (collab binary remains SoT).
    """
    HtmlArtifactShare = apps.get_model("tabdoc", "HtmlArtifactShare")
    Document = apps.get_model("tabdoc", "Document")
    db_alias = schema_editor.connection.alias

    share_qs = (
        HtmlArtifactShare.objects.using(db_alias)
        .filter(is_active=True)
        .only("id", "document_id", "block_id", "is_active")
    )
    doc_ids = {row.document_id for row in share_qs}
    docs = {
        doc.id: doc
        for doc in Document.objects.using(db_alias)
        .filter(id__in=doc_ids)
        .only("id", "description_json")
    }

    stable_counts: dict[tuple, int] = {}
    for doc_id, doc in docs.items():
        for block_id in _iter_stable_html_block_ids(doc.description_json or {}):
            key = (doc_id, block_id)
            stable_counts[key] = stable_counts.get(key, 0) + 1

    for share in share_qs.iterator():
        block_id = str(share.block_id or "").strip()
        if (
            not block_id
            or block_id.startswith("auto_")
            or stable_counts.get((share.document_id, block_id), 0) != 1
        ):
            # Keep block_id for audit; fail-closed deactivate only.
            share.is_active = False
            share.save(using=db_alias, update_fields=["is_active"])


def noop_reverse(apps, schema_editor):
    # Irreversible: intentionally deactivated ambiguous / position-alias shares.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0028_html_artifact_share_rename_block_index"),
    ]

    operations = [
        migrations.RunPython(deactivate_unstable_active_shares, noop_reverse),
    ]
