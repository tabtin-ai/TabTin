from importlib import import_module

from django.db import migrations


legacy_projection = import_module(
    "apps.tabdoc.migrations.0034_backfill_comment_threads"
)


RESTORE_LEGACY_COMMENT_SYNC_SQL = """
CREATE OR REPLACE FUNCTION tabdoc_sync_legacy_comment_thread()
RETURNS trigger AS $$
DECLARE
    thread_uuid uuid;
    document_organization_id uuid;
    valid_author_id uuid;
    comment_scope varchar(16);
    comment_anchor jsonb;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF EXISTS (SELECT 1 FROM tabdoc_comment_message WHERE id = NEW.id) THEN
            RETURN NEW;
        END IF;

        SELECT organization_id
          INTO document_organization_id
          FROM tabdoc_document
         WHERE id = NEW.document_id;

        SELECT id
          INTO valid_author_id
          FROM users_auth_user
         WHERE id = NEW.author_id;

        thread_uuid := gen_random_uuid();
        IF btrim(COALESCE(NEW.selected_text, '')) <> '' THEN
            comment_scope := 'text_range';
            comment_anchor := jsonb_build_object(
                'version', 1,
                'selected_text', btrim(NEW.selected_text),
                'migration_source', 'document_share_comment'
            );
        ELSE
            comment_scope := 'document';
            comment_anchor := jsonb_build_object(
                'version', 1,
                'migration_source', 'document_share_comment'
            );
        END IF;

        INSERT INTO tabdoc_comment_thread (
            id, organization_id, scope, status, anchor, anchor_status,
            resolved_at, created_at, updated_at, created_by_id,
            document_id, resolved_by_id
        ) VALUES (
            thread_uuid, document_organization_id, comment_scope, 'open',
            comment_anchor,
            CASE WHEN comment_scope = 'text_range' THEN 'attached' ELSE 'none' END,
            NULL, NEW.created_at, NEW.updated_at, valid_author_id,
            NEW.document_id, NULL
        );

        INSERT INTO tabdoc_comment_message (
            id, kind, author_name, body, mention_user_ids, is_deleted,
            created_at, updated_at, author_id, share_id, thread_id
        ) VALUES (
            NEW.id, 'root', COALESCE(NEW.author_name, ''), NEW.body,
            COALESCE(NEW.mention_user_ids, '[]'::jsonb), NEW.is_deleted,
            NEW.created_at, NEW.updated_at, valid_author_id, NEW.share_id,
            thread_uuid
        );
    ELSIF TG_OP = 'UPDATE' AND NEW.is_deleted IS DISTINCT FROM OLD.is_deleted THEN
        UPDATE tabdoc_comment_message
           SET is_deleted = NEW.is_deleted,
               updated_at = NEW.updated_at
         WHERE id = NEW.id AND kind = 'root';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tabdoc_legacy_comment_thread_sync
    ON tabdoc_share_comment;
CREATE TRIGGER tabdoc_legacy_comment_thread_sync
    AFTER INSERT OR UPDATE OF is_deleted ON tabdoc_share_comment
    FOR EACH ROW EXECUTE FUNCTION tabdoc_sync_legacy_comment_thread();
"""


def install_legacy_projection(apps, schema_editor):
    schema_editor.execute(RESTORE_LEGACY_COMMENT_SYNC_SQL)


def uninstall_legacy_projection(apps, schema_editor):
    legacy_projection.uninstall_legacy_comment_sync_trigger(apps, schema_editor)


def backfill_legacy_comments(apps, schema_editor):
    legacy_projection.backfill_comment_threads(apps, schema_editor)


def remove_backfilled_legacy_comments(apps, schema_editor):
    legacy_projection.reverse_backfill_comment_threads(apps, schema_editor)


class Migration(migrations.Migration):
    # 0034 deliberately batches the legacy projection in short transactions.
    atomic = False

    dependencies = [
        ("tabdoc", "0038_restore_comment_threads"),
    ]

    operations = [
        migrations.RunPython(
            install_legacy_projection,
            uninstall_legacy_projection,
        ),
        migrations.RunPython(
            backfill_legacy_comments,
            remove_backfilled_legacy_comments,
        ),
    ]
