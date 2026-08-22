import json
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock
from unittest.mock import patch


def _claim(status="claimed"):
    from apps.services.agent_engine.services.checkpoint_summary_execution import (
        CheckpointSummaryClaim,
    )

    return CheckpointSummaryClaim(
        status=status,
        checkpoint_id="checkpoint-1",
        invocation_id="checkpoint:checkpoint-1:summary:v1",
        organization_id="organization-1",
        user_id="user-1",
        checkpoint_context={
            "user_prompt": "完成发布方案并记录风险",
            "impact": {
                "files": [{"path": "release.py", "action": "modified"}],
                "resources": [],
            },
            "decision_summary": {"outcome": "修改了 1 个文件", "status": "basic"},
        },
        agent_run_id="run-1",
    )


def _provider_payload():
    return {
        "intent_summary": "完成发布方案并核对风险",
        "decision_summary": {
            "outcome": "形成可执行的发布方案",
            "key_decisions": ["发布前必须完成风险检查"],
        },
        "unresolved_items": ["确认最终发布时间"],
    }


class _InMemoryCheckpointSummaryStore:
    def __init__(self):
        self._lock = threading.Lock()
        self.status = "pending"
        self.complete_count = 0
        self.failure_codes = []

    def claim(self, checkpoint_id):
        with self._lock:
            if self.status == "completed":
                return _claim("completed")
            if self.status == "running":
                return _claim("in_progress")
            self.status = "running"
            return _claim()

    def complete(self, checkpoint_id, invocation_id, *, summary):
        with self._lock:
            if self.status == "completed":
                return SimpleNamespace(status="completed", checkpoint_id=checkpoint_id)
            self.status = "completed"
            self.complete_count += 1
            self.summary = summary
            return SimpleNamespace(status="completed", checkpoint_id=checkpoint_id)

    def fail(self, checkpoint_id, invocation_id, error_code):
        with self._lock:
            if self.status != "completed":
                self.status = "failed"
                self.failure_codes.append(error_code)


class CheckpointSummaryExecutionTests(TestCase):
    def test_composite_prompt_contract_contains_all_three_required_sections(self):
        prompt_dir = (
            Path(__file__).resolve().parents[2]
            / "llm"
            / "scenes"
            / "bundled"
            / "checkpoint_decision_summary"
        )
        system_prompt = (prompt_dir / "system.md").read_text(encoding="utf-8")
        user_prompt = (prompt_dir / "user.md.tmpl").read_text(encoding="utf-8")

        self.assertIn('"intent_summary"', system_prompt)
        self.assertIn('"decision_summary"', system_prompt)
        self.assertIn('"unresolved_items"', system_prompt)
        self.assertIn("同时用于生成", user_prompt)

    def test_normal_execution_uses_one_stable_composite_call_and_persists_both_summaries(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CheckpointSummaryClaim,
            execute_checkpoint_summary,
        )

        claim = _claim()
        store = SimpleNamespace(
            claim=MagicMock(return_value=claim),
            complete=MagicMock(
                return_value=SimpleNamespace(
                    status="completed",
                    checkpoint_id="checkpoint-1",
                )
            ),
            fail=MagicMock(),
        )
        provider_payload = _provider_payload()

        def fake_llm_call(**kwargs):
            content = json.dumps(provider_payload, ensure_ascii=False)
            kwargs["result_validator"](content)
            return SimpleNamespace(content=content)

        llm_call = MagicMock(side_effect=fake_llm_call)

        result = execute_checkpoint_summary(
            "checkpoint-1",
            store=store,
            llm_call=llm_call,
        )

        self.assertEqual(result.status, "completed")
        llm_call.assert_called_once()
        call = llm_call.call_args.kwargs
        self.assertEqual(call["scene_key"], "checkpoint_decision_summary")
        self.assertEqual(
            call["invocation_context"].invocation_id,
            "checkpoint:checkpoint-1:summary:v1",
        )
        self.assertEqual(call["invocation_context"].execution_key, "checkpoint_summary")
        self.assertTrue(call["invocation_context"].stable_invocation)
        store.complete.assert_called_once()
        composite = store.complete.call_args.kwargs["summary"]
        self.assertEqual(composite.intent_summary, "完成发布方案并核对风险")
        self.assertEqual(composite.decision_summary["outcome"], "形成可执行的发布方案")
        self.assertEqual(composite.unresolved_items, ("确认最终发布时间",))
        store.fail.assert_not_called()

    def test_ambiguous_reclaim_is_tagged_on_the_stable_invocation(self):
        from dataclasses import replace

        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )

        store = SimpleNamespace(
            claim=MagicMock(
                return_value=replace(_claim(), ambiguous_previous_attempt=True)
            ),
            complete=MagicMock(
                return_value=SimpleNamespace(status="completed")
            ),
            fail=MagicMock(),
        )
        invocation_contexts = []

        def llm_call(**kwargs):
            invocation_contexts.append(kwargs["invocation_context"])
            return SimpleNamespace(
                content=json.dumps(_provider_payload(), ensure_ascii=False)
            )

        execute_checkpoint_summary(
            "checkpoint-1",
            store=store,
            llm_call=llm_call,
        )

        self.assertEqual(len(invocation_contexts), 1)
        self.assertEqual(
            invocation_contexts[0].retry_source,
            "ambiguous_provider_attempt",
        )

    def test_concurrent_duplicate_claims_produce_one_completed_execution(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )

        store = _InMemoryCheckpointSummaryStore()
        provider_started = threading.Event()
        release_provider = threading.Event()
        provider_calls = 0
        provider_lock = threading.Lock()

        def fake_llm_call(**kwargs):
            nonlocal provider_calls
            with provider_lock:
                provider_calls += 1
            provider_started.set()
            release_provider.wait(timeout=2)
            content = json.dumps(_provider_payload(), ensure_ascii=False)
            kwargs["result_validator"](content)
            return SimpleNamespace(content=content)

        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(
                execute_checkpoint_summary,
                "checkpoint-1",
                store=store,
                llm_call=fake_llm_call,
            )
            self.assertTrue(provider_started.wait(timeout=1))
            second = pool.submit(
                execute_checkpoint_summary,
                "checkpoint-1",
                store=store,
                llm_call=fake_llm_call,
            )
            second_result = second.result(timeout=1)
            release_provider.set()
            first_result = first.result(timeout=1)

        self.assertEqual(first_result.status, "completed")
        self.assertEqual(second_result.status, "in_progress")
        self.assertEqual(provider_calls, 1)
        self.assertEqual(store.complete_count, 1)

    def test_django_store_claims_checkpoint_row_and_persists_running_identity(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            DjangoCheckpointSummaryStore,
        )

        checkpoint = SimpleNamespace(
            id="checkpoint-1",
            organization_id="organization-1",
            editor_type="user",
            editor_id="user-1",
            agent_run_id="run-1",
            metadata={"checkpoint_context": _claim().checkpoint_context},
            save=MagicMock(),
        )
        queryset = MagicMock()
        queryset.select_for_update.return_value = queryset
        queryset.filter.return_value.first.return_value = checkpoint
        manager = MagicMock()
        manager.using.return_value = queryset
        fake_models = SimpleNamespace(
            SpaceCheckpoint=SimpleNamespace(objects=manager),
        )

        with (
            patch.dict(sys.modules, {"apps.collab.models": fake_models}),
            patch(
                "django.db.transaction.atomic",
                return_value=nullcontext(),
            ),
            patch(
                "apps.services.common.db_router.postgres_app_db_alias",
                return_value="default",
            ),
        ):
            result = DjangoCheckpointSummaryStore(
                now_provider=lambda: datetime(2026, 8, 11, tzinfo=timezone.utc)
            ).claim("checkpoint-1")

        self.assertEqual(result.status, "claimed")
        self.assertEqual(result.invocation_id, "checkpoint:checkpoint-1:summary:v1")
        queryset.select_for_update.assert_called_once_with()
        execution = checkpoint.metadata["checkpoint_context"]["summary_execution"]
        self.assertEqual(execution["status"], "running")
        self.assertEqual(execution["execution_key"], "checkpoint_summary")
        self.assertEqual(execution["attempt_count"], 1)
        checkpoint.save.assert_called_once_with(using="default", update_fields=["metadata"])

    def test_django_store_completes_all_legacy_fields_in_one_locked_write(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CompositeCheckpointSummary,
            DjangoCheckpointSummaryStore,
        )

        context = _claim().checkpoint_context
        context["decision_summary"]["outcome_structured"] = {
            "files_modified": 1,
        }
        context["summary_execution"] = {
            "status": "running",
            "invocation_id": "checkpoint:checkpoint-1:summary:v1",
            "execution_key": "checkpoint_summary",
            "attempt_count": 1,
        }
        checkpoint = SimpleNamespace(
            id="checkpoint-1",
            anchor_session_id="session-1",
            anchor_message_id="message-1",
            metadata={"checkpoint_context": context},
            save=MagicMock(),
        )
        queryset = MagicMock()
        queryset.select_for_update.return_value = queryset
        queryset.filter.return_value.first.return_value = checkpoint
        manager = MagicMock()
        manager.using.return_value = queryset
        fake_models = SimpleNamespace(
            SpaceCheckpoint=SimpleNamespace(objects=manager),
        )
        summary = CompositeCheckpointSummary(
            intent_summary="完成发布方案并核对风险",
            decision_summary={
                "outcome": "形成可执行的发布方案",
                "key_decisions": ["发布前必须完成风险检查"],
            },
            unresolved_items=("确认最终发布时间",),
        )

        with (
            patch.dict(sys.modules, {"apps.collab.models": fake_models}),
            patch("django.db.transaction.atomic", return_value=nullcontext()),
            patch(
                "apps.services.common.db_router.postgres_app_db_alias",
                return_value="default",
            ),
        ):
            result = DjangoCheckpointSummaryStore(
                now_provider=lambda: datetime(2026, 8, 11, tzinfo=timezone.utc)
            ).complete(
                "checkpoint-1",
                "checkpoint:checkpoint-1:summary:v1",
                summary=summary,
            )

        persisted = checkpoint.metadata["checkpoint_context"]
        self.assertEqual(result.status, "completed")
        self.assertEqual(persisted["intent_summary"], summary.intent_summary)
        self.assertEqual(persisted["unresolved_items"], ["确认最终发布时间"])
        self.assertEqual(persisted["decision_summary"]["intent"], summary.intent_summary)
        self.assertEqual(persisted["decision_summary"]["open_items"], ["确认最终发布时间"])
        self.assertEqual(persisted["decision_summary"]["status"], "ready")
        self.assertEqual(
            persisted["decision_summary"]["outcome_structured"],
            {"files_modified": 1},
        )
        self.assertEqual(persisted["summary_execution"]["status"], "completed")
        checkpoint.save.assert_called_once_with(using="default", update_fields=["metadata"])

    def test_active_running_claim_is_a_noop_but_stale_running_is_reclaimed_as_ambiguous(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            DjangoCheckpointSummaryStore,
        )

        now = datetime(2026, 8, 11, tzinfo=timezone.utc)
        context = _claim().checkpoint_context
        context["summary_execution"] = {
            "status": "running",
            "invocation_id": "checkpoint:checkpoint-1:summary:v1",
            "started_at": (now - timedelta(minutes=1)).isoformat(),
            "attempt_count": 1,
        }
        checkpoint = SimpleNamespace(
            id="checkpoint-1",
            organization_id="organization-1",
            editor_type="user",
            editor_id="user-1",
            agent_run_id="run-1",
            metadata={"checkpoint_context": context},
            save=MagicMock(),
        )
        queryset = MagicMock()
        queryset.select_for_update.return_value = queryset
        queryset.filter.return_value.first.return_value = checkpoint
        manager = MagicMock()
        manager.using.return_value = queryset
        fake_models = SimpleNamespace(
            SpaceCheckpoint=SimpleNamespace(objects=manager),
        )

        with (
            patch.dict(sys.modules, {"apps.collab.models": fake_models}),
            patch("django.db.transaction.atomic", return_value=nullcontext()),
            patch(
                "apps.services.common.db_router.postgres_app_db_alias",
                return_value="default",
            ),
        ):
            store = DjangoCheckpointSummaryStore(now_provider=lambda: now)
            active = store.claim("checkpoint-1")
            checkpoint.metadata["checkpoint_context"]["summary_execution"][
                "started_at"
            ] = (now - timedelta(minutes=6)).isoformat()
            stale = store.claim("checkpoint-1")

        self.assertEqual(active.status, "in_progress")
        self.assertEqual(active.retry_after_seconds, 241)
        self.assertEqual(stale.status, "claimed")
        self.assertTrue(stale.ambiguous_previous_attempt)
        self.assertEqual(
            checkpoint.metadata["checkpoint_context"]["summary_execution"][
                "attempt_count"
            ],
            2,
        )
        checkpoint.save.assert_called_once_with(using="default", update_fields=["metadata"])

    def test_partial_provider_result_is_rejected_before_completion(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CheckpointSummaryExecutionError,
            execute_checkpoint_summary,
        )

        store = SimpleNamespace(
            claim=MagicMock(return_value=_claim()),
            complete=MagicMock(),
            fail=MagicMock(),
        )
        llm_call = MagicMock(
            return_value=SimpleNamespace(
                content=json.dumps(
                    {
                        "intent_summary": "只有意图",
                        "decision_summary": {"outcome": "缺字段"},
                    },
                    ensure_ascii=False,
                )
            )
        )

        with self.assertRaises(CheckpointSummaryExecutionError) as raised:
            execute_checkpoint_summary(
                "checkpoint-1",
                store=store,
                llm_call=llm_call,
            )

        self.assertEqual(raised.exception.error_code, "CHECKPOINT_SUMMARY_INVALID_RESULT")
        store.complete.assert_not_called()
        store.fail.assert_called_once_with(
            "checkpoint-1",
            "checkpoint:checkpoint-1:summary:v1",
            "CHECKPOINT_SUMMARY_INVALID_RESULT",
        )

    def test_provider_failure_retry_reuses_invocation_and_completes_once(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CheckpointSummaryExecutionError,
            execute_checkpoint_summary,
        )

        store = _InMemoryCheckpointSummaryStore()
        invocation_ids = []

        def llm_call(**kwargs):
            invocation_ids.append(kwargs["invocation_context"].invocation_id)
            if len(invocation_ids) == 1:
                raise TimeoutError("provider timeout")
            content = json.dumps(_provider_payload(), ensure_ascii=False)
            return SimpleNamespace(content=content)

        with self.assertRaises(CheckpointSummaryExecutionError) as raised:
            execute_checkpoint_summary(
                "checkpoint-1",
                store=store,
                llm_call=llm_call,
            )
        result = execute_checkpoint_summary(
            "checkpoint-1",
            store=store,
            llm_call=llm_call,
        )

        self.assertEqual(
            raised.exception.error_code,
            "CHECKPOINT_SUMMARY_PROVIDER_FAILED",
        )
        self.assertEqual(result.status, "completed")
        self.assertEqual(
            invocation_ids,
            [
                "checkpoint:checkpoint-1:summary:v1",
                "checkpoint:checkpoint-1:summary:v1",
            ],
        )
        self.assertEqual(store.complete_count, 1)

    def test_persistence_gap_retries_same_identity_and_keeps_one_completed_result(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            CheckpointSummaryExecutionError,
            execute_checkpoint_summary,
        )

        class PersistenceGapStore(_InMemoryCheckpointSummaryStore):
            def __init__(self):
                super().__init__()
                self.persist_attempts = 0

            def complete(self, checkpoint_id, invocation_id, *, summary):
                self.persist_attempts += 1
                if self.persist_attempts == 1:
                    raise RuntimeError("commit failed")
                return super().complete(
                    checkpoint_id,
                    invocation_id,
                    summary=summary,
                )

        store = PersistenceGapStore()
        invocation_ids = []

        def llm_call(**kwargs):
            invocation_ids.append(kwargs["invocation_context"].invocation_id)
            return SimpleNamespace(
                content=json.dumps(_provider_payload(), ensure_ascii=False)
            )

        with self.assertRaises(CheckpointSummaryExecutionError) as raised:
            execute_checkpoint_summary(
                "checkpoint-1",
                store=store,
                llm_call=llm_call,
            )
        result = execute_checkpoint_summary(
            "checkpoint-1",
            store=store,
            llm_call=llm_call,
        )

        self.assertEqual(raised.exception.error_code, "CHECKPOINT_SUMMARY_PERSIST_FAILED")
        self.assertEqual(result.status, "completed")
        self.assertEqual(len(invocation_ids), 2)
        self.assertEqual(len(set(invocation_ids)), 1)
        self.assertEqual(store.complete_count, 1)
        self.assertIn("CHECKPOINT_SUMMARY_PERSIST_FAILED", store.failure_codes)

    def test_completed_duplicate_does_not_call_provider(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )

        store = _InMemoryCheckpointSummaryStore()
        store.status = "completed"
        llm_call = MagicMock()

        result = execute_checkpoint_summary(
            "checkpoint-1",
            store=store,
            llm_call=llm_call,
        )

        self.assertEqual(result.status, "completed")
        llm_call.assert_not_called()
