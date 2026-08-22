"""#9964 Agent Host 权威状态主动拉取回归。"""

import uuid

from django.contrib.auth import get_user_model
from django.db.models.signals import post_save
from django.test import RequestFactory, TestCase

from apps.agent.models import Agent
from apps.skills.models import AgentSkillLink, UserSkillPreference
from apps.tabmemo.models import MemoRecordStyle
from apps.tabtinspace.models import (
    Device,
    MCPConnection,
    SpaceAppSettings,
    SpaceMembership,
    Workspace,
)
from apps.tabtinspace.services.base import ServiceError
from apps.tabtinspace.services.host_state_pull_service import HostStatePullService
from apps.tabtinspace.signals import create_default_organization
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user

User = get_user_model()


class HostStatePullServiceTests(TestCase):
    databases = {"default", "postgresql"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        post_save.disconnect(create_default_organization, sender=User)

    @classmethod
    def tearDownClass(cls):
        post_save.connect(create_default_organization, sender=User)
        super().tearDownClass()

    def setUp(self):
        self.user = create_test_user(prefix="host-state")
        self.organization = create_test_organization(
            owner=self.user,
            prefix="host-state",
        )
        self.organization.settings = {"allow_member_yolo": True}
        self.organization.save(update_fields=["settings", "updated_at"])
        self.device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Host device",
            device_type="electron",
            role="control",
            fingerprint=f"host-state-{uuid.uuid4().hex}",
            status="online",
        )

    def _workspace(self, *, device=None, name="Workspace"):
        workspace = Workspace.objects.create(
            organization=self.organization,
            device=device or self.device,
            name=name,
            working_dir=f"/tmp/{uuid.uuid4().hex}",
            normalized_working_dir=f"/tmp/{uuid.uuid4().hex}",
            approval_grant="auto",
            custom_rules="workspace rules",
            execution_limits={"enabled": True, "max_iterations_per_run": 8},
            created_by=self.user,
        )
        SpaceMembership.objects.create(
            workspace=workspace,
            user=self.user,
            role="owner",
        )
        return workspace

    def _agent(self, *, name="Agent", owner=None, active=True):
        return Agent.objects.create(
            organization=self.organization,
            owner_user=owner or self.user,
            name=name,
            is_active=active,
            custom_rules="agent rules",
            agent_config={"schema_version": 2, "security": {}},
        )

    def test_returns_every_agent_workspace_pair_bound_to_device(self):
        workspaces = [self._workspace(name="one"), self._workspace(name="two")]
        agents = [self._agent(name="one"), self._agent(name="two")]

        result = HostStatePullService(user=self.user).pull(self.device.fingerprint)

        self.assertEqual(len(result["contexts"]), 4)
        self.assertEqual(
            {
                (str(context["agentDetail"]["id"]), context["workspaceDetail"]["id"])
                for context in result["contexts"]
            },
            {
                (str(agent.id), str(workspace.id))
                for agent in agents
                for workspace in workspaces
            },
        )
        context = result["contexts"][0]
        self.assertEqual(context["organizationId"], str(self.organization.id))
        self.assertEqual(context["organizationDetail"]["name"], self.organization.name)
        self.assertTrue(
            context["agentDetail"]["organization_allow_member_yolo"]
        )
        self.assertIn("goal", context["agentDetail"])
        self.assertIn("settings", context["agentDetail"])
        self.assertIn("suggested_prompts", context["agentDetail"])
        self.assertEqual(context["workspaceDetail"]["approval_grant"], "auto")
        self.assertEqual(context["workspaceDetail"]["working_dir"], workspaces[0].working_dir)
        self.assertEqual(
            context["workspaceDetail"]["device_id"],
            str(self.device.id),
        )
        self.assertEqual(
            context["workspaceDetail"]["execution_limits"]["max_iterations_per_run"],
            8,
        )
        self.assertIn("operationSwitches", context["runtimeConfig"])
        self.assertIsInstance(context["runtimeConfig"]["memoryCapability"], bool)
        self.assertIsInstance(context["runtimeConfig"]["enabledApps"], list)

    def test_excludes_other_device_inactive_and_foreign_agents(self):
        included_workspace = self._workspace()
        other_device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Other device",
            device_type="electron",
            role="control",
            fingerprint=f"host-state-other-{uuid.uuid4().hex}",
        )
        self._workspace(device=other_device)
        included_agent = self._agent()
        self._agent(name="inactive", active=False)
        other_user = create_test_user(prefix="host-state-other")
        self._agent(name="foreign", owner=other_user)

        result = HostStatePullService(user=self.user).pull(self.device.fingerprint)

        self.assertEqual(len(result["contexts"]), 1)
        self.assertEqual(
            str(result["contexts"][0]["agentDetail"]["id"]),
            str(included_agent.id),
        )
        self.assertEqual(
            result["contexts"][0]["workspaceDetail"]["id"],
            str(included_workspace.id),
        )

    def test_rejects_foreign_device(self):
        other_user = create_test_user(prefix="host-state-foreign")
        with self.assertRaises(ServiceError) as foreign_error:
            HostStatePullService(user=other_user).pull(self.device.fingerprint)
        self.assertEqual(foreign_error.exception.status, 404)

    def test_runtime_configuration_changes_invalidate_bound_host(self):
        from unittest.mock import patch

        workspace = self._workspace()
        agent = self._agent()
        publish_path = (
            "apps.tabtinspace.services.host_state_invalidation."
            "publish_host_state_invalidated"
        )
        with patch(publish_path) as publish:
            changes = [
                lambda: SpaceAppSettings.objects.create(
                    workspace=workspace,
                    user=self.user,
                    disabled_apps=["tabdoc"],
                ),
                lambda: MemoRecordStyle.objects.create(
                    user_id=self.user.id,
                    organization_id=self.organization.id,
                    enabled=False,
                ),
                lambda: AgentSkillLink.objects.create(
                    agent=agent,
                    skill_canonical_key="platform:live-test",
                    source="platform",
                ),
                lambda: UserSkillPreference.objects.create(
                    user_id=self.user.id,
                    skill_canonical_key="platform:live-test",
                    enabled=False,
                ),
                lambda: MCPConnection.objects.create(
                    name="Live test MCP",
                    device=self.device,
                    transport="http",
                    endpoint="https://example.invalid/mcp",
                ),
            ]

            for change in changes:
                publish.reset_mock()
                with self.captureOnCommitCallbacks(execute=True):
                    change()
                publish.assert_called_once()
                self.assertEqual(
                    list(publish.call_args.args[0]),
                    [self.device.fingerprint],
                )

    def test_workspace_rebind_invalidates_old_and_new_devices(self):
        from unittest.mock import patch

        old_device = self.device
        new_device = Device.objects.create(
            organization=self.organization,
            user=self.user,
            name="Replacement device",
            device_type="electron",
            role="control",
            fingerprint=f"host-state-replacement-{uuid.uuid4().hex}",
            status="online",
        )
        workspace = self._workspace(device=old_device)
        publish_path = (
            "apps.tabtinspace.services.host_state_invalidation."
            "publish_host_state_invalidated"
        )

        with patch(publish_path) as publish, self.captureOnCommitCallbacks(execute=True):
            workspace.device = new_device
            workspace.save(update_fields=["device", "updated_at"])

        publish.assert_called_once_with(
            tuple(sorted([old_device.fingerprint, new_device.fingerprint])),
            reason="workspace_binding_changed",
        )

    def test_workspace_delete_invalidates_bound_device(self):
        from unittest.mock import patch

        workspace = self._workspace()
        publish_path = (
            "apps.tabtinspace.services.host_state_invalidation."
            "publish_host_state_invalidated"
        )

        with patch(publish_path) as publish, self.captureOnCommitCallbacks(execute=True):
            workspace.delete()

        publish.assert_called_once_with(
            (self.device.fingerprint,),
            reason="workspace_binding_changed",
        )


class HostStatePullRouteTests(TestCase):
    def test_route_accepts_access_and_daemon_auth(self):
        from apps.tabtinspace.routers.device import router

        for path, path_view in router.path_operations.items():
            if "host-state" not in str(path):
                continue
            auth_names = {
                type(callback).__name__
                for operation in path_view.operations
                for callback in (operation.auth_callbacks or [])
            }
            self.assertEqual(auth_names, {"JWTAuth", "DaemonJWTAuth"})
            return
        self.fail("host-state route not found")

    def test_route_uses_daemon_claim_instead_of_untrusted_header(self):
        from unittest.mock import patch

        from apps.tabtinspace.routers.device import get_device_host_state

        request = RequestFactory().get(
            "/api/context/devices/host-state",
            HTTP_X_DEVICE_FINGERPRINT="spoofed-fingerprint",
        )
        request.auth = type("User", (), {"id": "user-1"})()
        request.daemon_device_id = "daemon-fingerprint"
        with patch(
            "apps.tabtinspace.services.host_state_pull_service.HostStatePullService.pull",
            return_value={"contexts": []},
        ) as pull:
            response = get_device_host_state(request)

        pull.assert_called_once_with("daemon-fingerprint")
        self.assertEqual(response["data"], {"contexts": []})

    def test_route_requires_fingerprint_for_regular_jwt(self):
        from apps.tabtinspace.routers.device import get_device_host_state

        request = RequestFactory().get("/api/context/devices/host-state")
        request.auth = type("User", (), {"id": "user-1"})()

        response = get_device_host_state(request)

        self.assertEqual(response.status_code, 400)

    def test_route_forwards_regular_jwt_device_header(self):
        from unittest.mock import patch

        from apps.tabtinspace.routers.device import get_device_host_state

        request = RequestFactory().get(
            "/api/context/devices/host-state",
            HTTP_X_DEVICE_FINGERPRINT="electron-valid-device",
        )
        request.auth = type("User", (), {"id": "user-1"})()

        with patch(
            "apps.tabtinspace.services.host_state_pull_service.HostStatePullService.pull",
            return_value={"contexts": []},
        ) as pull:
            response = get_device_host_state(request)

        pull.assert_called_once_with("electron-valid-device")
        self.assertEqual(response["data"], {"contexts": []})
