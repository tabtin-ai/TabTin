"""
#3406 停止链路收口：chat.cancel WS handler 按 thread 取消回归测试。

背景：普通 chat stop 前端没有 Tracker 那样的 ``_runtime_task_id`` 记录，
老实现要求 payload 必带 ``task_id`` → Electron 从不发 chat.cancel →
非本机托管的 run 停不掉。修复后：

  1. ``task_id`` 可选——缺省时仍 forward（设备端按 envelope thread_id
     经 ``resolveAbortSessionKeys`` 命中当前 run）；
  2. 对该 thread 最近的 running ExecutionRun 写 durable cancel marker
     （``RunService.request_cancel``），设备离线也能最终收敛；
  3. marker 写失败 fail-soft，不影响 cancel ACK。

覆盖用例：
  - 缺 session_id → nak schema_invalid
  - 带 task_id → forward_cancel(task_id=...) + ok（历史行为不回退）
  - 无 task_id → forward_cancel(task_id=None) 仍被调 + ok（ 核心）
  - running run 存在 → request_cancel(run_id) 被调
  - 无活跃 run / marker 抛错 → 仍 ok（fail-soft）
"""
from __future__ import annotations

import asyncio
import os
import sys
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

from apps.services.common.ws.handlers.chat_cancel import (  # noqa: E402
    create_chat_cancel_handler,
    CHAT_CANCEL_OK,
    CHAT_CANCEL_NAK,
)

_SESSION_ID = "16ab3a0e-0575-48b4-8e41-e44a7e1beb13"
_TASK_ID = "prompt_abc123def456"
_THREAD_ID = f"chat-session-{_SESSION_ID}"


def _make_consumer(role: str = "electron"):
    consumer = MagicMock()
    consumer.role = role
    consumer.user = MagicMock()
    consumer.user_id = "user-1"
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _make_session():
    session = MagicMock()
    session.effective_thread_id = _THREAD_ID
    session.workspace = MagicMock()
    session.workspace.id = "workspace-1"
    session.workspace.organization_id = "organization-1"
    session.agent_id = None
    session.target_device_installation_id = None
    session.id = _SESSION_ID
    session.pk = _SESSION_ID
    return session


def _run(consumer, payload: dict):
    handler = create_chat_cancel_handler(consumer)
    publisher = AsyncMock(return_value=True)
    with patch(
        "apps.services.common.ws.handlers.chat_cancel.publish_ws_event_async",
        new=publisher,
    ):
        asyncio.run(handler({"request_id": "req-1", "payload": payload}))
    return publisher


def _sent_envelope(consumer) -> dict:
    consumer._send_envelope.assert_awaited_once()
    return consumer._send_envelope.await_args.args[0]


def _patch_pipeline(session, published: int = 1):
    """打包 patch：session 解析 + PromptForwardService + RunService。"""
    pfs_cls = patch(
        "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService",
    )
    resolve = patch(
        "apps.services.common.ws.handlers.chat_cancel._resolve_cancel_session",
        new=AsyncMock(return_value=session),
    )
    run_service = patch(
        "apps.services.agent_engine.services.run_service.RunService",
    )
    return pfs_cls, resolve, run_service, published


def _patch_withdraw(result: dict | None = None):
    """#9614：撤回路径会调 service；单测默认 mock 掉 DB 删除。"""
    return patch(
        "apps.chat.conversation.services.withdraw_unanswered.withdraw_unanswered_messages",
        return_value=result or {
            "withdraw_applied": True,
            "deleted_count": 1,
            "reason": None,
            "restored_title": None,
        },
    )


def test_missing_session_id_naks_schema_invalid():
    consumer = _make_consumer()
    _run(consumer, {"task_id": _TASK_ID})

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_NAK
    assert sent["payload"]["error_code"] == "schema_invalid"


def test_cancel_with_task_id_forwards_and_acks():
    """历史形态（带 task_id）不回退。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        _run(consumer, {"session_id": _SESSION_ID, "task_id": _TASK_ID})

        pfs.return_value.forward_cancel.assert_called_once_with(
            thread_id=_THREAD_ID,
            task_id=_TASK_ID,
            space=session.workspace,
            agent_id=None,
            withdraw_unanswered=False,
            client_message_id=None,
            target_content=None,
            session_id=_SESSION_ID,
            target_device_fingerprint=None,
        )

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
    assert sent["payload"]["published"] == 1


def test_cancel_forwards_chat_session_agent_id():
    """ChatSession.agent_id 是控制转发使用的执行 Agent 字段。"""
    consumer = _make_consumer()
    session = _make_session()
    session.agent_id = "agent-1"
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        _run(consumer, {"session_id": _SESSION_ID, "task_id": _TASK_ID})

        pfs.return_value.forward_cancel.assert_called_once_with(
            thread_id=_THREAD_ID,
            task_id=_TASK_ID,
            space=session.workspace,
            agent_id="agent-1",
            withdraw_unanswered=False,
            client_message_id=None,
            target_content=None,
            session_id=_SESSION_ID,
            target_device_fingerprint=None,
        )

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK


def test_cancel_without_task_id_still_forwards():
    """#3406 核心：无 task_id 也能取消（按 thread 命中当前 run）。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        _run(consumer, {"session_id": _SESSION_ID})

        pfs.return_value.forward_cancel.assert_called_once_with(
            thread_id=_THREAD_ID,
            task_id=None,
            space=session.workspace,
            agent_id=None,
            withdraw_unanswered=False,
            client_message_id=None,
            target_content=None,
            session_id=_SESSION_ID,
            target_device_fingerprint=None,
        )

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK


def test_cancel_forwards_unanswered_withdraw_context():
    consumer = _make_consumer()
    session = _make_session()
    session.agent_id = "agent-1"
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs, _patch_withdraw() as withdraw:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        _run(consumer, {
            "session_id": _SESSION_ID,
            "withdraw_unanswered": True,
            "client_message_id": "client-1",
            "target_content": "发错了",
        })

        pfs.return_value.forward_cancel.assert_called_once_with(
            thread_id=_THREAD_ID,
            task_id=None,
            space=session.workspace,
            agent_id="agent-1",
            withdraw_unanswered=True,
            client_message_id="client-1",
            target_content="发错了",
            session_id=_SESSION_ID,
            target_device_fingerprint=None,
        )
        withdraw.assert_called_once()

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
    assert sent["payload"]["published"] == 1
    assert sent["payload"]["withdraw_applied"] is True


def test_cancel_broadcasts_abort_terminal_to_all_session_observers():
    """取消终态由服务端独立广播，不依赖被 abort 的 runtime delivery buffer。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs, _patch_withdraw():
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        publisher = _run(consumer, {
            "session_id": _SESSION_ID,
            "task_id": _TASK_ID,
            "client_message_id": "client-1",
            "withdraw_unanswered": True,
        })

    publisher.assert_awaited_once()
    topic, envelope = publisher.await_args.args
    assert topic == f"agent.stream.{_THREAD_ID}"
    assert envelope["type"] == "agent.stream.done"
    assert envelope["thread_id"] == _THREAD_ID
    assert envelope["session_id"] == _SESSION_ID
    assert envelope["payload"] == {
        "session_id": _SESSION_ID,
        "task_id": _TASK_ID,
        "source_client_event_id": "client-1",
        "stop_reason": "aborted",
        "error": True,
        "error_class": "ABORT",
        "error_message": "Run aborted by user.",
        "suggested_action": "retry_later",
        "cancel_control": True,
        "withdraw_unanswered": True,
        "withdraw_applied": True,
    }


def test_cancel_withdraw_applied_false_still_acks_without_error():
    """#9614：服务端复判拒绝时 withdraw_applied=false，仍按普通 cancel 收口。"""
    consumer = _make_consumer(role="mobile")
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)
    rejected = {
        "withdraw_applied": False,
        "deleted_count": 0,
        "reason": "has_substantive_output",
        "restored_title": None,
    }

    with pfs_cls as pfs, resolve, run_service as rs, _patch_withdraw(rejected) as withdraw:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        publisher = _run(consumer, {
            "session_id": _SESSION_ID,
            "withdraw_unanswered": True,
            "client_message_id": "11111111-1111-1111-1111-111111111111",
        })

        withdraw.assert_called_once()
        assert withdraw.call_args.kwargs["source"] == "mobile_cancel"

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
    assert sent["payload"]["withdraw_applied"] is False
    _topic, envelope = publisher.await_args.args
    assert envelope["payload"]["withdraw_applied"] is False


def test_cancel_without_withdraw_flag_omits_withdraw_applied():
    """老 payload（无 withdraw_unanswered）行为不变：ack/done 不加 withdraw_applied。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs, _patch_withdraw() as withdraw:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = None
        publisher = _run(consumer, {
            "session_id": _SESSION_ID,
            "task_id": _TASK_ID,
        })
        withdraw.assert_not_called()

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
    assert "withdraw_applied" not in sent["payload"]
    _topic, envelope = publisher.await_args.args
    assert "withdraw_applied" not in envelope["payload"]


def test_cancel_writes_durable_marker_for_running_run():
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    latest_run = MagicMock()
    latest_run.status = "running"
    latest_run.run_id = "run-uuid-1"

    with pfs_cls as pfs, resolve, run_service as rs, patch(
        "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService",
    ) as run_state:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = latest_run
        _run(consumer, {"session_id": _SESSION_ID})

        rs.get_latest_run.assert_called_once_with(_THREAD_ID)
        rs.request_cancel.assert_called_once_with("run-uuid-1", reason="chat_cancel")
        run_state.transition.assert_called_once_with(
            run_id="run-uuid-1",
            status="cancelling",
            stop_reason="chat_cancel",
        )
        run_state.cancel_queued_after.assert_called_once_with(
            run_id="run-uuid-1",
        )

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK


def test_cancel_without_runtime_receiver_terminals_current_run():
    """没有执行端收到 cancel 时，服务端兜底终态化，避免 projection 永久 busy。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    latest_run = MagicMock()
    latest_run.status = "cancelling"
    latest_run.run_id = "run-uuid-1"

    with pfs_cls as pfs, resolve, run_service as rs, patch(
        "apps.services.agent_engine.services.session_run_state_service.SessionRunStateService",
    ) as run_state:
        pfs.return_value.forward_cancel.return_value = 0
        rs.get_latest_run.return_value = latest_run
        run_state.transition.return_value = MagicMock()
        _run(consumer, {"session_id": _SESSION_ID})

        rs.request_cancel.assert_called_once_with("run-uuid-1", reason="chat_cancel")
        assert run_state.transition.call_args_list[0].kwargs == {
            "run_id": "run-uuid-1",
            "status": "cancelling",
            "stop_reason": "chat_cancel",
        }
        assert run_state.transition.call_args_list[1].kwargs["run_id"] == "run-uuid-1"
        assert run_state.transition.call_args_list[1].kwargs["status"] == "interrupted"
        assert run_state.transition.call_args_list[1].kwargs["stop_reason"] == "aborted"
        assert run_state.transition.call_args_list[1].kwargs["error_class"] == "ABORT"
        rs.clear_cancelled.assert_called_once_with("run-uuid-1")

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
    assert sent["payload"]["published"] == 0


def test_cancel_marker_skipped_for_terminal_run():
    """已终态（completed 等）的 run 不写 marker，避免误标。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    latest_run = MagicMock()
    latest_run.status = "completed"

    with pfs_cls as pfs, resolve, run_service as rs:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.return_value = latest_run
        _run(consumer, {"session_id": _SESSION_ID})

        rs.request_cancel.assert_not_called()

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK


def test_marker_failure_does_not_break_ack():
    """marker 写失败 fail-soft：forward 已尽力，仍回 ok。"""
    consumer = _make_consumer()
    session = _make_session()
    pfs_cls, resolve, run_service, _ = _patch_pipeline(session)

    with pfs_cls as pfs, resolve, run_service as rs:
        pfs.return_value.forward_cancel.return_value = 1
        rs.get_latest_run.side_effect = RuntimeError("redis down")
        _run(consumer, {"session_id": _SESSION_ID})

    sent = _sent_envelope(consumer)
    assert sent["type"] == CHAT_CANCEL_OK
