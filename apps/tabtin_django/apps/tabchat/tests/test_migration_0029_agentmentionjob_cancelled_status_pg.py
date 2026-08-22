"""PostgreSQL scenario for AgentMentionJob cancelled status migration."""

from uuid import uuid4

import pytest
from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


pytestmark = pytest.mark.requires_pg_native


class AgentMentionJobCancelledStatusScenario(PostgresMigrationScenarioTestCase):
    app_label = "tabchat"
    migrate_from = "0028_reconcile_retired_im_model_state"
    migrate_to = "0029_agentmentionjob_cancelled_status"

    def test_existing_statuses_survive_and_cancelled_is_available(self) -> None:
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        return executor.loader.project_state(
            self._resolve_targets(target, required=True)
        ).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        AgentMentionJob = old_apps.get_model("tabchat", "AgentMentionJob")

        self.job_ids = {}
        for status in ("pending", "running", "succeeded", "failed"):
            job_id = uuid4()
            self.job_ids[status] = job_id
            AgentMentionJob.objects.create(
                id=job_id,
                agent_id=f"agent-{status}",
                organization_id="org-migration-0029",
                status=status,
                billing_idempotency_key=f"migration-0029-{status}",
            )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        AgentMentionJob = new_apps.get_model("tabchat", "AgentMentionJob")

        statuses = {
            str(job.id): job.status
            for job in AgentMentionJob.objects.filter(id__in=self.job_ids.values())
        }
        self.assertEqual(
            statuses,
            {str(job_id): status for status, job_id in self.job_ids.items()},
        )
        self.assertTrue(
            all(
                job.source_message_seq is None
                for job in AgentMentionJob.objects.filter(id__in=self.job_ids.values())
            )
        )
        self.assertIn(
            ("cancelled", "Cancelled"),
            AgentMentionJob._meta.get_field("status").choices,
        )
        self.assertFalse(self.column_nullable("tabchat_agent_mention_job", "status"))
        self.assertTrue(
            self.column_nullable("tabchat_agent_mention_job", "source_message_seq")
        )
