"""
W5-a: subagent.cancel WS handler 测试。

覆盖（与 chat.cancel 同源协议，只是 child_id 维度而非 task_id）：
  1. role 不在白名单 → _send_error(ERROR_PERMISSION_DENIED)
  2. 缺 child_id / session_id → nak schema_invalid
  3. session 解析不到（无权限/不存在）→ nak not_found
  4. session 没有 space → nak no_space
  5. happy path → forward_subagent_cancel(child_id=...) 被调，ok 带 published
  6. 下行 envelope 字面量契约：forward 出的是 PromptForwardEvent.SUBAGENT_CANCEL
     == "agent.subagent.cancel"，payload 只带 {child_id}（daemon 接收端契约）。
"""
from __future__ import annotations

import asyncio
import os
import sys
import types

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

from apps.services.common.ws.handlers.subagent_cancel import (  # noqa: E402
    create_subagent_cancel_handler,
    SUBAGENT_CANCEL_OK,
    SUBAGENT_CANCEL_NAK,
)
from apps.services.common.ws.protocol import ERROR_PERMISSION_DENIED  # noqa: E402

_SESSION_ID = "11111111-1111-1111-1111-111111111111"
_CHILD_ID = "child-abc-123"
_THREAD_ID = f"chat-session-{_SESSION_ID}"


def _make_consumer(role: str = "electron"):
    consumer = MagicMock()
    consumer.role = role
    consumer.user = MagicMock()
    consumer.user_id = "user-1"
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _envelope(payload: dict, request_id: str = "req-1") -> dict:
    return {"request_id": request_id, "payload": payload}


def _run(consumer, payload: dict):
    handler = create_subagent_cancel_handler(consumer)
    asyncio.run(handler(_envelope(payload)))


def test_role_not_allowed_sends_permission_error():
    consumer = _make_consumer(role="daemon")
    _run(consumer, {"session_id": _SESSION_ID, "child_id": _CHILD_ID})

    consumer._send_error.assert_awaited_once()
    args = consumer._send_error.await_args.args
    assert args[1] == ERROR_PERMISSION_DENIED
    consumer._send_envelope.assert_not_awaited()


def test_missing_child_id_naks_schema_invalid():
    consumer = _make_consumer()
    _run(consumer, {"session_id": _SESSION_ID})

    consumer._send_envelope.assert_awaited_once()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == SUBAGENT_CANCEL_NAK
    assert sent["payload"]["error_code"] == "schema_invalid"


def test_missing_session_id_naks_schema_invalid():
    consumer = _make_consumer()
    _run(consumer, {"child_id": _CHILD_ID})

    consumer._send_envelope.assert_awaited_once()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == SUBAGENT_CANCEL_NAK
    assert sent["payload"]["error_code"] == "schema_invalid"


def test_session_not_found_naks():
    consumer = _make_consumer()
    with patch(
        "apps.services.common.ws.handlers.subagent_cancel._resolve_cancel_session",
        new=AsyncMock(return_value=None),
    ):
        _run(consumer, {"session_id": _SESSION_ID, "child_id": _CHILD_ID})

    consumer._send_envelope.assert_awaited_once()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == SUBAGENT_CANCEL_NAK
    assert sent["payload"]["error_code"] == "not_found"


def test_session_without_space_naks_no_space():
    consumer = _make_consumer()
    session = types.SimpleNamespace(space=None, effective_thread_id=_THREAD_ID)
    with patch(
        "apps.services.common.ws.handlers.subagent_cancel._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ):
        _run(consumer, {"session_id": _SESSION_ID, "child_id": _CHILD_ID})

    consumer._send_envelope.assert_awaited_once()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == SUBAGENT_CANCEL_NAK
    assert sent["payload"]["error_code"] == "no_space"


def test_happy_path_forwards_and_acks():
    consumer = _make_consumer()
    space = MagicMock(name="space")
    session = types.SimpleNamespace(
        workspace=space,
        effective_thread_id=_THREAD_ID,
        target_device_installation_id=None,
    )

    service_instance = MagicMock()
    service_instance.forward_subagent_cancel.return_value = 1
    service_cls = MagicMock(return_value=service_instance)

    with patch(
        "apps.services.common.ws.handlers.subagent_cancel._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    ), patch(
        "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
        new=service_cls,
    ):
        _run(consumer, {"session_id": _SESSION_ID, "child_id": _CHILD_ID})

    # forward 被调，参数对齐契约
    service_instance.forward_subagent_cancel.assert_called_once_with(
        thread_id=_THREAD_ID,
        child_id=_CHILD_ID,
        space=space,
        target_device_fingerprint=None,
    )

    consumer._send_envelope.assert_awaited_once()
    sent = consumer._send_envelope.await_args.args[0]
    assert sent["type"] == SUBAGENT_CANCEL_OK
    assert sent["payload"]["published"] == 1


def test_forward_subagent_cancel_emits_correct_downstream_envelope():
    """守护下行契约：daemon 在等 type=='agent.subagent.cancel' + payload{child_id}。"""
    from apps.services.agent_engine.services.prompt_forward_service import PromptForwardService
    from apps.services.common.agent_protocol.constants import PromptForwardEvent

    assert PromptForwardEvent.SUBAGENT_CANCEL == "agent.subagent.cancel"

    service = PromptForwardService()
    captured = {}

    def _fake_publish_exclusive(
        thread_id,
        space,
        envelope,
        *,
        agent_id=None,
        target_device_fingerprint=None,
    ):
        captured["thread_id"] = thread_id
        captured["envelope"] = envelope
        captured["agent_id"] = agent_id
        captured["target_device_fingerprint"] = target_device_fingerprint
        return 1

    with patch.object(service, "_publish_exclusive", side_effect=_fake_publish_exclusive):
        published = service.forward_subagent_cancel(
            thread_id=_THREAD_ID,
            child_id=_CHILD_ID,
            space=MagicMock(),
        )

    assert published == 1
    env = captured["envelope"]
    assert env["type"] == "agent.subagent.cancel"
    assert env["payload"] == {"child_id": _CHILD_ID}
    assert env.get("thread_id") == _THREAD_ID
    assert captured["target_device_fingerprint"] is None
