"""Reconcile ORM state with columns written by the retired Django IM branch.

Some databases received the original 0023/0024 schema operations before those
history nodes were replaced with compatibility no-ops. Fresh databases never
received the columns. Add them only when absent, then record the matching model
state. Reverse migration deliberately keeps the columns to avoid data loss.
"""

from django.db import migrations, models
import django.db.models.deletion


RECONCILE_SQL = """
ALTER TABLE tabchat_agent_mention_job
    ALTER COLUMN source_message_id DROP NOT NULL,
    ALTER COLUMN conversation_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS source_message_ref varchar(100) NULL,
    ADD COLUMN IF NOT EXISTS source_sender_id varchar(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS source_content text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS context_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS conversation_ref varchar(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS conversation_name varchar(200) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS project_ref varchar(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS final_content text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS final_message_type smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS final_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE tabchat_agent_mention_job
    ALTER COLUMN source_sender_id DROP DEFAULT,
    ALTER COLUMN source_content DROP DEFAULT,
    ALTER COLUMN context_messages DROP DEFAULT,
    ALTER COLUMN conversation_ref DROP DEFAULT,
    ALTER COLUMN conversation_name DROP DEFAULT,
    ALTER COLUMN project_ref DROP DEFAULT,
    ALTER COLUMN final_content DROP DEFAULT,
    ALTER COLUMN final_message_type DROP DEFAULT,
    ALTER COLUMN final_metadata DROP DEFAULT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tabchat_agent_job_ref_agent_uniq'
    ) THEN
        ALTER TABLE tabchat_agent_mention_job
            ADD CONSTRAINT tabchat_agent_job_ref_agent_uniq
            UNIQUE (source_message_ref, agent_id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'tabchat_agent_mention_job_final_message_type_check'
    ) THEN
        ALTER TABLE tabchat_agent_mention_job
            ADD CONSTRAINT tabchat_agent_mention_job_final_message_type_check
            CHECK (final_message_type >= 0);
    END IF;
END $$;

ALTER TABLE tabchat_handoff_package
    ALTER COLUMN conversation_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS conversation_ref varchar(100) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS card_message_ref uuid NULL,
    ADD COLUMN IF NOT EXISTS card_message_sequence bigint NULL;

ALTER TABLE tabchat_handoff_package
    ALTER COLUMN conversation_ref DROP DEFAULT;

CREATE INDEX IF NOT EXISTS tabchat_handoff_conversation_ref_idx
    ON tabchat_handoff_package (conversation_ref);
"""


class Migration(migrations.Migration):
    dependencies = [("tabchat", "0027_merge_release_and_retired_history")]

    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(RECONCILE_SQL, reverse_sql=migrations.RunSQL.noop),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="agentmentionjob",
                    name="source_message",
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="agent_mention_jobs",
                        to="tabchat.message",
                    ),
                ),
                migrations.AlterField(
                    model_name="agentmentionjob",
                    name="conversation",
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="agent_mention_jobs",
                        to="tabchat.conversation",
                    ),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="source_message_ref",
                    field=models.CharField(blank=True, max_length=100, null=True),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="source_sender_id",
                    field=models.CharField(blank=True, default="", max_length=100),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="source_content",
                    field=models.TextField(blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="context_messages",
                    field=models.JSONField(blank=True, default=list),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="conversation_ref",
                    field=models.CharField(blank=True, default="", max_length=100),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="conversation_name",
                    field=models.CharField(blank=True, default="", max_length=200),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="project_ref",
                    field=models.CharField(blank=True, default="", max_length=100),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="final_content",
                    field=models.TextField(blank=True, default=""),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="final_message_type",
                    field=models.PositiveSmallIntegerField(default=1),
                ),
                migrations.AddField(
                    model_name="agentmentionjob",
                    name="final_metadata",
                    field=models.JSONField(blank=True, default=dict),
                ),
                migrations.AddConstraint(
                    model_name="agentmentionjob",
                    constraint=models.UniqueConstraint(
                        fields=("source_message_ref", "agent_id"),
                        name="tabchat_agent_job_ref_agent_uniq",
                    ),
                ),
                migrations.AlterField(
                    model_name="handoffpackage",
                    name="conversation",
                    field=models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="handoff_packages",
                        to="tabchat.conversation",
                    ),
                ),
                migrations.AddField(
                    model_name="handoffpackage",
                    name="conversation_ref",
                    field=models.CharField(blank=True, db_index=True, max_length=100),
                ),
                migrations.AddField(
                    model_name="handoffpackage",
                    name="card_message_ref",
                    field=models.UUIDField(blank=True, null=True),
                ),
                migrations.AddField(
                    model_name="handoffpackage",
                    name="card_message_sequence",
                    field=models.BigIntegerField(blank=True, null=True),
                ),
            ],
        ),
    ]
