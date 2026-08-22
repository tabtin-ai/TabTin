"""
H2-A FR-10：relay_trace_writer 单元测试

覆盖：
  1. 辅助函数：_short_name_from_stream_type / _derive_event_name /
     _is_terminal_lifecycle / _is_done_event / _resolve_done_status
  2. relay_handler 集成：trace_id 缺失被跳过；publish_ws 总是先调；trace 写表
     失败不阻塞 publish_ws；多 trace_id 分组；DONE 终结 trace
  3. bulk_create 调用次数 — 关键性能契约（避免 N+1 INSERT）
  4. WS 双通道：写表后必须对 trace.stream.{trace_id} 频道双推 record_event +
     trace_end，让 AdminDash useTraceStream 实时刷新生效
"""
from __future__ import annotations

import os
import sys
import uuid
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402

from apps.services.common.ws.handlers.relay_trace_writer import (  # noqa: E402
    LOCAL_RUNTIME_GRAPH_TYPE,
    LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE,
    _derive_event_name,
    _is_done_event,
    _is_terminal_lifecycle,
    _merge_trace_finalize,
    _persist_relay_events_to_trace_sync,
    _resolve_done_status,
    _resolve_lifecycle_status,
    _short_name_from_stream_type,
)


# ────────────────────────────────────────────────────────────────────
# 1. 辅助函数（pure）
# ────────────────────────────────────────────────────────────────────


class TestShortNameFromStreamType:
    """_short_name_from_stream_type — 提取 short name。"""

    def test_strips_agent_stream_prefix(self):
        assert _short_name_from_stream_type("agent.stream.assistant") == "assistant"
        assert _short_name_from_stream_type("agent.stream.tool") == "tool"
        assert _short_name_from_stream_type("agent.stream.lifecycle") == "lifecycle"
        assert _short_name_from_stream_type("agent.stream.done") == "done"

    def test_passes_through_non_prefixed(self):
        # 防御：不是 agent.stream.* 前缀直接返回原串
        assert _short_name_from_stream_type("custom.event") == "custom.event"


class TestDeriveEventName:
    """_derive_event_name — 根据 short_name + payload 推导 TraceEvent.name。"""

    def test_tool_uses_tool_name(self):
        assert _derive_event_name("tool", {"tool_name": "bash"}) == "bash"
        assert _derive_event_name("tool", {"tool_name": "web_fetch"}) == "web_fetch"

    def test_tool_fallback_when_missing_name(self):
        assert _derive_event_name("tool", {}) == "tool"

    def test_step_uses_step_type(self):
        assert _derive_event_name("step", {"step_type": "thinking"}) == "thinking"

    def test_system_notice_uses_notice_type(self):
        assert _derive_event_name("system_notice", {"notice_type": "doom_loop_warn"}) == "doom_loop_warn"
        assert _derive_event_name("system_notice", {}) == "notice"

    def test_compaction_prefers_mode_over_phase(self):
        assert _derive_event_name("compaction", {"mode": "auto", "phase": "end"}) == "auto"
        assert _derive_event_name("compaction", {"phase": "end"}) == "end"

    def test_lifecycle_uses_phase(self):
        assert _derive_event_name("lifecycle", {"phase": "start"}) == "start"
        assert _derive_event_name("lifecycle", {"phase": "end"}) == "end"

    def test_assistant_uses_phase(self):
        assert _derive_event_name("assistant", {"phase": "delta"}) == "delta"
        assert _derive_event_name("assistant", {"phase": "final"}) == "final"

    def test_subagent_strips_prefix(self):
        # subagent_started/subagent_progress 等去 subagent_ 前缀作为 name
        assert _derive_event_name("subagent_started", {}) == "started"
        assert _derive_event_name("subagent_completed", {}) == "completed"

    def test_unknown_uses_short_name(self):
        assert _derive_event_name("reasoning", {}) == "reasoning"


class TestIsTerminalLifecycle:
    """_is_terminal_lifecycle — 判断是否触发 trace 终结。"""

    def test_end_phase_is_terminal(self):
        assert _is_terminal_lifecycle("lifecycle", {"phase": "end"}) is True

    def test_error_phase_is_terminal(self):
        assert _is_terminal_lifecycle("lifecycle", {"phase": "error"}) is True

    def test_terminated_phase_is_terminal(self):
        assert _is_terminal_lifecycle("lifecycle", {"phase": "terminated"}) is True

    def test_session_interrupted_is_terminal(self):
        assert _is_terminal_lifecycle("lifecycle", {"phase": "session_interrupted"}) is True

    def test_start_phase_is_not_terminal(self):
        assert _is_terminal_lifecycle("lifecycle", {"phase": "start"}) is False

    def test_non_lifecycle_is_not_terminal(self):
        assert _is_terminal_lifecycle("done", {"phase": "end"}) is False
        assert _is_terminal_lifecycle("tool", {"phase": "end"}) is False


class TestIsDoneEvent:
    def test_done_returns_true(self):
        assert _is_done_event("done") is True

    def test_others_return_false(self):
        assert _is_done_event("lifecycle") is False
        assert _is_done_event("assistant") is False


class TestResolveDoneStatus:
    """_resolve_done_status — 从 done payload 提取 status / error。"""

    def test_normal_done_is_completed(self):
        status, error = _resolve_done_status({"content": "hi"})
        assert status == "completed"
        assert error is None

    def test_error_done_extracts_message(self):
        status, error = _resolve_done_status({
            "error": True,
            "error_message": "LLM timeout",
        })
        assert status == "error"
        assert error == "LLM timeout"

    def test_error_without_message(self):
        status, error = _resolve_done_status({"error": True})
        assert status == "error"
        assert error == ""


class TestResolveLifecycleStatus:
    def test_error_phase(self):
        status, error = _resolve_lifecycle_status({"phase": "error", "error_message": "boom"})
        assert status == "error"
        assert error == "boom"

    def test_terminated_phase_with_detail(self):
        status, error = _resolve_lifecycle_status({"phase": "terminated", "detail": "user_cancelled"})
        assert status == "error"
        assert error == "user_cancelled"

    def test_end_phase_is_completed(self):
        status, error = _resolve_lifecycle_status({"phase": "end"})
        assert status == "completed"
        assert error is None


# H2-A 技术 Review P0：终结状态合并优先级
class TestMergeTraceFinalize:
    """_merge_trace_finalize — 终结状态合并优先级。

    P0 修复点：query.ts 错误路径是「yield DONE(error) → break → finally yield
    lifecycle.end(=completed)」，同批两条共存。后写覆盖会让 AdminDash 把失败显示为成功。
    """

    def test_no_existing_accepts_new(self):
        result = _merge_trace_finalize(None, ("error", "boom", "done"))
        assert result == ("error", "boom", "done")

    def test_done_not_overridden_by_lifecycle(self):
        """关键 bug 修复 — DONE(error) 已写后 lifecycle.end(completed) 不能覆盖。"""
        cur = ("error", "LLM 504", "done")
        new = ("completed", None, "lifecycle")
        assert _merge_trace_finalize(cur, new) == ("error", "LLM 504", "done")

    def test_lifecycle_overridden_by_done(self):
        """lifecycle 先到、DONE 后到 → DONE 是权威，应覆盖。"""
        cur = ("completed", None, "lifecycle")
        new = ("error", "tool fail", "done")
        assert _merge_trace_finalize(cur, new) == ("error", "tool fail", "done")

    def test_same_source_error_wins(self):
        """同 source 内 error 优先（lifecycle.error → lifecycle.end 不能洗掉 error）。"""
        cur = ("error", "broken", "lifecycle")
        new = ("completed", None, "lifecycle")
        assert _merge_trace_finalize(cur, new) == ("error", "broken", "lifecycle")

    def test_same_source_replace_when_no_status_drop(self):
        cur = ("completed", None, "done")
        new = ("completed", None, "done")
        result = _merge_trace_finalize(cur, new)
        assert result[0] == "completed"


# ────────────────────────────────────────────────────────────────────
# 2. _persist_relay_events_to_trace_sync — mock-based 集成测试
# ────────────────────────────────────────────────────────────────────


@pytest.fixture
def mock_orm():
    """Mock 整套 ORM 入口（ExecutionTrace / TraceEvent / ChatSession / connections / transaction）。

    返回 dict 含所有关键 mock，让测试能断言调用次数。
    """
    with patch(
        "apps.services.common.ws.handlers.relay_trace_writer.ExecutionTrace"
    ) as mock_trace_cls, patch(
        "apps.services.common.ws.handlers.relay_trace_writer.TraceEvent"
    ) as mock_event_cls, patch(
        "apps.services.common.ws.handlers.relay_trace_writer.connections"
    ) as mock_connections, patch(
        "apps.services.common.ws.handlers.relay_trace_writer.transaction"
    ) as mock_transaction:
        # 模拟 chat session 查询：fixed user_id / organization_id
        with patch("apps.chat.conversation.models.ChatSession") as mock_chat_session:
            mock_chat_session.objects.filter.return_value.values.return_value.first.return_value = {
                "user_id": "user-42",
                "organization_id": "wt-99",
            }

            # ExecutionTrace.objects.using(...).get_or_create
            trace_instance = MagicMock()
            trace_instance.id = 12345
            trace_instance.last_event_seq = 0
            trace_instance.trace_id = uuid.UUID("11111111-2222-3333-4444-555555555555")
            mock_trace_cls.objects.using.return_value.get_or_create.return_value = (
                trace_instance, True
            )
            mock_trace_cls._meta.db_table = "agent_engine_traces"
            # filter().update() 链
            mock_trace_cls.objects.using.return_value.filter.return_value.update.return_value = 1

            # cursor 模拟
            mock_cursor = MagicMock()
            mock_cursor.fetchone.return_value = (5,)  # last_event_seq → 5
            mock_cursor.__enter__ = MagicMock(return_value=mock_cursor)
            mock_cursor.__exit__ = MagicMock(return_value=False)
            mock_conn = MagicMock()
            mock_conn.cursor.return_value = mock_cursor
            mock_connections.__getitem__.return_value = mock_conn

            # transaction.atomic 是 contextmanager
            mock_transaction.atomic.return_value.__enter__ = MagicMock()
            mock_transaction.atomic.return_value.__exit__ = MagicMock(return_value=False)

            yield {
                "trace_cls": mock_trace_cls,
                "event_cls": mock_event_cls,
                "chat_session": mock_chat_session,
                "connections": mock_connections,
                "transaction": mock_transaction,
                "trace_instance": trace_instance,
                "cursor": mock_cursor,
            }


def _make_event(stream_type: str, payload: dict) -> dict:
    return {"type": stream_type, "payload": payload}


class TestPersistRelayEventsBasic:
    """主路径：trace_id 注入 → get_or_create → bulk_create → 终结。"""

    def test_skips_events_without_trace_id(self, mock_orm):
        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash"}),  # 无 trace_id
            _make_event("agent.stream.tool", {"tool_name": "web_search"}),  # 无 trace_id
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["skipped_no_trace_id"] == 2
        assert stats["traces_created"] == 0
        assert stats["events_written"] == 0
        # 没有 trace_id 时根本不应该调 get_or_create
        mock_orm["trace_cls"].objects.using.return_value.get_or_create.assert_not_called()

    def test_creates_trace_with_local_runtime_graph_type(self, mock_orm):
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event(
                "agent.stream.tool",
                {"tool_name": "bash", "trace_id": trace_id},
            ),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_created"] == 1
        assert stats["events_written"] == 1

        # 关键：metadata.runtime='local' + graph_type='local-runtime'
        get_or_create = mock_orm["trace_cls"].objects.using.return_value.get_or_create
        get_or_create.assert_called_once()
        defaults = get_or_create.call_args.kwargs["defaults"]
        assert defaults["graph_type"] == LOCAL_RUNTIME_GRAPH_TYPE
        assert defaults["graph_type"] == "local-runtime"  # 显式断言文档化字面量
        assert defaults["metadata"]["runtime"] == "local"
        assert defaults["session_id"] == "sess-1"
        # 从 ChatSession 取来的 user_id / organization_id
        assert defaults["user_id"] == "user-42"
        assert defaults["organization_id"] == "wt-99"

    def test_bulk_create_called_once_per_trace_batch(self, mock_orm):
        """关键性能契约：N events 同一 trace_id 只调 1 次 bulk_create。"""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.tool", {"tool_name": f"tool_{i}", "trace_id": trace_id})
            for i in range(50)
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["events_written"] == 50

        bulk_create = mock_orm["event_cls"].objects.using.return_value.bulk_create
        assert bulk_create.call_count == 1
        # 一次性传入 50 个 TraceEvent 实例
        objs_arg = bulk_create.call_args.args[0]
        assert len(objs_arg) == 50

        # SQL UPDATE 也只调 1 次（分配 seq 范围）
        assert mock_orm["cursor"].execute.call_count == 1

    def test_done_event_finalizes_trace_completed(self, mock_orm):
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.assistant", {"phase": "delta", "trace_id": trace_id}),
            _make_event("agent.stream.done", {"content": "ok", "trace_id": trace_id}),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_finalized"] == 1
        # 最后一次 update 把 status='completed'
        update_chain = (
            mock_orm["trace_cls"].objects.using.return_value.filter.return_value.update
        )
        update_chain.assert_called_once()
        kwargs = update_chain.call_args.kwargs
        assert kwargs["status"] == "completed"
        assert kwargs["error"] is None

    def test_done_with_error_finalizes_trace_error(self, mock_orm):
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event(
                "agent.stream.done",
                {"error": True, "error_message": "LLM 504", "trace_id": trace_id},
            ),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_finalized"] == 1
        update_chain = (
            mock_orm["trace_cls"].objects.using.return_value.filter.return_value.update
        )
        kwargs = update_chain.call_args.kwargs
        assert kwargs["status"] == "error"
        assert kwargs["error"] == "LLM 504"

    def test_lifecycle_end_finalizes_trace(self, mock_orm):
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.lifecycle", {"phase": "start", "trace_id": trace_id}),
            _make_event("agent.stream.lifecycle", {"phase": "end", "trace_id": trace_id}),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_finalized"] == 1


class TestPersistDoneAndLifecycleEndCoexist:
    """关键回归（H2-A 技术 Review P0 #1）：DONE(error) + lifecycle.end 同批的真实顺序。

    见 query.ts: 多数错误路径是 yield DONE(error=true) → break → finally yield lifecycle.end。
    一次 RelayBuffer flush 可能两条共存。修复前会被 lifecycle.end 洗成 completed。
    """

    def test_done_error_then_lifecycle_end_keeps_error(self, mock_orm):
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.assistant", {"phase": "delta", "trace_id": trace_id}),
            # query.ts 错误路径 yield 顺序：DONE(error) 先
            _make_event(
                "agent.stream.done",
                {"error": True, "error_message": "Max turns exceeded", "trace_id": trace_id},
            ),
            # finally 块 yield lifecycle.end
            _make_event(
                "agent.stream.lifecycle",
                {"phase": "end", "run_id": trace_id, "trace_id": trace_id},
            ),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_finalized"] == 1
        # 关键：status 应为 error 而非被 lifecycle.end 洗成 completed
        update_chain = (
            mock_orm["trace_cls"].objects.using.return_value.filter.return_value.update
        )
        kwargs = update_chain.call_args.kwargs
        assert kwargs["status"] == "error"
        assert kwargs["error"] == "Max turns exceeded"

    def test_done_completed_then_lifecycle_end_stays_completed(self, mock_orm):
        """正常路径：DONE(completed) + lifecycle.end → 仍 completed。"""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.done", {"content": "ok", "trace_id": trace_id}),
            _make_event(
                "agent.stream.lifecycle",
                {"phase": "end", "trace_id": trace_id},
            ),
        ]
        _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        update_chain = (
            mock_orm["trace_cls"].objects.using.return_value.filter.return_value.update
        )
        kwargs = update_chain.call_args.kwargs
        assert kwargs["status"] == "completed"


class TestPersistMultipleTraces:
    """多 trace_id 分组场景：连发对话 / 子 Agent。"""

    def test_groups_by_trace_id(self, mock_orm):
        """两个 trace_id 各自独立写入 — 各自 1 次 bulk_create。"""
        trace_id_a = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        trace_id_b = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash", "trace_id": trace_id_a}),
            _make_event("agent.stream.tool", {"tool_name": "ls", "trace_id": trace_id_a}),
            _make_event("agent.stream.tool", {"tool_name": "find", "trace_id": trace_id_b}),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        # 两个 trace 各自创建
        assert stats["traces_created"] == 2
        assert stats["events_written"] == 3

        # bulk_create 调 2 次（两个 trace 各 1 次）
        bulk_create = mock_orm["event_cls"].objects.using.return_value.bulk_create
        assert bulk_create.call_count == 2


# ────────────────────────────────────────────────────────────────────
# LH2-A1（H3-C）：子 Agent trace 识别 + 嵌套 metadata
# ────────────────────────────────────────────────────────────────────


class TestPersistSubagentTraceLh2a1:
    """LH2-A1：当 event payload 含 `parent_trace_id` 时，trace 必须被识别为
    子 Agent 并写入独立 graph_type + metadata.parent_trace_id。

    这是 AdminDash trace-detail 嵌套展开子 trace 的数据基础——靠
    metadata.parent_trace_id 反向关联，前端能从父 trace events 节点直接跳到
    对应 child trace。
    """

    def test_detects_subagent_trace_via_parent_trace_id(self, mock_orm):
        """payload 含 parent_trace_id 即视为子 trace，graph_type 切换为
        LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE。"""
        child_trace_id = "11111111-2222-3333-4444-555555555555"
        parent_trace_id = "00000000-aaaa-aaaa-aaaa-000000000000"
        events = [
            _make_event(
                "agent.stream.tool",
                {
                    "tool_name": "bash",
                    "trace_id": child_trace_id,
                    "parent_trace_id": parent_trace_id,
                    "subagent_run_id": child_trace_id,
                    "child_id": child_trace_id,
                },
            ),
        ]
        _persist_relay_events_to_trace_sync(
            session_id="sess-sa-1",
            thread_id="chat-session-sess-sa-1",
            events=events,
        )

        get_or_create = mock_orm["trace_cls"].objects.using.return_value.get_or_create
        get_or_create.assert_called_once()
        defaults = get_or_create.call_args.kwargs["defaults"]
        # graph_type 切换为子 Agent 专属
        assert defaults["graph_type"] == LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE
        assert defaults["graph_type"] == "local-runtime-subagent"
        # metadata 含父 trace_id 与 subagent_run_id 关联
        assert defaults["metadata"]["parent_trace_id"] == parent_trace_id
        assert defaults["metadata"]["subagent_run_id"] == child_trace_id
        # 仍标记 runtime='local'（与父 trace 同一来源）
        assert defaults["metadata"]["runtime"] == "local"

    def test_parent_and_child_trace_in_same_batch_split_into_two_traces(self, mock_orm):
        """同一 batch 含父 + 子 events → 两个 trace 各自 get_or_create，
        graph_type 不同。

        agent-tool 在 while loop 内对每条 child event 调
        subagentTraceEmitter（独立通道），但 ElectronAgentHost 的 emitter
        实现是 `relayBuffer.push(...)` —— child events 与父 events 共享同一
        RelayBuffer 实例，所以同一个 relay batch 既含父也含子。
        """
        parent_trace_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        child_trace_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
        events = [
            # 父 trace 事件（无 parent_trace_id 字段）
            _make_event(
                "agent.stream.lifecycle",
                {"phase": "start", "trace_id": parent_trace_id},
            ),
            _make_event(
                "agent.stream.subagent_started",
                {
                    "trace_id": parent_trace_id,
                    "subagent_run_id": child_trace_id,
                    "task": "do X",
                    "label": "child task",
                    "started_at": 0,
                },
            ),
            # 子 trace 事件（有 parent_trace_id 字段）
            _make_event(
                "agent.stream.lifecycle",
                {
                    "phase": "start",
                    "trace_id": child_trace_id,
                    "parent_trace_id": parent_trace_id,
                    "subagent_run_id": child_trace_id,
                    "child_id": child_trace_id,
                },
            ),
            _make_event(
                "agent.stream.tool",
                {
                    "tool_name": "bash",
                    "trace_id": child_trace_id,
                    "parent_trace_id": parent_trace_id,
                    "subagent_run_id": child_trace_id,
                    "child_id": child_trace_id,
                },
            ),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-mixed",
            thread_id="chat-session-sess-mixed",
            events=events,
        )

        # 两个 trace 都创建
        assert stats["traces_created"] == 2
        assert stats["events_written"] == 4

        # 验证两次 get_or_create 调用的 graph_type 区分正确
        get_or_create = mock_orm["trace_cls"].objects.using.return_value.get_or_create
        assert get_or_create.call_count == 2

        graph_types = sorted(
            call.kwargs["defaults"]["graph_type"]
            for call in get_or_create.call_args_list
        )
        assert graph_types == sorted(
            [LOCAL_RUNTIME_GRAPH_TYPE, LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE]
        )

        # 验证 child trace 的 metadata.parent_trace_id 正确
        for call in get_or_create.call_args_list:
            defaults = call.kwargs["defaults"]
            if defaults["graph_type"] == LOCAL_RUNTIME_SUBAGENT_GRAPH_TYPE:
                assert defaults["metadata"]["parent_trace_id"] == parent_trace_id
            else:
                # 父 trace 的 metadata 不含 parent_trace_id（确实是顶层）
                assert "parent_trace_id" not in defaults["metadata"]

    def test_parent_trace_events_without_parent_trace_id_not_misclassified(self, mock_orm):
        """防御：仅当任何事件 payload 含 parent_trace_id 时才切到子 trace
        graph_type。普通父 trace events 永远不该被误判。
        """
        parent_trace_id = "ffffffff-ffff-ffff-ffff-ffffffffffff"
        events = [
            _make_event(
                "agent.stream.lifecycle",
                {"phase": "start", "trace_id": parent_trace_id},
            ),
            _make_event(
                "agent.stream.assistant",
                {"phase": "delta", "trace_id": parent_trace_id},
            ),
            _make_event(
                "agent.stream.subagent_started",
                {
                    "trace_id": parent_trace_id,
                    "subagent_run_id": "child-uuid",
                    "task": "do X",
                },
            ),
        ]
        _persist_relay_events_to_trace_sync(
            session_id="sess-parent",
            thread_id="chat-session-sess-parent",
            events=events,
        )

        get_or_create = mock_orm["trace_cls"].objects.using.return_value.get_or_create
        defaults = get_or_create.call_args.kwargs["defaults"]
        assert defaults["graph_type"] == LOCAL_RUNTIME_GRAPH_TYPE
        # parent_trace_id 字段不存在于 metadata（这本身就是父 trace）
        assert "parent_trace_id" not in defaults["metadata"]


class TestPersistFailureTolerance:
    """失败容错：单 trace 写表异常不影响其他 trace；整体异常返回部分 stats。"""

    def test_orm_exception_does_not_raise(self, mock_orm):
        """ChatSession 查询异常不应让 persist 抛——继续写表（只是 user_id / organization_id 为 None）。"""
        # 让 ChatSession 抛异常
        mock_orm["chat_session"].objects.filter.side_effect = RuntimeError("DB down")

        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [_make_event("agent.stream.tool", {"tool_name": "bash", "trace_id": trace_id})]

        # persist 不应该抛异常
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        # 写表仍发生
        assert stats["events_written"] == 1
        defaults = (
            mock_orm["trace_cls"].objects.using.return_value.get_or_create.call_args.kwargs["defaults"]
        )
        # ChatSession 失败 → user_id / organization_id 为 None（不阻塞）
        assert defaults["user_id"] is None
        assert defaults["organization_id"] is None

    def test_invalid_trace_id_skipped(self, mock_orm):
        """非法 UUID trace_id 字符串不应让整批失败。"""
        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash", "trace_id": "not-a-uuid"}),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        assert stats["traces_created"] == 0
        assert stats["events_written"] == 0

    def test_get_or_create_failure_isolated_per_trace(self, mock_orm):
        """单 trace get_or_create 抛异常 — 其他 trace 仍正常写。"""
        trace_id_a = "11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        trace_id_b = "22222222-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

        call_count = {"n": 0}
        bad_instance = MagicMock(id=99, last_event_seq=0)
        good_instance = MagicMock(id=100, last_event_seq=0)

        def fail_first_succeed_second(*args, **kwargs):
            call_count["n"] += 1
            if call_count["n"] == 1:
                raise RuntimeError("first trace boom")
            return (good_instance, True)

        mock_orm["trace_cls"].objects.using.return_value.get_or_create.side_effect = (
            fail_first_succeed_second
        )

        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash", "trace_id": trace_id_a}),
            _make_event("agent.stream.tool", {"tool_name": "find", "trace_id": trace_id_b}),
        ]
        stats = _persist_relay_events_to_trace_sync(
            session_id="sess-1", thread_id="chat-session-sess-1", events=events,
        )
        # trace_a 失败、trace_b 成功 — stats 反映这一点
        assert stats["traces_created"] == 1
        assert stats["events_written"] == 1


# ────────────────────────────────────────────────────────────────────
# 3. relay_handler 集成（trace 写表与 publish_ws 解耦）
# ────────────────────────────────────────────────────────────────────


class TestRelayHandlerTraceIntegration:
    """#5199：ACK / critical 落库优先；直播 publish 延后且不挡 ACK。
    trace 写表仍后台异步，失败不影响 publish / ACK。"""

    def test_ack_and_trace_spawn_before_deferred_publish(self):
        """ACK 与 trace spawn 在 deferred publish 之前；publish 仍会发生。"""
        import asyncio
        from apps.services.common.ws.handlers.relay_handler import (
            create_relay_events_handler,
            drain_deferred_relay_side_effects_for_tests,
        )

        consumer = MagicMock()
        consumer.user_id = "user-42"
        wt = MagicMock()
        wt.is_member.return_value = True
        consumer.organization_ctx = wt
        from unittest.mock import AsyncMock
        consumer._send_error = AsyncMock()

        handler = create_relay_events_handler(consumer)

        call_order: list[tuple[str, object]] = []

        async def fake_publish_ws(thread_id, short, payload):
            call_order.append(("publish_ws", short))

        def fake_spawn(session_id, thread_id, events):
            call_order.append(("spawn_trace_task", len(events)))
            return True

        async def fake_send_envelope(envelope):
            call_order.append(("ack", envelope.get("type")))

        consumer._send_envelope = AsyncMock(side_effect=fake_send_envelope)

        # `step` 在白名单且为 detail：会 spawn trace + deferred publish
        envelope = {
            "request_id": "req-1",
            "payload": {
                "session_id": "sess-1",
                "events": [
                    {
                        "type": "agent.stream.step",
                        "payload": {"step_type": "thinking", "trace_id": "11111111-2222-3333-4444-555555555555"},
                    },
                ],
            },
        }

        async def _run():
            with patch(
                "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
                new=AsyncMock(return_value=True),
            ), patch(
                "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
                new=AsyncMock(side_effect=fake_publish_ws),
            ), patch(
                "apps.services.common.ws.handlers.relay_handler._spawn_background_trace_write",
                side_effect=fake_spawn,
            ):
                await handler(envelope)
                await drain_deferred_relay_side_effects_for_tests()

        asyncio.run(_run())

        assert ("spawn_trace_task", 1) in call_order
        assert ("ack", "relay_events.ok") in call_order
        assert ("publish_ws", "step") in call_order
        assert call_order.index(("ack", "relay_events.ok")) < call_order.index(("publish_ws", "step"))
        assert call_order.index(("spawn_trace_task", 1)) < call_order.index(("publish_ws", "step"))

    @pytest.mark.asyncio
    async def test_ack_does_not_wait_for_persist(self):
        """运维 Review P0 修复：handler 立即发 ACK，不 await persist。"""
        import time
        import asyncio
        from apps.services.common.ws.handlers.relay_handler import (
            create_relay_events_handler,
        )

        consumer = MagicMock()
        consumer.user_id = "user-42"
        wt = MagicMock()
        wt.is_member.return_value = True
        consumer.organization_ctx = wt
        from unittest.mock import AsyncMock
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()

        handler = create_relay_events_handler(consumer)

        async def fake_persist(*args, **kwargs):
            await asyncio.sleep(5.0)
            return {"events_written": 0}

        envelope = {
            "request_id": "req-1",
            "payload": {
                "session_id": "sess-1",
                "events": [
                    {
                        "type": "agent.stream.tool",
                        "payload": {"tool_name": "bash", "trace_id": "11111111-2222-3333-4444-555555555555"},
                    },
                ],
            },
        }

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_ws",
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.persist_relay_events_to_trace",
            side_effect=fake_persist,
        ):
            t0 = time.monotonic()
            await handler(envelope)
            elapsed = time.monotonic() - t0

        assert elapsed < 1.0, f"handler 被 persist 阻塞了 {elapsed:.2f}s（应 < 1s）"
        consumer._send_envelope.assert_called_once()

    @pytest.mark.asyncio
    async def test_task_pool_full_increments_rejection_counter(self):
        """运维 Review P0：task 池满时拒绝计数 + ERROR 级日志（防静默丢数据）。

        修复前：池满只 logger.warning，运维容易在大量日志里漏掉。
        修复后：累计计数 + 每 50 次 ERROR 级日志，让运维准确判断"丢了多少 trace 写表"。
        """
        from apps.services.common.ws.handlers.relay_handler import (
            _BACKGROUND_TRACE_TASKS,
            _MAX_BACKGROUND_TASKS,
            _spawn_background_trace_write,
            get_rejected_trace_write_count,
            reset_rejected_trace_write_count,
        )

        reset_rejected_trace_write_count()

        # 灌满 task 池（用 mock task 占位，不实际跑）
        try:
            for _ in range(_MAX_BACKGROUND_TASKS):
                _BACKGROUND_TRACE_TASKS.add(MagicMock())

            # 池满后再 spawn 应返回 False + 计数 +1
            result = _spawn_background_trace_write(
                session_id="sess-rejected", thread_id="t-1", events=[],
            )
            assert result is False
            assert get_rejected_trace_write_count() == 1

            # 多次拒绝 — 计数累加
            for _ in range(5):
                _spawn_background_trace_write(
                    session_id="sess-rejected", thread_id="t-1", events=[],
                )
            assert get_rejected_trace_write_count() == 6
        finally:
            # 清理 — 不影响其他测试
            _BACKGROUND_TRACE_TASKS.clear()
            reset_rejected_trace_write_count()

    @pytest.mark.asyncio
    async def test_background_persist_exception_does_not_break_handler(self):
        """persist 抛异常时 publish_ws 已经成功，handler 仍正常返回 ok。"""
        from apps.services.common.ws.handlers.relay_handler import (
            create_relay_events_handler,
        )

        consumer = MagicMock()
        consumer.user_id = "user-42"
        wt = MagicMock()
        wt.is_member.return_value = True
        consumer.organization_ctx = wt
        from unittest.mock import AsyncMock
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()

        handler = create_relay_events_handler(consumer)

        publish_calls: list[str] = []

        def fake_publish_ws(thread_id, short, payload):
            publish_calls.append(short)

        async def fake_persist(*args, **kwargs):
            raise RuntimeError("trace writer down")

        envelope = {
            "request_id": "req-1",
            "payload": {
                "session_id": "sess-1",
                "events": [
                    {
                        "type": "agent.stream.tool",
                        "payload": {"tool_name": "bash", "trace_id": "11111111-2222-3333-4444-555555555555"},
                    },
                ],
            },
        }

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_ws",
            side_effect=fake_publish_ws,
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.persist_relay_events_to_trace",
            side_effect=fake_persist,
        ):
            await handler(envelope)
            # 给 background task 一个机会跑完（验证不冒泡）
            import asyncio
            await asyncio.sleep(0.05)

        # publish_ws 仍被调一次，handler 不抛
        assert publish_calls == ["tool"]
        # 关键：handler 仍发了 relay_events.ok（即正常返回）
        consumer._send_envelope.assert_called_once()
        sent_envelope = consumer._send_envelope.call_args.args[0]
        # envelope.type 应为 relay_events.ok
        assert sent_envelope["type"] == "relay_events.ok"


# ────────────────────────────────────────────────────────────────────
# 4. WS 双通道：trace.stream.{trace_id} publish
#    H2-A FR-10 关键完整性：useTraceStream 实时刷新依赖此通道
# ────────────────────────────────────────────────────────────────────


class TestWsDoublePublishToTraceStream:
    """relay_trace_writer 写表后必须向 `trace.stream.{trace_id}` 频道双推。

    背景（关键 bug）：
      - `ChatStreamPublisher.publish_ws` → `agent.stream.{thread_id}`（移动端 / chat UI）
      - `useTraceStream` 订阅 → `trace.stream.{trace_id}`
    两个频道完全不同，envelope.type 也不同。如果不双推，AdminDash trace-detail
    页的"实时连接"标签会亮起但 events 列表永远不刷新——欺骗性 UI。

    本类断言：
      1. 每条 TraceEvent 触发 1 次 publish_ws_event 到 trace.stream.{trace_id}
      2. envelope.type = 'trace.stream.event'（与 trace_recorder.record_event 对齐）
      3. trace_finalize 时额外推送 trace_end envelope（触发 useTraceStream.onTraceEnd）
      4. publish 失败不影响写表（异常永不冒泡）
    """

    def test_publishes_one_envelope_per_trace_event(self, mock_orm):
        """N 条 event → N 次 publish_ws_event 到 trace.stream.{trace_id}。"""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event(
                "agent.stream.tool",
                {"tool_name": f"tool_{i}", "trace_id": trace_id},
            )
            for i in range(5)
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event"
        ) as mock_pub:
            mock_pub.return_value = True
            stats = _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        assert stats["events_written"] == 5
        # 5 条 event → 5 次 publish（无 finalize 所以不额外推 trace_end）
        assert mock_pub.call_count == 5
        # 每次都推到 trace.stream.{trace_id} 频道
        for call_args in mock_pub.call_args_list:
            channel = call_args.args[0]
            envelope = call_args.args[1]
            assert channel == f"trace.stream.{trace_id}"
            assert envelope["type"] == "trace.stream.event"
            assert envelope["trace_id"] == trace_id

    def test_publishes_trace_end_on_finalize(self, mock_orm):
        """DONE event → 写完 record_event publish 后，额外推一条 trace_end."""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.assistant", {"phase": "delta", "trace_id": trace_id}),
            _make_event("agent.stream.done", {"content": "hi", "trace_id": trace_id}),
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event"
        ) as mock_pub:
            mock_pub.return_value = True
            stats = _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        assert stats["events_written"] == 2
        assert stats["traces_finalized"] == 1
        # 2 条 event publish + 1 条 trace_end publish = 3 次
        assert mock_pub.call_count == 3
        # 最后一次是 trace_end（payload.phase = 'trace_end'）
        last_call = mock_pub.call_args_list[-1]
        last_envelope = last_call.args[1]
        assert last_envelope["payload"]["phase"] == "trace_end"
        assert last_envelope["payload"]["status"] == "completed"

    def test_publishes_trace_end_with_error_status(self, mock_orm):
        """DONE(error) → trace_end envelope 携带 status='error' + error_message."""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event(
                "agent.stream.done",
                {
                    "error": True,
                    "error_message": "LLM timeout",
                    "trace_id": trace_id,
                },
            ),
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event"
        ) as mock_pub:
            mock_pub.return_value = True
            _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        assert mock_pub.call_count == 2  # 1 record_event + 1 trace_end
        trace_end_call = mock_pub.call_args_list[-1]
        payload = trace_end_call.args[1]["payload"]
        assert payload["phase"] == "trace_end"
        assert payload["status"] == "error"
        assert payload["error"] == "LLM timeout"

    def test_publish_failure_does_not_break_persist(self, mock_orm):
        """publish_ws_event 抛异常 — _persist 仍正常返回 stats（写表已成功）。"""
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash", "trace_id": trace_id}),
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event",
            side_effect=RuntimeError("Redis down"),
        ):
            # 不应该抛异常
            stats = _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        # 写表仍发生，stats 正确
        assert stats["events_written"] == 1
        assert stats["traces_created"] == 1

    def test_publish_uses_record_event_payload_shape(self, mock_orm):
        """每条 publish envelope.payload 的 shape 与 trace_recorder.record_event 对齐.

        前端 useTraceStream 用 SSETraceEvent 类型解析 payload —— 这个类型的字段
        来自 trace_recorder._publish_event(build_record_event_ws_payload(...))。
        本测试断言双通道 envelope.payload 含 trace_recorder 同名键，避免前端
        两套解析。

        实施细节：mock_orm 让 TraceEvent 类是 MagicMock，实例属性也是 MagicMock，
        所以这里只断言 build_record_event_ws_payload 写入的"键名"（phase /
        event_type / name / seq / started_at / ended_at / trace_id 全部存在）—
        不断言键的值（值是 MagicMock 不可比）。值的真实性由 _make_trace_event
        系列纯函数测试覆盖。
        """
        trace_id = "11111111-2222-3333-4444-555555555555"
        events = [
            _make_event(
                "agent.stream.tool",
                {"tool_name": "bash", "trace_id": trace_id},
            ),
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event"
        ) as mock_pub:
            mock_pub.return_value = True
            _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        assert mock_pub.call_count == 1
        envelope = mock_pub.call_args.args[1]
        payload = envelope["payload"]

        # 关键字段对齐 build_record_event_ws_payload 的输出（只断言键名存在）
        for required_key in (
            "phase", "event_id", "event_type", "name", "seq",
            "started_at", "ended_at", "trace_id", "input", "output",
        ):
            assert required_key in payload, f"missing field: {required_key}"
        # phase 是字面量 "end"（来自 build_record_event_ws_payload，不是 mock）
        assert payload["phase"] == "end"
        # trace_id 在 envelope 顶层（build_envelope 的 kwarg）也被注入
        assert envelope["trace_id"] == trace_id

    def test_no_publish_when_skipped_no_trace_id(self, mock_orm):
        """无 trace_id 的 event 不应触发任何 publish。"""
        events = [
            _make_event("agent.stream.tool", {"tool_name": "bash"}),  # 无 trace_id
        ]

        with patch(
            "apps.services.common.ws.handlers.relay_trace_writer.publish_ws_event"
        ) as mock_pub:
            mock_pub.return_value = True
            stats = _persist_relay_events_to_trace_sync(
                session_id="sess-1", thread_id="chat-session-sess-1", events=events,
            )

        assert stats["skipped_no_trace_id"] == 1
        # 无 trace 写表，自然无 publish
        mock_pub.assert_not_called()
