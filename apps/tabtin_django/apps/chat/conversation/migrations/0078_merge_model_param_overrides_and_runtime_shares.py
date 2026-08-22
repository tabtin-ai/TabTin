"""Merge the three conversation 0077 leaves .

Leaves at conflict time:
- ``0077_chatsession_model_param_overrides``
- ``0077_merge_runtime_and_session_shares``
- ``0077_chatmessage_system_prompt_context_kind``
"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0077_chatmessage_system_prompt_context_kind"),
        ("conversation", "0077_chatsession_model_param_overrides"),
        ("conversation", "0077_merge_runtime_and_session_shares"),
    ]

    operations = []
