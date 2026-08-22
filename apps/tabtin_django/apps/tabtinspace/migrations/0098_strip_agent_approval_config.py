from django.db import migrations


def strip_agent_approval_config(apps, schema_editor):
    Agent = apps.get_model("tabtinspace", "Agent")
    batch = []
    for agent in Agent.objects.only("id", "agent_config").iterator(chunk_size=500):
        config = agent.agent_config
        if not isinstance(config, dict):
            continue
        changed = False
        for key in ("git_status", "approval_grant", "approval_memo"):
            if key in config:
                config.pop(key, None)
                changed = True
        security = config.get("security")
        if isinstance(security, dict):
            for key in ("approval_grant", "approval_memo"):
                if key in security:
                    security.pop(key, None)
                    changed = True
        if changed:
            agent.agent_config = config
            batch.append(agent)
        if len(batch) >= 500:
            Agent.objects.bulk_update(batch, ["agent_config"])
            batch = []
    if batch:
        Agent.objects.bulk_update(batch, ["agent_config"])


class Migration(migrations.Migration):
    dependencies = [("tabtinspace", "0097_workspace_backfill_from_space_3266")]

    operations = [
        migrations.RunPython(strip_agent_approval_config, migrations.RunPython.noop),
    ]
