from django.db import migrations


class Migration(migrations.Migration):
    """收敛未答轮次撤回审计与消息作者角色回填两条迁移分支。"""

    dependencies = [
        ("conversation", "0093_chatmessagewithdrawevent"),
        ("conversation", "0094_alter_chatmessage_external_archive_context_kind"),
    ]

    operations = []
