from django.db import migrations, models


def backfill_execution_workspace(apps, schema_editor):
    ChannelBinding = apps.get_model("channel_gateway", "ChannelBinding")
    Workspace = apps.get_model("tabtinspace", "Workspace")
    workspace_ids = {
        str(workspace_id)
        for workspace_id in Workspace.objects.values_list("id", flat=True).iterator(
            chunk_size=500,
        )
    }
    for binding in ChannelBinding.objects.filter(
        execution_workspace_id__isnull=True,
    ).iterator(chunk_size=500):
        candidate = binding.handling_space_id or binding.space_id
        if candidate and candidate in workspace_ids:
            binding.execution_workspace_id = candidate
            binding.save(update_fields=["execution_workspace_id"])


class Migration(migrations.Migration):
    dependencies = [
        ("channel_gateway", "0010_alter_channelaccount_organization_id_and_more"),
        ("tabtinspace", "0098_strip_agent_approval_config"),
    ]

    operations = [
        migrations.AddField(
            model_name="channelbinding",
            name="execution_workspace_id",
            field=models.CharField(
                blank=True,
                max_length=100,
                null=True,
                verbose_name="执行 Workspace ID",
            ),
        ),
        migrations.AddIndex(
            model_name="channelbinding",
            index=models.Index(
                fields=["execution_workspace_id"],
                name="cg_bind_execution_ws_idx",
            ),
        ),
        migrations.RunPython(
            backfill_execution_workspace,
            migrations.RunPython.noop,
        ),
    ]
