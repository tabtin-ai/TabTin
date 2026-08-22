"""
#8785 契约测试：后台命令终态 `_terminal_update` mini-message 的 relay 广播。

背景：host（Electron/Daemon）在后台命令终结时 relay 一条终态 tool_result
mini-message（role=user + message_kind=llm 的 4 件套），Django 落库 supersede
running 快照的同时，必须把这组事件**广播**到 `agent.stream.chat-session-<id>`
topic——live 中的 Electron renderer / iOS / Android 靠它原地刷新工具卡
（文生图卡片换成成品图）。若广播被排除列表 / 分类改动误伤，live UI 会回到
#8785 的「永远转圈」。

本测试锁定：4 件套全部被接受（skipped=0）且逐个进入 ACK 后的 deferred
publish（ 通道），content_block_start 的 tool_result payload 原样透传。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

from apps.services.common.ws.handlers.relay_handler import (  # noqa: E402
    create_relay_events_handler,
    drain_deferred_relay_side_effects_for_tests,
)
from apps.services.common.ws.handlers.relay_message_writer import (  # noqa: E402
    SyncWriteResult,
)


def _make_event(short_name: str, payload: dict) -> dict:
    return {"type": f"agent.stream.{short_name}", "payload": payload}


def _build_terminal_update_events(thread_id: str, tool_use_id: str) -> list[dict]:
    """对齐 host 侧 buildBackgroundTaskTerminalResultEvents 的 wire 4 件套。"""
    message_id = str(uuid.uuid4())
    run_id = f"bg-terminal-{uuid.uuid4()}"
    content_json = json.dumps({
        "status": "completed",
        "session_id": "pty-session-1",
        "exit_code": 0,
        "exited_by": "normal_exit",
        "duration_ms": 116_000,
        "stdout": json.dumps({"ok": True, "data": {"result_urls": ["https://example.com/x.jpeg"]}}),
        "output_file": "/tmp/out.log",
        "command": "tabtin media image generate --prompt cat",
        "cwd": "/tmp",
        "_terminal_update": True,
    })
    base = {"thread_id": thread_id, "run_id": run_id, "message_id": message_id}
    return [
        _make_event("message_start", {
            **base,
            "role": "user",
            "message_kind": "llm",
            "model_id": "tabtin-tool-runtime",
            "model_name": "tabtin-tool-runtime",
        }),
        _make_event("content_block_start", {
            **base,
            "index": 0,
            "block": {
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content_json,
            },
        }),
        _make_event("content_block_stop", {**base, "index": 0}),
        _make_event("message_stop", base),
    ]


class TestTerminalUpdateRelayBroadcast:
    def test_terminal_update_mini_message_is_accepted_and_broadcast(self):
        consumer = MagicMock()
        consumer.organization_ctx = object()
        consumer.user_id = "user-1"
        consumer.device_fingerprint = "device-1"
        consumer._send_error = AsyncMock()
        consumer._send_envelope = AsyncMock()
        handler = create_relay_events_handler(consumer)

        session_id = "22222222-2222-4222-8222-222222222222"
        thread_id = f"chat-session-{session_id}"
        tool_use_id = "toolu_bg_terminal_1"
        events = _build_terminal_update_events(thread_id, tool_use_id)
        envelope = {
            "request_id": "req-terminal-update-1",
            "payload": {"session_id": session_id, "events": events},
        }

        async def _run() -> None:
            await handler(envelope)
            await drain_deferred_relay_side_effects_for_tests()

        with patch(
            "apps.services.common.ws.handlers.relay_handler._verify_session_in_organizations",
            new=AsyncMock(return_value=True),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler.sync_write_critical_events",
            new=AsyncMock(return_value=SyncWriteResult(success=True)),
        ), patch(
            "apps.services.common.ws.handlers.relay_handler._async_publish_ws",
            new=AsyncMock(),
        ) as publish_mock:
            asyncio.run(_run())

        consumer._send_error.assert_not_called()
        response = consumer._send_envelope.call_args.args[0]
        assert response["type"] == "relay_events.ok"
        # 4 件套必须全部被接受——任何一条被 skip 都会让 merge / 广播断链。
        assert response["payload"]["skipped"] == 0
        assert response["payload"]["relayed"] == 4

        # ACK 后 deferred publish：逐条广播到 session topic，且 payload 原样透传。
        published = [call.args for call in publish_mock.await_args_list]
        published_short_names = [args[1] for args in published]
        assert published_short_names == [
            "message_start",
            "content_block_start",
            "content_block_stop",
            "message_stop",
        ]
        for pub_thread_id, _short, _payload in published:
            assert pub_thread_id == thread_id

        block_payload = published[1][2]
        block = block_payload["block"]
        assert block["type"] == "tool_result"
        assert block["tool_use_id"] == tool_use_id
        assert json.loads(block["content"])["_terminal_update"] is True

    def test_terminal_update_is_not_in_broadcast_exclusion(self):
        """回归锁：_terminal_update 相关事件类型不得落入广播排除集合。

        relay_handler 的排除是字面短名列表（persist_message / llm_snapshot /
        audit_cap）；本用例直接驱动 handler 已覆盖真实判定，这里再钉住
        4 件套短名都在 relay 白名单内。
        """
        from apps.services.common.agent_protocol.constants import (
            RELAY_ALLOWED_SHORT_NAMES,
        )

        for short_name in (
            "message_start",
            "content_block_start",
            "content_block_stop",
            "message_stop",
        ):
            assert short_name in RELAY_ALLOWED_SHORT_NAMES
