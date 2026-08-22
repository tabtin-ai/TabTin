from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0030_conversation_agent_workspace"),
    ]

    operations = [
        migrations.AddIndex(
            model_name="agentmentionjob",
            index=models.Index(
                fields=["session_id"],
                name="tabchat_agent_job_session_idx",
            ),
        ),
    ]
