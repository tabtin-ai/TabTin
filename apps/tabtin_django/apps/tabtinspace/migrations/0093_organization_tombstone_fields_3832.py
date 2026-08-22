"""#3832 墓碑式删除管线：组织删除发起时间/发起人留痕字段。

组织行在发起删除后立刻标记 deleting（墓碑，对用户隐身），保留到
default DB 清理链（OrganizationLifecycleCleanupService）末步校验子表
清空后才物理删除。这两个字段记录删除发起上下文供审计追溯。
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0092_alter_spaceadminactionlog_action_type_and_more"),
    ]

    operations = [
        migrations.AddField(
            model_name="organization",
            name="delete_requested_at",
            field=models.DateTimeField(blank=True, null=True, verbose_name="删除发起时间"),
        ),
        migrations.AddField(
            model_name="organization",
            name="delete_requested_by_id",
            field=models.CharField(blank=True, default="", max_length=36, verbose_name="删除发起人ID"),
        ),
    ]
