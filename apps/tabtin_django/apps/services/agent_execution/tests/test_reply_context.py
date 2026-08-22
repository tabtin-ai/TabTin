from apps.services.agent_execution.reply_context import (
    extract_persist_reply_kwargs_from_app_context,
    extract_reply_context_from_app_context,
)


def test_extract_reply_context_includes_display_message() -> None:
    ctx = extract_reply_context_from_app_context({
        "display_message": "bubble text",
        "reply_to_message_id": "msg-1",
        "reply_to_preview": {"text": "quoted"},
    })
    assert ctx["display_message"] == "bubble text"
    assert ctx["reply_to_message_id"] == "msg-1"
    assert ctx["reply_to_preview"] == {"text": "quoted"}


def test_persist_reply_kwargs_strip_display_message() -> None:
    kwargs = extract_persist_reply_kwargs_from_app_context({
        "display_message": "bubble text",
        "reply_to_message_id": "msg-1",
    })
    assert "display_message" not in kwargs
    assert kwargs["reply_to_message_id"] == "msg-1"
