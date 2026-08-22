import importlib.util
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

_TASK_SUMMARY_MODULE = None


def _load_task_summary_module():
    global _TASK_SUMMARY_MODULE
    if _TASK_SUMMARY_MODULE is not None:
        return _TASK_SUMMARY_MODULE
    module_path = (
        Path(__file__).parents[2]
        / "agent_engine"
        / "tasks"
        / "memory"
        / "task_summary.py"
    )
    spec = importlib.util.spec_from_file_location("task_summary_under_test", module_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    _TASK_SUMMARY_MODULE = module
    return _TASK_SUMMARY_MODULE


class TaskSummaryInvocationTests(SimpleTestCase):
    def test_thread_identity_is_reused_for_task_summary_retries(self):
        task_summary = _load_task_summary_module()

        captured_contexts = []

        def fake_llm_call(**kwargs):
            captured_contexts.append(kwargs["invocation_context"])
            kwargs["result_validator"]('{"title":"Done"}')
            return SimpleNamespace(content='{"title":"Done"}')

        fake_modules = {
            "apps.agent_memory.workspace_memory_execution": SimpleNamespace(
                resolve_workspace_memory_worker=lambda **kwargs: SimpleNamespace(
                    enabled=True,
                    selected_model_id="00000000-0000-4000-8000-000000000501",
                )
            ),
            "apps.tabmemo.services.record_style_service": SimpleNamespace(
                resolve_record_preference=lambda *args: (True, "concise")
            ),
            "apps.services.llm.services.chat": SimpleNamespace(
                unified_llm_call=fake_llm_call
            ),
            "apps.services.agent_engine.utils.memory_utils": SimpleNamespace(
                strip_code_fence=lambda content: content
            ),
        }
        with patch.object(task_summary, "_resolve_organization", return_value="org-1"), patch.dict(
            sys.modules, fake_modules
        ):
            first = task_summary._generate_with_llm(
                [{"role": "user", "content": "hello"}],
                user_id="user-1",
                space_id="space-1",
                thread_id="thread-1",
                task_id="celery-1",
                retry_source="celery",
                selected_model_id="00000000-0000-4000-8000-000000000501",
            )
            second = task_summary._generate_with_llm(
                [{"role": "user", "content": "hello"}],
                user_id="user-1",
                space_id="space-1",
                thread_id="thread-1",
                task_id="celery-1",
                retry_source="celery",
                selected_model_id="00000000-0000-4000-8000-000000000501",
            )

        self.assertEqual(first, {"title": "Done"})
        self.assertEqual(second, {"title": "Done"})
        self.assertEqual(
            [context.invocation_id for context in captured_contexts],
            ["task_summary:thread-1:v1", "task_summary:thread-1:v1"],
        )
        self.assertTrue(all(context.stable_invocation for context in captured_contexts))
        self.assertTrue(all(context.business_object_id == "thread-1" for context in captured_contexts))
        self.assertTrue(
            all(
                context.selected_model_id
                == "00000000-0000-4000-8000-000000000501"
                for context in captured_contexts
            )
        )

    def test_invalid_task_summary_is_rejected_by_caller_validator(self):
        task_summary = _load_task_summary_module()

        def fake_llm_call(**kwargs):
            kwargs["result_validator"]("not-json")
            raise AssertionError("validator should reject before result is returned")

        fake_modules = {
            "apps.agent_memory.workspace_memory_execution": SimpleNamespace(
                resolve_workspace_memory_worker=lambda **kwargs: SimpleNamespace(
                    enabled=True,
                    selected_model_id="00000000-0000-4000-8000-000000000501",
                )
            ),
            "apps.tabmemo.services.record_style_service": SimpleNamespace(
                resolve_record_preference=lambda *args: (True, "concise")
            ),
            "apps.services.llm.services.chat": SimpleNamespace(
                unified_llm_call=fake_llm_call
            ),
            "apps.services.agent_engine.utils.memory_utils": SimpleNamespace(
                strip_code_fence=lambda content: content
            ),
        }
        with patch.object(task_summary, "_resolve_organization", return_value="org-1"), patch.dict(
            sys.modules, fake_modules
        ):
            result = task_summary._generate_with_llm(
                [{"role": "user", "content": "hello"}],
                user_id="user-1",
                space_id="space-1",
                thread_id="thread-1",
                selected_model_id="00000000-0000-4000-8000-000000000501",
            )

        self.assertEqual(result, {})
