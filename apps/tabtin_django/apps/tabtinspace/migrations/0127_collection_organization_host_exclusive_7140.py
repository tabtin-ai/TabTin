# ：Collection 宿主三态互斥收口 + org 侧 unique/index。
# 替换 ctx_coll_ws_xor_project。本文件只做 DDL（回填走 management command）。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0126_collection_organization_7140'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='collection',
            index=models.Index(fields=['organization', 'order'], name='ctx_coll_org_order_idx'),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=['organization', 'parent', 'name'],
                name='ctx_coll_org_child_name_unique',
                condition=models.Q(parent__isnull=False, organization__isnull=False),
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=['organization', 'name'],
                name='ctx_coll_org_root_name_unique',
                condition=models.Q(parent__isnull=True, organization__isnull=False),
            ),
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.UniqueConstraint(
                fields=['organization', 'system_key'],
                name='ctx_coll_org_system_key_unique',
                condition=models.Q(system_key__isnull=False, organization__isnull=False),
            ),
        ),
        migrations.RemoveConstraint(
            model_name='collection',
            name='ctx_coll_ws_xor_project',
        ),
        migrations.AddConstraint(
            model_name='collection',
            constraint=models.CheckConstraint(
                check=(
                    (
                        models.Q(workspace__isnull=False)
                        & models.Q(project__isnull=True)
                        & models.Q(organization__isnull=True)
                    )
                    | (
                        models.Q(workspace__isnull=True)
                        & models.Q(project__isnull=False)
                        & models.Q(organization__isnull=True)
                    )
                    | (
                        models.Q(workspace__isnull=True)
                        & models.Q(project__isnull=True)
                        & models.Q(organization__isnull=False)
                    )
                ),
                name='ctx_coll_host_exclusive_7140',
            ),
        ),
    ]
