"""Remove ChatSession.external_session_id (ACP cleanup).

The field stored the external Agent (ACP) session ID for Daemon restart
recovery. After ACP path was removed (Q2 2026), no code reads or writes
it anymore.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0028_chatsession_context_tier_id'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='chatsession',
            name='external_session_id',
        ),
    ]
