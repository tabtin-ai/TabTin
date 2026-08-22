from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("tabtinspace", "0095b_human_agent_shadow_row_split")]

    operations = [
        migrations.RemoveConstraint(
            model_name="agent",
            name="ctx_agent_workspace_user_unique",
        ),
        migrations.RemoveIndex(
            model_name="agent",
            name="ctx_agent_ws_user_idx",
        ),
        migrations.RemoveField(model_name="agent", name="user"),
        migrations.AlterField(
            model_name="agent",
            name="type",
            field=models.CharField(
                choices=[("bot", "AI 助手")],
                default="bot",
                max_length=20,
                verbose_name="Agent 类型",
            ),
        ),
    ]
