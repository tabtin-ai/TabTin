"""#4528 姊妹缺陷：回退清算的删除边界必须与可见边界对齐。

- 回退到 assistant 回复「此处」：保留该条回复，仅删其后（对齐 tooltip
  「移除之后的消息」+ _build_revert_visible_message_filter 的 assistant id__lte）。
- 回退到 user 消息：连该条 user 一并删（对齐 user id__lt 可见边界）。

用 ORM 直连，不走 API/鉴权，专测 cleanup_reverted_messages 的物理删除边界。
"""
import uuid

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.chat.conversation.api._common import _visible_messages_queryset
from apps.chat.conversation.services.file_restore_finalize_lease import (
    FileRestoreFinalizePendingError,
)
from apps.services.agent_engine.models import PendingInteraction
from apps.services.agent_engine.services.pending_interaction_service import (
    list_pending_single_hitl_for_thread,
)
from apps.services.agent_engine.services.persistence_pipeline import (
    cleanup_reverted_messages,
)


class RevertCleanupBoundaryTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create(username=f"revb-{uuid.uuid4().hex[:8]}")
        self.session = ChatSession.objects.create(
            user=self.user, organization_id="4528-revb", title="revert-boundary",
        )

    def _mk(self, role, text):
        return ChatMessage.objects.create(
            session=self.session, role=role, text_summary=text,
            content_blocks_json=[{"type": "text", "text": text}],
            message_kind="llm", client_event_id=uuid.uuid4(),
        )

    def _seq(self, *msgs):
        base = timezone.now().replace(microsecond=0)
        for i, m in enumerate(msgs):
            ChatMessage.objects.filter(id=m.id).update(
                created_at=base + timezone.timedelta(seconds=i)
            )

    def _remaining(self):
        return list(
            self.session.messages.order_by("created_at").values_list("text_summary", flat=True)
        )

    def test_revert_to_assistant_keeps_that_reply(self):
        u1 = self._mk("user", "q1")
        a1 = self._mk("assistant", "a1")   # ← 回退到此处，应保留
        u2 = self._mk("user", "q2")
        a2 = self._mk("assistant", "a2")
        self._seq(u1, a1, u2, a2)

        self.session.revert_message_id = a1.id
        self.session.revert_at = timezone.now()
        self.session.save(update_fields=["revert_message_id", "revert_at", "updated_at"])
        self.session.refresh_from_db()

        # 软回退可见应含 a1
        visible = list(
            _visible_messages_queryset(self.session)
            .order_by("created_at").values_list("text_summary", flat=True)
        )
        self.assertEqual(visible, ["q1", "a1"])

        cleanup_reverted_messages(self.session)

        # 清算后 a1 仍在，其后被删
        self.assertEqual(self._remaining(), ["q1", "a1"])
        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)

    def test_revert_to_user_removes_that_user_message(self):
        u1 = self._mk("user", "q1")
        a1 = self._mk("assistant", "a1")
        u2 = self._mk("user", "q2")   # ← 回退到此处（user），应连同一并删
        a2 = self._mk("assistant", "a2")
        self._seq(u1, a1, u2, a2)

        self.session.revert_message_id = u2.id
        self.session.revert_at = timezone.now()
        self.session.save(update_fields=["revert_message_id", "revert_at", "updated_at"])
        self.session.refresh_from_db()

        cleanup_reverted_messages(self.session)

        self.assertEqual(self._remaining(), ["q1", "a1"])
        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)

    def test_cleanup_refuses_new_message_while_local_file_finalize_is_pending(self):
        target = self._mk("user", "pending edit")
        later = self._mk("assistant", "must stay until finalize")
        self._seq(target, later)
        self.session.revert_message_id = target.id
        self.session.revert_at = timezone.now()
        self.session.revert_history = [{
            'type': 'rollback',
            'apply_id': 'rollback:pending-file-result',
            'target_message_id': str(target.id),
            'file_restore_status': 'pending',
            'file_restore_finalize_required': True,
            'file_restore_finalize_expires_at': (
                timezone.now() + timezone.timedelta(minutes=1)
            ).isoformat(),
            'created_at': timezone.now().isoformat(),
        }]
        self.session.save(update_fields=[
            'revert_message_id', 'revert_at', 'revert_history', 'updated_at',
        ])

        with self.assertRaises(FileRestoreFinalizePendingError):
            cleanup_reverted_messages(self.session)

        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_message_id, target.id)
        self.assertEqual(self._remaining(), ['pending edit', 'must stay until finalize'])

    def test_missing_target_cannot_bypass_pending_file_finalize_gate(self):
        target = self._mk("user", "target later removed")
        target_id = target.id
        self.session.revert_message_id = target_id
        self.session.revert_at = timezone.now()
        self.session.revert_history = [{
            'type': 'rollback',
            'apply_id': 'rollback:pending-missing-target',
            'target_message_id': str(target_id),
            'file_restore_status': 'pending',
            'file_restore_finalize_required': True,
            'file_restore_finalize_expires_at': (
                timezone.now() + timezone.timedelta(minutes=1)
            ).isoformat(),
            'created_at': timezone.now().isoformat(),
        }]
        self.session.save(update_fields=[
            'revert_message_id', 'revert_at', 'revert_history', 'updated_at',
        ])
        target.delete()

        with self.assertRaises(FileRestoreFinalizePendingError):
            cleanup_reverted_messages(self.session)

        self.session.refresh_from_db()
        self.assertEqual(self.session.revert_message_id, target_id)
        self.assertTrue(self.session.revert_history[0]['file_restore_finalize_required'])

    def test_cleanup_invalidates_single_hitl_from_reverted_assistant_turn(self):
        kept_tool_use_id = "tu-kept"
        reverted_tool_use_id = "tu-reverted"
        u1 = self._mk("user", "q1")
        a1 = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary="a1",
            content_blocks_json=[{
                "type": "tool_use",
                "id": kept_tool_use_id,
                "name": "ask_user",
                "input": {},
            }],
            message_kind="llm",
            client_event_id=uuid.uuid4(),
        )
        u2 = self._mk("user", "q2")
        a2 = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            text_summary="a2",
            content_blocks_json=[{
                "type": "tool_use",
                "id": reverted_tool_use_id,
                "name": "ask_user",
                "input": {},
            }],
            message_kind="llm",
            client_event_id=uuid.uuid4(),
        )
        self._seq(u1, a1, u2, a2)

        for request_key, tool_use_id, created_at in (
            ("ask-kept", kept_tool_use_id, a1.created_at),
            ("ask-reverted", reverted_tool_use_id, a2.created_at),
        ):
            PendingInteraction.objects.create(
                kind="ask_choice",
                status="resolved",
                thread_id=f"chat-session-{self.session.id}",
                session_id=self.session.id,
                organization_id=self.session.organization_id,
                user_id=self.user.id,
                request_key=request_key,
                source="agent_stream",
                payload={"tool_use_id": tool_use_id},
                result={"answers": []},
                resolved_at=created_at,
            )

        self.session.revert_message_id = u2.id
        self.session.revert_at = timezone.now()
        self.session.save(update_fields=["revert_message_id", "revert_at", "updated_at"])
        self.session.refresh_from_db()

        cleanup_reverted_messages(self.session)

        kept = PendingInteraction.objects.get(request_key="ask-kept")
        reverted = PendingInteraction.objects.get(request_key="ask-reverted")
        self.assertEqual(kept.status, "resolved")
        self.assertEqual(reverted.status, "cancelled")
        self.assertEqual(reverted.result["reason"], "timeline_reverted")
        restored_keys = {
            row["request_key"]
            for row in list_pending_single_hitl_for_thread(
                f"chat-session-{self.session.id}",
            )
        }
        self.assertIn("ask-kept", restored_keys)
        self.assertNotIn("ask-reverted", restored_keys)
