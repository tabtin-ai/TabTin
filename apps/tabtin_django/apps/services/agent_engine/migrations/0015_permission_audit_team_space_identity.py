from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("agent_engine", "0014_pending_interaction"),
    ]

    operations = [
        migrations.AddField(
            model_name="permissionaudit",
            name="initiator_user_id",
            field=models.UUIDField(
                blank=True,
                help_text="Team Space 中触发本次 AI run 的成员；个人 Space 为空。",
                null=True,
            ),
        ),
        migrations.AddField(
            model_name="permissionaudit",
            name="execution_owner_user_id",
            field=models.UUIDField(
                blank=True,
                help_text="Team Space 固定执行 Owner；个人 Space 为空。",
                null=True,
            ),
        ),
    ]
