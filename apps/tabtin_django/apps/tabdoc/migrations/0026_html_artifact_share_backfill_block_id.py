# Data-only backfill: map file_record → block_id from current document PM JSON.
#
# Only explicit, non-empty, non-auto_* blockIds are eligible. Orphan HTML blocks
# (missing blockId) and position aliases must never be persisted on shares —
# they drift under insert/delete/segment changes ( /  review).

from __future__ import annotations

from django.db import migrations


def _iter_stable_html_block_refs(pm_json) -> list[tuple[str, str]]:
    """Return (block_id, file_id) pairs for top-level htmlBlocks with stable ids."""
    if not isinstance(pm_json, dict):
        return []
    content = pm_json.get("content")
    if not isinstance(content, list):
        return []
    refs: list[tuple[str, str]] = []
    for node in content:
        if not isinstance(node, dict) or node.get("type") != "htmlBlock":
            continue
        attrs = node.get("attrs") if isinstance(node.get("attrs"), dict) else {}
        block_id = str(attrs.get("blockId") or "").strip()
        # Fail-closed: missing / position-alias ids are not share identities.
        if not block_id or block_id.startswith("auto_"):
            continue
        file_id = str(attrs.get("fileId") or "").strip()
        if file_id:
            refs.append((block_id, file_id))
    return refs


def backfill_block_ids(apps, schema_editor):
    HtmlArtifactShare = apps.get_model("tabdoc", "HtmlArtifactShare")
    Document = apps.get_model("tabdoc", "Document")
    db_alias = schema_editor.connection.alias

    # Prefetch documents that still have active file-bound shares.
    share_qs = (
        HtmlArtifactShare.objects.using(db_alias)
        .filter(is_active=True)
        .only("id", "document_id", "file_record_id", "block_id")
    )
    doc_ids = {row.document_id for row in share_qs}
    docs = {
        doc.id: doc
        for doc in Document.objects.using(db_alias)
        .filter(id__in=doc_ids)
        .only("id", "description_json")
    }

    # file_id → [block_id, ...] and block_id occurrence counts (detect ambiguity).
    file_to_blocks: dict[tuple, list[str]] = {}
    block_counts: dict[tuple, int] = {}
    for doc_id, doc in docs.items():
        for block_id, file_id in _iter_stable_html_block_refs(doc.description_json or {}):
            file_to_blocks.setdefault((doc_id, file_id), []).append(block_id)
            key = (doc_id, block_id)
            block_counts[key] = block_counts.get(key, 0) + 1

    for share in share_qs.iterator():
        file_id = str(share.file_record_id)
        candidates = file_to_blocks.get((share.document_id, file_id), [])
        if (
            len(candidates) == 1
            and block_counts.get((share.document_id, candidates[0]), 0) == 1
        ):
            share.block_id = candidates[0]
            share.save(using=db_alias, update_fields=["block_id"])
        else:
            # Fail-closed: ambiguous / missing / orphan mapping → deactivate.
            share.block_id = ""
            share.is_active = False
            share.save(using=db_alias, update_fields=["block_id", "is_active"])


def noop_reverse(apps, schema_editor):
    # Irreversible by design: deactivated shares and lost file→block ambiguity.
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0025_html_artifact_share_add_block_id"),
    ]

    operations = [
        migrations.RunPython(backfill_block_ids, noop_reverse),
    ]
