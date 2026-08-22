from __future__ import annotations

from collections import defaultdict

from django.db import migrations


def backfill_document_owner_id(apps, schema_editor):
    """Backfill TabDoc owner_id only when the owner fact is unambiguous."""
    connection = schema_editor.connection
    table_names = set(connection.introspection.table_names())

    Document = apps.get_model("tabdoc", "Document")
    DocumentPermission = apps.get_model("tabdoc", "DocumentPermission")

    if (
        Document._meta.db_table not in table_names
        or DocumentPermission._meta.db_table not in table_names
    ):
        return

    db_alias = connection.alias
    documents = list(
        Document.objects.using(db_alias)
        .filter(owner_id__isnull=True, created_by_id__isnull=False)
        .values("id", "created_by_id")
    )
    if not documents:
        return

    doc_ids = [row["id"] for row in documents]
    owner_subjects_by_doc: dict[object, set[str]] = defaultdict(set)
    owner_permissions = (
        DocumentPermission.objects.using(db_alias)
        .filter(
            document_id__in=doc_ids,
            subject_type="user",
            permission="owner",
            is_active=True,
        )
        .values("document_id", "subject_id")
    )
    for perm in owner_permissions:
        owner_subjects_by_doc[perm["document_id"]].add(str(perm["subject_id"]))

    updated = 0
    skipped_without_owner_permission = 0
    skipped_multiple_owner_permissions = 0
    skipped_created_by_mismatch = 0

    for document in documents:
        document_id = document["id"]
        created_by_id = str(document["created_by_id"])
        owner_subjects = owner_subjects_by_doc.get(document_id, set())

        if not owner_subjects:
            skipped_without_owner_permission += 1
            continue
        if len(owner_subjects) > 1:
            skipped_multiple_owner_permissions += 1
            continue
        if created_by_id not in owner_subjects:
            skipped_created_by_mismatch += 1
            continue

        updated += Document.objects.using(db_alias).filter(id=document_id).update(
            owner_id=document["created_by_id"],
        )

    if updated or skipped_without_owner_permission or skipped_multiple_owner_permissions or skipped_created_by_mismatch:
        print(
            "\n  [tabdoc backfill_document_owner_id] "
            f"updated={updated}, "
            f"skipped_without_owner_permission={skipped_without_owner_permission}, "
            f"skipped_multiple_owner_permissions={skipped_multiple_owner_permissions}, "
            f"skipped_created_by_mismatch={skipped_created_by_mismatch}",
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0012_alter_document_created_by_alter_document_updated_by_and_more"),
    ]

    operations = [
        migrations.RunPython(
            backfill_document_owner_id,
            reverse_code=migrations.RunPython.noop,
            hints={"db_alias": "postgresql"},
        ),
    ]
