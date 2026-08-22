"""记录已退役 Django IM 分支写入共享测试库的 migration 历史。"""

from django.db import migrations


class Migration(migrations.Migration):
    reconciles = [
        ("tabchat", "0023_agent_mention_snapshots"),
        ("tabchat", "0024_handoff_message_refs"),
        ("tabchat", "0025_relax_retired_django_im_columns"),
    ]

    dependencies = [
        ("tabchat", "0022_resource_access_request_editor_optional_source"),
    ]

    operations = []
