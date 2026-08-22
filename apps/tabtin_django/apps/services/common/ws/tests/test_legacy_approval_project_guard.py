"""Project 会话禁用旧 ``agent.action.approval_*`` 协议。"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.agent_protocol.constants import AgentActionEvent
from apps.services.common.ws.handlers.approval import (
    _is_project_thread,
    create_approval_request_handler,
    create_approval_response_handler,
)
from apps.services.common.ws.protocol import ERROR_PERMISSION_DENIED


def _consumer(*, role: str) -> MagicMock:
    consumer = MagicMock()
    consumer.role = role
    consumer.capabilities = {"agent.action"}
    consumer.device_fingerprint = "device-1"
    consumer.organization_id = "organization-1"
    consumer.user_id = "user-1"
    consumer._send_error = AsyncMock()
    consumer._send_envelope = AsyncMock()
    return consumer


def _envelope(event_type: str) -> dict:
    return {
        "type": event_type,
        "request_id": "request-1",
        "thread_id": "chat-session-session-1",
        "payload": {
            "thread_id": "chat-session-session-1",
            "approval_id": "approval-1",
            "approved": True,
            "scope": "once",
            "command": "read secret.txt",
        },
    }


def test_legacy_approval_project_lookup_fails_closed() -> None:
    with patch(
        "apps.chat.conversation.api._common.resolve_session_id_for_thread",
        side_effect=RuntimeError("database unavailable"),
    ):
        assert _is_project_thread("chat-session-00000000-0000-0000-0000-000000000001")


def test_project_legacy_approval_request_is_rejected_before_persist_or_publish() -> None:
    consumer = _consumer(role="daemon")
    upsert = MagicMock()
    publish = AsyncMock()

    async def run() -> None:
        with patch(
            "apps.services.common.ws.handlers.approval.has_action_capability",
            return_value=True,
        ), patch(
            "apps.services.common.ws.handlers.approval._is_project_thread_async",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.approval.upsert_action_approval_interaction",
            new=upsert,
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_ws_event_async",
            new=publish,
        ):
            await create_approval_request_handler(consumer)(
                _envelope(AgentActionEvent.APPROVAL_REQUEST),
            )

    asyncio.run(run())

    consumer._send_error.assert_awaited_once_with(
        "request-1",
        ERROR_PERMISSION_DENIED,
        "legacy approval protocol is disabled for Project sessions",
    )
    upsert.assert_not_called()
    publish.assert_not_awaited()
    consumer._send_envelope.assert_not_awaited()


def test_project_legacy_approval_response_is_rejected_before_runtime_forward() -> None:
    consumer = _consumer(role="mobile")
    create_localrt_handler = MagicMock()

    async def run() -> None:
        with patch(
            "apps.services.common.ws.handlers.approval._is_project_thread_async",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.create_localrt_user_response_handler",
            new=create_localrt_handler,
        ):
            await create_approval_response_handler(consumer)(
                _envelope(AgentActionEvent.APPROVAL_RESPONSE),
            )

    asyncio.run(run())

    consumer._send_error.assert_awaited_once_with(
        "request-1",
        ERROR_PERMISSION_DENIED,
        "legacy approval protocol is disabled for Project sessions",
    )
    create_localrt_handler.assert_not_called()
    consumer._send_envelope.assert_not_awaited()


def test_personal_legacy_approval_request_remains_compatible() -> None:
    consumer = _consumer(role="daemon")
    upsert = MagicMock(return_value=SimpleNamespace(status="pending"))
    publish = AsyncMock(return_value=1)
    publish_user = AsyncMock(return_value=1)
    action_service = MagicMock()

    async def run() -> None:
        with patch(
            "apps.services.common.ws.handlers.approval.has_action_capability",
            return_value=True,
        ), patch(
            "apps.services.common.ws.handlers.approval._is_project_thread_async",
            new=AsyncMock(return_value=False),
        ), patch(
            "apps.services.common.ws.handlers.approval.runtime_can_open_interaction",
            return_value=True,
        ), patch(
            "apps.services.common.ws.handlers.approval._get_action_service",
            return_value=action_service,
        ), patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="organization-1",
        ), patch(
            "apps.services.common.ws.handlers.approval.upsert_action_approval_interaction",
            new=upsert,
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_ws_event_async",
            new=publish,
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_to_user_async",
            new=publish_user,
        ):
            await create_approval_request_handler(consumer)(
                _envelope(AgentActionEvent.APPROVAL_REQUEST),
            )

    asyncio.run(run())

    consumer._send_error.assert_not_awaited()
    upsert.assert_called_once()
    assert publish.await_count == 2
    publish_user.assert_awaited_once()
    ack = consumer._send_envelope.await_args.args[0]
    assert ack["type"] == AgentActionEvent.APPROVAL_REQUEST_OK


def test_personal_legacy_approval_response_remains_compatible() -> None:
    consumer = _consumer(role="mobile")
    publish_user = AsyncMock(return_value=1)
    deliver_localrt_response = AsyncMock(return_value=True)
    create_localrt_handler = MagicMock(return_value=deliver_localrt_response)

    async def run() -> None:
        with patch(
            "apps.services.common.ws.handlers.approval._is_project_thread_async",
            new=AsyncMock(return_value=False),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.create_localrt_user_response_handler",
            new=create_localrt_handler,
        ), patch(
            "apps.services.common.ws.handlers.approval._resolve_thread_organization_cached",
            return_value="organization-1",
        ), patch(
            "apps.services.common.ws.handlers.approval.publish_to_user_async",
            new=publish_user,
        ):
            await create_approval_response_handler(consumer)(
                _envelope(AgentActionEvent.APPROVAL_RESPONSE),
            )

    asyncio.run(run())

    consumer._send_error.assert_not_awaited()
    create_localrt_handler.assert_called_once()
    deliver_localrt_response.assert_awaited_once()
    publish_user.assert_awaited_once()
    forwarded = deliver_localrt_response.await_args.args[0]
    assert forwarded["type"] == "localrt.user_response"
    assert forwarded["payload"]["response"]["batch_id"] == "approval-1"
