# ：补齐 Collection 在 Project 侧的唯一约束与索引（对称 workspace 侧）。
#
# 0113 已完成 Project 侧重名去重。本迁移单独建索引/约束，与 DELETE 拆事务，
# 避免 Collection 自引用 parent FK 的 pending trigger events。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0113_collection_project_unique_3266'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(
                fields=['project', 'order'],
                name='ctx_coll_project_order_idx',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('project', 'parent', 'name'),
                condition=models.Q(('parent__isnull', False), ('project__isnull', False)),
                name='ctx_coll_project_child_name_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('project', 'name'),
                condition=models.Q(('parent__isnull', True), ('project__isnull', False)),
                name='ctx_coll_project_root_name_unique',
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=('project', 'system_key'),
                condition=models.Q(('system_key__isnull', False), ('project__isnull', False)),
                name='ctx_coll_project_system_key_unique',
            ),
        ),
    ]
