#  终态 · 0107 个人域 workspace FK 复合索引（步骤 3c/N）
#
# 0107 已加字段（含 FK 单列自动索引），0107a 已回填。本迁移只建复合索引。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0107a_personal_workspace_fk_backfill_3266'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['workspace', 'order'],
                name='ctx_coll_workspace_order_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(
                fields=['workspace', 'item_type'],
                name='ctx_item_workspace_type_idx',
            ),
        ),
        migrations.AddIndex(
            model_name='workspace',
            index=models.Index(
                fields=['agent'],
                name='ctx_ws_agent_idx',
            ),
        ),
    ]
