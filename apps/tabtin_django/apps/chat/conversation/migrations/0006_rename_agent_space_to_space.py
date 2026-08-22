# Rename agent_space fields → space (state-only where db_column preserves old name)
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):

    dependencies = [
        ("conversation", "0005_chatglobalconfig_engine_context_guard_features"),
        ("tabtinspace", "0006_rename_agentspace_to_space"),
    ]

    operations = [
        # All state-only: field renames, index renames, AlterField for db_column
        migrations.SeparateDatabaseAndState(
            state_operations=[
                # ChatSession: rename field + fix db_column
                migrations.RemoveIndex(model_name="chatsession", name="chat_sess_proj_updated_idx"),
                migrations.RenameField("chatsession", "agent_space", "space"),
                migrations.AlterField(
                    model_name="chatsession", name="space",
                    field=models.ForeignKey(
                        blank=True, db_column="agent_space_id",
                        db_constraint=False, null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="chat_sessions", to="tabtinspace.space",
                        verbose_name="所属智能体空间",
                    ),
                ),
                migrations.AddIndex(
                    model_name="chatsession",
                    index=models.Index(fields=["space", "-updated_at"], name="chat_sess_space_updated_idx"),
                ),

                # ChatContext: rename fields + fix db_column
                migrations.RemoveIndex(model_name="chatcontext", name="chat_contex_current_e0cc8a_idx"),
                migrations.RenameField("chatcontext", "current_agent_space_id", "current_space_id"),
                migrations.AlterField(
                    model_name="chatcontext", name="current_space_id",
                    field=models.CharField(
                        blank=True, db_column="current_agent_space_id",
                        max_length=100, verbose_name="当前 Space ID",
                    ),
                ),
                migrations.RenameField("chatcontext", "recent_agent_spaces", "recent_spaces"),
                migrations.AlterField(
                    model_name="chatcontext", name="recent_spaces",
                    field=models.JSONField(
                        db_column="recent_agent_spaces", default=list,
                        verbose_name="最近 Space 列表",
                    ),
                ),
                migrations.AddIndex(
                    model_name="chatcontext",
                    index=models.Index(fields=["current_space_id"], name="chat_contex_current_e0cc8a_idx"),
                ),
            ],
            database_operations=[],
        ),
    ]
