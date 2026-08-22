"""级联删除测试（PRD 4.3.B）：

    - ChatSession.post_delete → `delete_by_query(session_id)` on tabtin-messages
    - Space.post_delete → delete_by_query 清 resources / memos / messages
    - Conversation.post_delete → delete_by_query on tabtin-im
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase, override_settings

from apps.fts import signals


@override_settings(SEARCH_ENGINE_ENABLED=True)
class ChatSessionCascadeTests(SimpleTestCase):

    def test_session_delete_triggers_messages_delete_by_query(self) -> None:
        session = MagicMock(id="sess-1", organization_id="wt-1")
        with patch.object(signals, "_schedule_delete_by_query") as d:
            signals.on_chat_session_deleted(None, session)
        d.assert_called_once()
        kwargs = d.call_args.kwargs or {}
        args = d.call_args.args
        # _schedule_delete_by_query(index_alias, field, value)
        index_alias, field, value = args if args else (
            kwargs.get("index_alias"),
            kwargs.get("field"),
            kwargs.get("value"),
        )
        self.assertIn("tabtin-messages", index_alias)
        self.assertEqual(field, "session_id")
        self.assertEqual(value, "sess-1")


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SpaceCascadeTests(SimpleTestCase):

    def test_space_delete_cleans_resources_memos_messages(self) -> None:
        space = MagicMock(id="space-1", organization_id="wt-1")
        with patch.object(signals, "_schedule_delete_by_query") as d, \
             patch.object(signals, "_safe_write_outbox"), \
             patch.object(signals, "_schedule_flush"):
            signals.on_space_deleted(None, space)
        # 一次 space 自身的 delete outbox（_safe_write_outbox）+ 三次 delete_by_query
        self.assertEqual(d.call_count, 3)
        indexes_called = [call.args[0] if call.args else call.kwargs.get("index_alias") for call in d.call_args_list]
        fields_called = [call.args[1] if len(call.args) > 1 else call.kwargs.get("field") for call in d.call_args_list]
        self.assertTrue(any("resources" in i for i in indexes_called))
        self.assertTrue(any("memos" in i for i in indexes_called))
        self.assertTrue(any("messages" in i for i in indexes_called))
        self.assertTrue(all(f == "space_id" for f in fields_called))


@override_settings(SEARCH_ENGINE_ENABLED=True)
class SpaceTrashCascadeTests(SimpleTestCase):
    """R1-09 修复：Space 软删（trashed_at: None → 非 None）必须级联清
    memos / messages / resources 索引，而不仅仅是清自己。

    QC Agent 端到端复现的 BLOCKER：用户软删 Space 后用户仍能搜到该
    Space 下的 memo / message。Wave 1 原实现只在 on_space_deleted 硬删
    时级联，但 TabTin 产品有 30 天回收站 → 用户感知"已删除"=软删。
    """

    def _make_space(self, *, trashed_at=None):
        s = MagicMock(id="space-1", organization_id="wt-1")
        s.trashed_at = trashed_at
        s.is_archived = False
        return s

    def test_trash_event_triggers_cascade_delete_by_query(self) -> None:
        from datetime import datetime, timezone as _tz
        space = self._make_space(trashed_at=datetime(2026, 4, 17, tzinfo=_tz.utc))
        space._fts_old_trash = None  # pre_save 缓存的旧值：未被 trash
        with patch.object(signals, "_schedule_delete_by_query") as d, \
             patch.object(signals, "_safe_write_outbox") as w, \
             patch.object(signals, "_schedule_flush"):
            signals.on_space_saved(None, space, created=False)
        # 自身写 delete outbox（spaces 索引）
        w.assert_called_once()
        self.assertEqual(w.call_args.kwargs["action"], "delete")
        self.assertIn("tabtin-spaces", w.call_args.kwargs["index_name"])
        # 级联 3 个索引
        self.assertEqual(d.call_count, 3)
        indexes_called = [
            (c.args[0] if c.args else c.kwargs.get("index_alias")) for c in d.call_args_list
        ]
        usings = [c.kwargs.get("using") for c in d.call_args_list]
        self.assertTrue(any("resources" in i for i in indexes_called))
        self.assertTrue(any("memos" in i for i in indexes_called))
        self.assertTrue(any("messages" in i for i in indexes_called))
        self.assertTrue(all(u == "postgresql" for u in usings))

    def test_no_trash_change_does_not_cascade(self) -> None:
        """无 trashed_at 变化（None → None）不应级联。"""
        space = self._make_space(trashed_at=None)
        space._fts_old_trash = None
        with patch.object(signals, "_schedule_delete_by_query") as d, \
             patch.object(signals, "_safe_write_outbox"), \
             patch.object(signals, "_schedule_flush"):
            signals.on_space_saved(None, space, created=False)
        d.assert_not_called()

    def test_already_trashed_does_not_cascade_again(self) -> None:
        """已 trashed → 再次 save（如刷新 previous_status）不应重复级联。"""
        from datetime import datetime, timezone as _tz
        ts = datetime(2026, 4, 17, tzinfo=_tz.utc)
        space = self._make_space(trashed_at=ts)
        space._fts_old_trash = ts  # 已经在回收站
        with patch.object(signals, "_schedule_delete_by_query") as d, \
             patch.object(signals, "_safe_write_outbox"), \
             patch.object(signals, "_schedule_flush"):
            signals.on_space_saved(None, space, created=False)
        d.assert_not_called()

    def test_recovery_does_not_auto_reindex(self) -> None:
        """从回收站恢复（trashed_at: 非 None → None）不自动 reindex；
        ContextItem/Memo 各自的 signal 在它们自己被恢复时会发 upsert。"""
        from datetime import datetime, timezone as _tz
        space = self._make_space(trashed_at=None)
        space._fts_old_trash = datetime(2026, 4, 17, tzinfo=_tz.utc)  # 之前被 trash
        with patch.object(signals, "_schedule_delete_by_query") as d, \
             patch.object(signals, "_safe_write_outbox"), \
             patch.object(signals, "_schedule_flush"):
            signals.on_space_saved(None, space, created=False)
        d.assert_not_called()

    def test_created_space_no_cascade(self) -> None:
        """新建 Space 不该触发级联。"""
        space = self._make_space()
        space._fts_old_trash = None
        with patch.object(signals, "_schedule_delete_by_query") as d:
            signals.on_space_saved(None, space, created=True)
        d.assert_not_called()

    def test_pre_save_skips_irrelevant_update_fields(self) -> None:
        """pre_save 只在 update_fields 含 trashed_at/previous_status 时拉旧值。"""
        space = self._make_space()
        space.pk = "space-1"
        sender = MagicMock()
        signals.on_space_pre_save(
            sender, space, update_fields=["last_activity_at"],
        )
        sender.objects.filter.assert_not_called()
        self.assertIsNone(space._fts_old_trash)

    def test_pre_save_reads_when_trash_in_update_fields(self) -> None:
        space = self._make_space()
        space.pk = "space-1"
        sender = MagicMock()
        sender.objects.filter.return_value.values.return_value.first.return_value = {
            "trashed_at": None,
        }
        signals.on_space_pre_save(
            sender, space, update_fields=["trashed_at"],
        )
        sender.objects.filter.assert_called()


@override_settings(SEARCH_ENGINE_ENABLED=True)
class ConversationCascadeTests(SimpleTestCase):

    def test_conversation_delete_cleans_im(self) -> None:
        conv = MagicMock(id="conv-1")
        with patch.object(signals, "_schedule_delete_by_query") as d:
            signals.on_conversation_deleted(None, conv)
        d.assert_called_once()
        kwargs = d.call_args.kwargs or {}
        args = d.call_args.args
        index_alias, field, value = args if args else (
            kwargs.get("index_alias"),
            kwargs.get("field"),
            kwargs.get("value"),
        )
        self.assertIn("tabtin-im", index_alias)
        self.assertEqual(field, "conversation_id")
        self.assertEqual(value, "conv-1")


@override_settings(SEARCH_ENGINE_ENABLED=False)
class DisabledFlagSkipsCascadeTests(SimpleTestCase):

    def test_session_delete_noop_when_disabled(self) -> None:
        session = MagicMock(id="sess-1")
        with patch.object(signals, "_schedule_delete_by_query") as d:
            signals.on_chat_session_deleted(None, session)
        d.assert_not_called()
