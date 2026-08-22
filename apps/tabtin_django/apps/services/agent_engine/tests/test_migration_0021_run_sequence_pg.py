from __future__ import annotations

import uuid

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class ExecutionRunSequenceBackfillScenario(PostgresMigrationScenarioTestCase):
    app_label = "agent_engine"
    migrate_from = "0020_session_run_projection"
    migrate_to = "0022_execution_run_sequence_constraint"

    def test_empty_session_ids_and_existing_runs_survive_unique_constraint(self):
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection) -> None:
        old_apps = self._state_apps(connection, self.migrate_from)
        ExecutionRun = old_apps.get_model("agent_engine", "ExecutionRun")
        self.session_id = str(uuid.uuid4())
        self.empty_run_ids = [uuid.uuid4(), uuid.uuid4()]
        self.session_run_ids = [uuid.uuid4(), uuid.uuid4()]

        for run_id in self.empty_run_ids:
            ExecutionRun.objects.create(
                run_id=run_id,
                thread_id=f"legacy-{run_id}",
                graph_type="chat",
                session_id="",
                status="error",
            )
        for run_id in self.session_run_ids:
            ExecutionRun.objects.create(
                run_id=run_id,
                thread_id=f"chat-session-{self.session_id}",
                graph_type="chat",
                session_id=self.session_id,
                status="running",
            )

    def assert_after_migration(self, connection) -> None:
        new_apps = self._state_apps(connection, self.migrate_to)
        ExecutionRun = new_apps.get_model("agent_engine", "ExecutionRun")

        empty_runs = ExecutionRun.objects.filter(
            run_id__in=self.empty_run_ids,
        ).order_by("run_id")
        self.assertEqual(
            list(empty_runs.values_list("session_id", flat=True)),
            [None, None],
        )
        self.assertEqual(
            set(empty_runs.values_list("status", flat=True)),
            {"failed"},
        )
        self.assertEqual(
            list(
                ExecutionRun.objects.filter(
                    run_id__in=self.session_run_ids,
                )
                .order_by("sequence")
                .values_list("sequence", flat=True)
            ),
            [1, 2],
        )
