"""
fork_session 纯函数单元测试。

覆盖：
- _truncate_pg_messages_at_fork_point: PG 消息截断逻辑
- _fork_state_json: state_json 清理逻辑

运行: cd apps/tabtin_django && source venv/bin/activate
      DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/chat/conversation/tests/test_fork_session.py -v
"""

import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional
from unittest.mock import patch, MagicMock

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django  # noqa: E402
django.setup()

import pytest  # noqa: E402

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import TestCase  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.chat.conversation.api import (  # noqa: E402
    _fork_state_json,
    _fork_copy_messages_sync,
    _resolve_assistant_fork_point,
    _truncate_pg_messages_at_fork_point,
)
from apps.chat.conversation.api.fork import (  # noqa: E402
    _conservative_truncate_by_ordinal,
    _fork_boundary_queryset,
    _sort_messages_by_conversation_time,
)
from apps.chat.conversation.models import ChatMessage, ChatSession  # noqa: E402
from apps.chat.conversation.services.fork_tool_id_remap import (  # noqa: E402
    is_tabtin_tool_use_id,
)
from apps.chat.conversation.tasks import fork_copy_messages_async  # noqa: E402


@dataclass
class FakeChatMessage:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    content: str = ""
    text_summary: str = ""
    role: str = "user"
    created_at: datetime = field(default_factory=datetime.now)
    arrival_seq: Optional[int] = None
    metadata: dict = field(default_factory=dict)
    client_event_id: Optional[str] = None


def _pg(role: str, content: str) -> dict:
    return {"role": role, "content": content}


# ---------------------------------------------------------------------------
# _truncate_pg_messages_at_fork_point
# ---------------------------------------------------------------------------


class TestTruncatePgMessagesAtForkPoint:
    def test_empty_pg_msgs(self):
        result, failed = _truncate_pg_messages_at_fork_point([], [], "any-id")
        assert result == []
        assert failed is False

    def test_no_fork_point_id_returns_full_copy(self):
        pg = [_pg("user", "hello")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, [FakeChatMessage()], None)
        assert result == pg
        assert result is not pg
        assert failed is False

    def test_no_mysql_messages_returns_full_copy(self):
        pg = [_pg("user", "hello")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, [], "some-id")
        assert result == pg
        assert failed is False

    def test_fork_msg_not_found_in_mysql_returns_full_copy(self):
        pg = [_pg("user", "a"), _pg("assistant", "b")]
        mysql = [FakeChatMessage(id="id-1", content="a", role="user")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "nonexistent-id")
        assert result == pg
        assert failed is False

    def test_fork_at_last_message(self):
        """fork 点在最后一条 user 消息，无后续 assistant 轮，只保留到该条。"""
        pg = [
            _pg("system", "sys prompt"),
            _pg("user", "q1"),
            _pg("assistant", "a1"),
            _pg("user", "q2"),
        ]
        fork_id = "fork-id"
        mysql = [
            FakeChatMessage(id="m1", content="q1", role="user"),
            FakeChatMessage(id="m2", content="a1", role="assistant"),
            FakeChatMessage(id=fork_id, content="q2", role="user"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, fork_id)
        assert result == pg  # 全量保留，因为 q2 后没有更多 user 消息
        assert failed is False

    def test_fork_at_middle_preserves_assistant_tool_turn(self):
        """fork 点在中间 user 消息，后面的 assistant+tool 轮应保留，下一个 user 轮截断。"""
        pg = [
            _pg("system", "sys"),
            _pg("user", "q1"),
            _pg("assistant", "a1"),
            _pg("tool", "tool-result-1"),
            _pg("assistant", "a1-final"),
            _pg("user", "q2"),
            _pg("assistant", "a2"),
        ]
        fork_id = "fork-mid"
        mysql = [
            FakeChatMessage(id=fork_id, content="q1", role="user"),
            FakeChatMessage(id="m2", content="a1-final", role="assistant"),
            FakeChatMessage(id="m3", content="q2", role="user"),
            FakeChatMessage(id="m4", content="a2", role="assistant"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, fork_id)
        assert len(result) == 5
        assert result[-1]["content"] == "a1-final"
        assert all(m["content"] != "q2" for m in result)
        assert failed is False

    def test_content_match_failure_conservative_truncate(self):
        """#2590：MySQL fork 消息 content 在 PG 找不到匹配时，不再静默全量，而是
        保守截断 + 返回 truncation_failed=True。单条 PG 且 fork 点是唯一消息时，
        保守切点至少保留首条（不会多带内容）。"""
        pg = [_pg("user", "completely different")]
        mysql = [FakeChatMessage(id="fk", content="no match here", role="user")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "fk")
        assert failed is True
        # fork 点是 MySQL 里唯一/最后一条 → ratio≈1.0，保守截断保留全部单条，
        # 但绝不多于源；关键是 failed 标志已置位（调用方据此写 warning）。
        assert len(result) <= len(pg)

    def test_content_match_failure_conservative_cuts_trailing(self):
        """#2590：fork 点在中段但 content 匹配失败时，保守截断按序位占比切，
        不把 fork 点之后的历史全带进新会话。"""
        pg = [
            _pg("system", "sys"),
            _pg("user", "q1"),
            _pg("assistant", "a1"),
            _pg("user", "q2"),
            _pg("assistant", "a2"),
            _pg("user", "q3"),
            _pg("assistant", "a3"),
        ]
        # fork 点是第 2 条（q2，ordinal=1，共 3 条 user 语义消息），content 故意写不匹配
        mysql = [
            FakeChatMessage(id="u1", content="q1", role="user"),
            FakeChatMessage(id="fk", content="UNMATCHABLE", role="user"),
            FakeChatMessage(id="u3", content="q3", role="user"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "fk")
        assert failed is True
        # 保守截断应少于全量（不含 fork 点之后的 q3/a3 尾部）
        assert len(result) < len(pg)
        assert all(m["content"] != "q3" for m in result)

    def test_fork_on_assistant_message(self):
        """fork 点是 assistant 消息，按 role 匹配。"""
        pg = [
            _pg("user", "q1"),
            _pg("assistant", "a1"),
            _pg("user", "q2"),
            _pg("assistant", "a2"),
        ]
        fork_id = "asst-fork"
        mysql = [
            FakeChatMessage(id="u1", content="q1", role="user"),
            FakeChatMessage(id=fork_id, content="a1", role="assistant"),
            FakeChatMessage(id="u2", content="q2", role="user"),
            FakeChatMessage(id="a2", content="a2", role="assistant"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, fork_id)
        # a1 后面下一个 user 是 q2，截断到 q2 之前
        assert len(result) == 2
        assert result[-1]["content"] == "a1"
        assert failed is False

    def test_content_match_with_whitespace_trimming(self):
        """content 前后有空白时仍能匹配。"""
        pg = [_pg("user", "  hello world  "), _pg("assistant", "reply")]
        mysql = [FakeChatMessage(id="ws", content="hello world", role="user")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "ws")
        assert len(result) == 2
        assert failed is False

    def test_content_match_multipart_list(self):
        """PG content 为 list[dict] 格式时能正确匹配。"""
        pg_msgs = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": "line1"},
                    {"type": "text", "text": "line2"},
                ],
            },
            _pg("assistant", "resp"),
            _pg("user", "next-q"),
        ]
        mysql = [
            FakeChatMessage(id="mp", content="line1\nline2", role="user"),
            FakeChatMessage(id="m2", content="resp", role="assistant"),
            FakeChatMessage(id="m3", content="next-q", role="user"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg_msgs, mysql, "mp")
        assert len(result) == 2
        assert result[0]["role"] == "user"
        assert result[1]["content"] == "resp"
        assert failed is False

    def test_duplicate_content_matches_clicked_occurrence(self):
        """相同 content 出现多次时，按 fork 点在源消息里的序位命中对应那一次。"""
        pg = [
            _pg("user", "dup"),
            _pg("assistant", "a1"),
            _pg("user", "dup"),
            _pg("assistant", "a2"),
            _pg("user", "q3"),
        ]
        mysql = [
            FakeChatMessage(id="d1", content="dup", role="user"),
            FakeChatMessage(id="a1", content="a1", role="assistant"),
            FakeChatMessage(id="d2", content="dup", role="user"),
            FakeChatMessage(id="a2", content="a2", role="assistant"),
            FakeChatMessage(id="q3", content="q3", role="user"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "d2")
        assert len(result) == 4
        assert result[-1]["content"] == "a2"
        assert failed is False

    def test_duplicate_assistant_content_uses_clicked_ordinal_not_later_match(self):
        """#10666：点击第一条同内容 assistant fork 时，PG 状态不得漂到后一次同内容回复。"""
        pg = [
            _pg("user", "q1"),
            _pg("assistant", "same answer"),
            _pg("user", "q2"),
            _pg("assistant", "same answer"),
            _pg("user", "q3-after-click"),
        ]
        mysql = [
            FakeChatMessage(id="u1", content="q1", text_summary="q1", role="user"),
            FakeChatMessage(id="a1-clicked", content="same answer", text_summary="same answer", role="assistant"),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "a1-clicked")
        assert failed is False
        assert [m["content"] for m in result] == ["q1", "same answer"]

    def test_returns_new_list_not_same_reference(self):
        pg = [_pg("user", "x")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, [], "any")
        assert result is not pg
        assert failed is False


class TestConservativeTruncateByOrdinal:
    def test_empty_pg(self):
        assert _conservative_truncate_by_ordinal([], 0, 3) == []

    def test_ratio_maps_and_stops_before_trailing_user(self):
        pg = [
            _pg("system", "sys"),
            _pg("user", "q1"),
            _pg("assistant", "a1"),
            _pg("user", "q2"),
            _pg("assistant", "a2"),
            _pg("user", "q3"),
            _pg("assistant", "a3"),
        ]
        # fork 点 ordinal=1 / total=3 → ratio≈0.67，应截到 q2 之前，不含 q3/a3
        result = _conservative_truncate_by_ordinal(pg, 1, 3)
        assert len(result) < len(pg)
        assert all(m["content"] != "q3" for m in result)


# ---------------------------------------------------------------------------
# _fork_state_json
# ---------------------------------------------------------------------------


class TestForkStateJson:
    def test_none_input(self):
        assert _fork_state_json(None) == {}

    def test_empty_dict(self):
        assert _fork_state_json({}) == {}

    def test_removes_conversation_summary(self):
        src = {"conversation_summary": "long text", "model": "gpt-4"}
        result = _fork_state_json(src)
        assert "conversation_summary" not in result
        assert result["model"] == "gpt-4"

    def test_removes_debug_mode(self):
        src = {"_debug_mode": True, "temperature": 0.7}
        result = _fork_state_json(src)
        assert "_debug_mode" not in result
        assert result["temperature"] == 0.7

    def test_removes_both_fields(self):
        src = {
            "conversation_summary": "summary",
            "_debug_mode": False,
            "tools": ["search"],
        }
        result = _fork_state_json(src)
        assert "conversation_summary" not in result
        assert "_debug_mode" not in result
        assert result["tools"] == ["search"]

    def test_preserves_other_fields(self):
        src = {
            "model": "claude-3",
            "system_prompt": "You are helpful.",
            "messages_json": [{"role": "user", "content": "hi"}],
            "metadata": {"key": "value"},
        }
        result = _fork_state_json(src)
        assert result == src

    def test_does_not_mutate_source(self):
        src = {"conversation_summary": "s", "keep": 1}
        original_keys = set(src.keys())
        _fork_state_json(src)
        assert set(src.keys()) == original_keys

    def test_falsy_empty_string_input(self):
        assert _fork_state_json("") == {}  # type: ignore[arg-type]

    def test_zero_input(self):
        assert _fork_state_json(0) == {}  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# _fork_copy_messages_sync（mock ORM）
# ---------------------------------------------------------------------------

@dataclass
class FullFakeChatMessage:
    """完整字段的 ChatMessage 替身"""
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    role: str = "user"
    content: str = ""
    content_blocks_json: Optional[list] = None
    text_summary: Optional[str] = None
    message_kind: str = "llm"
    model_id: Optional[str] = None
    trace_id: Optional[str] = None
    sender_user_id: Optional[str] = None
    agent_id: Optional[str] = None
    agent_run_id: Optional[str] = None
    metadata: Optional[dict] = None
    created_at: datetime = field(default_factory=datetime.now)
    arrival_seq: Optional[int] = None


class TestForkCopyMessagesSync:
    """_fork_copy_messages_sync 消息复制逻辑测试（mock ORM 调用）"""

    @staticmethod
    def _new_session():
        session = MagicMock()
        session.id = uuid.UUID("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        session.workspace = MagicMock()
        return session

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_copies_all_message_fields(self, MockChatMsg, mock_pg, mock_ctx):
        """验证所有消息字段被正确传递给 ChatMessage 构造器"""
        src = FullFakeChatMessage(
            role="assistant",
            content="hello world",
            content_blocks_json=[{"type": "text", "text": "block"}],
            text_summary="hello world",
            message_kind="llm",
            model_id="gpt-4",
            trace_id="trace-abc",
            sender_user_id="user-001",
            agent_id="agent-001",
            agent_run_id="run-xyz",
            metadata={"source": "skill_invoke"},
            arrival_seq=123456,
        )
        mock_session = self._new_session()

        _fork_copy_messages_sync([src], mock_session, None, MagicMock())

        assert MockChatMsg.call_count == 1
        _, kwargs = MockChatMsg.call_args
        assert kwargs["role"] == "assistant"
        assert kwargs["content_blocks_json"] == [{"type": "text", "text": "block"}]
        assert kwargs["text_summary"] == "hello world"
        assert kwargs["message_kind"] == "llm"
        assert kwargs["model_id"] == "gpt-4"
        assert kwargs["trace_id"] == "trace-abc"
        assert kwargs["sender_user_id"] == "user-001"
        assert kwargs["agent_id"] == "agent-001"
        assert kwargs["agent_run_id"] == "run-xyz"
        assert kwargs["metadata"] == {"source": "skill_invoke"}
        assert kwargs["arrival_seq"] == 123456
        assert kwargs["session"] is mock_session

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_new_messages_get_fresh_uuids(self, MockChatMsg, mock_pg, mock_ctx):
        """新消息的 id 是全新 UUID，不复用源消息 id"""
        source_id = "11111111-1111-4111-8111-111111111111"
        src = FullFakeChatMessage(id=source_id)
        mock_session = self._new_session()

        _fork_copy_messages_sync([src], mock_session, None, MagicMock())

        _, kwargs = MockChatMsg.call_args
        new_id = kwargs["id"]
        assert str(new_id) != source_id
        assert isinstance(new_id, uuid.UUID)
        assert new_id == uuid.uuid5(
            mock_session.id,
            f"{mock_session.id}:{source_id}",
        )

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_timestamps_restored_via_bulk_update(self, MockChatMsg, mock_pg, mock_ctx):
        """原始 created_at 通过 bulk_update 回填"""
        ts = datetime(2025, 3, 15, 10, 30, 0)
        src = FullFakeChatMessage(created_at=ts)
        mock_obj = MagicMock()
        MockChatMsg.return_value = mock_obj
        mock_session = self._new_session()

        _fork_copy_messages_sync([src], mock_session, None, MagicMock())

        MockChatMsg.objects.bulk_create.assert_called_once()
        MockChatMsg.objects.bulk_update.assert_called_once()
        update_args = MockChatMsg.objects.bulk_update.call_args
        assert update_args[0][1] == ['created_at']
        assert update_args[1].get('batch_size') == 500
        assert mock_obj.created_at == ts

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_empty_source_messages_skips_orm(self, MockChatMsg, mock_pg, mock_ctx):
        """空消息列表不调用 bulk_create/bulk_update"""
        mock_session = self._new_session()

        count, remap = _fork_copy_messages_sync([], mock_session, None, MagicMock())

        assert count == 0
        assert remap == {}
        MockChatMsg.objects.bulk_create.assert_not_called()
        MockChatMsg.objects.bulk_update.assert_not_called()
        assert mock_session.last_message_at is None

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_multiple_messages_preserved_order(self, MockChatMsg, mock_pg, mock_ctx):
        """多条消息按原顺序复制，返回正确计数"""
        msgs = [
            FullFakeChatMessage(role="user", content="q1", created_at=datetime(2025, 1, 1, 0, 0, i))
            for i in range(5)
        ]
        mock_session = self._new_session()

        count, _remap = _fork_copy_messages_sync(msgs, mock_session, None, MagicMock())

        assert count == 5
        assert MockChatMsg.call_count == 5
        assert MockChatMsg.objects.bulk_create.call_args[1]["batch_size"] == 500

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_last_message_at_set_on_session(self, MockChatMsg, mock_pg, mock_ctx):
        """new_session.last_message_at 被设置为最后一条消息的 created_at"""
        ts = datetime(2025, 6, 15, 14, 0, 0)
        src = FullFakeChatMessage(created_at=ts)
        mock_session = self._new_session()

        _fork_copy_messages_sync([src], mock_session, None, MagicMock())

        assert mock_session.last_message_at == ts
        mock_session.save.assert_called_once_with(update_fields=['last_message_at'])

    @patch("apps.chat.conversation.api.fork._fork_copy_context")
    @patch("apps.chat.conversation.api.fork._fork_copy_pg_state")
    @patch("apps.chat.conversation.api.fork.ChatMessage")
    def test_remaps_tool_use_ids_in_content_blocks(self, MockChatMsg, mock_pg, mock_ctx):
        """#7033：fork 复制时把上游 tool_use id 重写为 tu_*，配对 id 一致。"""
        src = FullFakeChatMessage(
            role="assistant",
            content_blocks_json=[
                {
                    "type": "tool_use",
                    "id": "run_terminal_command_41",
                    "name": "run_terminal_command",
                    "input": {},
                },
                {
                    "type": "tool_result",
                    "tool_use_id": "run_terminal_command_41",
                    "content": "ok",
                },
            ],
        )
        mock_session = self._new_session()

        _count, remap = _fork_copy_messages_sync([src], mock_session, None, MagicMock())

        _, kwargs = MockChatMsg.call_args
        blocks = kwargs["content_blocks_json"]
        use_id = blocks[0]["id"]
        result_id = blocks[1]["tool_use_id"]
        assert is_tabtin_tool_use_id(use_id)
        assert result_id == use_id
        assert use_id != "run_terminal_command_41"
        # 与 ConversationState 共用 mapper；快照供本机 fork 种子化
        assert mock_pg.call_args.kwargs.get("tool_id_mapper") is not None
        assert remap.get("run_terminal_command_41") == use_id


# ---------------------------------------------------------------------------
# fork 点精度 — 同秒消息场景
# ---------------------------------------------------------------------------


class TestForkPointPrecisionSameSecond:
    """
    验证 _truncate_pg_messages_at_fork_point 在多条消息具有相同时间戳时
    通过 content+role 匹配仍能正确定位 fork 点。
    """

    def test_same_second_different_content(self):
        """同秒内多条不同 content 的 user 消息，fork 点正确匹配"""
        ts = datetime(2025, 6, 1, 12, 0, 0)
        pg = [
            _pg("user", "first question"),
            _pg("assistant", "answer 1"),
            _pg("user", "second question"),
            _pg("assistant", "answer 2"),
            _pg("user", "third question"),
        ]
        mysql = [
            FakeChatMessage(id="m1", content="first question", role="user", created_at=ts),
            FakeChatMessage(id="a1", content="answer 1", role="assistant", created_at=ts),
            FakeChatMessage(id="m2", content="second question", role="user", created_at=ts),
            FakeChatMessage(id="a2", content="answer 2", role="assistant", created_at=ts),
            FakeChatMessage(id="m3", content="third question", role="user", created_at=ts),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "m2")
        assert len(result) == 4
        assert result[-1]["content"] == "answer 2"
        assert all(m["content"] != "third question" for m in result)
        assert failed is False

    def test_same_second_fork_at_first(self):
        """fork 点在同秒消息的第一条"""
        ts = datetime(2025, 6, 1, 12, 0, 0)
        pg = [
            _pg("user", "alpha"),
            _pg("assistant", "resp-alpha"),
            _pg("user", "beta"),
            _pg("assistant", "resp-beta"),
        ]
        mysql = [
            FakeChatMessage(id="m1", content="alpha", role="user", created_at=ts),
            FakeChatMessage(id="a1", content="resp-alpha", role="assistant", created_at=ts),
            FakeChatMessage(id="m2", content="beta", role="user", created_at=ts),
            FakeChatMessage(id="a2", content="resp-beta", role="assistant", created_at=ts),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "m1")
        assert len(result) == 2
        assert result[-1]["content"] == "resp-alpha"
        assert failed is False

    def test_same_second_with_tool_messages(self):
        """同秒消息中穿插 tool 消息，tool 轮正确保留"""
        ts = datetime(2025, 6, 1, 12, 0, 0)
        pg = [
            _pg("user", "search x"),
            _pg("assistant", "calling tool"),
            _pg("tool", "tool result"),
            _pg("assistant", "final answer"),
            _pg("user", "next question"),
        ]
        mysql = [
            FakeChatMessage(id="u1", content="search x", role="user", created_at=ts),
            FakeChatMessage(id="a1", content="final answer", role="assistant", created_at=ts),
            FakeChatMessage(id="u2", content="next question", role="user", created_at=ts),
        ]
        result, failed = _truncate_pg_messages_at_fork_point(pg, mysql, "u1")
        assert len(result) == 4
        assert result[-1]["content"] == "final answer"
        assert failed is False


# ---------------------------------------------------------------------------
# fork 复制边界 — 真实 QuerySet / async 路径
# ---------------------------------------------------------------------------


_BASE_SEQ = 1_783_990_000_000_000


class ForkBoundaryQuerySetTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create(username=f"fork-boundary-{uuid.uuid4().hex[:8]}")
        self.source = ChatSession.objects.create(
            user=self.user,
            organization_id="fork-boundary",
            title="source",
            thread_id=f"fork-source-{uuid.uuid4()}",
        )

    def _mk(self, role: str, text: str, arrival_offset_s: int, created_offset_s: int):
        msg = ChatMessage.objects.create(
            session=self.source,
            role=role,
            text_summary=text,
            content_blocks_json=[{"type": "text", "text": text}],
            message_kind="llm",
            client_event_id=uuid.uuid4(),
            arrival_seq=_BASE_SEQ + arrival_offset_s * 1_000_000,
        )
        ChatMessage.objects.filter(id=msg.id).update(
            created_at=datetime.fromtimestamp(
                _BASE_SEQ / 1_000_000 + created_offset_s,
                tz=timezone.get_current_timezone(),
            ),
        )
        msg.refresh_from_db()
        return msg

    def _scrambled_messages(self):
        """对话顺序和落库时间反向，复现 created_at 边界会多复制尾部的问题。"""
        u1 = self._mk("user", "q1", arrival_offset_s=0, created_offset_s=40)
        a1 = self._mk("assistant", "a1-clicked", arrival_offset_s=10, created_offset_s=30)
        u2 = self._mk("user", "q2-after-click", arrival_offset_s=20, created_offset_s=20)
        a2 = self._mk("assistant", "a2-after-click", arrival_offset_s=30, created_offset_s=10)
        return u1, a1, u2, a2

    def test_fork_boundary_queryset_uses_arrival_seq_when_created_at_is_reversed(self):
        _u1, a1, _u2, _a2 = self._scrambled_messages()
        timeline = ChatMessage.objects.filter(session=self.source)

        bounded = _fork_boundary_queryset(timeline, a1)
        ordered = _sort_messages_by_conversation_time(bounded)

        self.assertEqual([m.text_summary for m in ordered], ["q1", "a1-clicked"])

    def test_async_fork_copies_only_messages_before_clicked_arrival_seq_boundary(self):
        u1, a1, _u2, _a2 = self._scrambled_messages()
        target = ChatSession.objects.create(
            user=self.user,
            organization_id="fork-boundary",
            title="target",
            thread_id=f"fork-target-{uuid.uuid4()}",
            forked_from_id=self.source.id,
            fork_point_message_id=a1.id,
            fork_copy_status="pending",
        )

        fork_copy_messages_async(
            source_session_id=str(self.source.id),
            new_session_id=str(target.id),
            fork_point_message_id=str(a1.id),
            source_thread_id=self.source.effective_thread_id,
            space_id=None,
        )

        copied = list(
            ChatMessage.objects
            .filter(session=target)
            .order_by("arrival_seq")
            .values_list("id", "text_summary", "arrival_seq")
        )
        self.assertEqual([text for _id, text, _seq in copied], ["q1", "a1-clicked"])
        from apps.chat.conversation.services.fork_message_id_remap import (
            forked_message_id,
        )

        self.assertEqual(
            [message_id for message_id, _text, _seq in copied],
            [
                forked_message_id(target.id, u1.id),
                forked_message_id(target.id, a1.id),
            ],
        )
        target.refresh_from_db()
        self.assertEqual(target.fork_copy_status, "complete")


# ---------------------------------------------------------------------------
# 空会话 fork 校验
# ---------------------------------------------------------------------------


class TestEmptySessionForkValidation:
    """空会话 / 边界条件 fork 校验"""

    def test_empty_pg_empty_mysql(self):
        """PG 和 MySQL 都为空时返回空列表"""
        result, failed = _truncate_pg_messages_at_fork_point([], [], "any-id")
        assert result == []
        assert failed is False

    def test_single_system_message_only(self):
        """只有 system 消息的 PG 列表 + 空 MySQL，返回完整副本"""
        pg = [_pg("system", "You are helpful.")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, [], "id1")
        assert result == pg
        assert result is not pg
        assert failed is False

    def test_fork_point_id_is_none_returns_full_copy(self):
        """fork_point_message_id 为 None 返回完整副本"""
        pg = [_pg("user", "q"), _pg("assistant", "a")]
        result, failed = _truncate_pg_messages_at_fork_point(pg, [FakeChatMessage()], None)
        assert result == pg
        assert failed is False

    def test_copy_messages_sync_empty_returns_zero(self):
        """_fork_copy_messages_sync 空消息返回 0"""
        with patch("apps.chat.conversation.api.fork._fork_copy_context"), \
             patch("apps.chat.conversation.api.fork._fork_copy_pg_state"), \
             patch("apps.chat.conversation.api.fork.ChatMessage"):
            mock_session = MagicMock()
            mock_session.workspace = MagicMock()
            count, remap = _fork_copy_messages_sync([], mock_session, None, MagicMock())
            assert count == 0
            assert remap == {}


# ---------------------------------------------------------------------------
# fork 点必须是 assistant
# ---------------------------------------------------------------------------


class _FakeTimeline:
    """轻量 QuerySet 替身，供 `_resolve_assistant_fork_point` 单测。"""

    def __init__(self, rows: list[FakeChatMessage]):
        self._rows = list(rows)

    def filter(self, *conditions, **kwargs):
        rows = self._rows
        for condition in conditions:
            rows = [r for r in rows if self._matches_q(r, condition)]
        if "id" in kwargs:
            mid = str(kwargs["id"])
            rows = [r for r in rows if str(r.id) == mid]
        if "role" in kwargs:
            rows = [r for r in rows if r.role == kwargs["role"]]
        return _FakeTimeline(rows)

    def _matches_q(self, row: FakeChatMessage, condition) -> bool:
        children = getattr(condition, "children", None)
        connector = getattr(condition, "connector", "AND")
        negated = getattr(condition, "negated", False)
        if children is None:
            return True

        results = []
        for child in children:
            if hasattr(child, "children"):
                results.append(self._matches_q(row, child))
                continue
            key, value = child
            if key == "metadata__client_message_id":
                results.append(row.metadata.get("client_message_id") == value)
            elif key == "metadata__message_id":
                results.append(row.metadata.get("message_id") == value)
            elif key == "id":
                results.append(str(row.id) == str(value))
            elif key == "client_event_id":
                results.append(str(row.client_event_id) == str(value))
            else:
                results.append(False)

        matched = any(results) if connector == "OR" else all(results)
        return not matched if negated else matched

    def order_by(self, *args):
        rows = list(self._rows)
        if args and args[0] == "-created_at":
            rows = list(reversed(rows))
        return _FakeTimeline(rows)

    def only(self, *args):
        return self

    def first(self):
        return self._rows[0] if self._rows else None

    def exists(self):
        return bool(self._rows)

    def __iter__(self):
        return iter(self._rows)


class TestResolveAssistantForkPoint:
    def test_rejects_user_message_id(self):
        uid = "user-1"
        tl = _FakeTimeline([
            FakeChatMessage(id=uid, role="user", content="q"),
            FakeChatMessage(id="a1", role="assistant", content="a"),
        ])
        res = _resolve_assistant_fork_point(tl, uid)
        assert res.error is not None
        assert "assistant" in res.error.lower()
        assert res.status_code == 400

    def test_accepts_assistant_message_id(self):
        aid = "asst-1"
        tl = _FakeTimeline([
            FakeChatMessage(id="u1", role="user", content="q"),
            FakeChatMessage(id=aid, role="assistant", content="a"),
        ])
        res = _resolve_assistant_fork_point(tl, aid)
        assert res.error is None
        assert str(res.message_id) == aid

    def test_accepts_agent_host_anchor_from_metadata(self):
        tl = _FakeTimeline([
            FakeChatMessage(id="u1", role="user", content="q"),
            FakeChatMessage(
                id="server-a1",
                role="assistant",
                content="a",
                metadata={"client_message_id": "host-a1"},
            ),
        ])
        res = _resolve_assistant_fork_point(
            tl,
            None,
            fork_anchor_message_id="host-a1",
        )
        assert res.error is None
        assert str(res.message_id) == "server-a1"

    def test_falls_back_to_server_message_id_when_anchor_not_yet_indexed(self):
        tl = _FakeTimeline([
            FakeChatMessage(id="u1", role="user", content="q"),
            FakeChatMessage(id="server-a1", role="assistant", content="a"),
        ])
        res = _resolve_assistant_fork_point(
            tl,
            "server-a1",
            fork_anchor_message_id="host-a1-not-yet-synced",
        )
        assert res.error is None
        assert str(res.message_id) == "server-a1"

    def test_rejects_agent_host_anchor_when_it_points_to_user_message(self):
        tl = _FakeTimeline([
            FakeChatMessage(
                id="server-u1",
                role="user",
                content="q",
                metadata={"client_message_id": "host-u1"},
            ),
            FakeChatMessage(id="a1", role="assistant", content="a"),
        ])
        res = _resolve_assistant_fork_point(
            tl,
            None,
            fork_anchor_message_id="host-u1",
        )
        assert res.error is not None
        assert "assistant" in res.error.lower()
        assert res.status_code == 400

    def test_whole_session_snaps_to_last_assistant_skipping_trailing_user(self):
        tl = _FakeTimeline([
            FakeChatMessage(id="u1", role="user", content="q1"),
            FakeChatMessage(id="a1", role="assistant", content="a1"),
            FakeChatMessage(id="u2", role="user", content="orphan"),
        ])
        res = _resolve_assistant_fork_point(tl, None)
        assert res.error is None
        assert str(res.message_id) == "a1"

    def test_whole_session_snaps_to_last_assistant_by_arrival_seq(self):
        older_created_later = FakeChatMessage(
            id="a-old-created-late",
            role="assistant",
            content="old",
            created_at=datetime(2025, 1, 1, 0, 0, 3),
            arrival_seq=1_000,
        )
        newer_created_earlier = FakeChatMessage(
            id="a-new-created-early",
            role="assistant",
            content="new",
            created_at=datetime(2025, 1, 1, 0, 0, 1),
            arrival_seq=2_000,
        )
        tl = _FakeTimeline([older_created_later, newer_created_earlier])
        res = _resolve_assistant_fork_point(tl, None)
        assert res.error is None
        assert str(res.message_id) == "a-new-created-early"

    def test_no_assistant_cannot_fork(self):
        tl = _FakeTimeline([
            FakeChatMessage(id="u1", role="user", content="only user"),
        ])
        res = _resolve_assistant_fork_point(tl, None)
        assert res.error is not None
        assert res.status_code == 400
