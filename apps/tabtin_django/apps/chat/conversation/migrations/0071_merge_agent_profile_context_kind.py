# ：合并双叶子
# - 0067_chatmessage_agent_profile_context_kind（本 PR）
# - 0070_chatcontext_current_project_backfill（release 线）

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0067_chatmessage_agent_profile_context_kind'),
        ('conversation', '0070_chatcontext_current_project_backfill'),
    ]

    operations = []
