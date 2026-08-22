from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabdoc", "0034_backfill_comment_threads"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="commentthread",
            index=models.Index(fields=["document", "status", "created_at"], name="docct_doc_status_created_idx"),
        ),
        migrations.AddIndex(
            model_name="commentthread",
            index=models.Index(fields=["organization_id", "document"], name="docct_org_document_idx"),
        ),
        migrations.AddIndex(
            model_name="commentmessage",
            index=models.Index(fields=["thread", "is_deleted", "created_at"], name="doccm_thread_del_created_idx"),
        ),
        migrations.AddIndex(
            model_name="commentmessage",
            index=models.Index(fields=["author", "created_at"], name="doccm_author_created_idx"),
        ),
        migrations.AddConstraint(
            model_name="commentmessage",
            constraint=models.UniqueConstraint(condition=models.Q(("kind", "root")), fields=("thread",), name="doccm_one_root_per_thread"),
        ),
        migrations.AddIndex(
            model_name="commentattachment",
            index=models.Index(fields=["message", "created_at"], name="docca_message_created_idx"),
        ),
        migrations.AddIndex(
            model_name="commentattachment",
            index=models.Index(fields=["organization_id", "created_at"], name="docca_org_created_idx"),
        ),
    ]
