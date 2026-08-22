"""#8465：记忆 capture 正文取数 — 完整 text，排除附件 / 思考 / 工具结果。"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from apps.services.agent_engine.utils.memory_utils import (
    plaintext_for_memory_capture,
    serialize_messages,
)


def test_plaintext_keeps_full_user_text_and_drops_attachments():
    blocks = [
        {"type": "text", "text": "请记住我偏好用中文写 commit message，并且每条不超过 72 字符。"},
        {"type": "image", "source": {"type": "base64", "data": "xxx"}},
        {"type": "document", "title": "spec.pdf"},
        {"type": "file", "name": "a.py"},
    ]
    text = plaintext_for_memory_capture(blocks)
    assert "commit message" in text
    assert "72" in text
    assert "spec.pdf" not in text
    assert "a.py" not in text


def test_plaintext_drops_thinking_and_tool_blocks_from_assistant():
    blocks = [
        {"type": "thinking", "thinking": "先查一下记忆表结构……"},
        {"type": "tool_use", "id": "t1", "name": "read_file", "input": {"path": "x"}},
        {
            "type": "tool_result",
            "tool_use_id": "t1",
            "content": "huge tool dump should not enter capture",
        },
        {"type": "text", "text": "已记下：你偏好中文 commit。"},
        {"type": "text", "text": "下次写日志我会遵守。"},
    ]
    text = plaintext_for_memory_capture(blocks)
    assert text == "已记下：你偏好中文 commit。\n下次写日志我会遵守。"
    assert "记忆表结构" not in text
    assert "tool dump" not in text
    assert "read_file" not in text


def test_plaintext_string_passthrough():
    assert plaintext_for_memory_capture("  hello  ") == "hello"
    assert plaintext_for_memory_capture(None) == ""
    assert plaintext_for_memory_capture({"type": "text"}) == ""


def test_serialize_messages_flattens_blocks_but_keeps_tool_role():
    """assistant 内嵌 tool 块剔除；独立 tool 行保留（L4 task_summary 踩坑）。"""
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "长提示词" * 20},
                {"type": "image", "source": {}},
            ],
        },
        {
            "role": "assistant",
            "content": [
                {"type": "thinking", "thinking": "internal"},
                {"type": "tool_result", "content": "embedded tool out"},
                {"type": "text", "text": "好的，已记住。"},
            ],
        },
        {"role": "tool", "content": "Error: disk full"},
        {"role": "system", "content": "sys"},
    ]
    out = serialize_messages(messages)
    assert [m["role"] for m in out] == ["user", "assistant", "tool", "system"]
    assert out[0]["content"] == "长提示词" * 20
    assert out[1]["content"] == "好的，已记住。"
    assert "internal" not in out[1]["content"]
    assert "embedded tool out" not in out[1]["content"]
    assert out[2]["content"].startswith("[工具输出] ")
    assert "Error: disk full" in out[2]["content"]


def test_fetch_messages_uses_content_blocks_not_text_summary():
    from apps.services.agent_engine.tasks.memory.relay_memory_trigger import (
        _fetch_messages_from_db,
    )

    long_text = "用户完整偏好说明：" + ("详细内容。" * 40)
    assert len(long_text) > 200

    row = {
        "role": "user",
        "content_blocks_json": [
            {"type": "text", "text": long_text},
            {"type": "file", "name": "ignored.bin"},
        ],
        "agent_id": None,
        # 若误读 text_summary，会被截到 200 字且丢失后半段
        "text_summary": long_text[:200],
    }

    mock_qs = MagicMock()
    mock_qs.filter.return_value = mock_qs
    mock_qs.order_by.return_value = mock_qs
    mock_qs.values.return_value = mock_qs
    mock_qs.__getitem__ = MagicMock(return_value=[row])

    with patch(
        "apps.chat.conversation.models.ChatMessage.objects",
        mock_qs,
    ):
        messages = _fetch_messages_from_db("session-1", offset=0)

    assert len(messages) == 1
    assert messages[0]["content"] == long_text
    assert mock_qs.filter.call_args.kwargs.get("message_kind") == "llm"
    values_fields = mock_qs.values.call_args.args
    assert "content_blocks_json" in values_fields
    assert "text_summary" not in values_fields
