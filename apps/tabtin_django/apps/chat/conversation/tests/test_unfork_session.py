"""unfork_session：清除 fork 血缘，弹出为根级对话（不落库）。"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from apps.chat.conversation.api.fork import unfork_session


def _auth(user_id="user-1"):
    return SimpleNamespace(id=user_id)


class TestUnforkSessionView:
    def test_unfork_clears_lineage(self):
        session = MagicMock()
        session.forked_from_id = "parent-id"
        session.fork_point_message_id = "msg-id"
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.first.return_value = session
        schema = SimpleNamespace(model_dump=MagicMock(return_value={
            "id": "fork-id",
            "forked_from_id": None,
            "fork_point_message_id": None,
        }))

        request = SimpleNamespace(auth=_auth())
        with patch(
            "apps.chat.conversation.api.fork.ChatSession.objects.filter",
            return_value=qs,
        ), patch(
            "apps.chat.conversation.api.fork._visible_message_count",
            return_value=12,
        ) as count_fn, patch(
            "apps.chat.conversation.api.fork._session_to_schema",
            return_value=schema,
        ) as to_schema, patch(
            "apps.chat.conversation.api.fork.success_response",
            side_effect=lambda **kwargs: kwargs,
        ) as success:
            result = unfork_session(request, "fork-id")

        assert session.forked_from_id is None
        assert session.fork_point_message_id is None
        session.save.assert_called_once_with(
            update_fields=["forked_from_id", "fork_point_message_id", "updated_at"],
        )
        count_fn.assert_called_once_with(session)
        to_schema.assert_called_once_with(session, message_count=12)
        assert "data" in result
        success.assert_called_once()

    def test_unfork_root_rejected(self):
        session = MagicMock()
        session.forked_from_id = None
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.first.return_value = session

        request = SimpleNamespace(auth=_auth())
        with patch(
            "apps.chat.conversation.api.fork.ChatSession.objects.filter",
            return_value=qs,
        ), patch(
            "apps.chat.conversation.api.fork.error_response_with_status",
            side_effect=lambda code, message, status_code: {
                "code": code,
                "message": message,
                "status_code": status_code,
            },
        ):
            result = unfork_session(request, "root-id")

        assert result["status_code"] == 400
        assert result["code"] == "VALIDATION_ERROR"
        session.save.assert_not_called()

    def test_unfork_missing_404(self):
        qs = MagicMock()
        qs.filter.return_value = qs
        qs.first.return_value = None

        request = SimpleNamespace(auth=_auth())
        with patch(
            "apps.chat.conversation.api.fork.ChatSession.objects.filter",
            return_value=qs,
        ), patch(
            "apps.chat.conversation.api.fork.error_response_with_status",
            side_effect=lambda code, message, status_code: {
                "code": code,
                "message": message,
                "status_code": status_code,
            },
        ):
            result = unfork_session(request, "missing-id")

        assert result["status_code"] == 404
        assert result["code"] == "NOT_FOUND"
