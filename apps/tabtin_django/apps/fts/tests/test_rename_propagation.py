"""改名 / 状态传播测试（R0-08）：

    - ChatSession.title 变更 → tabtin-messages update_by_query
    - ChatSession.status 变更 → session_status 刷新
    - ChatSession.revert_state_index 变更 → 刷新
    - 未变更时不触发（避免无效请求）
    - Conversation.name 变更 → tabtin-im update_by_query
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.fts import signals


def _make_session(title="old title", status="active", revert_state_index=None):
    session = MagicMock()
    session.pk = "sess-1"
    session.id = "sess-1"
    session.title = title
    session.status = status
    session.revert_state_index = revert_state_index
    session._fts_old_snapshot = None
    return session


def _prime_old_snapshot(session, **fields):
    """模拟 pre_save 运行后留下的快照。"""
    session._fts_old_snapshot = fields


@override_settings(SEARCH_ENGINE_ENABLED=True)
class ChatSessionTitleRenameTests(SimpleTestCase):

    def test_title_change_triggers_update_by_query(self) -> None:
        session = _make_session(title="new title")
        _prime_old_snapshot(session, title="old title", status="active", revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        uq.assert_called_once()
        kwargs = uq.call_args.kwargs or {}
        args = uq.call_args.args
        # 兼容 args / kwargs 调用方式
        index_alias, field, value, partial = args if args else (
            kwargs.get("index_alias"),
            kwargs.get("field"),
            kwargs.get("value"),
            kwargs.get("partial_doc"),
        )
        self.assertIn("tabtin-messages", index_alias)
        self.assertEqual(field, "session_id")
        self.assertEqual(value, "sess-1")
        self.assertEqual(partial, {"session_title": "new title"})

    def test_title_unchanged_no_update(self) -> None:
        session = _make_session(title="same")
        _prime_old_snapshot(session, title="same", status="active", revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        uq.assert_not_called()

    def test_none_to_empty_string_is_noop(self) -> None:
        """2026-04-17 修复：MySQL NULL → Django values() 返回 None，但新
        instance 用 `title or ""` 规范为空串。None != "" 的假变动必须
        被归一化为 noop，避免每次 `update_last_message_time` 触发无效
        update_by_query。"""
        session = _make_session(title="", status="")
        _prime_old_snapshot(session, title=None, status=None, revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        uq.assert_not_called()

    def test_empty_to_none_is_noop(self) -> None:
        """对称测试：old='' → new=None 也应归一化为 noop。"""
        session = _make_session()
        session.title = None
        session.status = None
        _prime_old_snapshot(session, title="", status="", revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        uq.assert_not_called()

    def test_status_change_triggers_update(self) -> None:
        session = _make_session(status="archived")
        _prime_old_snapshot(session, title="x", status="active", revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        # session.title 在 old 里是 "x" 而新值是 "old title"（fixture 默认），所以
        # 同时会触发 title + status；验证 partial 含 status 即可
        partial = (uq.call_args.args[-1] if uq.call_args.args else
                   uq.call_args.kwargs.get("partial_doc"))
        self.assertIn("session_status", partial)
        self.assertEqual(partial["session_status"], "archived")

    def test_revert_state_index_change_triggers_update(self) -> None:
        session = _make_session(revert_state_index=10)
        _prime_old_snapshot(session, title="x", status="active", revert_state_index=None)
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        partial = (uq.call_args.args[-1] if uq.call_args.args else
                   uq.call_args.kwargs.get("partial_doc"))
        self.assertEqual(partial["session_revert_state_index"], 10)

    def test_created_session_does_not_propagate(self) -> None:
        """新建 session 没有消息文档，无需 update_by_query。"""
        session = _make_session(title="new")
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=True)
        uq.assert_not_called()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class ConversationRenameTests(SimpleTestCase):

    def test_conversation_rename_triggers_update(self) -> None:
        conv = MagicMock()
        conv.pk = "conv-1"
        conv.id = "conv-1"
        conv.name = "new team name"
        conv._fts_old_snapshot = {"name": "old team"}
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_conversation_saved(None, conv, created=False)
        uq.assert_called_once()
        partial = (uq.call_args.args[-1] if uq.call_args.args else
                   uq.call_args.kwargs.get("partial_doc"))
        self.assertEqual(partial, {"conversation_name": "new team name"})

    def test_conversation_name_unchanged_no_update(self) -> None:
        conv = MagicMock()
        conv.pk = "conv-1"
        conv.id = "conv-1"
        conv.name = "same"
        conv._fts_old_snapshot = {"name": "same"}
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_conversation_saved(None, conv, created=False)
        uq.assert_not_called()


@override_settings(SEARCH_ENGINE_ENABLED=False)
class DisabledFlagSkipsPropagationTests(SimpleTestCase):

    def test_title_change_skipped_when_flag_off(self) -> None:
        session = _make_session(title="new")
        _prime_old_snapshot(session, title="old")
        with patch.object(signals, "_schedule_update_by_query") as uq:
            signals.on_chat_session_saved(None, session, created=False)
        uq.assert_not_called()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class PreSaveUpdateFieldsOptimizationTests(SimpleTestCase):
    """R1-07 修复：pre_save 只在 sync 字段可能变时才查旧 snapshot。"""

    def test_last_message_at_only_update_skips_snapshot_read(self) -> None:
        """`update_last_message_time()` 用 update_fields=['last_message_at']；
        应跳过 snapshot SELECT。"""
        session = _make_session()
        sender = MagicMock()
        signals.on_chat_session_pre_save(
            sender, session, update_fields=["last_message_at"],
        )
        sender.objects.filter.assert_not_called()
        self.assertIsNone(getattr(session, "_fts_old_snapshot", "unset"))

    def test_title_in_update_fields_does_read_snapshot(self) -> None:
        session = _make_session()
        sender = MagicMock()
        sender.objects.filter.return_value.values.return_value.first.return_value = {
            "title": "old",
            "status": "active",
            "revert_state_index": None,
        }
        signals.on_chat_session_pre_save(
            sender, session, update_fields=["title"],
        )
        sender.objects.filter.assert_called_once()

    def test_no_update_fields_reads_snapshot(self) -> None:
        """update_fields=None（常规 .save()）仍保持原行为（查 snapshot）。"""
        session = _make_session()
        sender = MagicMock()
        sender.objects.filter.return_value.values.return_value.first.return_value = {
            "title": "x", "status": "active", "revert_state_index": None,
        }
        signals.on_chat_session_pre_save(sender, session)
        sender.objects.filter.assert_called_once()
