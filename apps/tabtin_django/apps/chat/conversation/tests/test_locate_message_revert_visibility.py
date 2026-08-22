import os
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402

django.setup()


def _make_request():
    req = MagicMock()
    req.auth = MagicMock()
    req.auth.id = "u-caller"
    return req


def test_locate_message_treats_reverted_out_message_as_not_found():
    from apps.chat.conversation.api.locate_and_segment import locate_message

    session_id = uuid.uuid4()
    message_id = str(uuid.uuid4())
    session = MagicMock()
    session.id = session_id
    session.revert_message_id = uuid.uuid4()

    visible_qs = MagicMock()
    visible_qs.filter.return_value.values.return_value.first.return_value = None
    physical_qs = MagicMock()
    physical_qs.exists.return_value = True

    with patch(
        "apps.chat.conversation.api.locate_and_segment._get_session_with_shared_access",
        return_value=(session, False),
    ), patch(
        "apps.chat.conversation.api.locate_and_segment._visible_messages_queryset",
        return_value=visible_qs,
    ), patch(
        "apps.chat.conversation.api.locate_and_segment.ChatMessage.objects",
    ) as mock_messages:
        mock_messages.filter.return_value = physical_qs

        status, body = locate_message(_make_request(), str(session_id), message_id)

    assert status == 200
    assert body["status"] == "ok"
    assert body["data"]["session_id"] == str(session_id)
    assert body["data"]["message_id"] == message_id
    assert body["data"]["exists"] is False
    assert body["data"]["created_at"] is None
    assert body["data"]["is_reverted_out"] is True
    assert body["data"]["revert_message_id"] == str(session.revert_message_id)


def test_conversation_segment_rejects_reverted_out_anchor():
    from apps.chat.conversation.api.locate_and_segment import get_conversation_segment

    session_id = uuid.uuid4()
    message_id = str(uuid.uuid4())
    session = MagicMock()
    session.id = session_id
    session.revert_message_id = uuid.uuid4()

    visible_qs = MagicMock()
    visible_qs.filter.return_value.values.return_value.first.return_value = None
    physical_qs = MagicMock()
    physical_qs.exists.return_value = True

    with patch(
        "apps.chat.conversation.api.locate_and_segment._get_session_with_shared_access",
        return_value=(session, False),
    ), patch(
        "apps.chat.conversation.api.locate_and_segment._visible_messages_queryset",
        return_value=visible_qs,
    ), patch(
        "apps.chat.conversation.api.locate_and_segment.ChatMessage.objects",
    ) as mock_messages:
        mock_messages.filter.return_value = physical_qs

        status, body = get_conversation_segment(_make_request(), str(session_id), around_message_id=message_id)

    assert status == 404
    assert body["status"] == "error"
    assert body["message"] == "Target message not found in this session"
    assert body["data"]["is_reverted_out"] is True
    assert body["data"]["revert_message_id"] == str(session.revert_message_id)
