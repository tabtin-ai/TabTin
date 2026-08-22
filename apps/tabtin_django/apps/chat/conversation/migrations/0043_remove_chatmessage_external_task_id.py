"""Remove ChatMessage.external_task_id (ACP cleanup, 2026-05).

The field was the idempotency dedup key for the ``agent.runtime.done``
(external Agent / ACP) persist path in ``agent_event_handler.py``. That
handler + the entire ``agent.runtime.*`` protocol were removed when the
never-shipped ACP (AgentConnect) integration line was torn out — the daemon
prompt.forward failure fallback now reports via ``agent.stream.done`` like any
other runtime error. No code reads or writes this column anymore.
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('conversation', '0042_drop_engineruntimeconfig_guard_default_permission_policy'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='chatmessage',
            name='external_task_id',
        ),
    ]
