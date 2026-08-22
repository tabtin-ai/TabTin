"""Merge the iOS runtime migration leaf with the 0.0.4 session-share line."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [
        ("conversation", "0071_chatmessage_agent_profile_context_kind"),
        ("conversation", "0076_chatsession_default_full_access_8004"),
    ]

    operations = []
