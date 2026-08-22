"""#5430：relay_llm_snapshot_writer 单测——快照落库幂等 + 体积兜底 + spawn 池。"""
from __future__ import annotations

import pytest

from apps.chat.conversation.models import ChatLLMSnapshot
from apps.services.common.ws.handlers.relay_llm_snapshot_writer import (
    _cap_snapshot_size,
    _persist_llm_snapshot,
)


def _payload(**overrides):
    base = {
        "runId": "run-1",
        "iteration": 0,
        "model": "claude-x",
        "system": {"sections": [{"name": "core", "contentPreview": "sys"}], "charCount": 3},
        "messages": [{"role": "user", "contentPreview": "hi", "charCount": 2}],
        "messageCount": 1,
        "tools": [{"name": "shell", "inputSchema": {"type": "object"}}],
        "toolCount": 1,
    }
    base.update(overrides)
    return base


@pytest.mark.django_db
class TestPersistLlmSnapshot:
    def test_writes_snapshot_row(self):
        _persist_llm_snapshot("sess-1", "chat-session-sess-1", _payload())

        row = ChatLLMSnapshot.objects.get(session_id="sess-1", run_id="run-1", iteration=0)
        assert row.model == "claude-x"
        assert row.thread_id == "chat-session-sess-1"
        assert row.snapshot_json["toolCount"] == 1

    def test_upsert_same_call_key_overwrites(self):
        _persist_llm_snapshot("sess-1", "t", _payload())
        _persist_llm_snapshot("sess-1", "t", _payload(model="claude-y"))

        rows = ChatLLMSnapshot.objects.filter(session_id="sess-1", run_id="run-1")
        assert rows.count() == 1
        assert rows.first().model == "claude-y"

    def test_drops_snapshot_without_run_id(self):
        _persist_llm_snapshot("sess-1", "t", {"iteration": 0, "model": "m"})
        assert ChatLLMSnapshot.objects.filter(session_id="sess-1").count() == 0

    def test_different_iterations_are_separate_rows(self):
        _persist_llm_snapshot("sess-1", "t", _payload(iteration=0))
        _persist_llm_snapshot("sess-1", "t", _payload(iteration=1))
        assert ChatLLMSnapshot.objects.filter(session_id="sess-1").count() == 2


class TestCapSnapshotSize:
    def test_normal_snapshot_passthrough(self):
        payload = _payload()
        assert _cap_snapshot_size(payload) is payload

    def test_oversize_snapshot_drops_details(self):
        payload = _payload(messages=[{"role": "user", "contentPreview": "x" * 1_000_000}])
        capped = _cap_snapshot_size(payload)
        assert capped["truncated_in_server"] is True
        assert "messages" not in capped
        assert capped["runId"] == "run-1"
