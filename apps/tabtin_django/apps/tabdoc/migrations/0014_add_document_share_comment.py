from __future__ import annotations

from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("tabdoc", "0013_backfill_document_owner_id"),
    ]

    operations = [
        migrations.CreateModel(
            name="DocumentShareComment",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("author_name", models.CharField(blank=True, default="", max_length=80, verbose_name="评论者名称")),
                ("selected_text", models.TextField(blank=True, default="", verbose_name="评论所选文本")),
                ("body", models.TextField(verbose_name="评论内容")),
                ("is_deleted", models.BooleanField(db_index=True, default=False, verbose_name="是否删除")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "author",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="tabdoc_share_comments",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="评论者",
                    ),
                ),
                (
                    "document",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="share_comments",
                        to="tabdoc.document",
                        verbose_name="所属文档",
                    ),
                ),
                (
                    "share",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="comments",
                        to="tabdoc.documentshare",
                        verbose_name="来源分享",
                    ),
                ),
            ],
            options={
                "verbose_name": "文档分享评论",
                "verbose_name_plural": "文档分享评论",
                "db_table": "tabdoc_share_comment",
                "ordering": ["created_at"],
                "indexes": [
                    models.Index(
                        fields=["document", "is_deleted", "created_at"],
                        name="docshc_doc_deleted_created_idx",
                    ),
                    models.Index(fields=["share", "created_at"], name="docshc_share_created_idx"),
                ],
            },
        ),
    ]
