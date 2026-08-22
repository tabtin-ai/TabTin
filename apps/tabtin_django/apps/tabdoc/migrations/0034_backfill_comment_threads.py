from django.conf import settings
from django.db import migrations, transaction
from django.db.models import Q


BACKFILL_BATCH_SIZE = 200
LEGACY_MIGRATION_SOURCE = "document_share_comment"


def install_legacy_comment_sync_trigger(apps, schema_editor):
    """覆盖 migrate 与新 Django 切换之间仍由旧版本产生的评论写入。"""
    schema_editor.execute(
        f"""
        CREATE OR REPLACE FUNCTION tabdoc_sync_legacy_comment_thread()
        RETURNS trigger AS $$
        DECLARE
            thread_uuid uuid;
            document_organization_id uuid;
            comment_scope varchar(16);
            comment_anchor jsonb;
        BEGIN
            IF TG_OP = 'INSERT' THEN
                -- 新服务先写 thread/message 再写兼容投影；这种双写不能再复制一次。
                IF EXISTS (SELECT 1 FROM tabdoc_comment_message WHERE id = NEW.id) THEN
                    RETURN NEW;
                END IF;

                SELECT organization_id
                  INTO document_organization_id
                  FROM tabdoc_document
                 WHERE id = NEW.document_id;

                thread_uuid := gen_random_uuid();
                IF btrim(COALESCE(NEW.selected_text, '')) <> '' THEN
                    comment_scope := 'text_range';
                    comment_anchor := jsonb_build_object(
                        'version', 1,
                        'selected_text', btrim(NEW.selected_text),
                        'migration_source', '{LEGACY_MIGRATION_SOURCE}'
                    );
                ELSE
                    comment_scope := 'document';
                    comment_anchor := jsonb_build_object(
                        'version', 1,
                        'migration_source', '{LEGACY_MIGRATION_SOURCE}'
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
                    NULL, NEW.created_at, NEW.updated_at, NEW.author_id,
                    NEW.document_id, NULL
                );

                INSERT INTO tabdoc_comment_message (
                    id, kind, author_name, body, mention_user_ids, is_deleted,
                    created_at, updated_at, author_id, share_id, thread_id
                ) VALUES (
                    NEW.id, 'root', COALESCE(NEW.author_name, ''), NEW.body,
                    COALESCE(NEW.mention_user_ids, '[]'::jsonb), NEW.is_deleted,
                    NEW.created_at, NEW.updated_at, NEW.author_id, NEW.share_id,
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
    )


def uninstall_legacy_comment_sync_trigger(apps, schema_editor):
    schema_editor.execute(
        """
        DROP TRIGGER IF EXISTS tabdoc_legacy_comment_thread_sync
            ON tabdoc_share_comment;
        DROP FUNCTION IF EXISTS tabdoc_sync_legacy_comment_thread();
        """
    )


def backfill_comment_threads(apps, schema_editor):
    """分批回填，避免在单一长事务里锁住整张 DocumentShareComment。"""
    alias = schema_editor.connection.alias
    CommentThread = apps.get_model("tabdoc", "CommentThread")
    CommentMessage = apps.get_model("tabdoc", "CommentMessage")
    DocumentShareComment = apps.get_model("tabdoc", "DocumentShareComment")
    user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
    User = apps.get_model(user_app_label, user_model_name)

    author_ids = (
        DocumentShareComment.objects.using(alias)
        .exclude(author_id__isnull=True)
        .values_list("author_id", flat=True)
        .distinct()
    )
    valid_author_ids = set(
        User.objects.using(alias)
        .filter(id__in=author_ids)
        .values_list("id", flat=True)
    )

    last_created_at = None
    last_id = None
    while True:
        with transaction.atomic(using=alias):
            # 锁住本批旧行，避免读取后旧服务再把 is_deleted 改掉。
            # 新 INSERT 由上面的数据库 trigger 即时投影，不依赖最后一轮扫描时机。
            qs = (
                DocumentShareComment.objects.using(alias)
                .select_related("document")
                .select_for_update()
            )
            if last_created_at is not None and last_id is not None:
                qs = qs.filter(
                    Q(created_at__gt=last_created_at)
                    | Q(created_at=last_created_at, id__gt=last_id)
                )
            batch = list(qs.order_by("created_at", "id")[:BACKFILL_BATCH_SIZE])
            if not batch:
                break

            for comment in batch:
                # 幂等：根消息 id 复用旧评论 id，已存在则跳过
                if CommentMessage.objects.using(alias).filter(id=comment.id).exists():
                    continue
                selected_text = (comment.selected_text or "").strip()
                scope = "text_range" if selected_text else "document"
                anchor = {
                    "version": 1,
                    "migration_source": LEGACY_MIGRATION_SOURCE,
                }
                if selected_text:
                    anchor["selected_text"] = selected_text
                author_id = comment.author_id if comment.author_id in valid_author_ids else None

                thread = CommentThread.objects.using(alias).create(
                    document_id=comment.document_id,
                    organization_id=comment.document.organization_id,
                    scope=scope,
                    status="open",
                    anchor=anchor,
                    anchor_status="attached" if selected_text else "none",
                    created_by_id=author_id,
                )
                CommentThread.objects.using(alias).filter(id=thread.id).update(
                    created_at=comment.created_at,
                    updated_at=comment.updated_at,
                )
                message = CommentMessage.objects.using(alias).create(
                    id=comment.id,
                    thread_id=thread.id,
                    kind="root",
                    author_id=author_id,
                    share_id=comment.share_id,
                    author_name=comment.author_name or "",
                    body=comment.body,
                    mention_user_ids=list(comment.mention_user_ids or []),
                    is_deleted=comment.is_deleted,
                )
                CommentMessage.objects.using(alias).filter(id=message.id).update(
                    created_at=comment.created_at,
                    updated_at=comment.updated_at,
                )

        last = batch[-1]
        last_created_at = last.created_at
        last_id = last.id


def reverse_backfill_comment_threads(apps, schema_editor):
    alias = schema_editor.connection.alias
    CommentThread = apps.get_model("tabdoc", "CommentThread")
    # 只回滚由本迁移或兼容 trigger 生成的投影。新服务原生线程也会双写
    # DocumentShareComment，不能再按“root id 存在于旧表”这个宽条件删除。
    CommentThread.objects.using(alias).filter(
        anchor__migration_source=LEGACY_MIGRATION_SOURCE,
    ).delete()


class Migration(migrations.Migration):
    # 分批提交，避免全表回填长事务
    atomic = False

    dependencies = [
        ("tabdoc", "0033_comment_thread_models"),
    ]

    operations = [
        migrations.RunPython(
            install_legacy_comment_sync_trigger,
            uninstall_legacy_comment_sync_trigger,
        ),
        migrations.RunPython(backfill_comment_threads, reverse_backfill_comment_threads),
    ]
