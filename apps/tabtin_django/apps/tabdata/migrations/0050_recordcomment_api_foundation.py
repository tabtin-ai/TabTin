from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


def _display_name(user) -> str:
    nickname = str(getattr(user, "nickname", "") or "").strip()
    if nickname:
        return nickname[:255]
    username = str(getattr(user, "username", "") or "").strip()
    if username:
        return f"@{username}"[:255]
    email = str(getattr(user, "email", "") or "").strip()
    if email:
        return email.split("@", 1)[0][:255]
    phone = str(getattr(user, "phone", "") or "").strip()
    if phone:
        return f"{phone[:3]}****{phone[-4:]}"[:255]
    return f"用户{str(user.id)[:8]}"


def backfill_comment_actor_snapshots(apps, schema_editor) -> None:
    RecordComment = apps.get_model("tabdata", "RecordComment")
    db_alias = schema_editor.connection.alias
    pending = []

    for comment in (
        RecordComment.objects.using(db_alias)
        .select_related("author")
        .iterator(chunk_size=500)
    ):
        if not comment.author_id:
            continue
        name = _display_name(comment.author)
        comment.author_name = name
        comment.actor_type = "human"
        comment.actor_id = str(comment.author_id)
        comment.actor_name = name
        pending.append(comment)
        if len(pending) >= 500:
            RecordComment.objects.using(db_alias).bulk_update(
                pending,
                ["author_name", "actor_type", "actor_id", "actor_name"],
            )
            pending = []

    if pending:
        RecordComment.objects.using(db_alias).bulk_update(
            pending,
            ["author_name", "actor_type", "actor_id", "actor_name"],
        )


class Migration(migrations.Migration):
    dependencies = [
        ("tabdata", "0049_tablefield_default_value"),
    ]

    operations = [
        migrations.AddField(
            model_name="recordcomment",
            name="actor_id",
            field=models.CharField(blank=True, default="", max_length=64, verbose_name="展示作者ID快照"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="actor_name",
            field=models.CharField(blank=True, default="", max_length=255, verbose_name="展示作者名称快照"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="actor_type",
            field=models.CharField(
                choices=[("human", "用户"), ("agent", "Agent")],
                default="human",
                max_length=16,
                verbose_name="展示作者类型",
            ),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="agent_run_id",
            field=models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="Agent Run ID"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="author_name",
            field=models.CharField(blank=True, default="", max_length=255, verbose_name="授权主体名称快照"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="client_request_id",
            field=models.CharField(blank=True, max_length=100, null=True, verbose_name="客户端幂等请求ID"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="deleted_at",
            field=models.DateTimeField(blank=True, null=True, verbose_name="删除时间"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="is_deleted",
            field=models.BooleanField(default=False, verbose_name="是否已删除"),
        ),
        migrations.AddField(
            model_name="recordcomment",
            name="session_id",
            field=models.CharField(blank=True, db_index=True, default="", max_length=64, verbose_name="Session ID"),
        ),
        migrations.RunPython(
            backfill_comment_actor_snapshots,
            reverse_code=migrations.RunPython.noop,
        ),
        migrations.AlterField(
            model_name="recordcomment",
            name="author",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="record_comments",
                to=settings.AUTH_USER_MODEL,
                verbose_name="授权用户",
            ),
        ),
        migrations.AlterModelOptions(
            name="recordcomment",
            options={
                "ordering": ["created_at", "id"],
                "verbose_name": "评论",
                "verbose_name_plural": "评论",
            },
        ),
        migrations.AddIndex(
            model_name="recordcomment",
            index=models.Index(
                fields=["record", "is_deleted", "created_at", "id"],
                name="td_comment_record_page_idx",
            ),
        ),
        migrations.AddConstraint(
            model_name="recordcomment",
            constraint=models.UniqueConstraint(
                condition=models.Q(author__isnull=False, client_request_id__isnull=False),
                fields=("record", "author", "client_request_id"),
                name="uniq_record_comment_request",
            ),
        ),
    ]
