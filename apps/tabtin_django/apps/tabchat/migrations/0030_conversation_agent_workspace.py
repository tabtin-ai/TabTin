from django.db import migrations, models
import django.db.models.deletion
import uuid


class Migration(migrations.Migration):
    dependencies = [
        ("tabchat", "0029_agentmentionjob_cancelled_status"),
        ("tabtinspace", "0145_shared_resource_placement_dismissed"),
    ]

    operations = [
        migrations.CreateModel(
            name="ConversationAgentWorkspace",
            fields=[
                (
                    "id",
                    models.UUIDField(
                        default=uuid.uuid4,
                        editable=False,
                        primary_key=True,
                        serialize=False,
                    ),
                ),
                ("organization_id", models.CharField(db_index=True, max_length=100)),
                ("agent_id", models.CharField(db_index=True, max_length=100)),
                ("bound_by_user_id", models.CharField(max_length=100)),
                ("bound_at", models.DateTimeField()),
                (
                    "conversation",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="agent_workspaces",
                        to="tabchat.conversation",
                    ),
                ),
                (
                    "workspace",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="conversation_agent_bindings",
                        to="tabtinspace.workspace",
                    ),
                ),
            ],
            options={
                "db_table": "tabchat_conversation_agent_workspace",
            },
        ),
        migrations.AddConstraint(
            model_name="conversationagentworkspace",
            constraint=models.UniqueConstraint(
                fields=("conversation", "agent_id"),
                name="tabchat_caw_conv_agent_uniq",
            ),
        ),
        migrations.AddIndex(
            model_name="conversationagentworkspace",
            index=models.Index(
                fields=["organization_id", "agent_id"],
                name="idx_tabchat_caw_org_agent",
            ),
        ),
    ]
