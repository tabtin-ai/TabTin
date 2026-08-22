import uuid

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("oss", "0014_widen_filerecord_url_fields"),
        ("tabdoc", "0032_document_recovery_draft"),
    ]

    operations = [
        migrations.CreateModel(
            name="CommentThread",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("organization_id", models.UUIDField(verbose_name="Organization ID")),
                ("scope", models.CharField(choices=[("document", "全文"), ("text_range", "文本选区"), ("block", "内容块")], default="document", max_length=16, verbose_name="批注范围")),
                ("status", models.CharField(choices=[("open", "待处理"), ("resolved", "已解决")], default="open", max_length=16, verbose_name="线程状态")),
                ("anchor", models.JSONField(blank=True, default=dict, verbose_name="版本化正文锚点")),
                ("anchor_status", models.CharField(choices=[("none", "无锚点"), ("attached", "已关联"), ("orphaned", "已失联")], default="none", max_length=16, verbose_name="锚点状态")),
                ("resolved_at", models.DateTimeField(blank=True, null=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="tabdoc_comment_threads_created", to=settings.AUTH_USER_MODEL)),
                ("document", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="comment_threads", to="tabdoc.document", verbose_name="所属文档")),
                ("resolved_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="tabdoc_comment_threads_resolved", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "db_table": "tabdoc_comment_thread",
                "ordering": ["created_at", "id"],
            },
        ),
        migrations.CreateModel(
            name="CommentMessage",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("kind", models.CharField(choices=[("root", "根消息"), ("reply", "回复")], default="reply", max_length=16, verbose_name="消息类型")),
                ("author_name", models.CharField(blank=True, default="", max_length=80)),
                ("body", models.TextField(verbose_name="消息内容")),
                ("mention_user_ids", models.JSONField(blank=True, default=list)),
                ("is_deleted", models.BooleanField(default=False)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("author", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="tabdoc_comment_messages", to=settings.AUTH_USER_MODEL, verbose_name="消息作者")),
                ("share", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="comment_messages", to="tabdoc.documentshare", verbose_name="来源分享")),
                ("thread", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="messages", to="tabdoc.commentthread", verbose_name="所属线程")),
            ],
            options={
                "db_table": "tabdoc_comment_message",
                "ordering": ["created_at", "id"],
            },
        ),
        migrations.CreateModel(
            name="CommentAttachment",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("organization_id", models.UUIDField(verbose_name="Organization ID")),
                ("attachment_type", models.CharField(choices=[("image", "图片"), ("file", "文件")], default="image", max_length=16)),
                ("metadata", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="tabdoc_comment_attachments_created", to=settings.AUTH_USER_MODEL)),
                ("file_record", models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name="tabdoc_comment_attachments", to="oss.filerecord", verbose_name="私有文件记录")),
                ("message", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="attachments", to="tabdoc.commentmessage", verbose_name="所属消息")),
            ],
            options={
                "db_table": "tabdoc_comment_attachment",
                "ordering": ["created_at", "id"],
            },
        ),
    ]
