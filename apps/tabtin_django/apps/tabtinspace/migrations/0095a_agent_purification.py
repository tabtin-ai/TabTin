from django.db import migrations


RETIRED_CONFIG_KEYS = {
    "workspace_root",
}


def strip_retired_agent_config(apps, schema_editor):
    Agent = apps.get_model("tabtinspace", "Agent")
    batch = []
    for agent in Agent.objects.only("id", "agent_config").iterator(chunk_size=500):
        config = agent.agent_config
        if not isinstance(config, dict):
            continue
        changed = False
        for key in RETIRED_CONFIG_KEYS:
            if key in config:
                config.pop(key, None)
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
    dependencies = [("tabtinspace", "0094_device_machine_key")]

    operations = [
        migrations.RemoveField(model_name="agent", name="working_dir"),
        migrations.RemoveField(model_name="agent", name="working_dir_type"),
        migrations.RemoveField(model_name="agent", name="bound_device"),
        migrations.RemoveField(model_name="agent", name="control_device"),
        migrations.RemoveField(model_name="agent", name="runtime_type"),
        migrations.RemoveField(model_name="agent", name="keywords"),
        migrations.RemoveField(model_name="agent", name="tags"),
        migrations.RemoveField(model_name="agent", name="crawl_config"),
        migrations.RunPython(strip_retired_agent_config, migrations.RunPython.noop),
    ]
