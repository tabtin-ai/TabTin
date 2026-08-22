from datetime import timedelta
from decimal import Decimal
from importlib import import_module
from inspect import getsource
from uuid import uuid4

from django.conf import settings
from django.db import IntegrityError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase
from django.utils import timezone

from apps.services.migration_guard.scenario import PostgresMigrationScenarioTestCase


class SubscriptionLifecycleMigrationScenario(PostgresMigrationScenarioTestCase):
    app_label = "membership"
    migrate_from = "0017_alter_organizationmembership_options_and_more"
    migrate_to = "0020_enforce_subscription_lifecycle_defaults"

    def test_historical_membership_is_backfilled_without_fabricated_price(self):
        self.run_migration_scenario()

    def _state_apps(self, connection, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        targets = self._resolve_targets(target, required=True)
        return executor.loader.project_state(targets).apps

    def seed_before_migration(self, connection):
        old_apps = self._state_apps(connection, self.migrate_from)
        MembershipTier = old_apps.get_model("membership", "MembershipTier")
        OrganizationMembership = old_apps.get_model(
            "membership",
            "OrganizationMembership",
        )

        self.tier_id = str(uuid4())
        self.membership_id = str(uuid4())
        self.organization_id = uuid4()
        self.start_date = timezone.now() - timedelta(days=9)
        self.end_date = timezone.now() + timedelta(days=21)

        tier = MembershipTier.objects.create(
            id=self.tier_id,
            tier_type=f"migration-{self.tier_id[:8]}",
            name="迁移前公开价套餐",
            description="",
            price=Decimal("8888.00"),
            duration_months=12,
            tier_level=20,
            sort_order=-123,
            features={},
        )
        OrganizationMembership.objects.create(
            id=self.membership_id,
            organization_id=str(self.organization_id),
            tier=tier,
            status="active",
            start_date=self.start_date,
            end_date=self.end_date,
            related_order_id="legacy-order-reference",
            auto_renew=True,
            purchased_by="legacy-user-id",
        )

    def assert_after_migration(self, connection):
        new_apps = self._state_apps(connection, self.migrate_to)
        OrganizationMembership = new_apps.get_model(
            "membership",
            "OrganizationMembership",
        )
        ChangeLog = new_apps.get_model(
            "membership",
            "OrganizationMembershipChangeLog",
        )
        user_app_label, user_model_name = settings.AUTH_USER_MODEL.split(".", 1)
        User = new_apps.get_model(user_app_label, user_model_name)
        Organization = new_apps.get_model("tabtinspace", "Organization")

        membership = OrganizationMembership.objects.get(id=self.membership_id)
        self.assertEqual(membership.billing_cycle, "monthly")
        self.assertEqual(membership.lifecycle_version, 1)
        self.assertIsNone(membership.current_actual_paid_period_price)
        self.assertIsNone(membership.grace_period_end)
        self.assertEqual(str(membership.tier_id), self.tier_id)
        self.assertEqual(membership.status, "active")
        self.assertEqual(membership.start_date, self.start_date)
        self.assertEqual(membership.end_date, self.end_date)
        self.assertEqual(membership.related_order_id, "legacy-order-reference")
        self.assertTrue(membership.auto_renew)

        user_id = str(uuid4())
        User.objects.create(
            id=user_id,
            username=f"membership-migration-{user_id[:8]}",
            email=f"membership-migration-{user_id[:8]}@tabtin.test",
            password="!",
        )
        organization = Organization.objects.create(
            id=self.organization_id,
            owner_id=user_id,
            name="Membership migration organization",
        )

        ChangeLog.objects.create(
            organization=organization,
            change_type="downgrade",
            status="pending",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ChangeLog.objects.create(
                    organization=organization,
                    change_type="switch",
                    status="pending",
                )

        ChangeLog.objects.create(
            organization=organization,
            change_type="upgrade",
            status="payment_pending",
            payment_order_id="payment-primary-key",
        )
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                ChangeLog.objects.create(
                    organization=organization,
                    change_type="renew",
                    status="payment_pending",
                    payment_order_id="payment-primary-key",
                )

        constraints = connection.introspection.get_constraints(
            connection.cursor(),
            ChangeLog._meta.db_table,
        )
        self.assertIn("uniq_membership_change_payment_order", constraints)
        self.assertIn("uniq_pending_membership_plan_per_org", constraints)

        self._migrate(
            connection,
            self._resolve_targets(self.migrate_from, required=True),
        )
        table_names = connection.introspection.table_names()
        self.assertNotIn(
            "users_membership_organization_change_log",
            table_names,
        )
        old_columns = {
            column.name
            for column in connection.introspection.get_table_description(
                connection.cursor(),
                "users_membership_organization_membership",
            )
        }
        self.assertNotIn("billing_cycle", old_columns)
        self.assertNotIn("lifecycle_version", old_columns)
        self.assertNotIn("current_actual_paid_period_price", old_columns)
        self.assertNotIn("grace_period_end", old_columns)


class SubscriptionLifecycleMigrationScopeTests(SimpleTestCase):
    def test_data_migration_only_backfills_cycle_and_version(self):
        migration_module = import_module(
            "apps.users.membership.migrations."
            "0019_backfill_subscription_lifecycle_defaults"
        )
        source = getsource(migration_module.backfill_lifecycle_defaults)
        self.assertIn("billing_cycle='monthly'", source)
        self.assertIn("lifecycle_version=1", source)
        self.assertNotIn("price", source.lower())
        self.assertNotIn("PaymentOrder", source)
        self.assertNotIn("OrganizationWallet", source)
        self.assertNotIn("OrganizationLlmMonthlyBudget", source)

    def test_schema_migration_does_not_target_payment_wallet_or_budget_models(self):
        migration_module = import_module(
            "apps.users.membership.migrations.0018_subscription_lifecycle_schema"
        )
        operation_text = "\n".join(
            repr(operation)
            for operation in migration_module.Migration.operations
        )
        self.assertNotIn("PaymentOrder", operation_text)
        self.assertNotIn("OrganizationWallet", operation_text)
        self.assertNotIn("OrganizationLlmMonthlyBudget", operation_text)
