"""
Remove TinApp related tables and clean up WorkteamAppInstall.app_source choices.

TinApp concept has been fully deprecated and removed. All apps are now
CORE_APPS driven by app.json manifests.
"""
from django.db import migrations, models


def cleanup_tinapp_records(apps, schema_editor):
    """Delete any orphaned tinapp install records (safe if table doesn't exist)."""
    try:
        WorkteamAppInstall = apps.get_model("tabtinspace", "WorkteamAppInstall")
        WorkteamAppInstall.objects.filter(app_source="tinapp").delete()
    except Exception:
        pass


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0020_add_space_avatar"),
    ]

    operations = [
        migrations.RunPython(cleanup_tinapp_records, migrations.RunPython.noop),
        migrations.AlterField(
            model_name="workteamappinstall",
            name="app_source",
            field=models.CharField(
                choices=[("core", "核心应用")],
                default="core",
                max_length=16,
                verbose_name="应用来源",
            ),
        ),
    ]
