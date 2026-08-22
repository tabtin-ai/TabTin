from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("collab", "0009_changelog_widen_change_type"),
    ]

    operations = [
        migrations.AlterField(
            model_name="spacecheckpoint",
            name="trigger",
            field=models.CharField(
                default="manual",
                help_text=(
                    "agent_turn_done / safety_before_restore / error_compensation / "
                    "tabdata_auto_anchor / pre_approval / manual / system_recovery"
                ),
                max_length=32,
                verbose_name="触发方式",
            ),
        ),
    ]
