"""记忆维护核心路径单测 — compaction / importance_adjust / signal 接线。

优先 SimpleTestCase + mock，避免依赖 PG-only 表。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.agent_engine.tasks.memory.compaction import (
    CompactionPersistenceError,
    _jaccard,
    _merge_group,
    _rollback_merged_memo,
    _tokenize,
)
from apps.services.agent_engine.tasks.memory.importance_adjust import (
    _should_archive_stale_memo,
)
from apps.services.agent_engine.tasks.memory.relay_memory_trigger import (
    _detect_memory_signals,
    _has_l1_priority_signals,
    _resolve_capture_mode,
    _trigger_l2_incremental_extract,
)
from apps.services.agent_engine.tasks.memory.capture import (
    _format_signal_hints,
    _resolve_effective_capture_mode,
)
from apps.services.agent_engine.utils.memory_signal import MemorySignalDetector


class TestCompactionTokenize(SimpleTestCase):
    def test_jaccard_identical(self):
        a = _tokenize("hello world foo bar")
        b = _tokenize("hello world foo bar")
        self.assertEqual(_jaccard(a, b), 1.0)

    def test_jaccard_disjoint(self):
        a = _tokenize("alpha beta gamma")
        b = _tokenize("delta epsilon zeta")
        self.assertEqual(_jaccard(a, b), 0.0)

    def test_jaccard_cjk_bigram(self):
        a = _tokenize("记住我的偏好设置")
        b = _tokenize("记住我的偏好习惯")
        self.assertGreater(_jaccard(a, b), 0.5)


class TestCompactionMergeGroupRollback(SimpleTestCase):
    # 回滚判据是「归档后仍有旧 memo 处于 ACTIVE」（_count_active_memos > 0），
    # 而非 _archive_old_memos 返回值的数量比较——用 _count_active_memos 控制分支。

    @patch("apps.services.agent_engine.tasks.memory.compaction._rollback_merged_memo")
    @patch("apps.services.agent_engine.tasks.memory.compaction._count_active_memos", return_value=2)
    @patch("apps.services.agent_engine.tasks.memory.compaction._archive_old_memos", return_value=[])
    @patch(
        "apps.services.agent_engine.utils.memory_constants.resolve_space_execution_agent_id",
        return_value="agent-1",
    )
    @patch("apps.agent_memory.repository.AgentMemoryRepository")
    @patch(
        "apps.services.billing.organization_resolver.resolve_organization_id_from_space",
        return_value="wt-1",
    )
    @patch("apps.services.llm.services.chat.unified_llm_call")
    def test_archive_failure_rolls_back_and_requests_retry(
        self,
        mock_llm,
        mock_resolve_wt,
        mock_memory_repo_cls,
        mock_resolve_agent,
        mock_archive,
        mock_count_active,
        mock_rollback,
    ):
        # 归档 DB 操作真失败 → 旧 memo 仍 ACTIVE（count=2）→ 回滚新合并 memo
        mock_llm.return_value = MagicMock(
            content='{"content": "merged text", "type": "事实", "importance": 3}',
        )
        mock_memory_repo_cls.create.return_value = MagicMock(id="new-memo-id")

        group = [
            {"memo_id": "old-1", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo bar"},
            {"memo_id": "old-2", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo baz"},
        ]
        with self.assertRaises(CompactionPersistenceError):
            _merge_group(group, space_id="space-1", user_id="user-1")
        mock_rollback.assert_called_once_with("new-memo-id")

    @patch("apps.services.agent_engine.tasks.memory.compaction._rollback_merged_memo")
    @patch("apps.services.agent_engine.tasks.memory.compaction._count_active_memos", return_value=0)
    @patch(
        "apps.services.agent_engine.tasks.memory.compaction._archive_old_memos",
        return_value=["old-1", "old-2"],
    )
    @patch(
        "apps.services.agent_engine.utils.memory_constants.resolve_space_execution_agent_id",
        return_value="agent-1",
    )
    @patch("apps.agent_memory.repository.AgentMemoryRepository")
    @patch(
        "apps.services.billing.organization_resolver.resolve_organization_id_from_space",
        return_value="wt-1",
    )
    @patch("apps.services.llm.services.chat.unified_llm_call")
    def test_archive_success_no_rollback(
        self,
        mock_llm,
        mock_resolve_wt,
        mock_memory_repo_cls,
        mock_resolve_agent,
        mock_archive,
        mock_count_active,
        mock_rollback,
    ):
        mock_llm.return_value = MagicMock(
            content='{"content": "merged text", "type": "事实", "importance": 3}',
        )
        mock_memory_repo_cls.create.return_value = MagicMock(id="new-memo-id")

        group = [
            {"memo_id": "old-1", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo bar"},
            {"memo_id": "old-2", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo baz"},
        ]
        ok = _merge_group(group, space_id="space-1", user_id="user-1")

        self.assertTrue(ok)
        mock_rollback.assert_not_called()

    @patch("apps.services.agent_engine.tasks.memory.compaction._rollback_merged_memo")
    @patch("apps.services.agent_engine.tasks.memory.compaction._count_active_memos", return_value=0)
    @patch(
        "apps.services.agent_engine.tasks.memory.compaction._archive_old_memos",
        return_value=["old-2"],
    )
    @patch(
        "apps.services.agent_engine.utils.memory_constants.resolve_space_execution_agent_id",
        return_value="agent-1",
    )
    @patch("apps.agent_memory.repository.AgentMemoryRepository")
    @patch(
        "apps.services.billing.organization_resolver.resolve_organization_id_from_space",
        return_value="wt-1",
    )
    @patch("apps.services.llm.services.chat.unified_llm_call")
    def test_partial_archived_but_none_active_no_rollback(
        self,
        mock_llm,
        mock_resolve_wt,
        mock_memory_repo_cls,
        mock_resolve_agent,
        mock_archive,
        mock_count_active,
        mock_rollback,
    ):
        # bugbot  回归：archived_ids 长度 < old_ids（old-1 已被别处归档），
        # 但复查残留 ACTIVE=0 → 不是失败，不应回滚（旧的数量比较会误判为失败）。
        mock_llm.return_value = MagicMock(
            content='{"content": "merged text", "type": "事实", "importance": 3}',
        )
        mock_memory_repo_cls.create.return_value = MagicMock(id="new-memo-id")

        group = [
            {"memo_id": "old-1", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo bar"},
            {"memo_id": "old-2", "organization_id": "wt-1", "owner_id": "user-1", "agent_id": "agent-1", "content": "foo baz"},
        ]
        ok = _merge_group(group, space_id="space-1", user_id="user-1")

        self.assertTrue(ok)
        mock_rollback.assert_not_called()


class TestImportanceAdjustArchiveCriteria(SimpleTestCase):
    def setUp(self):
        now = datetime.now(timezone.utc)
        self.stale_cutoff = now - timedelta(days=30)
        self.extended_cutoff = now - timedelta(days=90)
        self.old = now - timedelta(days=60)
        self.recent = now - timedelta(days=5)

    def test_zero_access_stale_low_importance_archives(self):
        self.assertTrue(
            _should_archive_stale_memo(
                access_count=0,
                importance=2,
                created_at=self.old,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )

    def test_zero_access_recent_not_archived(self):
        self.assertFalse(
            _should_archive_stale_memo(
                access_count=0,
                importance=2,
                created_at=self.recent,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )

    def test_access_count_ge_one_not_archived(self):
        self.assertFalse(
            _should_archive_stale_memo(
                access_count=1,
                importance=2,
                created_at=self.old,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )

    def test_importance_five_never_archived(self):
        self.assertFalse(
            _should_archive_stale_memo(
                access_count=0,
                importance=5,
                created_at=self.old,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )

    def test_importance_three_needs_extended_stale(self):
        self.assertFalse(
            _should_archive_stale_memo(
                access_count=0,
                importance=3,
                created_at=self.old,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )
        very_old = datetime.now(timezone.utc) - timedelta(days=100)
        self.assertTrue(
            _should_archive_stale_memo(
                access_count=0,
                importance=3,
                created_at=very_old,
                stale_cutoff=self.stale_cutoff,
                extended_stale_cutoff=self.extended_cutoff,
            )
        )


class TestMemorySignalDetector(SimpleTestCase):
    def test_explicit_remember_zh(self):
        detector = MemorySignalDetector()
        msgs = [{"role": "user", "content": "记住我的偏好设置，以后都用 dark mode"}]
        signals = detector.detect(msgs, 0)
        types = {s["type"] for s in signals}
        self.assertIn("explicit_remember", types)

    def test_no_false_positive_casual_chat(self):
        detector = MemorySignalDetector()
        msgs = [{"role": "user", "content": "今天天气不错，帮我查一下"}]
        signals = detector.detect(msgs, 0)
        self.assertEqual(signals, [])


class TestRelaySignalWiring(SimpleTestCase):
    def test_priority_signal_bypasses_interval(self):
        msgs = [{"role": "user", "content": "记住我的偏好设置，以后都用 dark mode"}]
        signals = _detect_memory_signals(msgs)
        self.assertTrue(_has_l1_priority_signals(signals))

    def test_resolve_capture_mode_on_remember(self):
        signals = [{"type": "explicit_remember", "snippet": "remember that"}]
        self.assertEqual(_resolve_capture_mode("selective", signals), "auto")

    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger._is_cold_start",
        return_value=False,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger._fetch_messages_from_db",
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger._get_extracted_index",
        return_value=0,
    )
    @patch(
        "apps.services.agent_engine.tasks.memory.relay_memory_trigger._resolve_memory_ctx_from_session",
    )
    def test_l2_submits_with_signals_below_interval(
        self, mock_ctx, mock_idx, mock_fetch, mock_cold,
    ):
        messages = [
            {"role": "user", "content": "记住我的偏好设置，以后都用 dark mode"},
            {"role": "assistant", "content": "已记住", "agent_id": "agent-1"},
        ]
        mock_ctx.return_value = {
            "space_id": "space-1",
            "selected_model_id": "model-A",
            "memory_config": {
                "observer": {
                    "mode": "selective",
                    "incremental_interval": 10,
                    "dedup_threshold": 0.85,
                    "override_detection": True,
                },
            },
        }
        mock_fetch.return_value = messages

        with patch(
            "apps.services.agent_engine.tasks.memory.capture.extract_memories_task",
        ) as mock_extract, patch(
            "apps.services.agent_engine.tasks.memory.capture.advance_memory_index_task",
        ) as mock_advance, patch("celery.chord"):
            mock_extract.s.return_value = MagicMock()
            mock_advance.s.return_value = MagicMock()
            _trigger_l2_incremental_extract(
                session_id="sess-1",
                thread_id="thread-1",
                user_id="user-1",
            )
            mock_extract.s.assert_called_once()
            kwargs = mock_extract.s.call_args.kwargs
            self.assertEqual(kwargs["capture_mode"], "auto")
            self.assertEqual(kwargs["selected_model_id"], "model-A")
            self.assertEqual(
                kwargs["capture_event_id"],
                "thread-1:0:2:agent-1",
            )
            self.assertTrue(kwargs["signals"])
            parsed = json.loads(kwargs["signals"])
            self.assertTrue(any(s["type"] == "explicit_remember" for s in parsed))


class TestCaptureSignalConsumption(SimpleTestCase):
    def test_effective_mode_for_remember(self):
        signals = [{"type": "explicit_remember", "snippet": "remember"}]
        self.assertEqual(_resolve_effective_capture_mode("selective", signals), "auto")

    def test_format_signal_hints(self):
        hints = _format_signal_hints([
            {"type": "correction", "snippet": "不对，应该是 PostgreSQL"},
        ])
        self.assertIn("correction", hints)
        self.assertIn("PostgreSQL", hints)
