from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.services.agent_engine.tasks.memory import task_summary
from apps.services.llm.scenes.exceptions import WorkspaceMemoryModelUnavailable


class TaskSummaryWorkspaceMemoryModelTests(SimpleTestCase):
    organization_id = "00000000-0000-4000-8000-000000000001"
    user_id = "00000000-0000-4000-8000-000000000002"
    space_id = "00000000-0000-4000-8000-000000000003"
    workspace_model_id = "00000000-0000-4000-8000-000000000004"

    def _runtime_patches(self, runtime_calls):
        def fake_unified_llm_call(**kwargs):
            runtime_calls.append(kwargs)
            kwargs["result_validator"]('{"title":"Done"}')
            return SimpleNamespace(content='{"title":"Done"}')

        return (
            patch.object(
                task_summary,
                "_resolve_organization",
                return_value=self.organization_id,
            ),
            patch(
                "apps.agent_memory.workspace_memory_execution."
                "resolve_workspace_memory_worker",
                return_value=SimpleNamespace(
                    enabled=True,
                    selected_model_id=self.workspace_model_id,
                ),
            ),
            patch(
                "apps.tabmemo.services.record_style_service."
                "resolve_record_preference",
                return_value=(True, "concise"),
            ),
            patch(
                "apps.services.llm.services.chat.unified_llm_call",
                side_effect=fake_unified_llm_call,
            ),
        )

    def test_codex_local_conversation_does_not_block_workspace_model(self):
        runtime_calls = []
        organization, resolver, preference, runtime = self._runtime_patches(
            runtime_calls
        )
        with organization, resolver as workspace_resolver, preference, runtime:
            result = task_summary._generate_with_llm(
                [{"role": "assistant", "content": "Codex local result"}],
                user_id=self.user_id,
                space_id=self.space_id,
                thread_id="thread-codex-local",
                selected_model_id=self.workspace_model_id,
            )

        self.assertEqual(result, {"title": "Done"})
        workspace_resolver.assert_called_once_with(
            scene_key="task_summary",
            organization_id=self.organization_id,
            user_id=self.user_id,
            selected_model_id=self.workspace_model_id,
        )
        self.assertEqual(
            runtime_calls[0]["selected_model_id"],
            self.workspace_model_id,
        )

    def test_invalid_workspace_model_fails_closed_before_provider(self):
        provider_calls = []
        with patch.object(
            task_summary,
            "_resolve_organization",
            return_value=self.organization_id,
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            side_effect=WorkspaceMemoryModelUnavailable(scene_key="task_summary"),
        ), patch(
            "apps.services.llm.services.chat.unified_llm_call",
            side_effect=lambda **kwargs: provider_calls.append(kwargs),
        ):
            with self.assertRaises(WorkspaceMemoryModelUnavailable):
                task_summary._generate_with_llm(
                    [{"role": "user", "content": "hello"}],
                    user_id=self.user_id,
                    space_id=self.space_id,
                    thread_id="thread-invalid-workspace-model",
                    selected_model_id="deleted-model",
                )

        self.assertEqual(provider_calls, [])

    def test_retry_reuses_the_frozen_workspace_model_uuid(self):
        runtime_calls = []
        organization, resolver, preference, runtime = self._runtime_patches(
            runtime_calls
        )
        with organization, resolver as workspace_resolver, preference, runtime:
            for _attempt in range(2):
                task_summary._generate_with_llm(
                    [{"role": "user", "content": "hello"}],
                    user_id=self.user_id,
                    space_id=self.space_id,
                    thread_id="thread-retry",
                    selected_model_id=self.workspace_model_id,
                )

        self.assertEqual(workspace_resolver.call_count, 2)
        self.assertEqual(
            [call["selected_model_id"] for call in runtime_calls],
            [self.workspace_model_id, self.workspace_model_id],
        )

    def test_empty_snapshot_never_falls_back_to_official(self):
        provider_calls = []
        with patch.object(
            task_summary,
            "_resolve_organization",
            return_value=self.organization_id,
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            side_effect=WorkspaceMemoryModelUnavailable(scene_key="task_summary"),
        ), patch(
            "apps.services.llm.services.chat.unified_llm_call",
            side_effect=lambda **kwargs: provider_calls.append(kwargs),
        ):
            with self.assertRaises(WorkspaceMemoryModelUnavailable):
                task_summary._generate_with_llm(
                    [{"role": "user", "content": "hello"}],
                    user_id=self.user_id,
                    space_id=self.space_id,
                    thread_id="thread-no-snapshot",
                    selected_model_id="",
                )

        self.assertEqual(provider_calls, [])
