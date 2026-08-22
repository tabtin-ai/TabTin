"""记录已由正式迁移覆盖的临时 ChatMessage 迁移。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [("conversation", "0047_chatmessage_updated_at_state")]

    dependencies = [("conversation", "0084_session_share_tencent_message_ref")]

    operations = []
