"""
添加 Collection（合集）和 CollectionSection（分区）模型，
ContextItem 增加 collection/section 外键。
"""
import uuid
from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
        ("tabtinspace", "0013_add_pinned_fields"),
    ]

    operations = [
        # ── Collection ──
        migrations.CreateModel(
            name="Collection",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=255, verbose_name="合集名称")),
                ("icon", models.CharField(blank=True, default="📚", max_length=50, verbose_name="图标")),
                ("color", models.CharField(blank=True, default="", max_length=20, verbose_name="颜色")),
                ("order", models.IntegerField(default=0, verbose_name="排序")),
                ("is_expanded", models.BooleanField(default=True, verbose_name="是否展开")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "space",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="collections",
                        to="tabtinspace.space",
                        verbose_name="所属 Space",
                    ),
                ),
                (
                    "created_by",
                    models.ForeignKey(
                        blank=True,
                        db_constraint=False,
                        null=True,
                        on_delete=django.db.models.deletion.SET_NULL,
                        related_name="created_collections",
                        to=settings.AUTH_USER_MODEL,
                        verbose_name="创建者",
                    ),
                ),
            ],
            options={
                "verbose_name": "合集",
                "verbose_name_plural": "合集",
                "db_table": "tabtinspace_collection",
                "ordering": ["order", "name"],
            },
        ),
        migrations.AddIndex(
            model_name="collection",
            index=models.Index(fields=["space", "order"], name="ctx_coll_space_order_idx"),
        ),
        migrations.AddConstraint(
            model_name="collection",
            constraint=models.UniqueConstraint(fields=("space", "name"), name="ctx_coll_space_name_unique"),
        ),

        # ── CollectionSection ──
        migrations.CreateModel(
            name="CollectionSection",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("name", models.CharField(max_length=255, verbose_name="分区名称")),
                ("order", models.IntegerField(default=0, verbose_name="排序")),
                ("is_expanded", models.BooleanField(default=True, verbose_name="是否展开")),
                ("created_at", models.DateTimeField(auto_now_add=True, verbose_name="创建时间")),
                ("updated_at", models.DateTimeField(auto_now=True, verbose_name="更新时间")),
                (
                    "collection",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="sections",
                        to="tabtinspace.collection",
                        verbose_name="所属合集",
                    ),
                ),
            ],
            options={
                "verbose_name": "合集分区",
                "verbose_name_plural": "合集分区",
                "db_table": "tabtinspace_collection_section",
                "ordering": ["order", "name"],
            },
        ),
        migrations.AddIndex(
            model_name="collectionsection",
            index=models.Index(fields=["collection", "order"], name="ctx_csec_coll_order_idx"),
        ),
        migrations.AddConstraint(
            model_name="collectionsection",
            constraint=models.UniqueConstraint(fields=("collection", "name"), name="ctx_csec_coll_name_unique"),
        ),

        # ── ContextItem 添加 collection / section FK ──
        migrations.AddField(
            model_name="contextitem",
            name="collection",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="items",
                to="tabtinspace.collection",
                verbose_name="所属合集",
            ),
        ),
        migrations.AddField(
            model_name="contextitem",
            name="section",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="items",
                to="tabtinspace.collectionsection",
                verbose_name="所属分区",
            ),
        ),
        migrations.AddIndex(
            model_name="contextitem",
            index=models.Index(fields=["collection", "order"], name="ctx_item_coll_order_idx"),
        ),
        migrations.AddIndex(
            model_name="contextitem",
            index=models.Index(fields=["section", "order"], name="ctx_item_sec_order_idx"),
        ),
    ]
