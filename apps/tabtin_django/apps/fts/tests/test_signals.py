"""signal handler 行为测试（PRD 4.3.A）。

覆盖：
    - SEARCH_ENGINE_ENABLED=false → 不写 outbox
    - SEARCH_ENGINE_ENABLED=true → 写 outbox 到正确库
    - transaction.on_commit 生效（事务回滚不 flush）
    - post_delete 写 action='delete'
    - ChatMessage role='system' 被过滤（不写 outbox）
    - ContextItem.trashed_at 非空时写 delete 而非 upsert

所有测试用 mock instance + patch `write_outbox` / `flush_outbox_task`，
不触碰真实 DB（与 Wave 0 一致）。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.fts import signals


def _make_message(role="user"):
    msg = MagicMock()
    msg.id = "msg-1"
    msg.role = role
    session = MagicMock()
    session.organization_id = "wt-1"
    msg.session = session
    return msg


@override_settings(SEARCH_ENGINE_ENABLED=False)
class DisabledEngineTests(SimpleTestCase):
    """flag=false 时所有 handler 都必须 return，不写 outbox。"""

    def test_chat_message_saved_no_op(self) -> None:
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_chat_message_saved(None, _make_message(), created=True)
        wm.assert_not_called()
        fl.assert_not_called()

    def test_chat_message_deleted_no_op(self) -> None:
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_chat_message_deleted(None, _make_message())
        wm.assert_not_called()
        fl.assert_not_called()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class EnabledEngineTests(SimpleTestCase):

    def test_chat_message_saved_writes_outbox(self) -> None:
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_chat_message_saved(None, _make_message(), created=True)
        wm.assert_called_once()
        call_kwargs = wm.call_args.kwargs
        self.assertEqual(call_kwargs["db"], "default")
        self.assertEqual(call_kwargs["action"], "upsert")
        self.assertEqual(call_kwargs["doc_id"], "msg-1")
        self.assertEqual(call_kwargs["organization_id"], "wt-1")
        self.assertIn("tabtin-messages", call_kwargs["index_name"])
        fl.assert_called_once_with("default")

    def test_chat_message_deleted_writes_delete_action(self) -> None:
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_chat_message_deleted(None, _make_message())
        self.assertEqual(wm.call_args.kwargs["action"], "delete")
        fl.assert_called_once_with("default")

    def test_chat_message_system_role_filtered(self) -> None:
        """role='system' 不索引（PRD 3.8.B）。"""
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_chat_message_saved(None, _make_message(role="system"), created=True)
        wm.assert_not_called()
        fl.assert_not_called()

    def test_context_item_trashed_writes_delete(self) -> None:
        """ContextItem.trashed_at 非空时应写 delete action。"""
        item = MagicMock()
        item.id = "item-1"
        from datetime import datetime, timezone as _tz
        item.trashed_at = datetime(2026, 4, 17, tzinfo=_tz.utc)
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        item.workspace = workspace
        item.project = None
        with patch.object(signals, "_safe_write_outbox") as wm, \
             patch.object(signals, "_schedule_flush") as fl:
            signals.on_context_item_saved(None, item, created=False)
        self.assertEqual(wm.call_args.kwargs["action"], "delete")
        self.assertEqual(wm.call_args.kwargs["db"], "postgresql")
        fl.assert_called_once_with("postgresql")

    def test_context_item_active_writes_upsert(self) -> None:
        item = MagicMock()
        item.id = "item-1"
        item.trashed_at = None
        workspace = MagicMock()
        workspace.organization_id = "wt-1"
        item.workspace = workspace
        item.project = None
        with patch.object(signals, "_safe_write_outbox") as wm:
            signals.on_context_item_saved(None, item, created=False)
        self.assertEqual(wm.call_args.kwargs["action"], "upsert")

    def test_agent_saved_routes_to_pg(self) -> None:
        agent = MagicMock()
        agent.id = "agent-1"
        agent.is_active = True
        agent.organization_id = "wt-1"
        with patch.object(signals, "_safe_write_outbox") as wm:
            signals.on_agent_saved(None, agent, created=True)
        self.assertEqual(wm.call_args.kwargs["db"], "postgresql")
        self.assertIn("tabtin-agents", wm.call_args.kwargs["index_name"])

    def test_agent_inactive_writes_delete(self) -> None:
        agent = MagicMock()
        agent.id = "agent-1"
        agent.is_active = False
        agent.organization_id = "wt-1"
        with patch.object(signals, "_safe_write_outbox") as wm:
            signals.on_agent_saved(None, agent, created=False)
        self.assertEqual(wm.call_args.kwargs["action"], "delete")

    def test_memo_saved_routes_to_pg(self) -> None:
        from datetime import datetime, timezone as _tz
        memo = MagicMock()
        memo.id = "memo-1"
        memo.status = "active"
        memo.trashed_at = None
        memo.organization_id = "wt-1"
        with patch.object(signals, "_safe_write_outbox") as wm:
            signals.on_memo_saved(None, memo, created=True)
        self.assertEqual(wm.call_args.kwargs["db"], "postgresql")
        self.assertEqual(wm.call_args.kwargs["action"], "upsert")

    def test_memo_archived_writes_delete(self) -> None:
        memo = MagicMock()
        memo.id = "memo-1"
        memo.status = "archived"
        memo.trashed_at = None
        memo.organization_id = "wt-1"
        with patch.object(signals, "_safe_write_outbox") as wm:
            signals.on_memo_saved(None, memo, created=False)
        self.assertEqual(wm.call_args.kwargs["action"], "delete")


@override_settings(SEARCH_ENGINE_ENABLED=True)
class TransactionOnCommitBehaviourTests(SimpleTestCase):
    """验证 `_schedule_flush` 真的走 `transaction.on_commit`。"""

    def test_schedule_flush_invokes_on_commit(self) -> None:
        with patch("apps.fts.signals.transaction") as txn, \
             patch("apps.fts.tasks.flush_outbox_task") as fl:
            signals._schedule_flush("default")
        txn.on_commit.assert_called_once()
        _, kwargs = txn.on_commit.call_args
        self.assertEqual(kwargs.get("using"), "default")

    def test_schedule_delete_by_query_invokes_on_commit(self) -> None:
        with patch("apps.fts.signals.transaction") as txn, \
             patch("apps.fts.tasks.delete_by_query_task"):
            signals._schedule_delete_by_query("tabtin-messages", "session_id", "s-1")
        txn.on_commit.assert_called_once()

    def test_schedule_delete_by_query_skips_none_value(self) -> None:
        with patch("apps.fts.signals.transaction") as txn:
            signals._schedule_delete_by_query("tabtin-messages", "session_id", None)
        txn.on_commit.assert_not_called()

    def test_schedule_update_by_query_skips_empty_partial(self) -> None:
        with patch("apps.fts.signals.transaction") as txn:
            signals._schedule_update_by_query("tabtin-messages", "session_id", "s-1", {})
        txn.on_commit.assert_not_called()
