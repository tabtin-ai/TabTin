from io import StringIO
import os
import re
from unittest.mock import patch
from uuid import uuid4

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase
from django.utils import timezone

from apps.collab.service import RestoreError
from apps.tabdata.constants import TABDATA_DB_ALIAS
from apps.tabdata.management.commands.repair_tabdata_record_divergence import Command
from apps.tabdata.models import Table, TableRecord
from apps.tabtinspace.models import Organization, Project


User = get_user_model()


class RepairTabDataRecordDivergenceCommandTests(TestCase):
    databases = ["default", "postgresql"]

    def setUp(self):
        acquire_lock_patcher = patch(
            "apps.tabdata.management.commands.repair_tabdata_record_divergence."
            "VersionHistoryService.acquire_restore_lock"
        )
        release_lock_patcher = patch(
            "apps.tabdata.management.commands.repair_tabdata_record_divergence."
            "VersionHistoryService.release_restore_lock"
        )
        self.acquire_restore_lock = acquire_lock_patcher.start()
        self.release_restore_lock = release_lock_patcher.start()
        self.addCleanup(acquire_lock_patcher.stop)
        self.addCleanup(release_lock_patcher.stop)

        self.user = User.objects.create_user(
            username="record_divergence_repair_user",
            email="record_divergence_repair@example.com",
            password="testpass123",
        )
        self.organization = Organization.objects.create(
            name="Record Divergence Repair Organization",
            owner=self.user,
        )
        self.space = Project.objects.create(
            name="Record Divergence Repair Space",
            organization=self.organization,
        )
        self.table = Table.objects.using(TABDATA_DB_ALIAS).create(
            organization_id=self.organization.id,
            space_id=self.space.id,
            name="待修复表",
            owner=self.user,
        )
        self.tombstone = TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            is_deleted=True,
            deleted_at=timezone.now(),
        )

    @patch("apps.tabdata.services.collab_service.CollabService.apply_table_ops")
    def test_defaults_to_read_only_plan(self, apply_table_ops):
        output = StringIO()

        call_command(
            "repair_tabdata_record_divergence",
            "--table",
            str(self.table.id),
            stdout=output,
        )

        apply_table_ops.assert_not_called()
        rendered = output.getvalue()
        self.assertIn("DRY-RUN", rendered)
        self.assertIn(f"table={self.table.id}", rendered)
        self.assertIn(f"tombstone_count=1", rendered)
        self.assertIn("plan_hash=", rendered)

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_requires_matching_plan_and_triggers_a_content_neutral_probe(self, apply_table_ops):
        TableRecord.objects.using(TABDATA_DB_ALIAS).create(
            table=self.table,
            is_deleted=False,
        )
        dry_run_output = StringIO()
        call_command(
            "repair_tabdata_record_divergence",
            "--table",
            str(self.table.id),
            stdout=dry_run_output,
        )
        plan_hash = re.search(
            r"^plan_hash=([0-9a-f]{64})$",
            dry_run_output.getvalue(),
            flags=re.MULTILINE,
        ).group(1)
        apply_table_ops.return_value = {
            "applied": 2,
            "total": 2,
            "store_completed": True,
            "record_lifecycle_candidates": 1,
            "record_lifecycle_remaining": 0,
        }
        apply_output = StringIO()

        with patch.dict(os.environ, {"TABTIN_ENV": "ack-test"}, clear=False):
            call_command(
                "repair_tabdata_record_divergence",
                "--table",
                str(self.table.id),
                "--apply",
                "--confirm-table",
                str(self.table.id),
                "--expected-space",
                str(self.space.id),
                "--expected-organization",
                str(self.organization.id),
                "--plan-hash",
                plan_hash,
                "--confirm-flush-pending-collab",
                stdout=apply_output,
            )

        apply_table_ops.assert_called_once()
        kwargs = apply_table_ops.call_args.kwargs
        self.assertEqual(kwargs["table_id"], self.table.id)
        self.assertEqual(kwargs["timeout"], 30)
        self.assertEqual(kwargs["editor_type"], "system")
        self.assertEqual(kwargs["system_policy"], "trusted_internal")
        self.assertTrue(kwargs["require_store_success"])
        self.assertEqual(
            kwargs["record_lifecycle_revalidation_ids"],
            [str(self.tombstone.id)],
        )
        self.assertEqual(len(kwargs["ops"]), 2)
        self.assertEqual(kwargs["ops"][0]["op"], "map.set")
        self.assertEqual(kwargs["ops"][0]["path"], ["meta"])
        self.assertEqual(kwargs["ops"][1]["op"], "map.delete")
        self.assertEqual(kwargs["ops"][1]["path"], ["meta"])
        self.assertFalse(any(op.get("path") == ["records"] for op in kwargs["ops"]))
        self.assertTrue(
            TableRecord.objects.using(TABDATA_DB_ALIAS).get(id=self.tombstone.id).is_deleted
        )
        self.assertIn("未发送记录删除", apply_output.getvalue())
        self.assertIn("字段和视图", apply_output.getvalue())

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_rejects_a_response_without_a_completed_store_barrier(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        apply_table_ops.return_value = {
            "applied": 2,
            "total": 2,
            "record_lifecycle_candidates": 1,
            "record_lifecycle_remaining": 0,
        }

        with self.assertRaisesMessage(CommandError, "未确认完成"):
            command._apply_plan(self.table, plan)

        self.release_restore_lock.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_rejects_when_no_planned_candidate_exists_in_the_room(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        apply_table_ops.return_value = {
            "applied": 2,
            "total": 2,
            "store_completed": True,
            "record_lifecycle_candidates": 0,
            "record_lifecycle_remaining": 0,
        }

        with self.assertRaisesMessage(CommandError, "未找到计划中的候选记录"):
            command._apply_plan(self.table, plan)

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_requires_explicit_pending_diff_confirmation(self, apply_table_ops):
        dry_run_output = StringIO()
        call_command(
            "repair_tabdata_record_divergence",
            "--table",
            str(self.table.id),
            stdout=dry_run_output,
        )
        plan_hash = re.search(
            r"^plan_hash=([0-9a-f]{64})$",
            dry_run_output.getvalue(),
            flags=re.MULTILINE,
        ).group(1)

        with patch.dict(os.environ, {"TABTIN_ENV": "ack-test"}, clear=False):
            with self.assertRaisesMessage(CommandError, "--confirm-flush-pending-collab"):
                call_command(
                    "repair_tabdata_record_divergence",
                    "--table",
                    str(self.table.id),
                    "--apply",
                    "--confirm-table",
                    str(self.table.id),
                    "--expected-space",
                    str(self.space.id),
                    "--expected-organization",
                    str(self.organization.id),
                    "--plan-hash",
                    plan_hash,
                )

        apply_table_ops.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_rejects_a_plan_that_changed_after_dry_run(self, apply_table_ops):
        dry_run_output = StringIO()
        call_command(
            "repair_tabdata_record_divergence",
            "--table",
            str(self.table.id),
            stdout=dry_run_output,
        )
        plan_hash = re.search(
            r"^plan_hash=([0-9a-f]{64})$",
            dry_run_output.getvalue(),
            flags=re.MULTILINE,
        ).group(1)
        self.tombstone.is_deleted = False
        self.tombstone.deleted_at = None
        self.tombstone.save(using=TABDATA_DB_ALIAS, update_fields=["is_deleted", "deleted_at"])

        with patch.dict(os.environ, {"TABTIN_ENV": "ack-test"}, clear=False):
            with self.assertRaisesMessage(CommandError, "plan_hash 已变化"):
                call_command(
                    "repair_tabdata_record_divergence",
                    "--table",
                    str(self.table.id),
                    "--apply",
                    "--confirm-table",
                    str(self.table.id),
                    "--expected-space",
                    str(self.space.id),
                    "--expected-organization",
                    str(self.organization.id),
                    "--plan-hash",
                    plan_hash,
                    "--confirm-flush-pending-collab",
                )

        apply_table_ops.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_rechecks_the_full_plan_before_triggering(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        self.tombstone.is_deleted = False
        self.tombstone.deleted_at = None
        self.tombstone.save(using=TABDATA_DB_ALIAS, update_fields=["is_deleted", "deleted_at"])

        with self.assertRaisesMessage(CommandError, "执行计划已漂移"):
            command._apply_plan(self.table, plan)

        apply_table_ops.assert_not_called()
        self.release_restore_lock.assert_called_once_with(self.table.id)

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_reloads_table_metadata_before_triggering(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        Table.objects.using(TABDATA_DB_ALIAS).filter(id=self.table.id).update(
            record_version_seq=7
        )

        with self.assertRaisesMessage(CommandError, "执行计划已漂移"):
            command._apply_plan(self.table, plan)

        apply_table_ops.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_probe_fails_closed_when_a_record_is_restored_while_it_runs(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)

        def _probe_side_effect(**_kwargs):
            self.tombstone.is_deleted = False
            self.tombstone.deleted_at = None
            self.tombstone.save(
                using=TABDATA_DB_ALIAS,
                update_fields=["is_deleted", "deleted_at"],
            )
            return {
                "applied": 2,
                "total": 2,
                "store_completed": True,
                "record_lifecycle_candidates": 1,
                "record_lifecycle_remaining": 1,
            }

        apply_table_ops.side_effect = _probe_side_effect

        with self.assertRaisesMessage(CommandError, "仍有 1 条候选投影"):
            command._apply_plan(self.table, plan)

        apply_table_ops.assert_called_once()
        self.tombstone.refresh_from_db(using=TABDATA_DB_ALIAS)
        self.assertFalse(self.tombstone.is_deleted)
        self.assertFalse(any(
            op.get("path") == ["records"]
            for op in apply_table_ops.call_args.kwargs["ops"]
        ))

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_holds_the_table_restore_lock_through_the_store_barrier(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        events = []
        self.acquire_restore_lock.side_effect = lambda *_args: events.append("acquire")
        self.release_restore_lock.side_effect = lambda *_args: events.append("release")

        def _store_barrier(**_kwargs):
            self.release_restore_lock.assert_not_called()
            events.append("store")
            return {
                "applied": 2,
                "total": 2,
                "store_completed": True,
                "record_lifecycle_candidates": 1,
                "record_lifecycle_remaining": 0,
            }

        apply_table_ops.side_effect = _store_barrier

        command._apply_plan(self.table, plan)

        self.assertEqual(events, ["acquire", "store", "release"])
        self.acquire_restore_lock.assert_called_once()
        self.release_restore_lock.assert_called_once_with(self.table.id)

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_fails_closed_when_a_table_restore_holds_the_lock(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)
        self.acquire_restore_lock.side_effect = RestoreError(
            RestoreError.LOCK_CONTENTION,
            "busy",
        )

        with self.assertRaisesMessage(CommandError, "目标表正在恢复"):
            command._apply_plan(self.table, plan)

        apply_table_ops.assert_not_called()
        self.release_restore_lock.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_postcheck_detects_a_record_restore_after_the_store_ack(self, apply_table_ops):
        command = Command()
        plan = command._build_plan(self.table)

        def _restore_then_ack(**_kwargs):
            self.tombstone.is_deleted = False
            self.tombstone.deleted_at = None
            self.tombstone.save(
                using=TABDATA_DB_ALIAS,
                update_fields=["is_deleted", "deleted_at"],
            )
            return {
                "applied": 2,
                "total": 2,
                "store_completed": True,
                "record_lifecycle_candidates": 1,
                "record_lifecycle_remaining": 0,
            }

        apply_table_ops.side_effect = _restore_then_ack

        with self.assertRaisesMessage(CommandError, "tombstone 候选已变化"):
            command._apply_plan(self.table, plan)

        self.release_restore_lock.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_rejects_wrong_space_confirmation(self, apply_table_ops):
        dry_run_output = StringIO()
        call_command(
            "repair_tabdata_record_divergence",
            "--table",
            str(self.table.id),
            stdout=dry_run_output,
        )
        plan_hash = re.search(
            r"^plan_hash=([0-9a-f]{64})$",
            dry_run_output.getvalue(),
            flags=re.MULTILINE,
        ).group(1)

        with patch.dict(os.environ, {"TABTIN_ENV": "ack-test"}, clear=False):
            with self.assertRaisesMessage(CommandError, "--expected-space 与目标表归属不一致"):
                call_command(
                    "repair_tabdata_record_divergence",
                    "--table",
                    str(self.table.id),
                    "--apply",
                    "--confirm-table",
                    str(self.table.id),
                    "--expected-space",
                    str(uuid4()),
                    "--expected-organization",
                    str(self.organization.id),
                    "--plan-hash",
                    plan_hash,
                    "--confirm-flush-pending-collab",
                )

        apply_table_ops.assert_not_called()

    @patch("apps.tabdata.management.commands.repair_tabdata_record_divergence.CollabService.apply_table_ops")
    def test_apply_is_rejected_outside_ack_test(self, apply_table_ops):
        with patch.dict(os.environ, {"TABTIN_ENV": "production"}, clear=False):
            with self.assertRaisesMessage(CommandError, "仅允许 TABTIN_ENV=ack-test"):
                call_command(
                    "repair_tabdata_record_divergence",
                    "--table",
                    str(self.table.id),
                    "--apply",
                )

        apply_table_ops.assert_not_called()
