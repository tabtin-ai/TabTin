"""#2822 方案 B：回退边界按对话时间（arrival_seq）而非 created_at。

复现场景（session 9b866ea1 实证）：relay 迟到重投 / RelayRetryQueue recover
补写的行 created_at 是补投时刻，与真实对话顺序完全颠倒——「中间回复」的
created_at 晚于「最终回答」。若边界仍按 created_at：

- preview 集合错乱（该移除的被当成保留侧）；
- 软回退可见过滤把被回退消息漏回时间线；
- cleanup 物理删除删错集合。

本文件用 ORM 直连锁定：三处边界（preview / 可见过滤 / cleanup）在 created_at
乱序时以 arrival_seq 为准；legacy 行（arrival_seq NULL）回落 created_at 不回归。
"""
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone

from django.contrib.auth import get_user_model
from django.test import TestCase
from django.utils import timezone

from apps.chat.conversation.models import ChatSession, ChatMessage
from apps.chat.conversation.api._common import _visible_messages_queryset
from apps.chat.conversation.api.rollback import (
    _compute_rollback_preview,
    _resolve_rewind_anchor_id,
)
from apps.services.agent_engine.services.persistence_pipeline import (
    cleanup_reverted_messages,
)

#: 对话时间基准（epoch 微秒）。
_BASE_SEQ = 1_783_990_000_000_000


class ConversationTimeRollbackBoundaryTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.user = User.objects.create(username=f"ct2822-{uuid.uuid4().hex[:8]}")
        self.session = ChatSession.objects.create(
            user=self.user, organization_id="2822-ct", title="conv-time-boundary",
        )

    def _mk(self, role, text, arrival_offset_s=None):
        """arrival_offset_s：对话时间偏移（秒）；None = legacy 行（不写 arrival_seq）。"""
        return ChatMessage.objects.create(
            session=self.session, role=role, text_summary=text,
            content_blocks_json=[{"type": "text", "text": text}],
            message_kind="llm", client_event_id=uuid.uuid4(),
            arrival_seq=(
                _BASE_SEQ + int(arrival_offset_s * 1_000_000)
                if arrival_offset_s is not None else None
            ),
        )

    def _set_created(self, msg, offset_s):
        """created_at = 落库时间，测试中故意与对话时间脱钩。

        基准取对话时间基准（_BASE_SEQ）而非 timezone.now()，保证 legacy 行
        （按 created_at 比较）与 arrival 行（按 seq 换算 dt 比较）落在同一
        时间坐标系，测试结果与运行时刻无关。
        """
        base = datetime.fromtimestamp(_BASE_SEQ / 1_000_000, tz=dt_timezone.utc)
        ChatMessage.objects.filter(id=msg.id).update(
            created_at=base + timedelta(seconds=offset_s)
        )

    def _mark_revert(self, target):
        self.session.revert_message_id = target.id
        self.session.revert_at = timezone.now()
        self.session.save(update_fields=["revert_message_id", "revert_at", "updated_at"])
        self.session.refresh_from_db()

    def _scrambled_session(self):
        """对话序：u1 → a1(目标) → u2 → a2 → a3；落库序（created_at）故意颠倒：
        被回退侧的 u2/a2/a3 比目标 a1 的 created_at 更早（relay 重投实况的极端化）。
        """
        u1 = self._mk("user", "q1", arrival_offset_s=0)
        a1 = self._mk("assistant", "a1", arrival_offset_s=10)   # ← 回退目标
        u2 = self._mk("user", "q2", arrival_offset_s=20)
        a2 = self._mk("assistant", "a2-final", arrival_offset_s=30)
        a3 = self._mk("assistant", "a3-middle", arrival_offset_s=25)
        # created_at 完全乱序：目标最晚落库，被回退侧最早；a3（对话上早于 a2）落库最晚
        self._set_created(u1, 0)
        self._set_created(u2, 10)
        self._set_created(a2, 20)
        self._set_created(a3, 40)
        self._set_created(a1, 30)
        return u1, a1, u2, a2, a3

    def test_preview_uses_conversation_time_when_created_at_scrambled(self):
        _u1, a1, _u2, _a2, _a3 = self._scrambled_session()
        a1.refresh_from_db()

        preview = _compute_rollback_preview(self.session, a1)

        removed_ids = {
            m["id"] for m in self.session.messages.filter(
                text_summary__in=["q2", "a2-final", "a3-middle"]
            ).values("id")
        }
        preview_ids = {uuid.UUID(m["id"]) for m in preview.messages_preview}
        # 预览集合 = 对话时间在目标之后的 3 条（按 created_at 算会漏成 1 条）
        self.assertEqual(preview_ids, removed_ids)
        # 预览列表按对话时间倒序展示（最新在前，取末 5 条 reversed）：
        # a2-final（对话 30s）应排在 a3-middle（对话 25s）前——按 created_at 算
        # 会颠倒（a3 落库最晚）。
        summaries = [
            self.session.messages.get(id=m["id"]).text_summary
            for m in preview.messages_preview
        ]
        self.assertLess(summaries.index("a2-final"), summaries.index("a3-middle"))

    def test_visible_filter_and_cleanup_use_conversation_time(self):
        _u1, a1, _u2, _a2, _a3 = self._scrambled_session()
        a1.refresh_from_db()
        self._mark_revert(a1)

        visible = set(
            _visible_messages_queryset(self.session).values_list("text_summary", flat=True)
        )
        # 软回退可见 = 目标及其前（按 created_at 算会把 q2/a2/a3 漏回来）
        self.assertEqual(visible, {"q1", "a1"})

        cleanup_reverted_messages(self.session)

        remaining = set(self.session.messages.values_list("text_summary", flat=True))
        self.assertEqual(remaining, {"q1", "a1"})
        self.session.refresh_from_db()
        self.assertIsNone(self.session.revert_message_id)

    def test_user_target_includes_itself_in_removal(self):
        _u1, _a1, u2, _a2, _a3 = self._scrambled_session()
        u2.refresh_from_db()
        self._mark_revert(u2)

        cleanup_reverted_messages(self.session)

        remaining = set(self.session.messages.values_list("text_summary", flat=True))
        self.assertEqual(remaining, {"q1", "a1"})

    def test_file_rewind_anchor_uses_conversation_time_when_created_at_scrambled(self):
        """文件锚点必须与预览/清算使用同一 arrival_seq 时间线。"""
        _u1, a1, u2, a2, a3 = self._scrambled_session()
        ChatMessage.objects.filter(id=a1.id).update(agent_run_id="run-a1")
        ChatMessage.objects.filter(id=a2.id).update(agent_run_id="run-a2")
        ChatMessage.objects.filter(id=a3.id).update(agent_run_id="run-a3")
        a1.refresh_from_db()
        u2.refresh_from_db()

        # 对话时间上 a3(25s) 早于 a2(30s)，尽管 created_at 更晚。
        self.assertEqual(_resolve_rewind_anchor_id(self.session, a1), "run-a3")
        self.assertEqual(_resolve_rewind_anchor_id(self.session, u2), "run-a3")

    def test_legacy_rows_without_arrival_seq_fall_back_to_created_at(self):
        """全 legacy（arrival_seq NULL）会话行为与旧口径一致，不回归。"""
        u1 = self._mk("user", "q1")
        a1 = self._mk("assistant", "a1")
        u2 = self._mk("user", "q2")
        a2 = self._mk("assistant", "a2")
        for i, m in enumerate([u1, a1, u2, a2]):
            self._set_created(m, i)
        a1.refresh_from_db()
        self._mark_revert(a1)

        visible = set(
            _visible_messages_queryset(self.session).values_list("text_summary", flat=True)
        )
        self.assertEqual(visible, {"q1", "a1"})

        cleanup_reverted_messages(self.session)
        self.assertEqual(
            set(self.session.messages.values_list("text_summary", flat=True)),
            {"q1", "a1"},
        )

    def test_mixed_legacy_and_arrival_rows_visible_delete_complementary(self):
        """混合行（部分 legacy）下可见集 ∪ 删除集 = 全集且不重叠。"""
        u1 = self._mk("user", "q1", arrival_offset_s=0)
        a1 = self._mk("assistant", "a1", arrival_offset_s=10)  # 目标
        u2 = self._mk("user", "q2-legacy")                      # legacy 行
        a2 = self._mk("assistant", "a2", arrival_offset_s=30)
        # legacy 行的 created_at 在目标对话时间点之后（正常时序）
        self._set_created(u1, 0)
        self._set_created(a1, 10)
        self._set_created(u2, 3600)
        self._set_created(a2, 3610)
        a1.refresh_from_db()
        self._mark_revert(a1)

        visible = set(
            _visible_messages_queryset(self.session).values_list("id", flat=True)
        )
        cleanup_reverted_messages(self.session)
        remaining = set(self.session.messages.values_list("id", flat=True))
        # 清算后剩余 == 软回退时可见（除 revert 后 system 例外，本会话无）
        self.assertEqual(remaining, visible)
        self.assertEqual(
            set(self.session.messages.values_list("text_summary", flat=True)),
            {"q1", "a1"},
        )
