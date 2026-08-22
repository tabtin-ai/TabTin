"""收敛共享测试库先行执行的 conversation migration 历史。

测试线曾先于 release 执行另一条 migration 分支。对应数据库结构保留为向后
兼容的超集；本节点只向发布包门禁声明这些 history 已被显式审计，不重复执行业务
DDL 或数据回填。
"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [
        ("conversation", "0089_remove_chatsession_approval_mode"),
        ("conversation", "0090_merge_20260808_2145"),
        ("conversation", "0092_merge_20260810_1609"),
        ("conversation", "0093_backfill_system_authored_message_roles"),
        ("conversation", "0094_backfill_remaining_system_authored_roles"),
        ("conversation", "0095_alter_chatmessage_external_archive_context_kind"),
        ("conversation", "0096_sessionshare_v2_contract"),
    ]

    dependencies = [
        ("conversation", "0092_remove_chatsession_approval_mode"),
        ("conversation", "0093_chatmessagewithdrawevent"),
    ]

    operations = []
