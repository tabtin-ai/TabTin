from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.agent_router import resolve_route
from apps.services.agent_execution.chat_service import ChatService


class WorkspaceRouteContractTests(SimpleTestCase):
    @patch("apps.services.agent_engine.engine.agent_dispatcher.AgentDispatcher")
    @patch("apps.tabtinspace.models.Workspace")
    def test_router_loads_workspace_without_retired_agent_relation(
        self,
        workspace_model,
        dispatcher_class,
    ):
        workspace = SimpleNamespace(id="workspace-1")
        workspace_model.objects.select_related.return_value.filter.return_value.first.return_value = workspace
        dispatcher_class.return_value.dispatch_external.return_value = {
            "published": 1,
            "backend_type": "local",
            "task_id": "task-1",
        }

        result = resolve_route(
            session=SimpleNamespace(),
            user=SimpleNamespace(),
            workspace_id="workspace-1",
            input_state={},
            plain_text="hello",
            model_id=None,
            model_instance=None,
            effective_thread_id="thread-1",
            user_messages=[],
            blocks=None,
            attachments=None,
            client_type="mobile",
            execution_profile=None,
            app_context=None,
        )

        workspace_model.objects.select_related.assert_called_once_with("organization", "device")
        dispatcher_class.return_value.dispatch_external.assert_called_once()
        self.assertEqual(result.target, "external")
        self.assertIs(result.space_obj, workspace)

    @patch("apps.services.agent_execution.chat_service._handle_routing_decision")
    @patch("apps.services.agent_execution.chat_service._resolve_route")
    def test_chat_service_routes_by_session_workspace_not_ui_space_context(
        self,
        resolve_route_mock,
        handle_decision_mock,
    ):
        resolve_route_mock.return_value = SimpleNamespace()
        handle_decision_mock.return_value = {"reply": "ok"}
        session = SimpleNamespace(workspace_id="workspace-1")
        context = SimpleNamespace(
            context={"current_space_id": "project-1"},
            input_state={},
            plain_text="hello",
            blocks=None,
        )
        model = SimpleNamespace(id="model-1")
        prep = SimpleNamespace(
            model_instance=model,
            final_model_id="model-1",
            effective_thread_id="thread-1",
        )
        ingest = SimpleNamespace(user_messages=[])

        result = ChatService._stage_route(
            session=session,
            user=SimpleNamespace(),
            prep=prep,
            ingest=ingest,
            ctx=context,
            app_context=None,
            client_type="mobile",
            execution_profile=None,
            attachments=None,
        )

        self.assertEqual(result, {"reply": "ok"})
        self.assertEqual(resolve_route_mock.call_args.kwargs["workspace_id"], "workspace-1")
        self.assertEqual(resolve_route_mock.call_args.kwargs["model_id"], "model-1")
        self.assertIs(resolve_route_mock.call_args.kwargs["model_instance"], model)
        self.assertNotIn("space_id", resolve_route_mock.call_args.kwargs)
