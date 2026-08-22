"""Agent × Workspace 解耦后的执行绑定语义。"""

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase


class ExecutionBindingSemanticTests(SimpleTestCase):
    def test_workspace_device_is_execution_binding_truth(self):
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        device = SimpleNamespace(id="device-1")
        workspace = SimpleNamespace(id="workspace-1", device=device)

        binding = resolve_execution_binding(space=workspace)

        self.assertIs(binding.device, device)
        self.assertEqual(binding.source, "workspace.device")
        self.assertIsNone(binding.agent)

    @patch("apps.tabtinspace.models.Agent.objects")
    def test_explicit_agent_is_resolved_independently_from_workspace(
        self,
        mock_agent_objects,
    ):
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        agent = SimpleNamespace(id="agent-1", is_active=True)
        device = SimpleNamespace(id="device-1")
        mock_agent_objects.filter.return_value.first.return_value = agent

        binding = resolve_execution_binding(
            space=SimpleNamespace(id="workspace-1", device=device),
            agent_id="agent-1",
        )

        self.assertIs(binding.device, device)
        self.assertIs(binding.agent, agent)
        mock_agent_objects.filter.assert_called_once_with(
            id="agent-1",
            is_active=True,
        )

    def test_space_compatibility_fields_do_not_participate_in_execution(self):
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        legacy_device = SimpleNamespace(id="legacy-device")
        legacy_space = SimpleNamespace(
            id="space-1",
            control_device=legacy_device,
            bound_device=legacy_device,
        )

        binding = resolve_execution_binding(space=legacy_space)

        self.assertIsNone(binding.device)
        self.assertEqual(binding.source, "none")

    def test_missing_workspace_device_fails_closed(self):
        from apps.tabtinspace.services.execution_binding import resolve_execution_binding

        binding = resolve_execution_binding(space=SimpleNamespace(id="workspace-1"))

        self.assertIsNone(binding.device)
        self.assertEqual(binding.source, "none")
