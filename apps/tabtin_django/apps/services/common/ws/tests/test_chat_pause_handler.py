import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from apps.services.common.ws.handlers.chat_pause import create_chat_pause_control_handler


def _consumer(role="mobile"):
    return SimpleNamespace(
        role=role,
        user=MagicMock(),
        _send_envelope=AsyncMock(),
        _send_error=AsyncMock(),
    )


def _envelope(session_id="session-1"):
    return {
        "request_id": "request-1",
        "payload": {"session_id": session_id} if session_id is not None else {},
    }


def _fake_sync_results(*results):
    remaining = iter(results)

    def fake_sync_to_async(_fn, **_kwargs):
        async def run(*_args, **_inner_kwargs):
            return next(remaining)

        return run

    return fake_sync_to_async


def test_pause_forwards_then_persists_and_acks():
    consumer = _consumer()
    workspace = MagicMock()
    session = SimpleNamespace(
        pk="session-1",
        effective_thread_id="chat-session-1",
        agent_id="agent-1",
        target_device_installation_id=None,
    )
    handler = create_chat_pause_control_handler(consumer, paused=True)

    call_count = 0

    def fake_sync_to_async(fn, **_kwargs):
        nonlocal call_count
        call_count += 1
        index = call_count

        async def run(*_args, **_inner_kwargs):
            # workspace 加载和 paused 状态落库不需要碰真实 ORM；中间的
            # forward lambda 必须真实执行，才能验证 ChatSession.agent_id 的转发。
            if index == 1:
                return workspace
            if index == 2:
                return fn()
            return None

        return run

    with patch(
        "apps.services.common.ws.handlers.chat_pause._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ), patch(
        "apps.services.common.ws.handlers.chat_pause.sync_to_async",
        side_effect=fake_sync_to_async,
    ), patch(
        "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
    ) as pfs:
        pfs.return_value.forward_pause_control.return_value = 1
        asyncio.run(handler(_envelope()))

        pfs.return_value.forward_pause_control.assert_called_once_with(
            thread_id="chat-session-1",
            space=workspace,
            paused=True,
            agent_id="agent-1",
            target_device_fingerprint=None,
        )

    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == "chat.pause.ok"
    assert sent["payload"]["published"] == 1
    assert sent["payload"]["is_paused"] is True


def test_resume_missing_session_returns_nak():
    consumer = _consumer()
    handler = create_chat_pause_control_handler(consumer, paused=False)

    with patch(
        "apps.services.common.ws.handlers.chat_pause._resolve_cancel_session",
        new=AsyncMock(return_value=None),
    ):
        asyncio.run(handler(_envelope()))

    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == "chat.resume.nak"
    assert sent["payload"]["error_code"] == "not_found"


def test_pause_without_reachable_runtime_does_not_persist():
    consumer = _consumer()
    session = SimpleNamespace(
        pk="session-1",
        effective_thread_id="chat-session-1",
        execution_agent_id="agent-1",
        target_device_installation_id=None,
    )
    handler = create_chat_pause_control_handler(consumer, paused=True)

    fake_sync = _fake_sync_results(MagicMock(), 0)
    with patch(
        "apps.services.common.ws.handlers.chat_pause._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ), patch(
        "apps.services.common.ws.handlers.chat_pause.sync_to_async",
        side_effect=fake_sync,
    ):
        asyncio.run(handler(_envelope()))

    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == "chat.pause.nak"
    assert sent["payload"]["error_code"] == "device_unreachable"


def test_pause_ack_does_not_project_run_state_paused():
    consumer = _consumer()
    workspace = MagicMock()
    session = SimpleNamespace(
        pk="session-1",
        id="session-1",
        effective_thread_id="chat-session-1",
        agent_id="agent-1",
        target_device_installation_id=None,
    )
    handler = create_chat_pause_control_handler(consumer, paused=True)
    call_count = 0

    def fake_sync_to_async(fn, **_kwargs):
        nonlocal call_count
        call_count += 1
        index = call_count

        async def run(*_args, **_inner_kwargs):
            if index == 1:
                return workspace
            if index == 2:
                return fn()
            return None

        return run

    with patch(
        "apps.services.common.ws.handlers.chat_pause._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ), patch(
        "apps.services.common.ws.handlers.chat_pause.sync_to_async",
        side_effect=fake_sync_to_async,
    ), patch(
        "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
    ) as pfs, patch(
        "apps.services.agent_engine.services.session_run_state_service."
        "SessionRunStateService.transition_current",
    ) as transition:
        pfs.return_value.forward_pause_control.return_value = 1
        asyncio.run(handler(_envelope()))

    transition.assert_not_called()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == "chat.pause.ok"
    assert sent["payload"]["is_paused"] is True


def test_resume_ack_projects_run_state_running():
    consumer = _consumer()
    workspace = MagicMock()
    session = SimpleNamespace(
        pk="session-1",
        id="session-1",
        effective_thread_id="chat-session-1",
        agent_id="agent-1",
        target_device_installation_id=None,
    )
    handler = create_chat_pause_control_handler(consumer, paused=False)
    call_count = 0

    def fake_sync_to_async(fn, **_kwargs):
        nonlocal call_count
        call_count += 1
        index = call_count

        async def run(*_args, **_inner_kwargs):
            if index == 1:
                return workspace
            if index == 2:
                return fn()
            if index == 4:
                return fn()
            return None

        return run

    with patch(
        "apps.services.common.ws.handlers.chat_pause._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ), patch(
        "apps.services.common.ws.handlers.chat_pause.sync_to_async",
        side_effect=fake_sync_to_async,
    ), patch(
        "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
    ) as pfs, patch(
        "apps.services.agent_engine.services.session_run_state_service."
        "SessionRunStateService.transition_current",
    ) as transition:
        pfs.return_value.forward_pause_control.return_value = 1
        asyncio.run(handler(_envelope()))

    transition.assert_called_once()
    assert transition.call_args.kwargs["status"] == "running"
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == "chat.resume.ok"
    assert sent["payload"]["is_paused"] is False


def test_pause_rejects_untrusted_role():
    consumer = _consumer(role="daemon")
    handler = create_chat_pause_control_handler(consumer, paused=True)

    asyncio.run(handler(_envelope()))

    consumer._send_error.assert_awaited_once()
    consumer._send_envelope.assert_not_awaited()
