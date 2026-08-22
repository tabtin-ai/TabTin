"""
M3.5 relay_memory_trigger 测试

覆盖：
  1. lifecycle phase=end 触发 L2 增量提取
  2. compaction phase=start 触发 L3 快照
  3. 无相关事件不触发
  4. memory 未启用时不触发
  5. 消息不足 interval 时跳过
  6. relay_handler 中 _spawn_memory_trigger 被正确调用
"""
from __future__ import annotations

import os
import sys
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from unittest.mock import patch, MagicMock, call  # noqa: E402

from apps.services.agent_engine.tasks.memory.relay_memory_trigger import (  # noqa: E402
    dispatch_memory_trigger,
    _dispatch_impl,
    _short_name,
    _resolve_memory_ctx_from_session,
    _trigger_l2_incremental_extract,
    _trigger_l3_compaction_snapshot,
)


# ── Helpers ──

def _make_event(short: str, payload: dict | None = None) -> dict:
    return {"type": f"agent.stream.{short}", "payload": payload or {}}


def _lifecycle_end_event(run_id: str = "test-run") -> dict:
    return _make_event("lifecycle", {"phase": "end", "run_id": run_id})


def _lifecycle_start_event(run_id: str = "test-run") -> dict:
    return _make_event("lifecycle", {"phase": "start", "run_id": run_id})


def _compaction_start_event() -> dict:
    return _make_event("compaction", {"phase": "start", "mode": "auto_compact"})


def _compaction_end_event() -> dict:
    return _make_event("compaction", {"phase": "end", "mode": "auto_compact"})


def _step_event() -> dict:
    return _make_event("step", {"step_type": "thinking"})


FAKE_SESSION_ID = str(uuid.uuid4())
FAKE_THREAD_ID = f"chat-session-{FAKE_SESSION_ID}"
FAKE_USER_ID = str(uuid.uuid4())
FAKE_SPACE_ID = str(uuid.uuid4())
FAKE_AGENT_ID = str(uuid.uuid4())


def _ua_turns(n_pairs: int) -> list[dict]:
    """构造可被 _group_messages_by_agent 分账的 user/assistant 轮次。"""
    messages: list[dict] = []
    for i in range(n_pairs):
        messages.append({"role": "user", "content": f"msg{i}", "agent_id": ""})
        messages.append({
            "role": "assistant",
            "content": f"reply{i}",
            "agent_id": FAKE_AGENT_ID,
        })
    return messages


def _mock_memory_ctx(enabled=True, interval=5):
    """返回模拟的 memory context。"""
    if not enabled:
        return None
    return {
        "space_id": FAKE_SPACE_ID,
        "memory_config": {
            "observer": {
                "mode": "on",
                "incremental_interval": interval,
                "dedup_threshold": 0.85,
            },
        },
    }


# ── Tests: _short_name ──

class TestShortName:
    def test_strips_prefix(self):
        assert _short_name({"type": "agent.stream.lifecycle"}) == "lifecycle"

    def test_no_prefix(self):
        assert _short_name({"type": "lifecycle"}) == "lifecycle"

    def test_empty(self):
        assert _short_name({}) == ""


# ── Tests: dispatch detection ──

class TestDispatchDetection:
    """_dispatch_impl 正确识别触发事件。"""

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l2_incremental_extract",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l3_compaction_snapshot",
    )
    def test_lifecycle_end_triggers_l2(self, mock_l3, mock_l2):
        _dispatch_impl(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[_lifecycle_end_event()],
        )
        mock_l2.assert_called_once()
        mock_l3.assert_not_called()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l2_incremental_extract",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l3_compaction_snapshot",
    )
    def test_compaction_start_triggers_l3(self, mock_l3, mock_l2):
        _dispatch_impl(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[_compaction_start_event()],
        )
        mock_l3.assert_called_once()
        mock_l2.assert_not_called()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l2_incremental_extract",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l3_compaction_snapshot",
    )
    def test_both_lifecycle_and_compaction(self, mock_l3, mock_l2):
        _dispatch_impl(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[
                _compaction_start_event(),
                _lifecycle_end_event(),
            ],
        )
        mock_l2.assert_called_once()
        mock_l3.assert_called_once()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l2_incremental_extract",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l3_compaction_snapshot",
    )
    def test_no_trigger_events(self, mock_l3, mock_l2):
        _dispatch_impl(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[
                _step_event(),
                _lifecycle_start_event(),
                _compaction_end_event(),
            ],
        )
        mock_l2.assert_not_called()
        mock_l3.assert_not_called()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l2_incremental_extract",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._trigger_l3_compaction_snapshot",
    )
    def test_empty_events(self, mock_l3, mock_l2):
        _dispatch_impl(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[],
        )
        mock_l2.assert_not_called()
        mock_l3.assert_not_called()


# ── Tests: L2 incremental extraction ──

class TestL2IncrementalExtraction:

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
        return_value=None,
    )
    def test_skips_when_memory_disabled(self, mock_ctx):
        _trigger_l2_incremental_extract(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
        )
        mock_ctx.assert_called_once()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_skips_observer_mode_off(self, mock_ctx):
        mock_ctx.return_value = {
            "space_id": FAKE_SPACE_ID,
            "memory_config": {"observer": {"mode": "off"}},
        }
        _trigger_l2_incremental_extract(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
        )

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._is_cold_start",
        return_value=False,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._fetch_messages_from_db",
        return_value=[
            {"role": "user", "content": f"msg{i}"}
            for i in range(3)
        ],
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._get_extracted_index",
        return_value=0,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_skips_when_below_interval(
        self, mock_ctx, mock_idx, mock_fetch, mock_cold,
    ):
        mock_ctx.return_value = _mock_memory_ctx(interval=10)
        with patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".extract_memories_task",
        ) as mock_task:
            _trigger_l2_incremental_extract(
                session_id=FAKE_SESSION_ID,
                thread_id=FAKE_THREAD_ID,
                user_id=FAKE_USER_ID,
            )
            mock_task.apply_async.assert_not_called()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._is_cold_start",
        return_value=False,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._fetch_messages_from_db",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._get_extracted_index",
        return_value=0,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_submits_when_above_interval(
        self, mock_ctx, mock_idx, mock_fetch, mock_cold,
    ):
        # 6 轮 = 12 条，超过 interval=10；须带 agent_id 才能进 chord 分账
        messages = _ua_turns(6)
        mock_ctx.return_value = _mock_memory_ctx(interval=10)
        mock_fetch.return_value = messages

        with patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".extract_memories_task",
        ) as mock_extract, patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".advance_memory_index_task",
        ) as mock_advance, patch(
            "celery.chord",
        ) as mock_chord:
            mock_extract.s.return_value = MagicMock(name="sig")
            mock_advance.s.return_value = MagicMock(name="advance")
            _trigger_l2_incremental_extract(
                session_id=FAKE_SESSION_ID,
                thread_id=FAKE_THREAD_ID,
                user_id=FAKE_USER_ID,
            )
            mock_extract.s.assert_called_once()
            task_kwargs = mock_extract.s.call_args.kwargs
            assert task_kwargs["space_id"] == FAKE_SPACE_ID
            assert task_kwargs["user_id"] == FAKE_USER_ID
            assert task_kwargs["thread_id"] == FAKE_THREAD_ID
            assert task_kwargs["agent_id"] == FAKE_AGENT_ID
            mock_chord.assert_called_once()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._is_cold_start",
        return_value=True,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._fetch_messages_from_db",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._get_extracted_index",
        return_value=0,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_cold_start_lowers_interval(
        self, mock_ctx, mock_idx, mock_fetch, mock_cold,
    ):
        """冷启动时 interval 降到 min(original, 3)，4 条即可触发。"""
        messages = _ua_turns(2)  # 4 条
        mock_ctx.return_value = _mock_memory_ctx(interval=10)
        mock_fetch.return_value = messages

        with patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".extract_memories_task",
        ) as mock_extract, patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".advance_memory_index_task",
        ) as mock_advance, patch(
            "celery.chord",
        ) as mock_chord:
            mock_extract.s.return_value = MagicMock(name="sig")
            mock_advance.s.return_value = MagicMock(name="advance")
            _trigger_l2_incremental_extract(
                session_id=FAKE_SESSION_ID,
                thread_id=FAKE_THREAD_ID,
                user_id=FAKE_USER_ID,
            )
            mock_extract.s.assert_called_once()
            mock_chord.assert_called_once()


# ── Tests: L3 compaction snapshot ──

class TestL3CompactionSnapshot:

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
        return_value=None,
    )
    def test_skips_when_memory_disabled(self, mock_ctx):
        _trigger_l3_compaction_snapshot(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
        )

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._fetch_messages_from_db",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._count_messages",
        return_value=20,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._get_extracted_index",
        return_value=5,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_submits_unextracted_messages(
        self, mock_ctx, mock_idx, mock_count, mock_fetch,
    ):
        mock_ctx.return_value = _mock_memory_ctx()
        mock_fetch.return_value = _ua_turns(8)  # 16 条未抽消息
        with patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".extract_memories_task",
        ) as mock_extract, patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".advance_memory_index_task",
        ) as mock_advance, patch(
            "celery.chord",
        ) as mock_chord:
            mock_extract.s.return_value = MagicMock(name="sig")
            mock_advance.s.return_value = MagicMock(name="advance")
            _trigger_l3_compaction_snapshot(
                session_id=FAKE_SESSION_ID,
                thread_id=FAKE_THREAD_ID,
                user_id=FAKE_USER_ID,
            )
            mock_extract.s.assert_called_once()
            call_kwargs = mock_extract.s.call_args.kwargs
            assert call_kwargs["space_id"] == FAKE_SPACE_ID
            assert call_kwargs["agent_id"] == FAKE_AGENT_ID
            mock_chord.assert_called_once()

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._count_messages",
        return_value=5,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._get_extracted_index",
        return_value=5,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._resolve_memory_ctx_from_session",
    )
    def test_skips_when_all_extracted(self, mock_ctx, mock_idx, mock_count):
        mock_ctx.return_value = _mock_memory_ctx()
        with patch(
            "apps.services.agent_engine.tasks.memory.capture"
            ".extract_memories_task",
        ) as mock_extract:
            _trigger_l3_compaction_snapshot(
                session_id=FAKE_SESSION_ID,
                thread_id=FAKE_THREAD_ID,
                user_id=FAKE_USER_ID,
            )
            mock_extract.delay.assert_not_called()


# ── Tests: dispatch_memory_trigger (top-level wrapper) ──

class TestDispatchMemoryTrigger:
    """顶层 dispatch_memory_trigger 吞异常、不抛出。"""

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger"
        "._dispatch_impl",
        side_effect=RuntimeError("boom"),
    )
    def test_swallows_exceptions(self, mock_impl):
        dispatch_memory_trigger(
            session_id=FAKE_SESSION_ID,
            thread_id=FAKE_THREAD_ID,
            user_id=FAKE_USER_ID,
            accepted_events=[_lifecycle_end_event()],
        )


# ── Tests: relay_handler integration ──

class TestRelayHandlerMemoryHook:
    """验证 relay_handler 中记忆触发相关函数。"""

    def test_spawn_is_callable(self):
        from apps.services.common.ws.handlers.relay_handler import (
            _spawn_memory_trigger,
        )
        assert callable(_spawn_memory_trigger)

    def test_has_trigger_events_lifecycle(self):
        from apps.services.common.ws.handlers.relay_handler import (
            _has_memory_trigger_events,
        )
        assert _has_memory_trigger_events([_lifecycle_end_event()]) is True
        assert _has_memory_trigger_events([_lifecycle_start_event()]) is True

    def test_has_trigger_events_compaction(self):
        from apps.services.common.ws.handlers.relay_handler import (
            _has_memory_trigger_events,
        )
        assert _has_memory_trigger_events([_compaction_start_event()]) is True
        assert _has_memory_trigger_events([_compaction_end_event()]) is True

    def test_has_trigger_events_none(self):
        from apps.services.common.ws.handlers.relay_handler import (
            _has_memory_trigger_events,
        )
        assert _has_memory_trigger_events([_step_event()]) is False
        assert _has_memory_trigger_events([]) is False

    def test_has_trigger_events_mixed(self):
        from apps.services.common.ws.handlers.relay_handler import (
            _has_memory_trigger_events,
        )
        events = [
            _step_event(),
            _make_event("assistant", {"content": "hi"}),
            _lifecycle_end_event(),
        ]
        assert _has_memory_trigger_events(events) is True
