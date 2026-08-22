"""Runtime → Django relay 的用户可见事件注册契约。

这些事件由 ``@tabtin/agent-runtime`` / ``@tabtin/agent-host`` 产生，Electron
本机 IPC 会直接消费；Django registry 若漏项，远端 mobile/web observer 会在
``relay_handler`` 的 ``event_not_allowed`` 分支被静默跳过。
"""

from apps.services.common.agent_protocol.constants import (
    AgentStreamEvent,
    EXCLUDED_FROM_TRACE,
    RELAY_ALLOWED_SHORT_NAMES,
)


PUBLIC_RUNTIME_UI_EVENTS = frozenset({
    AgentStreamEvent.PLAN_PROPOSAL,
    AgentStreamEvent.MODE_SWITCH_PROPOSAL,
    AgentStreamEvent.MESSAGE_QUEUED,
    AgentStreamEvent.MESSAGE_DEQUEUED,
    AgentStreamEvent.SUBAGENT_STREAM_EVENT,
})


def test_public_runtime_ui_events_are_relay_allowed() -> None:
    assert PUBLIC_RUNTIME_UI_EVENTS <= RELAY_ALLOWED_SHORT_NAMES


def test_only_high_frequency_subagent_stream_skips_trace_persistence() -> None:
    assert AgentStreamEvent.SUBAGENT_STREAM_EVENT in EXCLUDED_FROM_TRACE
    assert (
        PUBLIC_RUNTIME_UI_EVENTS - {AgentStreamEvent.SUBAGENT_STREAM_EVENT}
    ).isdisjoint(EXCLUDED_FROM_TRACE)


def test_persist_message_skips_trace_persistence_but_stays_relay_allowed() -> None:
    """#8836：persist_message 落 ChatMessage，但不进 ExecutionTrace。"""
    assert AgentStreamEvent.PERSIST_MESSAGE in RELAY_ALLOWED_SHORT_NAMES
    assert AgentStreamEvent.PERSIST_MESSAGE in EXCLUDED_FROM_TRACE


def test_llm_usage_is_relay_allowed_and_trace_persisted() -> None:
    """#10608：iteration usage 走 detail TraceEvent，不能被 relay 白名单挡掉。"""

    assert AgentStreamEvent.LLM_USAGE in RELAY_ALLOWED_SHORT_NAMES
    assert AgentStreamEvent.LLM_USAGE not in EXCLUDED_FROM_TRACE


def test_rewind_remains_an_internal_transcript_marker() -> None:
    """rewind 只写本地 messages.jsonl，不应成为跨端 UI 直播事件。"""

    assert "rewind" not in RELAY_ALLOWED_SHORT_NAMES
