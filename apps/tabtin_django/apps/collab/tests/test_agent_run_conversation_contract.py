"""
Agent run conversation anchor contract regression tests.

: version history "view conversation" needs a stable space_id from the
backend. Fresh renderer state cannot infer the Space from local session caches.
"""
import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()


def _make_request(user_id="u-caller"):
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = user_id
    return req


def _checkpoint_queryset(row):
    qs = MagicMock()
    qs.filter.return_value = qs
    qs.order_by.return_value = qs
    qs.values.return_value = qs
    qs.first.return_value = row
    return qs


def _values_queryset(row):
    qs = MagicMock()
    qs.values.return_value = qs
    qs.first.return_value = row
    return qs


class TestAgentRunConversationContract:
    def test_checkpoint_path_returns_space_and_organization_id(self):
        from apps.collab.api import get_agent_run_conversation

        space_id = uuid.uuid4()
        organization_id = uuid.uuid4()
        session_id = str(uuid.uuid4())
        message_id = str(uuid.uuid4())

        checkpoint_row = {
            "metadata": {
                "checkpoint_context": {
                    "session_id": session_id,
                    "assistant_message_id": message_id,
                    "user_prompt": "更新文档",
                },
            },
            "space_id": space_id,
            "organization_id": organization_id,
            "anchor_session_id": session_id,
            "anchor_message_id": message_id,
        }

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints:
            mock_checkpoints.using.return_value = _checkpoint_queryset(checkpoint_row)
            with patch("apps.tabtinspace.services.base.BaseService") as mock_base_service:
                mock_base_service.return_value.check_space_permission.return_value = True

                status, body = get_agent_run_conversation(_make_request(), "run-1")

        assert status == 200
        assert body["status"] == "ok"
        assert body["data"]["session_id"] == session_id
        assert body["data"]["assistant_message_id"] == message_id
        assert body["data"]["space_id"] == str(space_id)
        assert body["data"]["organization_id"] == str(organization_id)

    def test_chat_message_fallback_returns_session_space_and_organization_id(self):
        from django.utils import timezone

        from apps.collab.api import get_agent_run_conversation

        space_id = uuid.uuid4()
        session_id = uuid.uuid4()
        assistant_id = uuid.uuid4()
        user_id = uuid.uuid4()
        created_at = timezone.now()

        assistant_row = {
            "id": assistant_id,
            "session_id": session_id,
            "created_at": created_at,
        }
        user_row = {
            "id": user_id,
            "text_summary": "改成蛤蜊炖蛋",
        }
        session_row = {
            "space_id": space_id,
            "organization_id": "organization-1",
        }

        def chat_message_filter_side_effect(*_args, **kwargs):
            qs = MagicMock()
            qs.order_by.return_value = qs
            qs.values.return_value = qs
            if kwargs.get("role") == "assistant":
                qs.first.return_value = assistant_row
            else:
                qs.first.return_value = user_row
            return qs

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints, \
             patch("apps.chat.conversation.models.ChatMessage.objects") as mock_messages, \
             patch("apps.chat.conversation.models.ChatSession.objects") as mock_sessions, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_service:
            mock_checkpoints.using.return_value = _checkpoint_queryset(None)
            mock_messages.filter.side_effect = chat_message_filter_side_effect
            mock_sessions.filter.return_value = _values_queryset(session_row)
            mock_base_service.return_value.check_space_permission.return_value = True

            status, body = get_agent_run_conversation(_make_request(), "run-2")

        assert status == 200
        data = body["data"]
        assert data["session_id"] == str(session_id)
        assert data["assistant_message_id"] == str(assistant_id)
        assert data["user_message_id"] == str(user_id)
        assert data["user_prompt"] == "改成蛤蜊炖蛋"
        assert data["space_id"] == str(space_id)
        assert data["organization_id"] == "organization-1"

    def test_rejects_when_user_cannot_view_resolved_space(self):
        from apps.collab.api import get_agent_run_conversation

        checkpoint_row = {
            "metadata": {"checkpoint_context": {"session_id": str(uuid.uuid4())}},
            "space_id": uuid.uuid4(),
            "organization_id": uuid.uuid4(),
            "anchor_session_id": "",
            "anchor_message_id": "",
        }

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_service:
            mock_checkpoints.using.return_value = _checkpoint_queryset(checkpoint_row)
            mock_base_service.return_value.check_space_permission.return_value = False

            status, body = get_agent_run_conversation(_make_request(), "run-denied")

        assert status == 403
        assert body["status"] == "error"

    def test_checkpoint_anchor_marks_message_hidden_by_current_revert(self):
        from apps.collab.api import get_agent_run_conversation

        session_id = str(uuid.uuid4())
        message_id = str(uuid.uuid4())
        checkpoint_row = {
            "metadata": {
                "checkpoint_context": {
                    "session_id": session_id,
                    "assistant_message_id": message_id,
                },
            },
            "space_id": uuid.uuid4(),
            "organization_id": uuid.uuid4(),
            "anchor_session_id": session_id,
            "anchor_message_id": message_id,
        }

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints, \
             patch("apps.tabtinspace.services.base.BaseService") as mock_base_service, \
             patch("apps.collab.api._resolve_reverted_out_conversation_anchor") as mock_visible:
            mock_checkpoints.using.return_value = _checkpoint_queryset(checkpoint_row)
            mock_base_service.return_value.check_space_permission.return_value = True
            mock_visible.return_value = (True, "revert-message")

            status, body = get_agent_run_conversation(_make_request(), "run-reverted")

        assert status == 200
        assert body["data"]["session_id"] == session_id
        assert body["data"]["assistant_message_id"] == message_id
        assert body["data"]["is_reverted_out"] is True
        assert body["data"]["revert_message_id"] == "revert-message"
        mock_visible.assert_called_once_with(session_id, message_id)

    def test_legacy_session_without_space_requires_session_owner(self):
        from apps.collab.api import get_agent_run_conversation

        session_id = str(uuid.uuid4())
        checkpoint_row = {
            "metadata": {"checkpoint_context": {"session_id": session_id}},
            "space_id": None,
            "organization_id": None,
            "anchor_session_id": "",
            "anchor_message_id": "",
        }

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints, \
             patch("apps.chat.conversation.models.ChatSession.objects") as mock_sessions:
            mock_checkpoints.using.return_value = _checkpoint_queryset(checkpoint_row)
            session_lookup = _values_queryset({"space_id": None, "organization_id": None})
            owner_lookup = MagicMock()
            owner_lookup.exists.return_value = True
            mock_sessions.filter.side_effect = [session_lookup, owner_lookup]

            status, body = get_agent_run_conversation(_make_request(), "run-legacy")

        assert status == 200
        assert body["data"]["session_id"] == session_id
        assert mock_sessions.filter.call_args_list[-1].kwargs == {"id": session_id, "user_id": "u-caller"}

    def test_missing_run_returns_404(self):
        from apps.collab.api import get_agent_run_conversation

        with patch("apps.collab.models.SpaceCheckpoint.objects") as mock_checkpoints, \
             patch("apps.chat.conversation.models.ChatMessage.objects") as mock_messages:
            mock_checkpoints.using.return_value = _checkpoint_queryset(None)
            mock_messages.filter.return_value.order_by.return_value.values.return_value.first.return_value = None

            status, body = get_agent_run_conversation(_make_request(), "missing-run")

        assert status == 404
        assert body["status"] == "error"
