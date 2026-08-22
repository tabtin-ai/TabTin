from __future__ import annotations

import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.chat.conversation.models import ChatMessage, ChatSession
from apps.services.agent_engine.services.agent_router import (
    RoutingDecision,
    RoutingError,
    handle_routing_decision,
)
from apps.services.agent_engine.services.message_intake import (
    build_dedupe_response,
    drain_queue_until_safely_released,
)
from apps.services.agent_engine.services.message_queue_service import LockResult
from apps.services.agent_engine.services.message_queue_service import (
    MessageQueueService,
    QueueEnqueueError,
    QueueEnqueueResult,
    QueueEnqueueStatus,
    QueueHandoffError,
)
from apps.services.agent_engine.services.persistence_pipeline import (
    persist_user_messages,
)
from apps.services.agent_engine.tasks.queue_recovery import recover_chat_queue
from apps.services.agent_execution.chat_service import ChatService
from apps.tabtinspace.tests.fixtures import create_test_organization, create_test_user


class _ExecutionContext:
    is_team_space = False

    def __init__(self, user):
        self.execution_owner_user = user

    def to_message_metadata(self):
        return {}


class _QueueDouble:
    def __init__(self, acquire_results):
        self.acquire_results = list(acquire_results)
        self.collect = []
        self.release_checks = 0
        self.released = []
        self.dedupe = {}
        self.clear_dedupe_calls = []
        self.enqueue_error = None
        self.queue_full = False
        self.enqueue_once_calls = []

    def load_settings(self):
        return {
            "queue_mode": "collect",
            "queue_max": 0,
            "queue_ttl": 3600,
            "lock_ttl": 600,
            "dedupe_ttl": 300,
            "debounce_ms": 0,
        }

    def acquire_lock(self, thread_id, token, ttl=600):
        return self.acquire_results.pop(0)

    def enqueue_collect(self, thread_id, payload, ttl=3600):
        self.collect.append(payload)

    def enqueue_once(
        self,
        *,
        thread_id,
        client_event_id,
        payload,
        queued_result,
        **kwargs,
    ):
        self.enqueue_once_calls.append((thread_id, client_event_id, payload))
        if self.enqueue_error:
            raise QueueEnqueueError(str(self.enqueue_error))
        key = (thread_id, client_event_id)
        if key in self.dedupe:
            return QueueEnqueueResult(
                QueueEnqueueStatus.DUPLICATE,
                self.dedupe[key],
            )
        if self.queue_full:
            return QueueEnqueueResult(QueueEnqueueStatus.FULL, None)
        self.collect.append(payload)
        self.dedupe[key] = dict(queued_result)
        return QueueEnqueueResult(
            QueueEnqueueStatus.ENQUEUED,
            dict(queued_result),
        )

    def drain_collect(self, thread_id):
        items, self.collect = self.collect, []
        return items

    def release_lock_if_queues_empty(self, thread_id, token):
        self.release_checks += 1
        return not self.collect

    def release_lock(self, thread_id, token):
        self.released.append((thread_id, token))

    def get_dedupe_result(self, thread_id, dedupe_key):
        value = self.dedupe.get((thread_id, dedupe_key))
        if isinstance(value, str) and value.startswith("pending:"):
            return None
        return value

    def set_dedupe_pending(self, thread_id, dedupe_key, ttl, worker_id):
        key = (thread_id, dedupe_key)
        if key in self.dedupe:
            return False
        self.dedupe[key] = f"pending:{worker_id}:deadline"
        return True

    def set_dedupe_result(self, thread_id, dedupe_key, result, ttl=300):
        self.dedupe[(thread_id, dedupe_key)] = result
        return True

    def clear_dedupe_pending(self, thread_id, dedupe_key, worker_id):
        self.clear_dedupe_calls.append((thread_id, dedupe_key, worker_id))
        key = (thread_id, dedupe_key)
        value = self.dedupe.get(key, "")
        if value.startswith(f"pending:{worker_id}:"):
            self.dedupe.pop(key, None)
            return True
        return False

    def get_collect_size(self, thread_id):
        return len(self.collect)

    def try_reclaim_stale_pending(self, thread_id, dedupe_key, ttl=300):
        return False


class ChatQueueRecoveryPostgresTests(TestCase):
    databases = {"default"}

    def setUp(self):
        self.user = create_test_user(prefix="queue-recovery", nickname="Queue User")
        self.organization = create_test_organization(
            owner=self.user,
            prefix="queue-recovery",
        )
        self.session = ChatSession.objects.create(
            user=self.user,
            organization_id=str(self.organization.id),
            title="Queue recovery",
        )

    def test_device_offline_returns_structured_error_without_envelope(self):
        """设备离线：只回 error_category，不落 error_envelope（避免共享侧栏双提示）。"""
        user_message = persist_user_messages(
            self.session,
            ["ios message"],
            None,
            None,
            None,
            None,
            sender_user_id=str(self.user.id),
            client_message_id=str(uuid.uuid4()),
        )[0]
        routing = RoutingDecision(
            target="error",
            handled=True,
            dispatch_result={"published": 0},
            error=RoutingError(
                error_category="device_offline",
                user_message="执行设备离线",
                retryable=True,
            ),
        )

        with patch(
            "apps.services.common.chat_stream_publisher.ChatStreamPublisher.publish_stream_done",
        ) as publish_done:
            result = handle_routing_decision(
                routing,
                session=self.session,
                effective_thread_id=f"chat-session-{self.session.id}",
                model_instance=None,
                user_messages=[user_message],
            )

        self.assertFalse(
            ChatMessage.objects.filter(session=self.session, role="assistant").exists(),
        )
        self.assertEqual(result["error_category"], "device_offline")
        self.assertEqual(result["error_message"], "执行设备离线")
        self.assertEqual(result["message_id"], str(user_message.id))
        self.assertNotIn("error_message_id", result)
        self.assertEqual(result["reply"], "")
        self.assertTrue(result["retryable"])
        publish_done.assert_not_called()

    def test_route_error_retries_enter_route_again_in_same_dedupe_window(self):
        queue = _QueueDouble([
            LockResult.ACQUIRED,
            LockResult.ACQUIRED,
            LockResult.ACQUIRED,
            LockResult.ACQUIRED,
        ])
        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=self.session.thread_id,
            config={},
            ws_id="",
            uid=str(self.user.id),
        )

        def route_error(**kwargs):
            user_message = kwargs["ingest"].user_messages[0]
            is_device_error = "device offline" in user_message.text_summary
            return {
                "message_id": str(user_message.id),
                "reply": user_message.text_summary,
                "model_id": None,
                "model_name": None,
                "error_category": (
                    "device_offline" if is_device_error else "missing_organization_id"
                ),
                "retryable": is_device_error,
            }

        with self._chat_service_patches(queue), patch.object(
            ChatService,
            "_stage_prepare",
            return_value=prep,
        ), patch.object(
            ChatService,
            "_stage_contextualize",
            return_value=SimpleNamespace(),
        ), patch.object(
            ChatService,
            "_stage_route",
            side_effect=route_error,
        ) as route, patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service.spawn_title_thread",
        ):
            results = []
            for message, retryable in (
                ("retry while device offline", True),
                ("retry non-retryable route failure", False),
            ):
                client_event_id = str(uuid.uuid4())
                for _ in range(2):
                    results.append((
                        client_event_id,
                        retryable,
                        ChatService.send_message_sync(
                            str(self.session.id),
                            self.user,
                            message,
                            client_type="mobile",
                            client_message_id=client_event_id,
                        ),
                    ))

        self.assertEqual(route.call_count, 4)
        for client_event_id, retryable, result in results:
            self.assertEqual(result["message_id"], client_event_id)
            self.assertEqual(result["retryable"], retryable)
        self.assertEqual(len(queue.clear_dedupe_calls), 4)
        self.assertEqual(queue.dedupe, {})

    def test_route_none_returns_persisted_user_id_and_retryable(self):
        client_event_id = str(uuid.uuid4())
        prep = ChatService._PrepareResult(
            model_instance=None,
            model_fell_back=False,
            final_model_id=None,
            user_selected_model=False,
            resolved_agent_name="tin",
            effective_thread_id=self.session.thread_id,
            config={},
            ws_id="",
            uid=str(self.user.id),
        )

        with patch.object(
            ChatService,
            "_resolve_execution_context",
            return_value=_ExecutionContext(self.user),
        ), patch.object(
            ChatService,
            "_owner_execution_unavailable_response",
            return_value=None,
        ), patch.object(
            ChatService,
            "_stage_prepare",
            return_value=prep,
        ), patch.object(
            ChatService,
            "_stage_contextualize",
            return_value=SimpleNamespace(),
        ), patch.object(
            ChatService,
            "_stage_route",
            return_value=None,
        ), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service.spawn_title_thread",
        ):
            result = ChatService._process_message_sync_core(
                session=self.session,
                user=self.user,
                messages=["no route"],
                model_id=None,
                thread_id=self.session.thread_id,
                client_type="mobile",
                client_message_id=client_event_id,
            )

        self.assertEqual(result["message_id"], client_event_id)
        self.assertEqual(result["error_category"], "route_none")
        self.assertTrue(result["retryable"])
        self.assertTrue(
            ChatMessage.objects.filter(
                session=self.session,
                role="user",
                client_event_id=client_event_id,
            ).exists()
        )

    def test_held_by_other_persists_current_user_schema_and_mirrors_immediately(self):
        queue = _QueueDouble([LockResult.HELD_BY_OTHER])
        client_event_id = str(uuid.uuid4())

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ) as publish_user, patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
            return_value=True,
        ):
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "queued from ios",
                client_type="mobile",
                client_message_id=client_event_id,
            )

        message = ChatMessage.objects.get(session=self.session, role="user")
        self.assertEqual(str(message.id), client_event_id)
        self.assertEqual(str(message.client_event_id), client_event_id)
        self.assertEqual(message.message_kind, "llm")
        self.assertEqual(message.text_summary, "queued from ios")
        self.assertEqual(message.content_blocks_json[0]["text"], "queued from ios")
        publish_user.assert_called_once_with(self.session.thread_id, [message])
        self.assertEqual(queue.collect[0]["user_message_id"], str(message.id))
        self.assertEqual(result["message_id"], str(message.id))

    def test_same_client_event_held_by_other_enqueues_and_schedules_once(self):
        queue = _QueueDouble([
            LockResult.HELD_BY_OTHER,
            LockResult.HELD_BY_OTHER,
        ])
        client_event_id = str(uuid.uuid4())

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ) as publish_user, patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
            return_value=True,
        ) as schedule:
            first = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "same queued event",
                client_type="mobile",
                client_message_id=client_event_id,
            )
            second = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "same queued event",
                client_type="mobile",
                client_message_id=client_event_id,
            )

        self.assertEqual(
            ChatMessage.objects.filter(
                session=self.session,
                client_event_id=client_event_id,
            ).count(),
            1,
        )
        self.assertEqual(len(queue.collect), 1)
        self.assertEqual(len(queue.enqueue_once_calls), 2)
        self.assertEqual(schedule.call_count, 1)
        self.assertEqual(publish_user.call_count, 1)
        self.assertEqual(first["message_id"], client_event_id)
        self.assertEqual(second, first)

    def test_success_dedupe_uses_stable_event_and_restores_task_id(self):
        queue = _QueueDouble([
            LockResult.ACQUIRED,
            LockResult.ACQUIRED,
        ])
        client_event_id = str(uuid.uuid4())
        full_result = {
            "message_id": client_event_id,
            "reply": "",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "dispatched_external": True,
            "task_id": "prompt_stable_123",
        }

        with self._chat_service_patches(queue), patch.object(
            ChatService,
            "_process_message_sync_core",
            return_value=full_result,
        ) as process_core:
            first = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "same text",
                client_type="mobile",
                client_message_id=client_event_id,
            )
            second = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "changed text must still dedupe by event id",
                client_type="mobile",
                client_message_id=client_event_id,
            )

        self.assertEqual(process_core.call_count, 1)
        self.assertEqual(first["task_id"], "prompt_stable_123")
        self.assertEqual(second["task_id"], "prompt_stable_123")
        self.assertEqual(
            queue.dedupe[(self.session.thread_id, client_event_id)]["task_id"],
            "prompt_stable_123",
        )

    def test_legacy_user_id_cache_is_not_read_as_assistant_content(self):
        client_event_id = str(uuid.uuid4())
        user_message = persist_user_messages(
            self.session,
            ["legacy user"],
            None,
            None,
            None,
            None,
            sender_user_id=str(self.user.id),
            client_message_id=client_event_id,
        )[0]

        response = build_dedupe_response(
            self.session,
            str(user_message.id),
            client_message_id=client_event_id,
        )

        self.assertEqual(response["message_id"], str(user_message.id))
        self.assertEqual(response["reply"], "")

    def test_legacy_assistant_cache_reads_w3_text_summary(self):
        assistant = ChatMessage.objects.create(
            session=self.session,
            role="assistant",
            message_kind="llm",
            content_blocks_json=[{"type": "text", "text": "legacy reply"}],
            text_summary="legacy reply",
        )

        response = build_dedupe_response(self.session, str(assistant.id))

        self.assertEqual(response["message_id"], str(assistant.id))
        self.assertEqual(response["reply"], "legacy reply")

    def test_queue_full_is_persisted_retryable_nak_not_queued_ack(self):
        queue = _QueueDouble([LockResult.HELD_BY_OTHER])
        queue.queue_full = True

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
        ) as schedule:
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "queue full",
                client_type="mobile",
                client_message_id=str(uuid.uuid4()),
            )

        self.assertEqual(result["error_category"], "queue_full")
        self.assertTrue(result["retryable"])
        self.assertTrue(result["message_id"])
        self.assertEqual(queue.collect, [])
        schedule.assert_not_called()

    def test_enqueue_error_is_persisted_retryable_nak_not_queued_ack(self):
        queue = _QueueDouble([LockResult.HELD_BY_OTHER])
        queue.enqueue_error = RuntimeError("redis down")

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
        ) as schedule:
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "enqueue error",
                client_type="mobile",
                client_message_id=str(uuid.uuid4()),
            )

        self.assertEqual(result["error_category"], "queue_unavailable")
        self.assertTrue(result["retryable"])
        self.assertEqual(queue.collect, [])
        schedule.assert_not_called()

    def test_schedule_failure_reacquires_and_drains_inline(self):
        queue = _QueueDouble([
            LockResult.HELD_BY_OTHER,
            LockResult.ACQUIRED,
        ])
        client_event_id = str(uuid.uuid4())
        process_result = {
            "message_id": client_event_id,
            "reply": "",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "dispatched_external": True,
            "task_id": "prompt_inline_recovery",
        }

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
            return_value=False,
        ), patch.object(
            ChatService,
            "_process_message_sync_core",
            return_value=process_result,
        ) as process_core:
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "inline recovery",
                client_type="mobile",
                client_message_id=client_event_id,
            )

        process_core.assert_called_once()
        self.assertEqual(queue.collect, [])
        self.assertEqual(result["task_id"], "prompt_inline_recovery")

    def test_schedule_failure_and_redis_reacquire_error_is_fail_visible(self):
        queue = _QueueDouble([
            LockResult.HELD_BY_OTHER,
            LockResult.REDIS_ERROR,
        ])

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
            return_value=False,
        ):
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "no recovery owner",
                client_type="mobile",
                client_message_id=str(uuid.uuid4()),
            )

        self.assertEqual(
            result["error_category"],
            "queue_recovery_unavailable",
        )
        self.assertTrue(result["retryable"])
        self.assertNotEqual(result.get("delivery"), "queued")

    def test_late_enqueue_starts_background_recovery_without_blocking_ack(self):
        queue = _QueueDouble([LockResult.HELD_BY_OTHER])
        client_event_id = str(uuid.uuid4())

        with self._chat_service_patches(queue), patch(
            "apps.services.agent_execution.chat_service.publish_user_messages_to_stream",
        ), patch(
            "apps.services.agent_execution.chat_service._schedule_queue_recovery",
            return_value=True,
        ) as start_recovery:
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "tail message",
                client_type="mobile",
                client_message_id=client_event_id,
            )

        start_recovery.assert_called_once_with(
            session_id=str(self.session.id),
            user_id=str(self.user.id),
            thread_id=self.session.thread_id,
        )
        self.assertEqual(len(queue.collect), 1)
        self.assertEqual(result["message_id"], client_event_id)

    def test_background_recovery_reloads_context_and_drains(self):
        client_event_id = str(uuid.uuid4())
        queue = _QueueDouble([LockResult.ACQUIRED])
        queue.collect.append({
            "message": "recover me",
            "model_id": None,
            "user_message_id": client_event_id,
            "client_message_id": client_event_id,
        })

        with patch(
            "apps.services.agent_engine.services.message_queue_service.MessageQueueService",
            return_value=queue,
        ), patch.object(
            ChatService,
            "_process_message_sync_core",
            return_value={"message_id": "processed", "reply": ""},
        ) as process_core:
            recover_chat_queue.run(
                session_id=str(self.session.id),
                user_id=str(self.user.id),
                thread_id=self.session.thread_id,
            )

        process_core.assert_called_once()
        self.assertEqual(
            process_core.call_args.kwargs["user_message_ids"],
            [client_event_id],
        )
        self.assertEqual(queue.collect, [])
        self.assertEqual(queue.release_checks, 1)

    def test_main_owner_falls_back_to_release_when_atomic_handoff_fails(self):
        queue = _QueueDouble([LockResult.ACQUIRED])
        with self._chat_service_patches(queue), patch.object(
            ChatService,
            "_process_message_sync_core",
            return_value={"message_id": "assistant-id", "reply": "done"},
        ), patch(
            "apps.services.agent_execution.chat_service.drain_queue_until_safely_released",
            side_effect=QueueHandoffError("redis eval failed"),
        ):
            result = ChatService.send_message_sync(
                str(self.session.id),
                self.user,
                "main owner",
                client_type="mobile",
                client_message_id=str(uuid.uuid4()),
            )

        self.assertEqual(result["message_id"], "assistant-id")
        self.assertEqual(len(queue.released), 1)
        self.assertEqual(queue.released[0][0], self.session.thread_id)

    def _chat_service_patches(self, queue):
        return _PatchStack(
            patch(
                "apps.services.agent_engine.services.message_queue_service.MessageQueueService",
                return_value=queue,
            ),
            patch(
                "apps.chat.conversation.services.llm_model_loader.attach_llm_models_to_sessions",
            ),
            patch(
                "apps.services.agent_execution.chat_service._resolve_model",
                return_value=SimpleNamespace(instance=None),
            ),
            patch.object(
                ChatService,
                "_resolve_execution_context",
                return_value=_ExecutionContext(self.user),
            ),
            patch.object(
                ChatService,
                "_owner_execution_unavailable_response",
                return_value=None,
            ),
        )


class QueueTailHandoffTests(TestCase):
    databases = {"default"}

    def test_owner_redrains_when_atomic_release_observes_tail_enqueue(self):
        payload = {
            "message": "late",
            "model_id": None,
            "user_message_id": str(uuid.uuid4()),
            "client_message_id": str(uuid.uuid4()),
        }

        class TailQueue(_QueueDouble):
            def __init__(self):
                super().__init__([])
                self.drain_count = 0

            def drain_collect(self, thread_id):
                self.drain_count += 1
                if self.drain_count == 1:
                    return []
                if self.drain_count == 2:
                    return [payload]
                return []

            def release_lock_if_queues_empty(self, thread_id, token):
                self.release_checks += 1
                return self.release_checks > 1

        queue = TailQueue()
        processed = []

        drain_queue_until_safely_released(
            session=SimpleNamespace(id="session"),
            user=SimpleNamespace(id="user"),
            thread_id="chat-session-tail",
            queue_service=queue,
            queue_settings=queue.load_settings(),
            lock_token="owner-token",
            process_fn=lambda **kwargs: processed.append(kwargs) or {},
            error_fn=lambda *args: None,
        )

        self.assertEqual(len(processed), 1)
        self.assertEqual(processed[0]["messages"], ["late"])
        self.assertEqual(queue.release_checks, 2)

    def test_atomic_handoff_redis_error_raises(self):
        queue = object.__new__(MessageQueueService)
        queue._redis = MagicMock()
        queue._redis.eval.side_effect = RuntimeError("redis unavailable")

        with self.assertRaises(QueueHandoffError):
            queue.release_lock_if_queues_empty("chat-session-1", "token")
        queue._redis.eval.assert_called_once()

    def test_drain_propagates_handoff_error_without_hot_loop(self):
        queue = _QueueDouble([])
        queue.release_lock_if_queues_empty = MagicMock(
            side_effect=QueueHandoffError("redis unavailable"),
        )

        with self.assertRaises(QueueHandoffError):
            drain_queue_until_safely_released(
                session=SimpleNamespace(id="session"),
                user=SimpleNamespace(id="user"),
                thread_id="chat-session-tail",
                queue_service=queue,
                queue_settings=queue.load_settings(),
                lock_token="owner-token",
                process_fn=lambda **kwargs: {},
                error_fn=lambda *args: None,
            )

        queue.release_lock_if_queues_empty.assert_called_once()

    def test_atomic_enqueue_once_decodes_full_result_and_legacy_duplicate(self):
        queue = object.__new__(MessageQueueService)
        queue._redis = MagicMock()
        queued_result = {
            "message_id": "user-1",
            "task_id": "prompt-1",
            "delivery": "queued",
        }
        encoded = MessageQueueService.encode_dedupe_result(queued_result)
        queue._redis.eval.side_effect = [
            [1, encoded],
            [0, encoded],
            [0, "legacy-assistant-id"],
        ]

        kwargs = dict(
            thread_id="chat-session-1",
            client_event_id="client-event-1",
            payload={"message": "hello"},
            queued_result=queued_result,
            mode="collect",
            queue_max=50,
            queue_ttl=3600,
            dedupe_ttl=300,
            debounce_ms=0,
        )
        first = queue.enqueue_once(**kwargs)
        duplicate = queue.enqueue_once(**kwargs)
        legacy = queue.enqueue_once(**kwargs)

        self.assertEqual(first.status, QueueEnqueueStatus.ENQUEUED)
        self.assertEqual(duplicate.status, QueueEnqueueStatus.DUPLICATE)
        self.assertEqual(duplicate.cached_result["task_id"], "prompt-1")
        self.assertEqual(legacy.cached_result, "legacy-assistant-id")
        self.assertIsNone(
            MessageQueueService.decode_dedupe_result(
                "pending:worker:9999999999"
            )
        )
        # dedupe marker 至少与 1h queue TTL 同寿命。
        first_call = queue._redis.eval.call_args_list[0].args
        self.assertIn("3600", first_call)

    def test_atomic_enqueue_once_full_or_redis_error_never_reports_enqueued(self):
        queue = object.__new__(MessageQueueService)
        queue._redis = MagicMock()
        queue._redis.eval.return_value = [-1, ""]
        kwargs = dict(
            thread_id="chat-session-1",
            client_event_id="client-event-1",
            payload={"message": "hello"},
            queued_result={"message_id": "user-1"},
            mode="collect",
        )

        full = queue.enqueue_once(**kwargs)
        self.assertEqual(full.status, QueueEnqueueStatus.FULL)

        queue._redis.eval.side_effect = RuntimeError("redis down")
        with self.assertRaises(QueueEnqueueError):
            queue.enqueue_once(**kwargs)


class _PatchStack:
    def __init__(self, *patchers):
        self.patchers = patchers

    def __enter__(self):
        for patcher in self.patchers:
            patcher.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        for patcher in reversed(self.patchers):
            patcher.stop()
