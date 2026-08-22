"""billing.0046 在真实 PostgreSQL 上保留现有运行时配置值。"""

from decimal import Decimal

from django.db.migrations.executor import MigrationExecutor

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class BillingModelStateAlignmentScenario(PostgresMigrationScenarioTestCase):
    app_label = "billing"
    migrate_from = "0045_reconcile_unpublished_auto_topup_history"
    migrate_to = "0046_alter_organizationcreditledger_options_and_more"

    def test_runtime_config_values_survive_alignment(self) -> None:
        self.run_migration_scenario()

    def seed_before_migration(self, connection) -> None:
        executor = MigrationExecutor(connection)
        state_apps = executor.loader.project_state(
            [("billing", self.migrate_from)]
        ).apps
        RuntimeConfig = state_apps.get_model("billing", "BillingRuntimeConfig")
        RuntimeConfig.objects.create(
            id=991,
            credits_per_yuan=321,
            min_balance_threshold=Decimal("1.2345"),
            freeze_fallback_credits=Decimal("2.5000"),
            failopen_max_credits=Decimal("8.7500"),
            show_per_message_cost=False,
            sync_charge_threshold_credits=456,
            internal_llm_call_balance_guard_floor=654,
            large_charge_review_threshold_credits=987,
        )

    def assert_after_migration(self, connection) -> None:
        row = self.fetchone(
            """
            SELECT credits_per_yuan,
                   min_balance_threshold,
                   freeze_fallback_credits,
                   failopen_max_credits,
                   show_per_message_cost,
                   sync_charge_threshold_credits,
                   internal_llm_call_balance_guard_floor,
                   large_charge_review_threshold_credits
            FROM services_billing_runtime_config
            WHERE id = 991
            """
        )
        self.assertEqual(
            row,
            (
                321,
                Decimal("1.2345"),
                Decimal("2.5000"),
                Decimal("8.7500"),
                False,
                456,
                654,
                987,
            ),
        )
