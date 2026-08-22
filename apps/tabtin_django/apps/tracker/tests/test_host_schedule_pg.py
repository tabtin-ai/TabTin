"""本机 agent-host 持钟：清单与到点 fire。"""

from __future__ import annotations

import json
import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase
from django.utils import timezone

from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tracker.api.trackers import fire_host_schedule, list_host_schedule, reconcile_host_schedule
from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.services.tracker_service import TrackerService

pytestmark = pytest.mark.requires_pg_native
User = get_user_model()


class HostSchedulePostgresTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        token = uuid.uuid4().hex
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username=f"host_sched_owner_{token}",
            email=f"host-sched-owner-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Host schedule {token}",
            owner=self.owner,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.owner,
            defaults={"role": "owner"},
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Host schedule device",
            device_type="electron",
            role="control",
            fingerprint=f"host-schedule-{token}",
        )
        self.other_device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Other device",
            device_type="electron",
            role="control",
            fingerprint=f"host-schedule-other-{token}",
        )
        self.workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.owner,
            name="Host workspace",
            working_dir=f"/tmp/host-schedule-{token}",
            normalized_working_dir=f"/tmp/host-schedule-{token}",
        )
        SpaceMembership.objects.create(
            workspace=self.workspace,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        self.due_at = timezone.now() + timedelta(minutes=5)
        self.tracker = Tracker.objects.create(
            organization=self.organization,
            workspace=self.workspace,
            created_by=self.owner,
            name="Daily host tracker",
            status="active",
            trigger_type="cron",
            trigger_config={"cron_expression": "0 9 * * *"},
            skill_params={"instructions": "跑一次"},
            next_run_at=self.due_at,
        )

    def _request(self, *, fingerprint: str | None, method: str = "get"):
        factory = getattr(self.factory, method)
        request = factory("/api/tracker/host-schedule")
        request.auth = self.owner
        if fingerprint:
            request.META["HTTP_X_DEVICE_FINGERPRINT"] = fingerprint
        return request

    def test_list_only_returns_trackers_bound_to_caller_device(self) -> None:
        other_workspace = Workspace.objects.create(
            organization=self.organization,
            device=self.other_device,
            created_by=self.owner,
            name="Other workspace",
            working_dir=f"/tmp/host-schedule-other-{uuid.uuid4().hex}",
            normalized_working_dir=f"/tmp/host-schedule-other-{uuid.uuid4().hex}",
        )
        SpaceMembership.objects.create(
            workspace=other_workspace,
            user=self.owner,
            role="owner",
            is_active=True,
        )
        Tracker.objects.create(
            organization=self.organization,
            workspace=other_workspace,
            created_by=self.owner,
            name="Other device tracker",
            status="active",
            trigger_type="cron",
            trigger_config={"cron_expression": "0 10 * * *"},
            skill_params={"instructions": "别的机器"},
            next_run_at=self.due_at,
        )

        response = list_host_schedule(self._request(fingerprint=self.device.fingerprint))
        self.assertTrue(response["success"])
        items = response["data"]["items"]
        self.assertEqual([item["id"] for item in items], [str(self.tracker.id)])

    def test_list_includes_pending_run_in_host_work(self) -> None:
        run = TrackerRun.objects.create(
            tracker=self.tracker,
            status="pending",
            trigger_type="manual",
        )
        svc = TrackerService(user=self.owner)
        work = svc.list_host_work(self.device)
        self.assertEqual([item.id for item in work], [run.id])

    def test_trigger_persists_run_without_cloud_dispatch(self) -> None:
        svc = TrackerService(user=self.owner)
        run = svc.trigger_tracker(str(self.tracker.id), self.owner, trigger_type="manual")
        self.assertEqual(run.status, "pending")
        self.assertEqual([item.id for item in svc.list_host_work(self.device)], [run.id])

    def test_list_omits_tracker_with_active_run(self) -> None:
        TrackerRun.objects.create(
            tracker=self.tracker,
            status="pending",
            trigger_type="scheduled",
        )
        svc = TrackerService(user=self.owner)
        items = svc.list_host_schedule(self.device)
        self.assertEqual(items, [])

    def test_list_rejects_missing_fingerprint(self) -> None:
        response = list_host_schedule(self._request(fingerprint=None))
        self.assertEqual(response.status_code, 400)
        self.assertEqual(json.loads(response.content)["code"], "VALIDATION_ERROR")

    def test_fire_triggers_scheduled_run_for_bound_device(self) -> None:
        svc = TrackerService(user=self.owner)
        with patch.object(TrackerService, "trigger_tracker") as trigger_mock:
            trigger_mock.return_value = type("Run", (), {"id": uuid.uuid4()})()
            result = svc.fire_host_scheduled_tracker(str(self.tracker.id), self.device)
        self.assertTrue(result["fired"])
        trigger_mock.assert_called_once()
        self.assertEqual(trigger_mock.call_args.kwargs["trigger_type"], "scheduled")

    def test_fire_rejects_other_device(self) -> None:
        svc = TrackerService(user=self.owner)
        with self.assertRaises(PermissionError):
            svc.fire_host_scheduled_tracker(str(self.tracker.id), self.other_device)

    def test_fire_only_persists_a_run(self) -> None:
        original_next = self.tracker.next_run_at
        svc = TrackerService(user=self.owner)
        result = svc.fire_host_scheduled_tracker(str(self.tracker.id), self.device)
        self.tracker.refresh_from_db()
        self.assertTrue(result["fired"])
        self.assertEqual(self.tracker.next_run_at, original_next)
        self.assertTrue(TrackerRun.objects.filter(id=result["run_id"], trigger_type="scheduled").exists())

    def test_fire_endpoint_uses_device_header(self) -> None:
        mock_svc = type("Svc", (), {})()
        mock_svc.fire_host_scheduled_tracker = lambda *args, **kwargs: {
            "fired": True,
            "skipped": False,
            "run_id": str(uuid.uuid4()),
        }
        with patch("apps.tracker.api.trackers._tracker_service", return_value=mock_svc):
            response = fire_host_schedule(
                self._request(fingerprint=self.device.fingerprint, method="post"),
                self.tracker.id,
            )
        self.assertTrue(response["success"])
        self.assertTrue(response["data"]["fired"])

    def test_finalize_completes_running_run(self) -> None:
        run = TrackerRun.objects.create(
            tracker=self.tracker,
            status="running",
            trigger_type="manual",
        )
        svc = TrackerService(user=self.owner)
        result = svc.finalize_host_run(str(run.id), self.device)
        run.refresh_from_db()
        self.assertTrue(result["finalized"])
        self.assertEqual(run.status, "completed")

    def test_reconcile_resumes_waiting_device_run(self) -> None:
        run = TrackerRun.objects.create(
            tracker=self.tracker,
            status="waiting_device",
            trigger_type="scheduled",
        )
        svc = TrackerService(user=self.owner)
        result = svc.reconcile_host_lifecycle(self.device)
        run.refresh_from_db()
        self.assertEqual(result["resumed"], 1)
        self.assertEqual(run.status, "pending")

    def test_reconcile_endpoint_uses_device_header(self) -> None:
        mock_svc = type("Svc", (), {})()
        mock_svc.reconcile_host_lifecycle = lambda *args, **kwargs: {
            "resumed": 0,
            "recovered": 0,
        }
        with patch("apps.tracker.api.trackers._tracker_service", return_value=mock_svc):
            response = reconcile_host_schedule(
                self._request(fingerprint=self.device.fingerprint, method="post"),
            )
        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["resumed"], 0)
