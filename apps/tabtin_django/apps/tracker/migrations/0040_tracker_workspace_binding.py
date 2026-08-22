from django.db import migrations, models
import django.db.models.deletion


def backfill_workspace(apps, schema_editor):
    Tracker = apps.get_model("tracker", "Tracker")
    Workspace = apps.get_model("tabtinspace", "Workspace")
    Space = apps.get_model("tabtinspace", "Space")
    workspace_rows = list(
        Workspace.objects.values("id", "device_id", "normalized_working_dir")
    )
    workspace_ids = {row["id"] for row in workspace_rows}
    workspace_by_execution_key = {
        (row["device_id"], row["normalized_working_dir"]): row["id"]
        for row in workspace_rows
    }
    spaces = {
        row["id"]: row
        for row in Space.objects.values(
            "id",
            "type",
            "execution_space_id",
            "control_device_id",
            "normalized_working_dir",
        )
    }
    for tracker in Tracker.objects.filter(
        workspace_id__isnull=True,
    ).exclude(space_id__isnull=True).iterator(chunk_size=500):
        space = spaces.get(tracker.space_id)
        if not space:
            continue
        execution_space_id = (
            space["execution_space_id"]
            if space["type"] == "team_space" and space["execution_space_id"]
            else tracker.space_id
        )
        execution_space = spaces.get(execution_space_id) or space
        tracker.workspace_id = (
            execution_space_id
            if execution_space_id in workspace_ids
            else workspace_by_execution_key.get((
                execution_space["control_device_id"],
                execution_space["normalized_working_dir"],
            ))
        )
        if not tracker.workspace_id:
            continue
        tracker.save(update_fields=["workspace_id"])


class Migration(migrations.Migration):
    dependencies = [
        ("tracker", "0039_backfill_cron_timezone"),
        ("tabtinspace", "0098_strip_agent_approval_config"),
    ]

    operations = [
        migrations.AddField(
            model_name="tracker",
            name="workspace",
            field=models.ForeignKey(
                blank=True,
                help_text="自动化预授权的执行 Workspace；新建 Tracker 必填。",
                null=True,
                on_delete=django.db.models.deletion.SET_NULL,
                related_name="trackers",
                to="tabtinspace.workspace",
                verbose_name="执行现场",
            ),
        ),
        migrations.RunPython(backfill_workspace, migrations.RunPython.noop),
    ]
