"""#3836 + ：Agent 级旧 ``yolo_mode`` 键清场；保留 approval_grant。

组织准入天花板在 ``Organization.settings.allow_member_yolo``。
Agent 上用户侧「Yolo 开关」已下线，但  的 ``security.approval_grant``
与 legacy ``allow_yolo_mode`` 仍是升档授权数据，不可整字段清掉。

本迁移只跑 ``strip_retired_agent_config_fields``：清 Hilt 退役字段 +
旧键 ``yolo_mode``，并在缺 grant 时从旧 ``authorization_preset`` 抢救信号。
"""

from django.db import migrations


def strip_agent_yolo_gate(apps, schema_editor):
    db_alias = schema_editor.connection.alias
    if db_alias != "postgresql":
        return

    from apps.tabtinspace.agent_config_v2 import strip_retired_agent_config_fields

    Agent = apps.get_model("tabtinspace", "Agent")
    to_update = []
    for agent in Agent.objects.using(db_alias).only("id", "agent_config").iterator():
        new_cfg, changed = strip_retired_agent_config_fields(agent.agent_config)
        if changed:
            agent.agent_config = new_cfg
            to_update.append(agent)
    if to_update:
        Agent.objects.using(db_alias).bulk_update(
            to_update, ["agent_config"], batch_size=500
        )


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0090_alter_organization_options_and_more"),
    ]

    operations = [
        migrations.RunPython(strip_agent_yolo_gate, migrations.RunPython.noop),
    ]
