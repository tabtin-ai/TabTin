# Rename agent_space → space (state-only, db_column preserves old name)
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("tracker", "0008_goalstep_model_preference_choices"),
        ("tabtinspace", "0006_rename_agentspace_to_space"),
    ]

    operations = [
        migrations.RemoveIndex(model_name="goal", name="goal_agent_s_f55a97_idx"),

        # goal.agent_space → goal.space (state-only + AlterField for db_column)
        migrations.SeparateDatabaseAndState(
            state_operations=[
                migrations.RenameField("goal", "agent_space", "space"),
                migrations.AlterField(
                    model_name="goal", name="space",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        db_column="agent_space_id",
                        related_name="goals", to="tabtinspace.space",
                        verbose_name="所属智能体空间",
                    ),
                ),
                migrations.RenameField("scheduledjob", "agent_space", "space"),
                migrations.AlterField(
                    model_name="scheduledjob", name="space",
                    field=models.ForeignKey(
                        on_delete=django.db.models.deletion.SET_NULL,
                        db_column="agent_space_id",
                        null=True, blank=True,
                        related_name="scheduled_jobs", to="tabtinspace.space",
                        verbose_name="所属智能体空间",
                    ),
                ),
            ],
            database_operations=[],
        ),

        migrations.AlterField(
            model_name="goalstep",
            name="delegate_to",
            field=models.ForeignKey(
                blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL,
                related_name="+", to="tabtinspace.space", verbose_name="委托执行空间",
            ),
        ),

        migrations.AddIndex(
            model_name="goal",
            index=models.Index(fields=["space"], name="goal_agent_s_f55a97_idx"),
        ),
    ]
