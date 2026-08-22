# Idempotent fix for environments that applied the overlong index name before 0025 was corrected.

from django.db import migrations


def rename_block_index_if_needed(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'i'
                  AND c.relname = 'htmlashare_doc_block_active_idx'
              ) AND NOT EXISTS (
                SELECT 1 FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE c.relkind = 'i'
                  AND c.relname = 'htmlashare_doc_blk_act_idx'
              ) THEN
                ALTER INDEX htmlashare_doc_block_active_idx
                  RENAME TO htmlashare_doc_blk_act_idx;
              END IF;
            END $$;
            """
        )


def noop_reverse(apps, schema_editor):
    pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0027_html_artifact_share_block_identity"),
    ]

    operations = [
        migrations.RunPython(rename_block_index_if_needed, noop_reverse),
    ]
