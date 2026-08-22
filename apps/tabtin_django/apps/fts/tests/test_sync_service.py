"""`apps.fts.services.sync_service` 的 6 个 to_document 字段级测试。

测试策略（与 Wave 0 一致）：
    - 用 `MagicMock()` 模拟业务 instance 避免触碰 DB（TabTin 历史约定
      `SimpleTestCase + mock`；SQLite 测试库无法 apply 其他 app 的
      PG-only migrations）
    - 对照 PRD 4.4 / 4.5 / 3.8 的 mapping 字段逐一断言
    - should_index_* 的边界：trashed / is_deleted / role='system' 等
"""

from __future__ import annotations

from datetime import datetime, timezone as _tz
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.fts.services import sync_service


_FAKE_SPACE_ID = "11111111-1111-1111-1111-111111111111"
_FAKE_AGENT_ID = "22222222-2222-2222-2222-222222222222"


def _make_chat_message(**overrides):
    """返回一个可通过 to_message_document 的 ChatMessage mock。"""
    created_at = overrides.pop("created_at", datetime(2026, 4, 17, 12, 0, tzinfo=_tz.utc))
    mock = MagicMock(name="ChatMessage")
    mock.id = overrides.get("id", "msg-uuid-1")
    mock.role = overrides.get("role", "user")
    mock.content = overrides.get("content", "你好 Python 性能")
    mock.text_summary = overrides.get("content", "你好 Python 性能")
    mock.sender_user_id = overrides.get("sender_user_id", "user-123")
    mock.created_at = created_at
    mock.session_id = overrides.get("session_id", "sess-1")
    mock.checkpoint_state_index = overrides.get("checkpoint_state_index", None)
    mock.agent_id = overrides.get("message_agent_id", None)

    session = MagicMock(name="ChatSession")
    session.organization_id = overrides.get("organization_id", "wt-1")
    session.workspace_id = overrides.get("space_id", _FAKE_SPACE_ID)
    session.space_id = None
    session.agent_id = overrides.get("session_agent_id", _FAKE_AGENT_ID)
    session.title = overrides.get("session_title", "Python 性能优化")
    session.status = overrides.get("session_status", "active")
    session.revert_state_index = overrides.get("revert_state_index", None)

    mock.session = session
    return mock


class ToMessageDocumentTests(SimpleTestCase):
    """PRD 4.4：消息 mapping 的字段对照。"""

    def test_user_message_creator_type(self) -> None:
        msg = _make_chat_message(role="user")
        doc = sync_service.to_message_document(msg)
        assert doc is not None
        self.assertEqual(doc["role"], "user")
        self.assertEqual(doc["creator_type"], "user")
        self.assertEqual(doc["content"], "你好 Python 性能")
        self.assertEqual(doc["session_title"], "Python 性能优化")
        self.assertIsNone(doc["agent_id"])
        self.assertEqual(doc["organization_id"], "wt-1")
        # ADR-16：死字段 message_index_in_session 已移除
        self.assertNotIn("message_index_in_session", doc)

    def test_assistant_message_creator_type_agent(self) -> None:
        actual_agent_id = "33333333-3333-3333-3333-333333333333"
        msg = _make_chat_message(
            role="assistant",
            message_agent_id=actual_agent_id,
            session_agent_id=_FAKE_AGENT_ID,
        )
        doc = sync_service.to_message_document(msg)
        self.assertEqual(doc["creator_type"], "agent")
        self.assertEqual(doc["agent_id"], actual_agent_id)

    def test_system_message_skipped(self) -> None:
        msg = _make_chat_message(role="system")
        doc = sync_service.to_message_document(msg)
        self.assertIsNone(doc, msg="system 消息不应索引")

    def test_tool_message_skipped(self) -> None:
        msg = _make_chat_message(role="tool")
        self.assertIsNone(sync_service.to_message_document(msg))

    def test_revert_state_index_present_only_when_set(self) -> None:
        msg_nil = _make_chat_message(revert_state_index=None)
        msg_set = _make_chat_message(revert_state_index=5)
        doc_nil = sync_service.to_message_document(msg_nil)
        doc_set = sync_service.to_message_document(msg_set)
        self.assertNotIn("session_revert_state_index", doc_nil)
        self.assertEqual(doc_set["session_revert_state_index"], 5)

    def test_optional_fields_omitted_when_missing(self) -> None:
        """R0-08：未填 tool_call_summary / tool_names 不应写入（strict 允许字段缺省）。

        2026-04-17 QC 后补充：message_index_in_session 死字段也必须不写入
        （ADR-16），避免触发 strict_dynamic_mapping_exception。
        """
        msg = _make_chat_message()
        doc = sync_service.to_message_document(msg)
        self.assertNotIn("tool_call_summary", doc)
        self.assertNotIn("tool_names", doc)
        # ADR-16
        self.assertNotIn("message_index_in_session", doc)
        # checkpoint_state_index 默认 None → 也省略
        self.assertNotIn("checkpoint_state_index", doc)

    def test_checkpoint_state_index_present_only_when_set(self) -> None:
        """ADR-16：assistant 产 checkpoint 时 ChatMessage.checkpoint_state_index 非 None，
        Wave 2 用此字段做回滚消息过滤。"""
        msg_with = _make_chat_message(role="assistant", checkpoint_state_index=42)
        msg_without = _make_chat_message(role="assistant", checkpoint_state_index=None)
        doc_with = sync_service.to_message_document(msg_with)
        doc_without = sync_service.to_message_document(msg_without)
        self.assertEqual(doc_with["checkpoint_state_index"], 42)
        self.assertNotIn("checkpoint_state_index", doc_without)


class ToResourceDocumentTests(SimpleTestCase):
    """PRD 4.5：resources mapping 字段对照 + D4。"""

    def _make_item(self, **overrides):
        mock = MagicMock(name="ContextItem")
        mock.id = overrides.get("id", "item-1")
        mock.item_type = overrides.get("item_type", "tabdoc")
        mock.title = overrides.get("title", "会议纪要")
        mock.preview = overrides.get("preview", "这是一段预览文本")
        mock.resource_id = overrides.get("resource_id", "res-1")
        mock.workspace_id = overrides.get("space_id", "space-1")
        mock.project_id = None
        # ：显式 None，避免 MagicMock 自动生成假 organization_id
        mock.organization_id = overrides.get("item_organization_id", None)
        mock.is_archived = overrides.get("is_archived", False)
        mock.trashed_at = overrides.get("trashed_at", None)
        mock.created_by_id = overrides.get("created_by_id", "user-1")
        mock.created_at = datetime(2026, 4, 17, 10, tzinfo=_tz.utc)
        mock.updated_at = datetime(2026, 4, 17, 11, tzinfo=_tz.utc)

        if overrides.get("org_only"):
            mock.workspace_id = None
            mock.workspace = None
            mock.project = None
            mock.organization_id = overrides.get("organization_id", "wt-1")
            return mock

        workspace = MagicMock(name="Workspace")
        workspace.organization_id = overrides.get("organization_id", "wt-1")
        mock.workspace = workspace
        mock.project = None
        return mock

    def test_document_fields(self) -> None:
        item = self._make_item()
        doc = sync_service.to_resource_document(item)
        self.assertIsNotNone(doc)
        self.assertEqual(doc["item_id"], "item-1")
        self.assertEqual(doc["item_type"], "tabdoc")
        self.assertEqual(doc["title"], "会议纪要")
        self.assertEqual(doc["preview"], "这是一段预览文本")
        self.assertEqual(doc["resource_id"], "res-1")
        self.assertEqual(doc["space_id"], "space-1")
        self.assertEqual(doc["organization_id"], "wt-1")
        self.assertEqual(doc["creator_type"], "user")
        self.assertEqual(doc["creator_id"], "user-1")
        self.assertEqual(doc["visibility"], "private")

    def test_org_only_item_uses_item_organization_id(self) -> None:
        """#7238：org-only ContextItem 无宿主时读 item.organization_id。"""
        item = self._make_item(org_only=True, organization_id="org-only-1")
        doc = sync_service.to_resource_document(item)
        self.assertIsNotNone(doc)
        self.assertIsNone(doc["space_id"])
        self.assertEqual(doc["organization_id"], "org-only-1")

    def test_object_scope_id_not_populated_wave1(self) -> None:
        """D4：Wave 1 不填 object_scope_id（连 key 都不出现）。"""
        item = self._make_item()
        doc = sync_service.to_resource_document(item)
        self.assertNotIn("object_scope_id", doc)

    def test_trashed_item_returns_none(self) -> None:
        item = self._make_item(trashed_at=datetime(2026, 4, 17, tzinfo=_tz.utc))
        self.assertIsNone(sync_service.to_resource_document(item))


class ToAgentDocumentTests(SimpleTestCase):

    def test_document_fields(self) -> None:
        agent = MagicMock(name="Agent")
        agent.id = "agent-1"
        agent.name = "CodeBot"
        agent.goal = "辅助前端开发"
        agent.type = "bot"
        agent.organization_id = "wt-1"
        agent.owner_user_id = "user-9"
        agent.is_active = True
        agent.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)

        # 防止走真 DB：mock ChatSession / SpaceMembership
        with patch("apps.chat.conversation.models.ChatSession") as MockSession, \
             patch("apps.tabtinspace.models.SpaceMembership") as MockMem:
            MockSession.objects.filter.return_value.order_by.return_value.values_list.return_value.distinct.return_value = [
                "s1", "s2",
            ]
            MockMem.objects.filter.return_value.values_list.return_value = ["s3"]
            doc = sync_service.to_agent_document(agent)
        self.assertEqual(doc["agent_id"], "agent-1")
        self.assertEqual(doc["name"], "CodeBot")
        self.assertEqual(doc["description"], "辅助前端开发")
        self.assertEqual(doc["user_id"], "user-9")
        self.assertEqual(doc["type"], "bot")
        self.assertEqual(set(doc["space_ids"]), {"s1", "s2", "s3"})

    def test_inactive_agent_returns_none(self) -> None:
        agent = MagicMock(is_active=False)
        self.assertIsNone(sync_service.to_agent_document(agent))


class ToSpaceDocumentTests(SimpleTestCase):

    def test_document_fields(self) -> None:
        space = MagicMock()
        space.id = "space-1"
        space.name = "工作空间"
        space.description = "团队协作"
        space.type = "team"
        space.is_archived = False
        space.trashed_at = None
        space.organization_id = "wt-1"
        space.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)

        doc = sync_service.to_space_document(space)
        self.assertEqual(doc["space_id"], "space-1")
        self.assertEqual(doc["name"], "工作空间")
        self.assertEqual(doc["type"], "team")
        self.assertFalse(doc["is_archived"])

    def test_trashed_space_returns_none(self) -> None:
        space = MagicMock(trashed_at=datetime(2026, 4, 17, tzinfo=_tz.utc))
        self.assertIsNone(sync_service.to_space_document(space))


class ToMemoDocumentTests(SimpleTestCase):

    def _make_memo(self, **overrides):
        memo = MagicMock()
        memo.id = "memo-1"
        memo.content_plaintext = overrides.get("content", "我的备忘录")
        memo.tags = overrides.get("tags", ["工作"])
        memo.ai_tags = overrides.get("ai_tags", [])
        memo.status = overrides.get("status", "active")
        memo.memo_type = overrides.get("memo_type", "note")
        memo.source = overrides.get("source", "manual")
        memo.is_pinned = overrides.get("is_pinned", False)
        memo.trashed_at = overrides.get("trashed_at", None)
        memo.space_id = "space-1"
        memo.organization_id = "wt-1"
        memo.owner_id = "user-1"
        memo.created_at = datetime(2026, 4, 1, tzinfo=_tz.utc)
        memo.updated_at = datetime(2026, 4, 17, tzinfo=_tz.utc)
        return memo

    def test_user_memo_document(self) -> None:
        memo = self._make_memo()
        doc = sync_service.to_memo_document(memo)
        self.assertEqual(doc["memo_id"], "memo-1")
        self.assertEqual(doc["creator_type"], "user")
        self.assertEqual(doc["memo_type"], "note")
        self.assertEqual(doc["user_id"], "user-1")

    def test_agent_memo_creator_type(self) -> None:
        memo = self._make_memo(source="agent")
        doc = sync_service.to_memo_document(memo)
        self.assertEqual(doc["creator_type"], "agent")

    def test_insight_memo_without_agent_source_is_user(self) -> None:
        """2026-04-17 收紧：memo_type='insight' 但 source != 'agent' → 仍标 user。

        理由：用户可手写 memo_type='insight'（产品允许）；不能按类型学
        兜底判为 agent，否则 "只看我说的" 筛选会漏掉用户手写的 insight。
        """
        memo = self._make_memo(memo_type="insight", source="manual")
        doc = sync_service.to_memo_document(memo)
        self.assertEqual(doc["creator_type"], "user")

    def test_agent_source_insight_is_agent(self) -> None:
        """Agent 自己 source='agent' 写 memo_type='insight' → 标 agent。"""
        memo = self._make_memo(memo_type="insight", source="agent")
        doc = sync_service.to_memo_document(memo)
        self.assertEqual(doc["creator_type"], "agent")

    def test_archived_memo_returns_none(self) -> None:
        memo = self._make_memo(status="archived")
        self.assertIsNone(sync_service.to_memo_document(memo))

    def test_trashed_memo_returns_none(self) -> None:
        memo = self._make_memo(trashed_at=datetime.now(tz=_tz.utc))
        self.assertIsNone(sync_service.to_memo_document(memo))


class ToImDocumentTests(SimpleTestCase):

    def _make(self, **overrides):
        msg = MagicMock()
        msg.id = 123
        msg.conversation_id = "conv-1"
        msg.sender_id = "user-1"
        msg.content = "你好"
        msg.is_deleted = overrides.get("is_deleted", False)
        msg.created_at = datetime(2026, 4, 17, tzinfo=_tz.utc)

        conv = MagicMock()
        conv.name = overrides.get("conv_name", "团队闲聊")
        conv.organization_id = "wt-1"
        conv.space_id = overrides.get("space_id", "space-1")
        msg.conversation = conv
        return msg

    def test_im_document_fields(self) -> None:
        msg = self._make()
        doc = sync_service.to_im_document(msg)
        self.assertEqual(doc["message_id"], "123")
        self.assertEqual(doc["conversation_id"], "conv-1")
        self.assertEqual(doc["conversation_name"], "团队闲聊")
        self.assertEqual(doc["creator_type"], "user")
        self.assertFalse(doc["is_deleted"])

    def test_deleted_im_returns_none(self) -> None:
        msg = self._make(is_deleted=True)
        self.assertIsNone(sync_service.to_im_document(msg))


class ResolveIndexNameTests(SimpleTestCase):
    """物理索引名解析：rollover vs 非 rollover。"""

    def test_messages_rollover(self) -> None:
        dt = datetime(2026, 4, 17, tzinfo=_tz.utc)
        self.assertEqual(
            sync_service.resolve_message_index_name(dt),
            "tabtin-messages-2026-04",
        )

    def test_resolve_upsert_index_non_rollover(self) -> None:
        self.assertEqual(
            sync_service.resolve_upsert_index_name("resources"),
            "tabtin-resources",
        )

    def test_resolve_upsert_index_rollover_uses_created_at(self) -> None:
        instance = MagicMock()
        instance.created_at = datetime(2026, 5, 1, tzinfo=_tz.utc)
        self.assertEqual(
            sync_service.resolve_upsert_index_name("messages", instance),
            "tabtin-messages-2026-05",
        )
