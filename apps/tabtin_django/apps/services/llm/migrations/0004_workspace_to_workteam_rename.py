"""workspace → workteam 重命名迁移（llm app）"""

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("llm", "0003_circuit_breaker_cooldown"),
    ]

    operations = [
        migrations.RenameField(
            model_name="llmprovider",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="llmusagefact",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="llmusagebudgetpolicy",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
        migrations.RenameField(
            model_name="llmadminauditlog",
            old_name="workspace_id",
            new_name="workteam_id",
        ),
    ]
