"""PostgreSQL scenarios for the retired Django IM schema reconciliation."""

from __future__ import annotations

import pytest

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


pytestmark = pytest.mark.requires_pg_native


class MissingRetiredImColumnsScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabchat"
    migrate_from = "0027_merge_release_and_retired_history"
    migrate_to = "0028_reconcile_retired_im_model_state"

    def test_migration_scenario(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        self.assertFalse(self._column_exists("tabchat_agent_mention_job", "source_message_ref"))
        self.assertFalse(self._column_exists("tabchat_handoff_package", "card_message_ref"))

    def assert_after_migration(self, connection) -> None:
        self.assertTrue(self._column_exists("tabchat_agent_mention_job", "source_message_ref"))
        self.assertTrue(self._column_exists("tabchat_handoff_package", "card_message_ref"))
        self.assertTrue(self.column_nullable("tabchat_agent_mention_job", "source_message_id"))
        self.assertTrue(self.column_nullable("tabchat_handoff_package", "conversation_id"))

    def _column_exists(self, table: str, column: str) -> bool:
        return self.fetchone(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = %s AND column_name = %s
            )
            """,
            [table, column],
        )[0]


class ExistingRetiredImColumnsScenario(MissingRetiredImColumnsScenario):
    def seed_before_migration(self, connection) -> None:
        self.execute(
            """
            ALTER TABLE tabchat_agent_mention_job
                ADD COLUMN source_message_ref varchar(100) NULL,
                ADD COLUMN source_sender_id varchar(100) NOT NULL DEFAULT '',
                ADD COLUMN source_content text NOT NULL DEFAULT '',
                ADD COLUMN context_messages jsonb NOT NULL DEFAULT '[]'::jsonb,
                ADD COLUMN conversation_ref varchar(100) NOT NULL DEFAULT '',
                ADD COLUMN conversation_name varchar(200) NOT NULL DEFAULT '',
                ADD COLUMN project_ref varchar(100) NOT NULL DEFAULT '',
                ADD COLUMN final_content text NOT NULL DEFAULT '',
                ADD COLUMN final_message_type smallint NOT NULL DEFAULT 1,
                ADD COLUMN final_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
            ALTER TABLE tabchat_handoff_package
                ADD COLUMN conversation_ref varchar(100) NOT NULL DEFAULT '',
                ADD COLUMN card_message_ref uuid NULL,
                ADD COLUMN card_message_sequence bigint NULL;
            """
        )

    def assert_after_migration(self, connection) -> None:
        super().assert_after_migration(connection)
        constraint = self.fetchone(
            "SELECT 1 FROM pg_constraint WHERE conname = %s",
            ["tabchat_agent_job_ref_agent_uniq"],
        )
        self.assertIsNotNone(constraint)
