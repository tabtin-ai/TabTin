"""
M2.5 relay_handler 分流逻辑测试

覆盖：
  1. 事件分类：关键事件 vs 细节事件
  2. 关键事件同步写入后 ACK 返回 message_ids
  3. 同步写失败返回 NAK
  4. 细节事件异步写（不阻塞 ACK）
  5. 混合批次正确分流
  6. relay_message_writer 幂等写入
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from types import SimpleNamespace

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from unittest.mock import MagicMock, patch, AsyncMock  # noqa: E402

from apps.services.common.ws.handlers.relay_handler import (  # noqa: E402
    _classify_event,
    create_relay_events_handler,
    drain_deferred_relay_side_effects_for_tests,
)
from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    CRITICAL_EVENT_TYPES,
    MESSAGE_EVENT_TYPES,
    SyncWriteResult,
    _finalize_pending_revert_for_relay_user_message,
    _short_name,
    _sync_write_critical_events,
    build_chat_message_metadata,
)


async def _run_relay_handler(handler, envelope):
    """跑完 handler 后排空 ACK 后 deferred publish/notify。"""
    await handler(envelope)
    await drain_deferred_relay_side_effects_for_tests()


class TestClassifyEvent:
    """事件分类：critical vs detail。"""

    @pytest.mark.parametrize("short_name", [
        "user", "assistant", "tool", "state_snapshot", "done",
        "lifecycle", "approval_requested", "approval_resolved",
        "ask_choice_required", "ask_form_required", "request_approval_required",
        "billing",
    ])
    def test_critical_events(self, short_name: str):
        assert _classify_event(short_name) == "critical"

    @pytest.mark.parametrize("short_name", [
        "step", "compaction", "context_pressure", "reasoning",
        "chunk", "system_notice", "todo", "ssh_output",
        "subagent_started", "subagent_progress", "subagent_completed",
        "subagent_failed", "content_reset", "rich_content",
        "llm_heartbeat", "monitor_status", "tool_heartbeat",
        "message_persisted",
        # NB: ``title_updated`` 已切到 ``agent.user.*`` 用户级广播命名空间
        # （W1 用户级事件治理），stream relay 不再产生此短名，故从 fixture
        # 移除——避免回归到把 user-level 事件错塞回 stream relay 通道。
        "tool_timeout", "persist_error",
    ])
    def test_detail_events(self, short_name: str):
        assert _classify_event(short_name) == "detail"


class TestCriticalEventTypes:
    """CRITICAL_EVENT_TYPES 集合完整性。"""

    def test_user_is_critical(self):
        assert "user" in CRITICAL_EVENT_TYPES

    def test_assistant_is_critical(self):
        assert "assistant" in CRITICAL_EVENT_TYPES

    def test_state_snapshot_is_critical(self):
        assert "state_snapshot" in CRITICAL_EVENT_TYPES

    def test_done_is_critical(self):
        assert "done" in CRITICAL_EVENT_TYPES

    def test_tool_is_critical(self):
        assert "tool" in CRITICAL_EVENT_TYPES

    def test_billing_is_critical(self):
        assert "billing" in CRITICAL_EVENT_TYPES


class TestMessageEventTypes:
    """MESSAGE_EVENT_TYPES 只包含会产生 ChatMessage 的事件。"""

    def test_user_creates_message(self):
        assert "user" in MESSAGE_EVENT_TYPES

    def test_assistant_creates_message(self):
        assert "assistant" in MESSAGE_EVENT_TYPES

    def test_tool_does_not_create_message(self):
        assert "tool" not in MESSAGE_EVENT_TYPES

    def test_lifecycle_does_not_create_message(self):
        assert "lifecycle" not in MESSAGE_EVENT_TYPES


class TestShortName:
    """_short_name 从完整事件类型提取短名。"""

    def test_strips_prefix(self):
        assert _short_name({"type": "agent.stream.user"}) == "user"
        assert _short_name({"type": "agent.stream.assistant"}) == "assistant"

    def test_no_prefix_passthrough(self):
        assert _short_name({"type": "lifecycle"}) == "lifecycle"

    def test_empty_type(self):
        assert _short_name({}) == ""


class TestSyncWriteResult:
    """SyncWriteResult 数据类。"""

    def test_default_success(self):
        r = SyncWriteResult()
        assert r.success is True
        assert r.message_ids == []
        assert r.events_written == 0
        assert r.error is None

    def test_with_message_ids(self):
        r = SyncWriteResult(
            success=True,
            message_ids=[
                {"client_event_id": "abc", "server_id": "xyz"},
            ],
            events_written=1,
        )
        assert len(r.message_ids) == 1
        assert r.message_ids[0]["client_event_id"] == "abc"


class TestRelayRevertFinalizeOnUserMessage:
    """#4528：relay 路径发真实 user 消息前清算软回退态，且清算是写入的原子前置。

    架构迁移后 Electron/Daemon 发消息走 relay，不再经 ChatService._stage_prepare，
    原 cleanup_reverted_messages 触发点缺失，导致回退态 revert_message_id 永不清除。
    覆盖 relay 写 user 前的清算：仅真实用户输入 + 处于回退态才触发，排除
    environment / agent-profile context 系统注入与 assistant 事件；清算成功返回 True 放行写入，
    清算失败返回 False（fail-loud）让调用方 NAK 重投，不再静默吞异常。
    """

    _CLEANUP = (
        "apps.services.agent_engine.services.persistence_pipeline."
        "cleanup_reverted_messages"
    )
    _SESSION = "apps.chat.conversation.models.ChatSession"

    def _user_evt(self, message_kind: str | None = None) -> dict:
        payload = {"client_event_id": str(uuid.uuid4()), "content": "继续"}
        if message_kind:
            payload["message_kind"] = message_kind
        return {"type": "agent.stream.user", "payload": payload}

    def _assistant_evt(self) -> dict:
        return {"type": "agent.stream.assistant", "payload": {"client_event_id": str(uuid.uuid4())}}

    def test_real_user_message_in_revert_triggers_cleanup(self):
        session = MagicMock()
        session.revert_message_id = uuid.uuid4()
        with patch(self._SESSION) as CS, patch(self._CLEANUP) as cleanup:
            CS.objects.filter.return_value.first.return_value = session
            ok = _finalize_pending_revert_for_relay_user_message("s1", [self._user_evt()])
        cleanup.assert_called_once_with(session)
        assert ok is True

    def test_not_in_revert_state_no_cleanup(self):
        session = MagicMock()
        session.revert_message_id = None
        with patch(self._SESSION) as CS, patch(self._CLEANUP) as cleanup:
            CS.objects.filter.return_value.first.return_value = session
            ok = _finalize_pending_revert_for_relay_user_message("s1", [self._user_evt()])
        cleanup.assert_not_called()
        assert ok is True

    def test_environment_context_does_not_trigger_cleanup(self):
        with patch(self._CLEANUP) as cleanup:
            ok = _finalize_pending_revert_for_relay_user_message(
                "s1", [self._user_evt(message_kind="environment_context")],
            )
        cleanup.assert_not_called()
        assert ok is True

    def test_agent_profile_context_does_not_trigger_cleanup(self):
        with patch(self._CLEANUP) as cleanup:
            ok = _finalize_pending_revert_for_relay_user_message(
                "s1", [self._user_evt(message_kind="agent_profile_context")],

    def test_system_prompt_context_does_not_trigger_cleanup(self):
        with patch(self._CLEANUP) as cleanup:
            ok = _finalize_pending_revert_for_relay_user_message(
                "s1", [self._user_evt(message_kind="system_prompt_context")],
            )
        cleanup.assert_not_called()
        assert ok is True

    def test_assistant_only_does_not_trigger_cleanup(self):
        with patch(self._CLEANUP) as cleanup:
            ok = _finalize_pending_revert_for_relay_user_message("s1", [self._assistant_evt()])
        cleanup.assert_not_called()
        assert ok is True

    def test_cleanup_failure_returns_false_for_nak(self):
        """#4528：cleanup 失败返回 False（fail-loud）——调用方据此 NAK 重投，
        不再静默吞异常带残留回退态写库（旧行为会导致横幅卡死 + 旧消息复活）。
        """
        session = MagicMock()
        session.revert_message_id = uuid.uuid4()
        with patch(self._SESSION) as CS, patch(self._CLEANUP) as cleanup:
            CS.objects.filter.return_value.first.return_value = session
            cleanup.side_effect = RuntimeError("db down")
            ok = _finalize_pending_revert_for_relay_user_message("s1", [self._user_evt()])
        cleanup.assert_called_once_with(session)
        assert ok is False


class TestRelayHandlerIntegration:
    """relay_handler 集成级测试（mock consumer + DB 交互）。"""

    def _make_event(self, short_name: str, payload: dict | None = None) -> dict:
        return {
            "type": f"agent.stream.{short_name}",
            "payload": payload or {},
        }

    def _make_user_event(self, content: str = "hello") -> dict:
        return self._make_event("user", {
            "client_event_id": str(uuid.uuid4()),
            "content": content,
        })

    def _make_assistant_event(self, content: str = "hi there") -> dict:
        return self._make_event("assistant", {
            "client_event_id": str(uuid.uuid4()),
            "content": content,
        })

    def _make_step_event(self) -> dict:
        return self._make_event("step", {"step_type": "thinking"})

    def test_mixed_batch_classification(self):
        """混合批次中事件被正确分类。"""
        events = [
            self._make_user_event(),
            self._make_step_event(),
            self._make_assistant_event(),
            self._make_event("reasoning", {"phase": "delta"}),
            self._make_event("done", {}),
        ]

        critical = []
        detail = []
        for evt in events:
            event_type = evt["type"]
            short = event_type.replace("agent.stream.", "")
            if _classify_event(short) == "critical":
                critical.append(evt)
            else:
                detail.append(evt)

        assert len(critical) == 3  # user, assistant, done
        assert len(detail) == 2   # step, reasoning

    def test_ack_payload_structure(self):
        """验证 ACK payload 应当包含 message_ids。"""
        write_result = SyncWriteResult(
            success=True,
            message_ids=[
                {"client_event_id": "aaa", "server_id": "bbb"},
                {"client_event_id": "ccc", "server_id": "ddd"},
            ],
            events_written=2,
        )

        ack_payload = {"relayed": 5, "skipped": 0}
        if write_result.message_ids:
            ack_payload["message_ids"] = write_result.message_ids

        assert "message_ids" in ack_payload
        assert len(ack_payload["message_ids"]) == 2
        assert ack_payload["message_ids"][0]["server_id"] == "bbb"

    def test_nak_on_sync_failure(self):
        """同步写失败时应产生 NAK 语义。"""
        write_result = SyncWriteResult(
            success=False,
            error="db_write_error",
        )
        assert not write_result.success

    def test_done_result_is_not_written_when_critical_sync_fails(self):
        """critical 同步写失败时不能提前写 runtime result / reconcile Tracker。"""
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-1"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        envelope = {
            "request_id": "req-1",
            "payload": {
                "session_id": "session-1",
                "events": [
                    self._make_event("done", {
                        "task_id": "prompt_nak",
                        "content": "done",
                    }),
                ],
            },
        }

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(return_value=SyncWriteResult(success=False, error="db_error")),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_write_runtime_result_from_relay_done",
            new=AsyncMock(),
        ) as done_write_mock:
            asyncio.run(_run_relay_handler(handler, envelope))

        done_write_mock.assert_not_called()
        consumer._send_error.assert_not_called()
        consumer._send_envelope.assert_called_once()
        response = consumer._send_envelope.call_args.args[0]
        assert response["type"] == "relay_events.nak"
        assert response["payload"]["error_code"] == "db_error"

    def test_resolved_approval_requested_replay_is_not_rebroadcast(self):
        """已终态 pending 的 approval_requested 重放不能再广播给前端。

        PendingInteraction service 会保持 resolved/expired 终态幂等；relay 层也必须
        尊重该状态，否则 runtime 重试/WS replay 可能把已经处理的审批卡片复活。
        """
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-1"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        envelope = {
            "request_id": "req-approval-replay",
            "payload": {
                "session_id": "11111111-1111-4111-8111-111111111111",
                "events": [
                    self._make_event("approval_requested", {
                        "batch_id": "batch-already-resolved",
                        "approval_type": "tool_permission",
                        "action_requests": [{
                            "request_id": "batch-already-resolved",
                            "tool_call_id": "batch-already-resolved",
                            "tool_name": "browser.act",
                            "allowed_outcomes": ["allow", "deny"],
                            "allowed_scopes": ["once"],
                        }],
                    }),
                ],
            },
        }

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_upsert_tool_approval_interaction",
            new=AsyncMock(return_value=SimpleNamespace(status="resolved")),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ) as publish_mock, patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(),
        ) as sync_write_mock:
            asyncio.run(_run_relay_handler(handler, envelope))

        publish_mock.assert_not_called()
        sync_write_mock.assert_not_called()
        consumer._send_error.assert_not_called()
        consumer._send_envelope.assert_called_once()
        response = consumer._send_envelope.call_args.args[0]
        assert response["type"] == "relay_events.ok"
        assert response["payload"]["relayed"] == 0
        assert response["payload"]["skipped"] == 1

    def test_team_space_approval_relay_broadcasts_redacted_thread_and_full_owner_event(self):
        """Team Space 审批：共享 thread 只广播脱敏 payload，owner user event 拿完整 payload。"""
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-member"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        session_id = "11111111-1111-4111-8111-111111111111"
        payload = {
            "batch_id": "batch-team-owner",
            "approval_type": "tool_permission",
            "action_requests": [{
                "request_id": "req-team-owner",
                "tool_call_id": "tc-team-owner",
                "tool_name": "run_terminal_command",
                "tool_input": {"command": "touch owner-only.txt"},
                "decision_reason": {
                    "type": "workspace_out",
                    "path": "/private/team/owner-only.txt",
                },
                "allowed_scopes": ["once"],
                "allowed_outcomes": ["allow", "deny"],
            }],
            "runtime_mode": "interactive",
            "schema_version": 1,
            "team_space_execution": {
                "collaboration_space_id": "space-team",
                "execution_space_id": "space-owner",
                "initiator_user_id": "user-member",
                "execution_owner_user_id": "user-owner",
                "execution_owner_display_name": "Owner User",
            },
        }
        envelope = {
            "request_id": "req-team-approval",
            "payload": {
                "session_id": session_id,
                "events": [self._make_event("approval_requested", payload)],
            },
        }

        async def fake_upsert_tool_approval_interaction(**kwargs):
            from apps.services.agent_engine.services.pending_interaction_service import (
                _publish_interaction_event,
            )
            from apps.services.common.agent_protocol.constants import AgentUserEvent

            interaction_payload = kwargs["payload"]
            interaction = SimpleNamespace(
                id=uuid.uuid4(),
                kind="tool_approval",
                status="pending",
                thread_id=kwargs["thread_id"],
                session_id=session_id,
                organization_id="organization-team",
                user_id=interaction_payload["team_space_execution"]["execution_owner_user_id"],
                request_key=interaction_payload["batch_id"],
                source=kwargs["source"],
                payload=interaction_payload,
                result={},
                expires_at=None,
                resolved_at=None,
                created_at=None,
                updated_at=None,
            )
            _publish_interaction_event(AgentUserEvent.INTERACTION_REQUESTED, interaction)
            return interaction

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_enrich_team_space_execution_payload",
            new=AsyncMock(side_effect=lambda _session_id, event_payload: event_payload),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_upsert_tool_approval_interaction",
            new=AsyncMock(side_effect=fake_upsert_tool_approval_interaction),
        ) as upsert_mock, patch(
            "apps.services.agent_engine.services.pending_interaction_service.publish_to_user",
        ) as publish_to_user_mock, patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ) as publish_ws_mock, patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(return_value=SyncWriteResult(success=True)),
        ):
            asyncio.run(_run_relay_handler(handler, envelope))

        upsert_mock.assert_awaited_once()
        assert upsert_mock.await_args.kwargs["publish"] is True
        publish_ws_mock.assert_awaited_once()
        thread_id, short_name, thread_payload = publish_ws_mock.await_args.args
        assert thread_id == f"chat-session-{session_id}"
        assert short_name == "approval_requested"
        assert thread_payload["details_redacted"] is True
        assert thread_payload["team_space_execution"]["execution_owner_user_id"] == "user-owner"
        assert thread_payload["team_space_execution"]["initiator_user_id"] == "user-member"
        assert thread_payload["action_requests"] == [{
            "request_id": "req-team-owner",
            "tool_call_id": "tc-team-owner",
            "tool_name": "redacted_tool",
        }]
        assert "tool_input" not in thread_payload["action_requests"][0]
        assert "decision_reason" not in thread_payload["action_requests"][0]
        assert "allowed_scopes" not in thread_payload["action_requests"][0]
        assert "allowed_outcomes" not in thread_payload["action_requests"][0]

        publish_to_user_mock.assert_called_once()
        owner_user_id, owner_envelope = publish_to_user_mock.call_args.args
        owner_payload = owner_envelope["payload"]["interaction"]["payload"]
        assert owner_user_id == "user-owner"
        assert owner_envelope["type"] == "agent.user.interaction_requested"
        assert owner_payload["action_requests"][0]["tool_name"] == "run_terminal_command"
        assert owner_payload["action_requests"][0]["tool_input"]["command"] == "touch owner-only.txt"
        assert owner_payload["action_requests"][0]["decision_reason"]["path"] == "/private/team/owner-only.txt"
        assert "details_redacted" not in owner_payload

        response = consumer._send_envelope.call_args.args[0]
        assert response["type"] == "relay_events.ok"
        assert response["payload"]["relayed"] == 1
        assert response["payload"]["skipped"] == 0

    def test_ask_user_required_upserts_pending_interaction_before_broadcast(self):
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-1"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        payload = {
            "request_id": "ask-1",
            "tool_name": "ask_user",
            "interaction_type": "choice",
            "blocking_policy": "blocking",
            "intent": "clarify",
            "form_mode": "single",
            "questions": [{
                "id": "q1",
                "prompt": "选哪个？",
                "options": [{"id": "a", "label": "A", "description": ""}],
            }],
        }
        envelope = {
            "request_id": "req-ask",
            "payload": {
                "session_id": "11111111-1111-4111-8111-111111111111",
                "events": [self._make_event("ask_user_required", payload)],
            },
        }

        call_order: list[str] = []

        async def tracking_upsert(**kwargs):
            call_order.append("upsert")
            return SimpleNamespace(status="pending")

        async def tracking_publish(*args, **kwargs):
            call_order.append("publish")

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            # 避免无 django_db 时 enrich 触库失败改写 payload
            "apps.services.common.ws.handlers.relay_handler._async_enrich_team_space_execution_payload",
            new=AsyncMock(side_effect=lambda _sid, p: p),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_upsert_single_hitl_interaction",
            new=AsyncMock(side_effect=tracking_upsert),
        ) as upsert_mock, patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(side_effect=tracking_publish),
        ) as publish_mock, patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(return_value=SyncWriteResult(success=True)),
        ):
            asyncio.run(_run_relay_handler(handler, envelope))

        upsert_mock.assert_awaited_once()
        assert upsert_mock.await_args.kwargs["kind"] == "ask_choice"
        assert upsert_mock.await_args.kwargs["payload"]["request_id"] == "ask-1"
        publish_mock.assert_awaited_once_with(
            "chat-session-11111111-1111-4111-8111-111111111111",
            "ask_user_required",
            payload,
            exclude_channel=None,
        )
        assert call_order == ["upsert", "publish"]
        response = consumer._send_envelope.call_args.args[0]
        assert response["type"] == "relay_events.ok"
        assert response["payload"]["relayed"] == 1

    def test_ask_user_required_payload_is_enriched_with_team_space_execution(self):
        """#2355：ask_* 事件与 approval_requested 一样 enrich team_space_execution。

        缺失该元数据时，team space 场景成员端 fail-open 可自答、owner 侧
        fan-out / 可见性 / 决议门控全部失效。
        """
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-1"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        team_meta = {
            "execution_owner_user_id": "owner-1",
            "initiator_user_id": "member-1",
            "collaboration_space_id": "space-collab-1",
        }

        async def fake_enrich(session_id, payload):
            return {**payload, "team_space_execution": team_meta}

        payload = {
            "request_id": "ask-2",
            "tool_name": "ask_user",
            "interaction_type": "choice",
            "questions": [{"id": "q1", "prompt": "选哪个？", "options": []}],
        }
        envelope = {
            "request_id": "req-ask-enrich",
            "payload": {
                "session_id": "11111111-1111-4111-8111-111111111111",
                "events": [self._make_event("ask_user_required", payload)],
            },
        }

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_enrich_team_space_execution_payload",
            new=AsyncMock(side_effect=fake_enrich),
        ) as enrich_mock, patch(
            "apps.services.common.ws.handlers.relay_handler._async_upsert_single_hitl_interaction",
            new=AsyncMock(return_value=SimpleNamespace(status="pending")),
        ) as upsert_mock, patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ) as publish_mock, patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(return_value=SyncWriteResult(success=True)),
        ):
            asyncio.run(_run_relay_handler(handler, envelope))

        enrich_mock.assert_awaited_once()
        assert upsert_mock.await_args.kwargs["payload"]["team_space_execution"] == team_meta
        broadcast_payload = publish_mock.await_args.args[2]
        assert broadcast_payload["team_space_execution"] == team_meta

    def test_no_message_ids_for_detail_only(self):
        """纯细节事件批次不应有 message_ids。"""
        events = [
            self._make_step_event(),
            self._make_event("reasoning", {}),
        ]

        critical = [
            e for e in events
            if _classify_event(e["type"].replace("agent.stream.", "")) == "critical"
        ]
        assert len(critical) == 0

        ack_payload = {"relayed": 2, "skipped": 0}
        assert "message_ids" not in ack_payload


class TestBuildChatMessageMetadata:
    """Wave 2h D-2：ChatMessage.metadata 构造保留业务 source 不被覆盖。"""

    CLIENT_ID = "test-client-event-id-001"

    def test_preserves_top_level_source_client_event_id_for_history(self):
        source_id = "22222222-2222-4222-8222-222222222222"
        meta = build_chat_message_metadata(
            {"source_client_event_id": source_id},
            self.CLIENT_ID,
        )
        assert meta["source_client_event_id"] == source_id

    def test_explicit_metadata_source_client_event_id_wins(self):
        explicit = "33333333-3333-4333-8333-333333333333"
        payload = {
            "source_client_event_id": "44444444-4444-4444-8444-444444444444",
            "metadata": {"source_client_event_id": explicit},
        }
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source_client_event_id"] == explicit

    def test_preserves_skill_invoke_from_payload_top_level(self):
        """runtime yield 的 USER event 把 source 放 payload 顶层；要被提升。"""
        payload = {"source": "skill_invoke", "content": "hi"}
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source"] == "skill_invoke"
        assert meta["_persisted_via"] == "relay_events"
        assert meta["client_event_id"] == self.CLIENT_ID

    def test_preserves_skill_invoke_from_payload_metadata(self):
        """某些来源在 payload.metadata.source 打标；同样要保留。"""
        payload = {"metadata": {"source": "skill_invoke", "skill_id": "foo"}}
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source"] == "skill_invoke"
        # 未来扩展字段（skill_id 等）也应一并保留
        assert meta["skill_id"] == "foo"

    def test_metadata_source_takes_precedence_over_top_level(self):
        """同时提供时，metadata.source 优先（规范路径）。"""
        payload = {
            "metadata": {"source": "memory_recall"},
            "source": "skill_invoke",
        }
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source"] == "memory_recall"

    def test_falls_back_to_relay_events_when_no_source(self):
        """没有任何业务 source 时兜底为 relay_events。"""
        payload = {"content": "plain"}
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source"] == "relay_events"
        assert meta["_persisted_via"] == "relay_events"

    def test_relay_events_marker_not_counted_as_business_source(self):
        """即使 payload 自己标了 source=relay_events 也视为无业务语义。"""
        payload = {"source": "relay_events"}
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["source"] == "relay_events"
        assert meta["_persisted_via"] == "relay_events"

    def test_always_stamps_persisted_via_and_client_event_id(self):
        """所有分支都必须写 _persisted_via + client_event_id。"""
        for payload in [
            {},
            {"source": "x"},
            {"metadata": {"source": "y", "other": 1}},
            {"metadata": {"extra": True}, "source": "z"},
        ]:
            meta = build_chat_message_metadata(payload, self.CLIENT_ID)
            assert meta["_persisted_via"] == "relay_events"
            assert meta["client_event_id"] == self.CLIENT_ID

    def test_does_not_mutate_input_payload(self):
        """构造 metadata 不能回写原 payload（防串流）。"""
        original_meta = {"source": "skill_invoke", "custom": 42}
        payload = {"metadata": original_meta}
        build_chat_message_metadata(payload, self.CLIENT_ID)
        # 原 dict 不应被污染
        assert "_persisted_via" not in original_meta
        assert "client_event_id" not in original_meta

    def test_preserves_payload_top_level_tool_call_id(self):
        """W14：runtime emit `agent.stream.user` 把 tool_call_id 放 payload 顶层；
        持久化必须保留它，否则刷新会话后前端 SkillInjectionInlineCard 找不到关联
        的 tool_call 步骤，skill 卡片就消失。"""
        payload = {
            "source": "skill_invoke",
            "content": "skill body",
            "tool_call_id": "toolu_01abc",
        }
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["tool_call_id"] == "toolu_01abc"
        assert meta["source"] == "skill_invoke"

    def test_metadata_tool_call_id_takes_precedence_over_top_level(self):
        """payload.metadata.tool_call_id 已存在时不被 payload 顶层覆盖（已规范化路径）。"""
        payload = {
            "metadata": {"source": "skill_invoke", "tool_call_id": "from_metadata"},
            "tool_call_id": "from_top_level",
        }
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert meta["tool_call_id"] == "from_metadata"

    def test_no_tool_call_id_when_neither_provided(self):
        """两处都没有时不写空字段。"""
        payload = {"source": "skill_invoke", "content": "hi"}
        meta = build_chat_message_metadata(payload, self.CLIENT_ID)
        assert "tool_call_id" not in meta

    def test_top_level_tool_call_id_must_be_non_empty_string(self):
        """非字符串 / 空字符串的顶层 tool_call_id 不写。"""
        for bad_value in [None, "", 123, [], {}]:
            payload = {
                "source": "skill_invoke",
                "tool_call_id": bad_value,
            }
            meta = build_chat_message_metadata(payload, self.CLIENT_ID)
            assert "tool_call_id" not in meta, (
                f"unexpected tool_call_id written for value={bad_value!r}"
            )


class TestContentNormalization:
    """user/assistant 消息 content 归一化。"""

    def test_string_content(self):
        """纯字符串 content 不变。"""
        content = "hello world"
        assert isinstance(content, str)

    def test_blocks_content_normalized(self):
        """content 为 blocks 列表时拼接为字符串。"""
        content = [
            {"type": "text", "text": "Hello"},
            {"type": "text", "text": "World"},
        ]
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        result = "\n".join(text_parts)
        assert result == "Hello\nWorld"

    def test_mixed_content_blocks(self):
        """非 text 类型 block 被跳过。"""
        content = [
            {"type": "text", "text": "Before"},
            {"type": "image", "url": "http://..."},
            {"type": "text", "text": "After"},
        ]
        text_parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_parts.append(block.get("text", ""))
        result = "\n".join(text_parts)
        assert result == "Before\nAfter"
