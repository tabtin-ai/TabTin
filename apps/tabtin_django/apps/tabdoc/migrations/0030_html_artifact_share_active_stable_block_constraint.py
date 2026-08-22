# Schema-only guard: active HtmlArtifactShare rows must use a stable block_id.
# Split from 0029 data repair per  (no data_op + DDL in one atomic migration).
#
# Idempotent on DB: environments that briefly applied an earlier combined 0029
# may already have the constraint.

from __future__ import annotations

from django.db import migrations, models


_CONSTRAINT_NAME = "htmlashare_active_stable_block"


def _add_constraint_if_missing(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            DO $$
            BEGIN
              IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'htmlashare_active_stable_block'
              ) THEN
                ALTER TABLE tabdoc_html_artifact_share
                ADD CONSTRAINT htmlashare_active_stable_block
                CHECK (
                  (NOT is_active)
                  OR (
                    block_id <> ''
                    AND block_id NOT LIKE 'auto_%'
                  )
                );
              END IF;
            END $$;
            """
        )


def _remove_constraint_if_present(apps, schema_editor):
    if schema_editor.connection.vendor != "postgresql":
        return
    with schema_editor.connection.cursor() as cursor:
        cursor.execute(
            """
            DO $$
            BEGIN
              IF EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'htmlashare_active_stable_block'
              ) THEN
                ALTER TABLE tabdoc_html_artifact_share
                DROP CONSTRAINT htmlashare_active_stable_block;
              END IF;
            END $$;
            """
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0029_html_artifact_share_stable_block_id_guard"),
    ]

    operations = [
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.AddConstraint(
                    model_name="htmlartifactshare",
                    constraint=models.CheckConstraint(
                        check=(
                            models.Q(("is_active", False))
                            | (
                                ~models.Q(("block_id", ""))
                                & ~models.Q(("block_id__startswith", "auto_"))
                            )
                        ),
                        name=_CONSTRAINT_NAME,
                    ),
                ),
            ],
            database_operations=[
                migrations.RunPython(
                    _add_constraint_if_missing,
                    _remove_constraint_if_present,
                ),
            ],
        ),
    ]
