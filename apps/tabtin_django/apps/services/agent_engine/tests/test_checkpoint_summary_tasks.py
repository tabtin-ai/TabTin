import json
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import MagicMock, call, patch

from apps.services.agent_engine.tests.test_checkpoint_summary_execution import (
    _InMemoryCheckpointSummaryStore,
    _provider_payload,
)


def _load_checkpoint_summary_module():
    module_path = (
        Path(__file__).resolve().parents[1] / "tasks" / "checkpoint_summary.py"
    )
    spec = importlib.util.spec_from_file_location(
        "pr4_checkpoint_summary_tasks",
        module_path,
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


checkpoint_summary = _load_checkpoint_summary_module()


class CheckpointSummaryTaskTests(TestCase):
    def test_dispatcher_emits_exactly_one_composite_task(self):
        with (
            patch.object(
                checkpoint_summary,
                "_mark_decision_summary_pending",
                return_value=True,
            ) as mark_pending,
            patch.object(
                checkpoint_summary.generate_checkpoint_summary,
                "apply_async",
            ) as apply_async,
            patch.object(
                checkpoint_summary.generate_checkpoint_intent_summary,
                "delay",
            ) as old_intent_delay,
            patch.object(
                checkpoint_summary.generate_checkpoint_decision_summary,
                "apply_async",
            ) as old_decision_apply,
        ):
            checkpoint_summary.maybe_dispatch_checkpoint_summaries(
                "checkpoint-1",
                {"user_prompt": "完成发布方案"},
                diff_summary={"insertions": 100},
            )

        mark_pending.assert_called_once_with("checkpoint-1")
        apply_async.assert_called_once_with(
            args=["checkpoint-1"],
            task_id="checkpoint-summary-checkpoint-1",
            countdown=2,
        )
        old_intent_delay.assert_not_called()
        old_decision_apply.assert_not_called()

    def test_duplicate_dispatcher_delivery_finishes_one_business_execution(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )

        store = _InMemoryCheckpointSummaryStore()
        provider_call = MagicMock(
            return_value=SimpleNamespace(
                content=json.dumps(_provider_payload(), ensure_ascii=False)
            )
        )

        def run_dispatched(*, args, **kwargs):
            del kwargs
            return execute_checkpoint_summary(
                args[0],
                store=store,
                llm_call=provider_call,
            )

        with (
            patch.object(
                checkpoint_summary,
                "_mark_decision_summary_pending",
                return_value=True,
            ),
            patch.object(
                checkpoint_summary.generate_checkpoint_summary,
                "apply_async",
                side_effect=run_dispatched,
            ),
        ):
            checkpoint_summary.maybe_dispatch_checkpoint_summaries(
                "checkpoint-1",
                {"user_prompt": "完成发布方案"},
            )
            checkpoint_summary.maybe_dispatch_checkpoint_summaries(
                "checkpoint-1",
                {"user_prompt": "完成发布方案"},
            )

        provider_call.assert_called_once()
        self.assertEqual(store.complete_count, 1)

    def test_each_legacy_entrypoint_alone_produces_the_full_composite_result(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )

        legacy_tasks = (
            checkpoint_summary.generate_checkpoint_intent_summary,
            checkpoint_summary.generate_checkpoint_decision_summary,
        )
        for legacy_task in legacy_tasks:
            with self.subTest(task=legacy_task.name):
                store = _InMemoryCheckpointSummaryStore()
                provider_call = MagicMock(
                    return_value=SimpleNamespace(
                        content=json.dumps(_provider_payload(), ensure_ascii=False)
                    )
                )

                def execute_once(checkpoint_id):
                    return execute_checkpoint_summary(
                        checkpoint_id,
                        store=store,
                        llm_call=provider_call,
                    )

                with (
                    patch.object(checkpoint_summary, "close_old_connections"),
                    patch.object(
                        checkpoint_summary,
                        "_execute_checkpoint_summary_once",
                        side_effect=execute_once,
                    ),
                ):
                    result = legacy_task.run("checkpoint-1")

                self.assertEqual(result.status, "completed")
                provider_call.assert_called_once()
                self.assertEqual(
                    store.summary.intent_summary,
                    _provider_payload()["intent_summary"],
                )
                self.assertEqual(
                    store.summary.decision_summary,
                    _provider_payload()["decision_summary"],
                )
                self.assertEqual(
                    list(store.summary.unresolved_items),
                    _provider_payload()["unresolved_items"],
                )

    def test_both_legacy_task_symbols_forward_to_the_same_execution_helper(self):
        result = SimpleNamespace(status="completed")
        with (
            patch.object(checkpoint_summary, "close_old_connections"),
            patch.object(
                checkpoint_summary,
                "_execute_checkpoint_summary_once",
                return_value=result,
            ) as execute_once,
        ):
            intent_result = checkpoint_summary.generate_checkpoint_intent_summary.run(
                "checkpoint-1"
            )
            decision_result = checkpoint_summary.generate_checkpoint_decision_summary.run(
                "checkpoint-1"
            )

        self.assertIs(intent_result, result)
        self.assertIs(decision_result, result)
        self.assertEqual(
            execute_once.call_args_list,
            [
                call("checkpoint-1"),
                call("checkpoint-1"),
            ],
        )

    def test_running_duplicate_retries_after_the_durable_lease(self):
        in_progress = SimpleNamespace(
            status="in_progress",
            retry_after_seconds=241,
        )
        task = SimpleNamespace(
            retry=MagicMock(return_value="retry-scheduled"),
            MaxRetriesExceededError=type("MaxRetriesExceededError", (Exception,), {}),
        )
        with (
            patch.object(checkpoint_summary, "close_old_connections"),
            patch.object(
                checkpoint_summary,
                "_execute_checkpoint_summary_once",
                return_value=in_progress,
            ),
        ):
            result = checkpoint_summary._run_checkpoint_summary_task(
                task,
                "checkpoint-1",
            )

        self.assertEqual(result, "retry-scheduled")
        task.retry.assert_called_once_with(countdown=241)

    def test_concurrent_legacy_messages_share_the_durable_execution_claim(self):
        from apps.services.agent_engine.services.checkpoint_summary_execution import (
            execute_checkpoint_summary,
        )
        store = _InMemoryCheckpointSummaryStore()
        provider_calls = 0

        def llm_call(**kwargs):
            nonlocal provider_calls
            provider_calls += 1
            content = json.dumps(_provider_payload(), ensure_ascii=False)
            kwargs["result_validator"](content)
            return SimpleNamespace(content=content)

        def execute_once(checkpoint_id):
            return execute_checkpoint_summary(
                checkpoint_id,
                store=store,
                llm_call=llm_call,
            )

        def run_legacy(task):
            try:
                return task.run("checkpoint-1").status
            except Exception as exc:
                # Celery Retry 表示 active running duplicate 已安排在 lease 后复查。
                if exc.__class__.__name__ == "Retry":
                    return "retry"
                raise

        with (
            patch.object(checkpoint_summary, "close_old_connections"),
            patch.object(
                checkpoint_summary,
                "_execute_checkpoint_summary_once",
                side_effect=execute_once,
            ),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            results = [
                pool.submit(
                    run_legacy,
                    checkpoint_summary.generate_checkpoint_intent_summary,
                ),
                pool.submit(
                    run_legacy,
                    checkpoint_summary.generate_checkpoint_decision_summary,
                ),
            ]
            statuses = sorted(result.result(timeout=2) for result in results)

        self.assertIn("completed", statuses)
        self.assertTrue(set(statuses).issubset({"completed", "retry"}))
        self.assertEqual(provider_calls, 1)
        self.assertEqual(store.complete_count, 1)
