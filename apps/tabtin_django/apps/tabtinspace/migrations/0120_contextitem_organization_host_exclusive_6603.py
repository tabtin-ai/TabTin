# ：ContextItem 宿主三态互斥收口——workspace-only / project-only /
# organization-only，替换 workspace XOR project 二态约束
# （``ctx_item_ws_xor_project``）。本文件只做索引 + 约束 DDL。

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('tabtinspace', '0119_contextitem_organization_conflict_cleanup_6603'),
    ]

    operations = [
        migrations.AddIndex(
            model_name='contextitem',
            index=models.Index(fields=['organization', 'item_type'], name='ctx_item_org_type_idx'),
        ),
        migrations.RemoveConstraint(
            model_name='contextitem',
            name='ctx_item_ws_xor_project',
        ),
        migrations.AddConstraint(
            model_name='contextitem',
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
                name='ctx_item_host_exclusive_6603',
            ),
        ),
    ]
