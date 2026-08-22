from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.ws.handlers.relay_handler import (
    _enrich_team_space_execution_payload,
    _is_background_terminal_placeholder_run_id,
    _verify_session_in_organizations,
    create_relay_events_handler,
    drain_deferred_relay_side_effects_for_tests,
)


def test_only_canonical_background_terminal_run_is_a_placeholder() -> None:
    assert _is_background_terminal_placeholder_run_id(
        "bg-terminal-33333333-3333-4333-8333-333333333333",
    )
    assert not _is_background_terminal_placeholder_run_id(
        "bg-terminal-not-a-uuid",
    )
    assert not _is_background_terminal_placeholder_run_id(
        "33333333-3333-4333-8333-333333333333",
    )


def test_relay_session_requires_owner_runtime_and_target_match() -> None:
    async def verify() -> None:
        organization_ctx = MagicMock()
        organization_ctx.is_member.return_value = True
        queryset = MagicMock()

        with patch(
            "apps.chat.conversation.models.ChatSession.objects.filter",
            return_value=queryset,
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.runtime_can_open_interaction",
            side_effect=lambda **kwargs: (
                kwargs["user_id"] == "owner-1"
                and kwargs["source_device_fingerprint"] == "target-device"
            ),
        ):
            queryset.values_list.return_value.first.return_value = "organization-1"
            assert await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="electron",
                    user_id="owner-1",
                    device_fingerprint="target-device",
                    device_identity_verified=True,
                ),
            )
            assert not await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="web",
                    user_id="owner-1",
                    device_fingerprint="target-device",
                    device_identity_verified=False,
                ),
            )
            assert not await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="daemon",
                    user_id="other-user",
                    device_fingerprint="target-device",
                    device_identity_verified=True,
                ),
            )

            assert not await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="daemon",
                    user_id="owner-1",
                    device_fingerprint="other-device",
                    device_identity_verified=True,
                ),
            )
            assert await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="daemon",
                    user_id="owner-1",
                    device_fingerprint="target-device",
                    device_identity_verified=True,
                ),
            )
            assert not await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="electron",
                    user_id="owner-1",
                    device_fingerprint="target-device",
                    device_identity_verified=False,
                ),
            )

    asyncio.run(verify())


def test_relay_session_authorizes_each_execution_run_fact() -> None:
    async def verify() -> None:
        organization_ctx = MagicMock()
        organization_ctx.is_member.return_value = True
        queryset = MagicMock()
        runtime_authorized = MagicMock(return_value=True)
        run_id = "22222222-2222-4222-8222-222222222222"

        with patch(
            "apps.chat.conversation.models.ChatSession.objects.filter",
            return_value=queryset,
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.runtime_can_open_interaction",
            runtime_authorized,
        ):
            queryset.values_list.return_value.first.return_value = "organization-1"
            assert await _verify_session_in_organizations(
                "session-1",
                organization_ctx,
                SimpleNamespace(
                    role="daemon",
                    user_id="execution-owner",
                    device_fingerprint="execution-device",
                    device_identity_verified=True,
                ),
                run_ids=(run_id,),
            )

        runtime_authorized.assert_called_once_with(
            thread_id="chat-session-session-1",
            run_id=run_id,
            user_id="execution-owner",
            source_device_fingerprint="execution-device",
        )

    asyncio.run(verify())


def test_relay_event_without_run_id_is_attributed_to_current_run() -> None:
    async def verify() -> None:
        organization_ctx = MagicMock()
        organization_ctx.is_member.return_value = True
        consumer = SimpleNamespace(
            role="daemon",
            user_id="execution-owner",
            device_fingerprint="execution-device",
            device_identity_verified=True,
            organization_ctx=organization_ctx,
            _send_error=AsyncMock(),
            _send_envelope=AsyncMock(),
        )
        handler = create_relay_events_handler(consumer)

        with patch(
            "apps.services.common.ws.handlers.relay_handler.resolve_current_interaction_run_id",
            return_value="22222222-2222-4222-8222-222222222222",
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            AsyncMock(return_value=False),
        ) as verify:
            await handler({
                "request_id": "relay-without-run",
                "payload": {
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "events": [{
                        "type": "agent.stream.content_block_delta",
                        "payload": {"delta": "hello"},
                    }],
                },
            })

        assert verify.await_args.kwargs["run_ids"] == (
            "22222222-2222-4222-8222-222222222222",
        )

    asyncio.run(verify())


def test_background_terminal_placeholder_is_attributed_to_current_run() -> None:
    async def verify() -> None:
        organization_ctx = MagicMock()
        organization_ctx.is_member.return_value = True
        consumer = SimpleNamespace(
            role="electron",
            user_id="execution-owner",
            device_fingerprint="execution-device",
            device_identity_verified=True,
            organization_ctx=organization_ctx,
            _send_error=AsyncMock(),
            _send_envelope=AsyncMock(),
        )
        handler = create_relay_events_handler(consumer)
        event = {
            "type": "agent.stream.message_start",
            "payload": {
                "run_id": "bg-terminal-33333333-3333-4333-8333-333333333333",
                "message_id": "44444444-4444-4444-8444-444444444444",
            },
        }
        current_run_id = "22222222-2222-4222-8222-222222222222"

        with patch(
            "apps.services.common.ws.handlers.relay_handler.resolve_current_interaction_run_id",
            return_value=current_run_id,
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            AsyncMock(return_value=False),
        ) as verify:
            await handler({
                "request_id": "relay-background-terminal",
                "payload": {
                    "session_id": "11111111-1111-4111-8111-111111111111",
                    "events": [event],
                },
            })

        assert verify.await_args.kwargs["run_ids"] == (current_run_id,)
        assert event["payload"]["run_id"] == current_run_id

    asyncio.run(verify())


def test_runtime_team_execution_metadata_is_overwritten_by_session_metadata() -> None:
    payload = {
        "batch_id": "approval-forged-owner",
        "run_id": "22222222-2222-4222-8222-222222222222",
        "team_space_execution": {
            "initiator_user_id": "attacker",
            "execution_owner_user_id": "victim",
        },
    }
    trusted = {
        "initiator_user_id": "session-user",
        "execution_owner_user_id": "session-user",
    }

    with patch(
        "apps.services.agent_execution.team_space_execution."
        "resolve_message_execution_metadata",
        return_value={"team_space_execution": trusted},
    ) as resolve_metadata:
        enriched = _enrich_team_space_execution_payload("session-1", payload)

    assert enriched["team_space_execution"] == trusted
    assert enriched is not payload
    resolve_metadata.assert_called_once_with(
        "session-1",
        run_id="22222222-2222-4222-8222-222222222222",
    )


def test_runtime_team_execution_metadata_is_removed_when_session_lookup_fails() -> None:
    payload = {
        "batch_id": "approval-forged-owner",
        "team_space_execution": {"execution_owner_user_id": "victim"},
    }

    with patch(
        "apps.services.agent_execution.team_space_execution."
        "resolve_message_execution_metadata",
        side_effect=RuntimeError("database unavailable"),
    ):
        enriched = _enrich_team_space_execution_payload("session-1", payload)

    assert "team_space_execution" not in enriched
    assert enriched["__team_space_execution_redaction_required"] is True


def test_runtime_ui_events_are_relayed_without_silent_drop() -> None:
    asyncio.run(_assert_runtime_ui_events_are_relayed_without_silent_drop())


async def _assert_runtime_ui_events_are_relayed_without_silent_drop() -> None:
    consumer = MagicMock()
    consumer.user_id = "user-1"
    consumer.device_fingerprint = "device-1"
    consumer.organization_ctx = object()
    consumer.channel_name = "channel.sender"
    consumer._ws_client_version = "0.0-test"
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()

    events = [
        {
            "type": f"agent.stream.{AgentStreamEvent.PLAN_PROPOSAL}",
            "payload": {"plan_document_id": "plan.md", "plan_name": "Plan"},
        },
        {
            "type": f"agent.stream.{AgentStreamEvent.MODE_SWITCH_PROPOSAL}",
            "payload": {
                "proposal_id": "proposal-1",
                "from_mode_id": "plan",
                "target_mode_id": "agent",
            },
        },
        {
            "type": f"agent.stream.{AgentStreamEvent.MESSAGE_QUEUED}",
            "payload": {"client_message_id": "message-1", "position": 1},
        },
        {
            "type": f"agent.stream.{AgentStreamEvent.MESSAGE_DEQUEUED}",
            "payload": {"client_message_id": "message-1"},
        },
        {
            "type": f"agent.stream.{AgentStreamEvent.SUBAGENT_STREAM_EVENT}",
            "payload": {
                "subagent_run_id": "subagent-1",
                "child_event": {
                    "type": "agent.stream.content_block_delta",
                    "payload": {"delta": {"type": "text_delta", "text": "live"}},
                },
            },
        },
    ]
    envelope = {
        "v": 1,
        "request_id": "request-1",
        "payload": {"session_id": "session-1", "events": events},
    }

    publish = AsyncMock()
    spawn_trace = MagicMock(return_value=True)
    with patch(
        "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
        new=AsyncMock(return_value=True),
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
        new=publish,
    ), patch(
        "apps.services.common.ws.handlers.relay_handler._spawn_background_trace_write",
        new=spawn_trace,
    ):
        await create_relay_events_handler(consumer)(envelope)
        await drain_deferred_relay_side_effects_for_tests()

    consumer._send_error.assert_not_awaited()
    ack = consumer._send_envelope.await_args.args[0]
    assert ack["type"] == "relay_events.ok"
    assert ack["payload"]["relayed"] == len(events)
    assert ack["payload"]["skipped"] == 0

    assert [call.args[1] for call in publish.await_args_list] == [
        AgentStreamEvent.PLAN_PROPOSAL,
        AgentStreamEvent.MODE_SWITCH_PROPOSAL,
        AgentStreamEvent.MESSAGE_QUEUED,
        AgentStreamEvent.MESSAGE_DEQUEUED,
        AgentStreamEvent.SUBAGENT_STREAM_EVENT,
    ]
    assert all(
        call.kwargs["exclude_channel"] == consumer.channel_name
        for call in publish.await_args_list
    )

    trace_events = spawn_trace.call_args.kwargs["events"]
    assert [event["type"] for event in trace_events] == [
        f"agent.stream.{AgentStreamEvent.PLAN_PROPOSAL}",
        f"agent.stream.{AgentStreamEvent.MODE_SWITCH_PROPOSAL}",
        f"agent.stream.{AgentStreamEvent.MESSAGE_QUEUED}",
        f"agent.stream.{AgentStreamEvent.MESSAGE_DEQUEUED}",
    ]
