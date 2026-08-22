"""Tracker capability 契约的 PostgreSQL 回归测试。

capability 必须逐 Workspace 读取现有 RBAC 事实源：

- viewer 可读，但不能编辑、触发或取消；
- editor 能执行写动作；
- 同一个用户在不同 Workspace 的 capability 可以不同；
- Run 的 ``can_cancel`` 除 editor 权限外，还要叠加可取消状态。
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase

from apps.tabtinspace.models import (
    Device,
    Organization,
    OrganizationMember,
    SpaceMembership,
    Workspace,
)
from apps.tracker.api.trackers import (
    cancel_tracker_run,
    get_tracker,
    get_tracker_run,
    list_tracker_runs,
    list_trackers,
    trigger_tracker,
    update_tracker,
)
from apps.tracker.models import Tracker, TrackerRun
from apps.tracker.tracker_schemas import TrackerUpdate


pytestmark = pytest.mark.requires_pg_native
User = get_user_model()

_READ_ONLY_CAPABILITIES = {
    "can_edit": False,
    "can_trigger": False,
    "can_cancel": False,
}
_EDITOR_CAPABILITIES = {
    "can_edit": True,
    "can_trigger": True,
    "can_cancel": True,
}


class TrackerCapabilitiesPostgresTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self) -> None:
        token = uuid.uuid4().hex
        self.factory = RequestFactory()
        self.owner = User.objects.create_user(
            username=f"tracker_caps_owner_{token}",
            email=f"tracker-caps-owner-{token}@example.com",
            password="test-password",
        )
        self.member = User.objects.create_user(
            username=f"tracker_caps_member_{token}",
            email=f"tracker-caps-member-{token}@example.com",
            password="test-password",
        )
        self.organization = Organization.objects.create(
            name=f"Tracker capability {token}",
            owner=self.owner,
        )
        OrganizationMember.objects.get_or_create(
            organization=self.organization,
            user=self.owner,
            defaults={"role": "owner"},
        )
        OrganizationMember.objects.create(
            organization=self.organization,
            user=self.member,
            # 故意给 organization editor：capability 仍必须以逐 Workspace
            # membership 为准，不能拿组织角色把 Viewer Workspace 拍平成可写。
            role="editor",
        )
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.owner,
            name="Tracker capability device",
            device_type="electron",
            role="control",
            fingerprint=f"tracker-capability-{token}",
        )
        self.viewer_workspace = self._create_workspace(
            name="Viewer Workspace",
            path=f"/tmp/tracker-capability-viewer-{token}",
        )
        self.editor_workspace = self._create_workspace(
            name="Editor Workspace",
            path=f"/tmp/tracker-capability-editor-{token}",
        )
        for workspace in (self.viewer_workspace, self.editor_workspace):
            SpaceMembership.objects.create(
                workspace=workspace,
                user=self.owner,
                role="owner",
                is_active=True,
            )
        SpaceMembership.objects.create(
            workspace=self.viewer_workspace,
            user=self.member,
            role="viewer",
            is_active=True,
        )
        SpaceMembership.objects.create(
            workspace=self.editor_workspace,
            user=self.member,
            role="editor",
            is_active=True,
        )

        self.viewer_tracker = self._create_tracker(
            self.viewer_workspace,
            name="Viewer Tracker",
        )
        self.editor_tracker = self._create_tracker(
            self.editor_workspace,
            name="Editor Tracker",
        )
        self.viewer_pending_run = TrackerRun.objects.create(
            tracker=self.viewer_tracker,
            trigger_type="manual",
            status="pending",
        )
        self.editor_pending_run = TrackerRun.objects.create(
            tracker=self.editor_tracker,
            trigger_type="manual",
            status="pending",
        )
        self.editor_completed_run = TrackerRun.objects.create(
            tracker=self.editor_tracker,
            trigger_type="manual",
            status="completed",
        )

    def _create_workspace(self, *, name: str, path: str) -> Workspace:
        return Workspace.objects.create(
            organization=self.organization,
            device=self.device,
            created_by=self.owner,
            name=name,
            working_dir=path,
            normalized_working_dir=path,
        )

    def _create_tracker(self, workspace: Workspace, *, name: str) -> Tracker:
        return Tracker.objects.create(
            organization=self.organization,
            workspace=workspace,
            created_by=self.owner,
            name=name,
            trigger_type="manual",
            skill_params={"instructions": "执行测试任务"},
        )

    def _request(self, path: str = "/api/tracker/events"):
        request = self.factory.get(path)
        request.auth = self.member
        return request

    def test_list_and_detail_resolve_capabilities_per_workspace(self) -> None:
        """同一用户跨 Workspace 的角色不同，不能被 organization 角色拍平。"""
        response = list_trackers(
            self._request(),
            organization_id=str(self.organization.id),
            space_id=None,
            event_type=None,
            page=1,
            page_size=200,
        )

        self.assertTrue(response["success"])
        events_by_id = {event["id"]: event for event in response["data"]["events"]}
        self.assertEqual(
            events_by_id[str(self.viewer_tracker.id)]["capabilities"],
            _READ_ONLY_CAPABILITIES,
        )
        self.assertEqual(
            events_by_id[str(self.editor_tracker.id)]["capabilities"],
            _EDITOR_CAPABILITIES,
        )

        viewer_detail = get_tracker(
            self._request(f"/api/tracker/events/{self.viewer_tracker.id}"),
            self.viewer_tracker.id,
        )
        editor_detail = get_tracker(
            self._request(f"/api/tracker/events/{self.editor_tracker.id}"),
            self.editor_tracker.id,
        )
        self.assertEqual(
            viewer_detail["data"]["capabilities"],
            _READ_ONLY_CAPABILITIES,
        )
        self.assertEqual(
            editor_detail["data"]["capabilities"],
            _EDITOR_CAPABILITIES,
        )

    def test_run_capabilities_keep_permission_semantics_and_gate_cancel_by_status(self) -> None:
        """Run 保留编辑/触发授权；can_cancel 再叠加服务端可取消状态。"""
        editor_running_run = TrackerRun.objects.create(
            tracker=self.editor_tracker,
            trigger_type="manual",
            status="running",
        )
        editor_waiting_run = TrackerRun.objects.create(
            tracker=self.editor_tracker,
            trigger_type="manual",
            status="waiting_device",
        )
        viewer_response = list_tracker_runs(
            self._request(),
            self.viewer_tracker.id,
        )
        self.assertEqual(
            viewer_response["data"]["runs"][0]["capabilities"],
            _READ_ONLY_CAPABILITIES,
        )

        editor_response = list_tracker_runs(
            self._request(),
            self.editor_tracker.id,
        )
        editor_runs = {
            run["id"]: run["capabilities"]
            for run in editor_response["data"]["runs"]
        }
        self.assertEqual(
            editor_runs[str(self.editor_pending_run.id)],
            _EDITOR_CAPABILITIES,
        )
        self.assertEqual(
            editor_runs[str(editor_running_run.id)],
            _EDITOR_CAPABILITIES,
        )
        self.assertEqual(
            editor_runs[str(editor_waiting_run.id)],
            _EDITOR_CAPABILITIES,
        )
        self.assertEqual(
            editor_runs[str(self.editor_completed_run.id)],
            {
                "can_edit": True,
                "can_trigger": True,
                "can_cancel": False,
            },
        )

        detail_response = get_tracker_run(
            self._request(),
            self.editor_tracker.id,
            self.editor_completed_run.id,
        )
        self.assertEqual(
            detail_response["data"]["capabilities"],
            {
                "can_edit": True,
                "can_trigger": True,
                "can_cancel": False,
            },
        )

    def test_viewer_is_read_only_and_existing_write_guard_returns_403(self) -> None:
        response = update_tracker(
            self._request(),
            self.viewer_tracker.id,
            TrackerUpdate(name="viewer must not rename"),
        )

        self.assertEqual(response.status_code, 403)
        self.viewer_tracker.refresh_from_db()
        self.assertEqual(self.viewer_tracker.name, "Viewer Tracker")

        trigger_response = trigger_tracker(
            self._request(),
            self.viewer_tracker.id,
        )
        self.assertEqual(trigger_response.status_code, 403)
        self.assertEqual(
            TrackerRun.objects.filter(tracker=self.viewer_tracker).count(),
            1,
        )

        cancel_response = cancel_tracker_run(
            self._request(),
            self.viewer_tracker.id,
            self.viewer_pending_run.id,
        )
        self.assertEqual(cancel_response.status_code, 403)
        self.viewer_pending_run.refresh_from_db()
        self.assertEqual(self.viewer_pending_run.status, "pending")

    def test_editor_can_trigger_update_and_cancel(self) -> None:
        with patch(
            "apps.tracker.services.tracker_service._push_tracker_lifecycle_ws"
        ):
            update_response = update_tracker(
                self._request(),
                self.editor_tracker.id,
                TrackerUpdate(name="Editor renamed Tracker"),
            )
        self.assertTrue(update_response["success"])
        self.assertEqual(
            update_response["data"]["capabilities"],
            _EDITOR_CAPABILITIES,
        )

        with (
            patch(
                "apps.tracker.services.tracker_notification.TrackerNotificationService"
            ),
            patch(
                "apps.tracker.services.tracker_executor._update_tracker_stats"
            ),
            patch(
                "apps.tracker.services.tracker_executor._release_tracker_run_runtime_claim"
            ),
        ):
            cancel_response = cancel_tracker_run(
                self._request(),
                self.editor_tracker.id,
                self.editor_pending_run.id,
            )
        self.assertTrue(cancel_response["success"])
        self.assertEqual(
            cancel_response["data"]["capabilities"],
            {
                "can_edit": True,
                "can_trigger": True,
                "can_cancel": False,
            },
        )
        self.editor_pending_run.refresh_from_db()
        self.assertEqual(self.editor_pending_run.status, "cancelled")

        trigger_response = trigger_tracker(
            self._request(),
            self.editor_tracker.id,
        )
        self.assertTrue(trigger_response["success"])
        self.assertEqual(
            trigger_response["data"]["capabilities"],
            _EDITOR_CAPABILITIES,
        )
