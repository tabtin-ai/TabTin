from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.chat.conversation.models import ChatSession
from apps.chat.conversation.schemas import ChatSessionSchema
from apps.services.agent_execution.effective_runtime_config import resolve_workspace_approval_mode


class DefaultApprovalModeTests(SimpleTestCase):
    def test_session_model_has_no_approval_source(self) -> None:
        self.assertNotIn('approval_mode', {field.name for field in ChatSession._meta.fields})
        self.assertEqual(
            ChatSessionSchema.model_fields['approval_mode'].default,
            'always_ask',
        )

    def test_session_schema_exposes_cache_token_fields(self) -> None:
        self.assertIn('cache_read_input_tokens', ChatSessionSchema.model_fields)
        self.assertIn('cache_creation_input_tokens', ChatSessionSchema.model_fields)
        self.assertEqual(
            ChatSessionSchema.model_fields['cache_read_input_tokens'].default,
            0,
        )
        self.assertEqual(
            ChatSessionSchema.model_fields['cache_creation_input_tokens'].default,
            0,
        )

    def test_personal_session_uses_workspace_highest_available_mode(self) -> None:
        organization = SimpleNamespace(settings={"allow_member_yolo": True})

        for approval_grant in ("always_ask", "auto", "full_access"):
            workspace = SimpleNamespace(
                organization=organization,
                approval_grant=approval_grant,
            )
            with self.subTest(approval_grant=approval_grant):
                self.assertEqual(
                    resolve_workspace_approval_mode(workspace, project=None),
                    approval_grant,
                )

    def test_locked_organization_defaults_to_always_ask(self) -> None:
        workspace = SimpleNamespace(
            organization=SimpleNamespace(settings={"allow_member_yolo": False}),
            approval_grant="full_access",
        )

        self.assertEqual(
            resolve_workspace_approval_mode(workspace, project=None),
            "always_ask",
        )

    def test_project_session_defaults_to_always_ask(self) -> None:
        workspace = SimpleNamespace(
            organization=SimpleNamespace(settings={"allow_member_yolo": True}),
            approval_grant="full_access",
        )

        self.assertEqual(
            resolve_workspace_approval_mode(
                workspace,
                project=SimpleNamespace(),
            ),
            "always_ask",
        )
