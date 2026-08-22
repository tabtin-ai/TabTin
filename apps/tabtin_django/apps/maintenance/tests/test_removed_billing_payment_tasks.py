from __future__ import annotations

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import patch

from celery import current_app
from django.conf import settings
from django.test import SimpleTestCase

from tabtin.celery import get_beat_schedule


REMOVED_TASK_NAMES = {
    "apps.services.agent_engine.tasks.cleanup.chat_message_reconciliation."
    "reconcile_chat_messages_from_trace",
    "apps.services.billing.task_billing.reconcile_member_usage_counters",
    "apps.services.billing.tasks._generate_invoice_batch",
    "apps.services.billing.tasks._settle_organization_batch",
    "apps.services.billing.tasks.auto_collect_open_invoices",
    "apps.services.billing.tasks.auto_collect_single_invoice",
    "apps.services.billing.tasks.auto_retry_failed_invoices_after_recharge",
    "apps.services.billing.tasks.check_dispute_sla_overdue",
    "apps.services.billing.tasks.cleanup_billing_history",
    "apps.services.billing.tasks.cleanup_old_member_usage_counters",
    "apps.services.billing.tasks.collect_daily_storage_charges",
    "apps.services.billing.tasks.compensate_refund_entitlement_sync",
    "apps.services.billing.tasks.detect_billing_anomalies",
    "apps.services.billing.tasks.generate_last_month_invoices",
    "apps.services.billing.tasks.hourly_aggregate_charge",
    "apps.services.billing.tasks.reconcile_daily_billing",
    "apps.services.billing.tasks.reconcile_member_usage_counters",
    "apps.services.billing.tasks.reconcile_new_organization_provider_credits_async",
    "apps.services.billing.tasks.reconcile_storage_snapshots",
    "apps.services.billing.tasks.release_stale_frozen_credits",
    "apps.services.billing.tasks.retry_charge_failed_events",
    "apps.services.billing.tasks.retry_hourly_failed_aggregate_events",
    "apps.services.billing.tasks.retry_internal_refund",
    "apps.services.billing.tasks.retry_storage_billing_compensation",
    "apps.services.billing.tasks.retry_workteam_lifecycle_cleanups",
    "apps.services.billing.tasks.scan_refund_inconsistencies",
    "apps.services.billing.tasks.settle_previous_day_usage_for_all_organizations",
    "apps.services.billing.tasks.snapshot_storage_end_of_day",
    "apps.services.billing.tasks.verify_monthly_invoices_completeness",
    "apps.services.payment.tasks.compensate_unpaid_benefits",
    "apps.services.payment.tasks.reconcile_paying_orders",
    "tabtinspace.cleanup_old_workteam_activity",
    "tabtinspace.compensate_missing_default_workteam",
    "tabtinspace.expire_stale_grants",
    "tabtinspace.repurge_stuck_deleting_workteams",
    "tabtinspace.reset_monthly_suspended_shares",
}


class RemovedBillingPaymentTasksTests(SimpleTestCase):
    def test_removed_tasks_are_not_registered(self):
        current_app.loader.import_default_modules()

        registered = REMOVED_TASK_NAMES.intersection(current_app.tasks)

        self.assertEqual(registered, set())

    def test_removed_tasks_are_not_scheduled(self):
        scheduled = {
            entry["task"]
            for entry in get_beat_schedule().values()
            if isinstance(entry, dict) and "task" in entry
        }

        self.assertEqual(REMOVED_TASK_NAMES.intersection(scheduled), set())

    def test_removed_tasks_have_no_explicit_routes(self):
        explicit_routes = REMOVED_TASK_NAMES.intersection(settings.CELERY_TASK_ROUTES)

        self.assertEqual(explicit_routes, set())

    def test_removed_tasks_are_in_retired_periodic_task_registry(self):
        from tabtin.celery import _RETIRED_PERIODIC_TASK_NAMES

        self.assertEqual(
            REMOVED_TASK_NAMES.difference(_RETIRED_PERIODIC_TASK_NAMES),
            set(),
        )

    @patch("tabtin.celery._gate_fts_search_indexing_producers")
    @patch("tabtin.celery._sync_schedule_to_db")
    @patch(
        "tabtin.celery.get_beat_schedule",
        return_value={"scheduled": {"task": "scheduled.task"}},
    )
    def test_setup_disables_retired_periodic_tasks(
        self,
        _get_beat_schedule,
        _sync_schedule_to_db,
        _gate_fts_search_indexing_producers,
    ):
        from django_celery_beat import models as beat_models

        from tabtin.celery import setup_periodic_tasks

        retired_outbox = SimpleNamespace(
            task="apps.services.billing.tasks.hourly_aggregate_charge",
            enabled=True,
            description="outbox operator note",
        )
        retired_mention = SimpleNamespace(
            task="apps.services.billing.tasks.reconcile_daily_billing",
            enabled=True,
            description="mention operator note",
        )
        already_disabled_retired = SimpleNamespace(
            task="apps.services.billing.tasks.reconcile_daily_billing",
            enabled=False,
            description="disabled by operator",
        )
        scheduled = SimpleNamespace(
            task="scheduled.task",
            enabled=True,
            description="code schedule",
        )
        manual = SimpleNamespace(
            task="manual.task",
            enabled=True,
            description="operator managed",
        )

        class QuerySet:
            def __init__(self, rows):
                self.rows = rows

            def update(self, **values):
                for row in self.rows:
                    for field, value in values.items():
                        setattr(row, field, value)
                return len(self.rows)

        class Manager:
            def __init__(self, rows):
                self.rows = rows

            def filter(self, **conditions):
                rows = self.rows
                if "task__in" in conditions:
                    rows = [
                        row for row in rows
                        if row.task in conditions["task__in"]
                    ]
                if "enabled" in conditions:
                    rows = [
                        row for row in rows
                        if row.enabled is conditions["enabled"]
                    ]
                return QuerySet(rows)

        class PeriodicTasks:
            changed = 0

            @classmethod
            def update_changed(cls):
                cls.changed += 1

        periodic_task = SimpleNamespace(
            objects=Manager([
                retired_outbox,
                retired_mention,
                already_disabled_retired,
                scheduled,
                manual,
            ])
        )
        sender = SimpleNamespace(conf=SimpleNamespace())

        with (
            patch.object(beat_models, "PeriodicTask", periodic_task),
            patch.object(beat_models, "PeriodicTasks", PeriodicTasks),
            patch(
                "django.db.transaction.atomic",
                side_effect=lambda: nullcontext(),
            ) as atomic,
        ):
            setup_periodic_tasks(sender)
            setup_periodic_tasks(sender)

        self.assertFalse(retired_outbox.enabled)
        self.assertFalse(retired_mention.enabled)
        self.assertEqual(retired_outbox.description, "outbox operator note")
        self.assertEqual(retired_mention.description, "mention operator note")
        self.assertFalse(already_disabled_retired.enabled)
        self.assertEqual(
            already_disabled_retired.description,
            "disabled by operator",
        )
        self.assertTrue(scheduled.enabled)
        self.assertEqual(scheduled.description, "code schedule")
        self.assertTrue(manual.enabled)
        self.assertEqual(manual.description, "operator managed")
        self.assertEqual(PeriodicTasks.changed, 1)
        self.assertEqual(atomic.call_count, 2)


class RemovedBillingAdminTaskEndpointsTests(SimpleTestCase):
    @patch("apps.services.billing.api_admin.record_billing_audit")
    @patch("apps.services.billing.api_admin._require_admin")
    def test_reconciliation_endpoint_reports_task_removed(
        self,
        _require_admin,
        _record_billing_audit,
    ):
        from apps.services.billing.api_admin import (
            ReconciliationRunIn,
            admin_run_reconciliation,
        )

        response = admin_run_reconciliation(
            SimpleNamespace(),
            ReconciliationRunIn(target_date="2026-08-14"),
        )

        self.assertEqual(
            response["data"],
            {
                "task_id": "",
                "target_date": "2026-08-14",
                "disabled": True,
                "reason": "task_governance_offline",
            },
        )

    @patch("apps.services.billing.api_admin.record_billing_audit")
    @patch("apps.services.billing.api_admin._require_admin")
    def test_reconciliation_endpoint_accepts_legacy_empty_request(
        self,
        _require_admin,
        _record_billing_audit,
    ):
        from apps.services.billing.api_admin import (
            ReconciliationRunIn,
            admin_run_reconciliation,
        )

        response = admin_run_reconciliation(
            SimpleNamespace(),
            ReconciliationRunIn(),
        )

        self.assertEqual(response["code"], "SUCCESS")
        self.assertEqual(response["data"]["task_id"], "")
        self.assertEqual(response["data"]["target_date"], "yesterday")
        self.assertTrue(response["data"]["disabled"])
        self.assertEqual(response["data"]["reason"], "task_governance_offline")

    @patch("apps.services.billing.api_admin.record_billing_audit")
    @patch("apps.services.billing.api_admin._require_admin")
    def test_storage_reconcile_endpoint_reports_task_removed(
        self,
        _require_admin,
        _record_billing_audit,
    ):
        from apps.services.billing.api_admin import admin_run_storage_reconcile

        response = admin_run_storage_reconcile(SimpleNamespace())

        self.assertEqual(
            response["data"],
            {
                "task_id": "",
                "disabled": True,
                "reason": "task_governance_offline",
            },
        )
