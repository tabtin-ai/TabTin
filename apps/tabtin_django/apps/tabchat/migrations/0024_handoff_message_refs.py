"""Preserve the second retired Django IM migration history node."""

from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("tabchat", "0023_agent_mention_snapshots")]

    operations = []

