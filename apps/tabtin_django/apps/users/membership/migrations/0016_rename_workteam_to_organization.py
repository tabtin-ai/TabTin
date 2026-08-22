"""
workteam -> organization 重命名迁移（，B2 批次）。

历史索引/约束名中的缩写（ws/wt/worktea 截断名）按 RENAME-SPEC §3.4 保持不动；
仅显式含 "workteam" 全词的索引/约束改名。
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('membership', '0015_membershiptier_document_group_limits'),
    ]

    operations = [
        migrations.RenameModel(old_name='WorkteamMembership', new_name='OrganizationMembership'),
        migrations.RenameField(model_name='organizationmembership', old_name='workteam_id', new_name='organization_id'),
        migrations.AlterModelTable(name='organizationmembership', table='users_membership_organization_membership'),
    ]
