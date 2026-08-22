# ：Organization Collection 同名唯一按创建者分桶 + owner 查询索引。
# 本文件只做 DDL（历史跨创建者嵌套清理走 management command）。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0131_collection_pinned_7573'),
    ]

    operations = [
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_org_child_name_unique',
        ),
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_org_root_name_unique',
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=['organization', 'created_by', 'parent', 'name'],
                name='ctx_coll_org_owner_child_name_uniq',
                condition=models.Q(
                    parent__isnull=False,
                    organization__isnull=False,
                    created_by__isnull=False,
                ),
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=['organization', 'created_by', 'name'],
                name='ctx_coll_org_owner_root_name_uniq',
                condition=models.Q(
                    parent__isnull=True,
                    organization__isnull=False,
                    created_by__isnull=False,
                ),
            ),
        ),
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['organization', 'created_by', 'order'],
                name='ctx_coll_org_owner_order_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['organization', 'created_by', '-is_pinned', '-pinned_at'],
                name='ctx_coll_org_owner_pinned_idx',
            ),
        ),
    ]
