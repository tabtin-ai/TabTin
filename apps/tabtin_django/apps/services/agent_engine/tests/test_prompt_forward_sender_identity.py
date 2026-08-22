from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService


class PromptForwardSenderIdentityTests(SimpleTestCase):
    def _capture_payload(self, *, app_context, execution_owner_user_id):
        space = SimpleNamespace(
            id="workspace-1",
            organization_id="organization-1",
            approval_grant="always_ask",
        )
        with patch(
            "apps.services.agent_engine.services.prompt_forward_service."
            "_resolve_pressure_threshold_fields",
            return_value={},
        ), patch.object(
            PromptForwardService,
            "_route_to_device",
            return_value=1,
        ) as publish:
            PromptForwardService().forward_prompt(
                thread_id="chat-session-session-1",
                space=space,
                prompt="共享发言",
                attachments=[],
                agent_backend_config={"type": "local"},
                app_context=app_context,
                execution_owner_user_id=execution_owner_user_id,
            )
        return publish.call_args.args[2]["payload"]

    def test_shared_sender_is_distinct_from_execution_owner(self):
        payload = self._capture_payload(
            app_context={"_shared_chat_by": "grantee-1"},
            execution_owner_user_id="owner-1",
        )

        self.assertEqual(payload["sender_user_id"], "grantee-1")

    def test_regular_forward_uses_execution_owner_as_sender(self):
        payload = self._capture_payload(
            app_context=None,
            execution_owner_user_id="owner-1",
        )

        self.assertEqual(payload["sender_user_id"], "owner-1")
