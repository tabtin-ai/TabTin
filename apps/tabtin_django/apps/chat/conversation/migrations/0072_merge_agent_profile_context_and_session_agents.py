"""Merge the conversation migration leaves introduced by the backport."""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0071_backfill_missing_session_agents'),
        ('conversation', '0071_merge_agent_profile_context_kind'),
    ]

    operations = []
