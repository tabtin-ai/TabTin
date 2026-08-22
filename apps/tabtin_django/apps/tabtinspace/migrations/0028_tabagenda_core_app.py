"""Add tabagenda as core app and alias tabgoal → tabagenda."""

from django.db import migrations


def forwards(apps, schema_editor):
    try:
        SpaceApp = apps.get_model("tabtinspace", "SpaceApp")
    except LookupError:
        return
    db = schema_editor.connection.alias

    for sa in SpaceApp.objects.using(db).filter(app_id="tabgoal"):
        exists = SpaceApp.objects.using(db).filter(
            space_id=sa.space_id, app_id="tabagenda",
        ).exists()
        if not exists:
            SpaceApp.objects.using(db).create(
                space_id=sa.space_id,
                app_id="tabagenda",
                is_enabled=sa.is_enabled,
                config=sa.config,
            )


class Migration(migrations.Migration):

    dependencies = [
        ("tabtinspace", "0027_marketplace_app_source"),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
