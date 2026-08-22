from types import SimpleNamespace

from django.contrib.auth import get_user_model
from django.test import TestCase

from apps.chat.conversation.api.context import get_context, update_context
from apps.chat.conversation.models import ChatContext, ChatSession
from apps.chat.conversation.schemas import (
    GroupRuntimeConfig,
    GroupRuntimeRoleInput,
    UpdateContextRequest,
)


User = get_user_model()


class ChatContextGroupRuntimeApiTests(TestCase):
    databases = {"default", "postgresql"}

    def setUp(self):
        self.user = User.objects.create_user(
            email="ctx_group_runtime@example.com",
            password="testpass",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id="ws-group-runtime",
            title="group runtime test",
        )

    def _request(self):
        return SimpleNamespace(auth=self.user)

    def test_update_context_persists_group_runtime_payload(self):
        payload = UpdateContextRequest(
            current_space_id="space-1",
            group_runtime=GroupRuntimeConfig(
                enabled=True,
                orchestration_mode="moderated",
                lead_role="lead_agent",
                summary_style="summary_plus_details",
                roles=[GroupRuntimeRoleInput(template_id="tpl-1", enabled=True)],
            ),
        )

        response = update_context(self._request(), str(self.session.id), payload)

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["current_space_id"], "space-1")
        self.assertEqual(response["data"]["group_runtime"]["orchestration_mode"], "moderated")
        self.assertEqual(
            response["data"]["group_runtime"]["roles"],
            [{"template_id": "tpl-1", "enabled": True}],
        )

        context = ChatContext.objects.get(session=self.session)
        self.assertEqual(context.context_data["group_runtime"]["summary_style"], "summary_plus_details")
        self.assertEqual(
            context.context_data["group_runtime"]["roles"],
            [{"template_id": "tpl-1", "enabled": True}],
        )

    def test_get_context_projects_group_runtime_from_context_data(self):
        ChatContext.objects.create(
            session=self.session,
            current_space_id="space-2",
            context_data={
                "group_runtime": {
                    "enabled": False,
                    "orchestration_mode": "parallel",
                    "lead_role": "lead_agent",
                    "summary_style": "summary_only",
                    "roles": [{"template_id": "tpl-2", "enabled": True}],
                }
            },
        )

        response = get_context(self._request(), str(self.session.id))

        self.assertTrue(response["success"])
        self.assertEqual(response["data"]["current_space_id"], "space-2")
        self.assertEqual(response["data"]["group_runtime"]["lead_role"], "lead_agent")
        self.assertEqual(
            response["data"]["group_runtime"]["roles"],
            [{"template_id": "tpl-2", "enabled": True}],
        )

