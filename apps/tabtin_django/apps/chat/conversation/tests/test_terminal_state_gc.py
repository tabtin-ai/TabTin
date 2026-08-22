"""终端"假运行"诚实降级 Layer 3（终端假运行根治 v3 §5 / 失败模式 F14）回归测试。

两层覆盖：
  1. 纯逻辑（无 DB，``TestTerminalStateGCPureLogic``）——判定阈值如何避免误杀长跑、
     标记字段形态、幂等、判别守门。
  2. DB 集成（``@pytest.mark.django_db``，``TestMarkStaleRunningTerminals``）——真建
     ChatMessage（含 running 终端快照）跑 ``mark_stale_running_terminals_impl``，
     验证超 hard_timeout 才被标 unknown、几小时长跑不误标、幂等。
"""

import json
from datetime import datetime, timedelta, timezone as dt_timezone

import pytest
from django.test import SimpleTestCase
from django.contrib.auth import get_user_model
from django.utils import timezone

from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.chat.conversation.terminal_state_gc import (
    DEFAULT_HARD_TIMEOUT_MS,
    apply_unknown_marks,
    build_unknown_terminal_content,
    mark_stale_running_terminals_impl,
    parse_terminal_running_content,
    running_terminal_is_stale,
)

User = get_user_model()

_NOW = datetime(2026, 5, 31, 12, 0, 0, tzinfo=dt_timezone.utc)


def _running_content(**extra):
    content = {
        "status": "running",
        "session_id": "agent-space1-123",
        "pid": 4242,
        "stdout_tail": "compiling...\n",
        "stdout_byte_count": 12,
        "elapsed_ms": 60000,
        "output_file": "/tmp/tabtin-agent-tasks/agent-space1-123.log",
        "command": "pnpm dev",
        "cwd": "/work",
    }
    content.update(extra)
    return content


def _running_blocks(**extra):
    return [
        {"type": "tool_use", "id": "tc:0", "name": "run_terminal_command"},
        {"type": "tool_result", "tool_use_id": "tc:0",
         "content": json.dumps(_running_content(**extra))},
    ]


class TestTerminalStateGCPureLogic(SimpleTestCase):
    """纯函数：不建测试库，钉死判定阈值 / 标记形态 / 幂等 / 守门。"""

    def test_three_hour_dev_server_not_marked(self):
        # §8.8 不误杀长跑：几小时 dev server 远未到 12h → 不标
        created = _NOW - timedelta(hours=3)
        blocks = _running_blocks()
        new_blocks, marked = apply_unknown_marks(
            blocks, message_created_at=created, now=_NOW,
        )
        assert marked == 0
        assert new_blocks is blocks

    def test_stale_running_marked_unknown(self):
        created = _NOW - timedelta(hours=13)
        new_blocks, marked = apply_unknown_marks(
            _running_blocks(), message_created_at=created, now=_NOW,
        )
        assert marked == 1
        out = json.loads(new_blocks[1]["content"])
        assert out["status"] == "unknown"
        assert out["terminal_state_unknown"] is True
        assert out["unknown_reason"] == "stale_no_terminal_state"
        # unknown_reason 不含 "running" 子串，避免被 candidate LIKE 预筛每轮重复选中
        assert "running" not in out["unknown_reason"]
        assert out["hard_timeout_ms"] == DEFAULT_HARD_TIMEOUT_MS
        assert out["session_id"] == "agent-space1-123"
        assert out["output_file"].endswith(".log")
        assert out["stdout"] == "compiling...\n"  # 补 stdout = stdout_tail
        assert "_terminal_update" not in out      # DB 直改不走 relay supersede

    def test_larger_per_block_hard_timeout_protects_long_task(self):
        # 24h per-block 阈值（前向兼容；当前 running envelope 尚不带，未来 Layer 2 补）
        created_13h = _NOW - timedelta(hours=13)
        _, m1 = apply_unknown_marks(
            _running_blocks(hard_timeout_ms=24 * 60 * 60 * 1000),
            message_created_at=created_13h, now=_NOW,
        )
        assert m1 == 0  # 13h < 24h → 受保护不标
        created_25h = _NOW - timedelta(hours=25)
        nb, m2 = apply_unknown_marks(
            _running_blocks(hard_timeout_ms=24 * 60 * 60 * 1000),
            message_created_at=created_25h, now=_NOW,
        )
        assert m2 == 1
        assert json.loads(nb[1]["content"])["hard_timeout_ms"] == 24 * 60 * 60 * 1000

    def test_idempotent(self):
        created = _NOW - timedelta(hours=13)
        nb, m1 = apply_unknown_marks(_running_blocks(), message_created_at=created, now=_NOW)
        assert m1 == 1
        _, m2 = apply_unknown_marks(nb, message_created_at=created, now=_NOW)
        assert m2 == 0

    def test_parse_guards(self):
        assert parse_terminal_running_content({"type": "text", "text": "running"}) is None
        assert parse_terminal_running_content(
            {"type": "tool_result", "tool_use_id": "x", "content": "{bad json running"}
        ) is None
        # running 但缺 session_id → 非终端 running
        assert parse_terminal_running_content(
            {"type": "tool_result", "tool_use_id": "x",
             "content": json.dumps({"status": "running"})}
        ) is None
        # completed 终态不是 running
        assert parse_terminal_running_content(
            {"type": "tool_result", "tool_use_id": "x",
             "content": json.dumps({"status": "completed", "session_id": "s"})}
        ) is None
        assert parse_terminal_running_content(_running_blocks()[1]) is not None

    def test_missing_created_at_conservative(self):
        assert running_terminal_is_stale(
            _running_content(), message_created_at=None, now=_NOW,
        ) is False

    def test_build_unknown_preserves_existing_stdout(self):
        content = _running_content(stdout="explicit", stdout_tail="tail")
        out = build_unknown_terminal_content(
            content, now=_NOW, applied_hard_timeout_ms=DEFAULT_HARD_TIMEOUT_MS,
        )
        assert out["stdout"] == "explicit"  # 已有 stdout 不被 stdout_tail 覆盖


@pytest.mark.django_db
class TestMarkStaleRunningTerminals:
    """DB 集成：真建 ChatMessage 跑 impl，验证 created_at 锚点 + 阈值 + 幂等。"""

    def _make_message(self, *, created_at, blocks, role="assistant"):
        session = ChatSession.objects.create(
            user=self.user, organization_id="wt-test", title="x",
        )
        msg = ChatMessage.objects.create(
            session=session, role=role, content_blocks_json=blocks,
            message_kind="llm",
        )
        # created_at 是 auto_now_add，需用 update 改成测试需要的锚点
        ChatMessage.objects.filter(id=msg.id).update(created_at=created_at)
        return ChatMessage.objects.get(id=msg.id)

    def setup_method(self):
        self.user = User.objects.create(username="t3", email="t3@example.com")

    def test_marks_stale_running_to_unknown(self):
        now = timezone.now()
        msg = self._make_message(
            created_at=now - timedelta(hours=13), blocks=_running_blocks(),
        )
        result = mark_stale_running_terminals_impl(now=now)
        assert result["marked_messages"] == 1
        assert result["marked_blocks"] == 1
        msg.refresh_from_db()
        out = json.loads(msg.content_blocks_json[1]["content"])
        assert out["status"] == "unknown"
        assert out["terminal_state_unknown"] is True

    def test_does_not_mark_recent_running(self):
        now = timezone.now()
        msg = self._make_message(
            created_at=now - timedelta(hours=3), blocks=_running_blocks(),
        )
        result = mark_stale_running_terminals_impl(now=now)
        assert result["marked_messages"] == 0
        msg.refresh_from_db()
        out = json.loads(msg.content_blocks_json[1]["content"])
        assert out["status"] == "running"  # 长跑未误杀

    def test_idempotent_second_run_noop(self):
        now = timezone.now()
        self._make_message(
            created_at=now - timedelta(hours=13), blocks=_running_blocks(),
        )
        first = mark_stale_running_terminals_impl(now=now)
        assert first["marked_messages"] == 1
        second = mark_stale_running_terminals_impl(now=now)
        assert second["marked_messages"] == 0

    def test_user_role_message_ignored(self):
        now = timezone.now()
        self._make_message(
            created_at=now - timedelta(hours=13), blocks=_running_blocks(), role="user",
        )
        result = mark_stale_running_terminals_impl(now=now)
        # 终端 running 快照只 merge 进 assistant；user 角色不在扫描范围
        assert result["marked_messages"] == 0

    def test_late_real_terminal_state_supersedes_unknown(self):
        """可逆性回归（跨模块）：GC 标 unknown 后，真·终态经 relay supersede 仍能覆盖。

        这是 Layer 3 的核心安全属性——unknown 是"诚实兜底"而非"卡死终点"：若 host
        恢复 / relay 重投把真终态送达，必须能盖掉 unknown，不能永久停在 unknown。
        """
        from apps.services.common.ws.handlers.relay_message_writer import (
            _merge_tool_result_block_into_message,
        )

        now = timezone.now()
        msg = self._make_message(
            created_at=now - timedelta(hours=13), blocks=_running_blocks(),
        )
        assert mark_stale_running_terminals_impl(now=now)["marked_messages"] == 1
        msg.refresh_from_db()
        assert json.loads(msg.content_blocks_json[1]["content"])["status"] == "unknown"

        # 真·终态迟到（带 _terminal_update + 同 session_id + 同 tool_use_id）。
        late_terminal = {
            "type": "tool_result",
            "tool_use_id": "tc:0",
            "content": json.dumps({
                "status": "completed",
                "session_id": "agent-space1-123",
                "exit_code": 0,
                "exited_by": "normal_exit",
                "command": "pnpm dev",
                "_terminal_update": True,
            }),
        }
        ok = _merge_tool_result_block_into_message(
            matched=msg,
            tr_block=late_terminal,
            tool_use_id="tc:0",
            session_id=str(msg.session_id),
        )
        assert ok is True
        msg.refresh_from_db()
        out = json.loads(msg.content_blocks_json[1]["content"])
        # unknown 被真·终态覆盖——没有卡死
        assert out["status"] == "completed"
        assert out["exit_code"] == 0
        assert "terminal_state_unknown" not in out
