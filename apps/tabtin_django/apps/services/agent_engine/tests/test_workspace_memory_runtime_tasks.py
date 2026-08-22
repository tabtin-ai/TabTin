from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

class AutoMemoryWorkerGuardTests(SimpleTestCase):
    def test_memory_capture_uses_workspace_model_snapshot(self):
        from apps.services.agent_engine.tasks.memory.capture import (
            _do_extract_memories,
        )

        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=SimpleNamespace(
                enabled=True,
                selected_model_id="workspace-model-a",
            ),
        ), patch(
            "apps.services.agent_engine.tasks.memory.capture."
            "_resolve_effective_agent_id",
            return_value="agent-1",
        ), patch(
            "apps.services.agent_engine.tasks.memory.capture._extract_with_llm",
            return_value=[],
        ) as provider:
            result = _do_extract_memories(
                None,
                "space-1",
                "user-1",
                "thread-1",
                [{"role": "user", "content": "remember"}],
                agent_id="agent-1",
                selected_model_id="workspace-model-a",
            )

        self.assertTrue(result)
        self.assertEqual(
            provider.call_args.kwargs["selected_model_id"],
            "workspace-model-a",
        )

    def test_memory_capture_off_stops_before_provider_and_persistence(self):
        from apps.services.agent_engine.tasks.memory.capture import (
            _do_extract_memories,
        )

        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=SimpleNamespace(enabled=False),
        ), patch(
            "apps.services.agent_engine.tasks.memory.capture._extract_with_llm",
        ) as provider, patch(
            "apps.services.agent_engine.tasks.memory.capture._write_to_table",
        ) as persistence:
            result = _do_extract_memories(
                None,
                "space-1",
                "user-1",
                "thread-1",
                [{"role": "user", "content": "remember"}],
                selected_model_id="official-model",
            )

        self.assertTrue(result)
        provider.assert_not_called()
        persistence.assert_not_called()

    def test_invalid_workspace_model_is_blocked_before_provider(self):
        from apps.services.agent_engine.tasks.memory.capture import (
            _do_extract_memories,
        )

        from apps.services.llm.scenes.exceptions import (
            WorkspaceMemoryModelUnavailable,
        )

        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            side_effect=WorkspaceMemoryModelUnavailable(
                scene_key="memory_capture"
            ),
        ), patch(
            "apps.services.agent_engine.tasks.memory.capture._extract_with_llm",
        ) as provider:
            with self.assertRaises(WorkspaceMemoryModelUnavailable):
                _do_extract_memories(
                    None,
                    "space-1",
                    "user-1",
                    "thread-1",
                    [{"role": "user", "content": "remember"}],
                    selected_model_id="deleted-workspace-model",
                )

        provider.assert_not_called()

    def test_diary_off_stops_before_input_and_provider(self):
        from apps.services.agent_engine.tasks.memory.daily_diary import (
            distill_daily_diary_task,
        )

        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=SimpleNamespace(enabled=False),
        ), patch(
            "apps.agent_memory.repository.AgentMemoryRepository.aggregate_scope",
        ) as input_query, patch(
            "apps.services.llm.services.chat.unified_llm_call",
        ) as provider:
            result = distill_daily_diary_task.run(
                user_id="user-1",
                organization_id="organization-1",
                agent_id="agent-1",
                selected_model_id="model-a",
            )

        self.assertEqual(result["reason"], "auto_memory_disabled")
        input_query.assert_not_called()
        provider.assert_not_called()

    def test_portrait_off_stops_before_user_and_provider(self):
        from apps.user_portrait.tasks import distill_portrait_task

        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=SimpleNamespace(enabled=False),
        ), patch("django.contrib.auth.get_user_model") as user_model, patch(
            "apps.services.llm.services.chat.unified_llm_call"
        ) as provider:
            result = distill_portrait_task.run(
                user_id="user-1",
                organization_id="organization-1",
                agent_id="agent-1",
                selected_model_id="model-a",
            )

        self.assertEqual(result["reason"], "auto_memory_disabled")
        user_model.assert_not_called()
        provider.assert_not_called()

    def test_compaction_off_stops_before_memory_scan_and_provider(self):
        from apps.services.agent_engine.tasks.memory.compaction import (
            compact_memories_task,
        )

        with patch(
            "apps.services.billing.organization_resolver."
            "resolve_organization_id_from_space",
            return_value="organization-1",
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=SimpleNamespace(enabled=False),
        ), patch(
            "apps.services.agent_engine.tasks.memory.compaction._find_similar_groups"
        ) as memory_scan, patch(
            "apps.services.llm.services.chat.unified_llm_call"
        ) as provider:
            result = compact_memories_task.run(
                space_id="space-1",
                user_id="user-1",
                selected_model_id="model-a",
            )

        self.assertIsNone(result)
        memory_scan.assert_not_called()
        provider.assert_not_called()


class AggregateMemoryProducerSnapshotTests(SimpleTestCase):
    def test_idle_settlement_capture_carries_workspace_snapshot(self):
        from apps.services.agent_engine.tasks.memory.idle_settlement import (
            _extract_remaining,
        )

        messages = [
            {"role": "user", "content": "remember this"},
            {"role": "assistant", "content": "done", "agent_id": "agent-1"},
        ]
        with patch(
            "apps.services.agent_engine.tasks.memory.idle_settlement."
            "_group_messages_by_agent",
            return_value={"agent-1": messages},
        ), patch(
            "apps.services.agent_engine.tasks.memory.capture._do_extract_memories",
        ) as capture:
            _extract_remaining(
                space_id="space-1",
                user_id="user-1",
                session_id="thread-1",
                messages=messages,
                extracted_index=0,
                dedup_threshold=0.8,
                selected_model_id="workspace-model-a",
            )

        self.assertEqual(
            capture.call_args.kwargs["selected_model_id"],
            "workspace-model-a",
        )

    def test_capture_producer_uses_workspace_model_not_conversation_model(self):
        from apps.services.agent_engine.tasks.memory.relay_memory_trigger import (
            _resolve_memory_ctx_from_session,
        )

        session = SimpleNamespace(
            id="session-1",
            workspace_id="space-1",
            workspace=SimpleNamespace(organization_id="organization-1"),
            agent=SimpleNamespace(agent_config={}),
        )
        session_query = MagicMock()
        session_query.select_related.return_value.filter.return_value.only.return_value.first.return_value = session
        execution = SimpleNamespace(
            enabled=True,
            selected_model_id="workspace-model-a",
        )

        with patch(
            "apps.chat.conversation.models.ChatSession.objects",
            session_query,
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            return_value=execution,
        ) as resolver, patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.is_memory_enabled_for_organization",
            return_value=True,
        ) as legacy_gate:
            result = _resolve_memory_ctx_from_session("session-1", "user-1")

        self.assertEqual(result["selected_model_id"], "workspace-model-a")
        resolver.assert_called_once_with(
            scene_key="memory_capture",
            organization_id="organization-1",
            user_id="user-1",
        )
        legacy_gate.assert_called_once()

    def test_idle_dispatch_freezes_separate_workspace_models(self):
        from datetime import timedelta

        from django.utils import timezone

        from apps.services.agent_engine.tasks.memory.idle_settlement import (
            dispatch_idle_settlement,
            settle_idle_session_task,
        )

        session = SimpleNamespace(
            id="session-1",
            thread_id="thread-codex-local",
            user_id="user-1",
            workspace_id="space-1",
            agent_id="agent-1",
            updated_at=timezone.now() - timedelta(hours=1),
            current_model_id="gpt-5.6-sol",
        )
        session_query = MagicMock()
        session_query.filter.return_value.only.return_value.__getitem__.return_value = [
            session
        ]
        workspace = SimpleNamespace(
            id="space-1",
            organization_id="organization-1",
        )
        agent = SimpleNamespace(id="agent-1", agent_config={})
        workspace_manager = MagicMock()
        workspace_manager.filter.return_value.only.return_value = [workspace]
        agent_manager = MagicMock()
        agent_manager.filter.return_value.only.return_value = [agent]
        capture_execution = SimpleNamespace(
            enabled=True,
            selected_model_id="00000000-0000-4000-8000-000000000601",
        )
        summary_execution = SimpleNamespace(
            enabled=True,
            selected_model_id="00000000-0000-4000-8000-000000000602",
        )

        def resolve_scene(**kwargs):
            if kwargs["scene_key"] == "memory_capture":
                return capture_execution
            return summary_execution

        with patch(
            "apps.chat.conversation.models.ChatSession.objects",
            session_query,
        ), patch(
            "apps.tabtinspace.models.Workspace.objects",
            workspace_manager,
        ), patch(
            "apps.tabtinspace.models.Agent.objects",
            agent_manager,
        ), patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.is_memory_enabled_for_organization",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.get_memory_config",
            return_value={"observer": {"idle_timeout_minutes": 5}},
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            side_effect=resolve_scene,
        ) as resolver, patch.object(
            settle_idle_session_task,
            "apply_async",
        ) as apply_async:
            dispatch_idle_settlement.run()

        self.assertEqual(
            apply_async.call_args.kwargs["kwargs"]["memory_capture_model_id"],
            capture_execution.selected_model_id,
        )
        self.assertEqual(
            apply_async.call_args.kwargs["kwargs"]["task_summary_model_id"],
            summary_execution.selected_model_id,
        )
        self.assertNotIn(
            "selected_model_id",
            apply_async.call_args.kwargs["kwargs"],
        )
        self.assertEqual(
            [call.kwargs["scene_key"] for call in resolver.call_args_list],
            ["task_summary", "memory_capture"],
        )

    def test_idle_dispatch_stops_when_auto_memory_is_off(self):
        from datetime import timedelta

        from django.utils import timezone

        from apps.services.agent_engine.tasks.memory.idle_settlement import (
            dispatch_idle_settlement,
            settle_idle_session_task,
        )

        session = SimpleNamespace(
            id="session-1",
            thread_id="thread-1",
            user_id="user-1",
            workspace_id="space-1",
            agent_id="agent-1",
            updated_at=timezone.now() - timedelta(hours=1),
        )
        session_query = MagicMock()
        session_query.filter.return_value.only.return_value.__getitem__.return_value = [
            session
        ]
        workspace_manager = MagicMock()
        workspace_manager.filter.return_value.only.return_value = [
            SimpleNamespace(id="space-1", organization_id="organization-1")
        ]
        agent_manager = MagicMock()
        agent_manager.filter.return_value.only.return_value = [
            SimpleNamespace(id="agent-1", agent_config={})
        ]

        def resolve_scene(**kwargs):
            return SimpleNamespace(enabled=False, selected_model_id="")

        with patch(
            "apps.chat.conversation.models.ChatSession.objects",
            session_query,
        ), patch(
            "apps.tabtinspace.models.Workspace.objects",
            workspace_manager,
        ), patch(
            "apps.tabtinspace.models.Agent.objects",
            agent_manager,
        ), patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.is_memory_enabled_for_organization",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.get_memory_config",
            return_value={"observer": {"idle_timeout_minutes": 5}},
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            side_effect=resolve_scene,
        ), patch.object(
            settle_idle_session_task,
            "apply_async",
        ) as apply_async:
            dispatch_idle_settlement.run()

        apply_async.assert_not_called()

    def test_diary_dispatch_carries_exact_model_snapshot(self):
        from apps.services.agent_engine.tasks.memory.daily_diary import (
            dispatch_daily_diary,
            distill_daily_diary_task,
        )

        groups = [{
            "organization_id": "organization-1",
            "owner_id": "user-1",
            "agent_id": "agent-1",
        }]
        query = MagicMock()
        query.filter.return_value.exclude.return_value.values.return_value.distinct.return_value = groups
        execution = SimpleNamespace(
            enabled=True,
            selected_model_id="00000000-0000-4000-8000-000000000501",
        )
        with patch(
            "apps.agent_memory.repository.AgentMemoryRepository.base_qs",
            return_value=query,
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            return_value=execution,
        ), patch.object(distill_daily_diary_task, "delay") as delay:
            result = dispatch_daily_diary.run(target_date="2026-08-12")

        self.assertEqual(result["dispatched"], 1)
        self.assertEqual(
            delay.call_args.kwargs["selected_model_id"],
            execution.selected_model_id,
        )

    def test_portrait_scan_carries_exact_model_snapshot(self):
        from apps.user_portrait.models import UserPortrait
        from apps.user_portrait.tasks import (
            distill_portrait_task,
            scan_portraits_for_distill_task,
        )

        portrait = SimpleNamespace(
            user_id="user-1",
            organization_id="organization-1",
            agent_id="agent-1",
            last_distill_status=UserPortrait.DistillStatus.IDLE,
            pending_hints=[],
            last_distilled_at=None,
        )
        portrait_manager = MagicMock()
        portrait_query = MagicMock()
        portrait_query.iterator.return_value = [portrait]
        portrait_manager.using.return_value.exclude.return_value = portrait_query
        execution = SimpleNamespace(
            enabled=True,
            selected_model_id="00000000-0000-4000-8000-000000000502",
        )
        with patch(
            "apps.user_portrait.models.UserPortrait.objects",
            portrait_manager,
        ), patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(True, ""),
        ), patch(
            "apps.user_portrait.services.distill_service.has_new_memos_since",
            return_value=True,
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            return_value=execution,
        ), patch.object(distill_portrait_task, "delay") as delay:
            result = scan_portraits_for_distill_task.run(dry_run=False)

        self.assertEqual(result["triggered"], 1)
        self.assertEqual(
            delay.call_args.kwargs["selected_model_id"],
            execution.selected_model_id,
        )

    def test_compaction_dispatch_carries_exact_model_snapshot(self):
        from apps.services.agent_engine.tasks.memory.compaction import (
            compact_memories_task,
            dispatch_compaction_for_all_spaces,
        )

        pair_query = MagicMock()
        pair_query.__getitem__.return_value = [("agent-1", "user-1")]
        memo_query = MagicMock()
        memo_query.filter.return_value.values_list.return_value.distinct.return_value.order_by.return_value = pair_query
        redis = MagicMock()
        redis.get.return_value = None
        execution = SimpleNamespace(
            enabled=True,
            selected_model_id="00000000-0000-4000-8000-000000000503",
        )
        with patch(
            "django_redis.get_redis_connection",
            return_value=redis,
        ), patch(
            "apps.services.agent_engine.utils.memory_constants."
            "get_agent_memo_queryset",
            return_value=memo_query,
        ), patch(
            "apps.services.agent_engine.utils.memory_constants."
            "resolve_workspace_space_ids_for_agents",
            return_value={"agent-1": "space-1"},
        ), patch(
            "apps.services.agent_engine.services.memory_table_service."
            "MemoryTableService.is_memory_enabled_for",
            return_value=True,
        ), patch(
            "apps.services.billing.organization_resolver."
            "resolve_organization_id_from_space",
            return_value="organization-1",
        ), patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_dispatch",
            return_value=execution,
        ), patch.object(compact_memories_task, "apply_async") as apply_async:
            dispatch_compaction_for_all_spaces.run()

        self.assertEqual(
            apply_async.call_args.kwargs["kwargs"]["selected_model_id"],
            execution.selected_model_id,
        )


class AggregateMemoryWorkerSnapshotTests(SimpleTestCase):
    def test_diary_passes_worker_snapshot_to_invocation_and_runtime(self):
        from apps.services.agent_engine.tasks.memory.daily_diary import (
            distill_daily_diary_task,
        )

        selected_model_id = "00000000-0000-4000-8000-000000000501"
        execution = SimpleNamespace(
            enabled=True,
            selected_model_id=selected_model_id,
        )
        summary = SimpleNamespace(
            title="Done",
            content_markdown="A sufficiently long completed task summary for diary.",
            content_plaintext="",
        )
        query = MagicMock()
        query.filter.return_value.order_by.return_value = [summary]
        memo = SimpleNamespace(id="memo-1")
        with patch(
            "apps.agent_memory.workspace_memory_execution."
            "resolve_workspace_memory_worker",
            return_value=execution,
        ), patch(
            "apps.tabmemo.services.record_style_service.resolve_record_preference",
            return_value=(True, ""),
        ), patch(
            "apps.agent_memory.repository.AgentMemoryRepository.aggregate_scope",
            return_value=query,
        ), patch(
            "apps.services.llm.services.chat.unified_llm_call",
            return_value=SimpleNamespace(
                content=(
                    '{"title":"Diary","diary":"A sufficiently long diary '
                    'result for validation and persistence."}'
                )
            ),
        ) as provider, patch(
            "apps.services.agent_engine.tasks.memory.daily_diary._upsert_diary",
            return_value=memo,
        ):
            result = distill_daily_diary_task.run(
                user_id="user-1",
                organization_id="organization-1",
                agent_id="agent-1",
                target_date="2026-08-12",
                selected_model_id=selected_model_id,
            )

        self.assertTrue(result["success"])
        self.assertEqual(provider.call_args.kwargs["selected_model_id"], selected_model_id)
        self.assertEqual(
            provider.call_args.kwargs["invocation_context"].selected_model_id,
            selected_model_id,
        )

    def test_compaction_passes_worker_snapshot_to_invocation_and_runtime(self):
        from apps.services.agent_engine.tasks.memory.compaction import _merge_group

        selected_model_id = "00000000-0000-4000-8000-000000000502"
        group = [
            {
                "memo_id": "old-1",
                "organization_id": "organization-1",
                "owner_id": "user-1",
                "agent_id": "agent-1",
                "content": "same memory one",
            },
            {
                "memo_id": "old-2",
                "organization_id": "organization-1",
                "owner_id": "user-1",
                "agent_id": "agent-1",
                "content": "same memory two",
            },
        ]
        with patch(
            "apps.services.billing.organization_resolver."
            "resolve_organization_id_from_space",
            return_value="organization-1",
        ), patch(
            "apps.services.agent_engine.utils.memory_constants."
            "resolve_space_execution_agent_id",
            return_value="agent-1",
        ), patch(
            "apps.services.llm.services.chat.unified_llm_call",
            return_value=SimpleNamespace(
                content='{"content":"merged","type":"事实","importance":3}'
            ),
        ) as provider, patch(
            "apps.agent_memory.repository.AgentMemoryRepository.create",
            return_value=SimpleNamespace(id="new-1"),
        ), patch(
            "apps.services.agent_engine.tasks.memory.compaction._archive_old_memos",
            return_value=["old-1", "old-2"],
        ), patch(
            "apps.services.agent_engine.tasks.memory.compaction._count_active_memos",
            return_value=0,
        ):
            result = _merge_group(
                group,
                "space-1",
                "user-1",
                selected_model_id=selected_model_id,
            )

        self.assertTrue(result)
        self.assertEqual(provider.call_args.kwargs["selected_model_id"], selected_model_id)
        self.assertEqual(
            provider.call_args.kwargs["invocation_context"].selected_model_id,
            selected_model_id,
        )
