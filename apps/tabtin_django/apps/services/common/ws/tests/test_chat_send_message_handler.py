"""
chat.send_message handler 单元测试。

覆盖（对应 Wave 1 验收清单）：
  1. 成功路径：mock ChatService 验证 ack 形态完整
  2. role 闸门：daemon / device_runtime 拒绝
  3. session 不存在 → nak session_not_found
  4. client_event_id 非 UUID → nak schema_invalid
  5. blocks 单条 content > 32KB → nak blocks_too_large
  6. _rejected_concurrent → nak concurrent_rejected (retryable=True)
  7. error_category 路径 → nak with category
  8. HttpError(404) → nak session_not_found
  9. metadata / app_context 白名单生效

FocusSnapshot 入口接线见 ``test_chat_send_message_focus_snapshot.py``
（SimpleTestCase，``manage.py test`` 可发现）。
"""
from __future__ import annotations

import os
import sys
import uuid

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import asyncio  # noqa: E402
import time  # noqa: E402
from unittest.mock import AsyncMock, MagicMock, patch  # noqa: E402

import pytest  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.utils import timezone  # noqa: E402
from ninja.errors import HttpError  # noqa: E402

from apps.chat.conversation.models import ChatSession  # noqa: E402
from apps.services.agent_engine.models import (  # noqa: E402
    ExecutionRun,
    SessionRunProjection,
)
from apps.services.agent_execution.effective_runtime_config import (  # noqa: E402
    EffectiveRuntimeConfigError,
)
from apps.services.common.ws.handlers.chat_send_message import (  # noqa: E402
    CHAT_SEND_MESSAGE_NAK,
    CHAT_SEND_MESSAGE_OK,
    _ALLOWED_ROLES,
    _APP_CONTEXT_WHITELIST,
    _MAX_BLOCK_CONTENT_BYTES,
    _METADATA_WHITELIST,
    _filter_dict,
    _has_user_content,
    _is_diagnostic_error_message,
    _is_valid_uuid,
    _map_http_error,
    _resolve_nak_user_message,
    _validate_blocks,
    _validate_skill_slash_invoke,
    create_chat_send_message_handler,
)


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestPureHelpers:
    def test_is_valid_uuid_accepts_uuid_string(self):
        assert _is_valid_uuid(str(uuid.uuid4())) is True

    @pytest.mark.parametrize("bad", [None, "", "not-a-uuid", 123, "1234"])
    def test_is_valid_uuid_rejects_garbage(self, bad):
        assert _is_valid_uuid(bad) is False

    def test_validate_blocks_none_passes(self):
        assert _validate_blocks(None) is None

    def test_validate_blocks_empty_list_passes(self):
        assert _validate_blocks([]) is None

    def test_validate_skill_slash_invoke_normalizes_valid_input(self):
        value, error = _validate_skill_slash_invoke({
            "skill_key": " app:office/meeting-notes ",
            "args": "整理今天的会议",
        })
        assert error is None
        assert value == {
            "skill_key": "app:office/meeting-notes",
            "args": "整理今天的会议",
        }

    @pytest.mark.parametrize("bad", ["skill", {}, {"skill_key": 42}, {"skill_key": "x", "args": 42}])
    def test_validate_skill_slash_invoke_rejects_invalid_input(self, bad):
        value, error = _validate_skill_slash_invoke(bad)
        assert value is None
        assert error is not None

    def test_validate_blocks_rejects_non_list(self):
        assert "must be a list" in (_validate_blocks("nope") or "")

    def test_is_diagnostic_error_message(self):
        assert _is_diagnostic_error_message("", error_category="device_offline") is True
        assert _is_diagnostic_error_message("device_offline", error_category="device_offline") is True
        assert _is_diagnostic_error_message(
            "control_device sedas-MacBook-Air.local (darwin) status=offline",
            error_category="device_offline",
        ) is True
        assert _is_diagnostic_error_message(
            "无法转发消息到执行设备，请在电脑打开 TabTin 后再试。",
            error_category="device_offline",
        ) is False
        assert _is_diagnostic_error_message(
            "无法转发消息到您的设备，请确认 Daemon 正在运行。",
            error_category="device_offline",
        ) is False

    def test_resolve_nak_user_message_prefers_reply(self):
        msg = _resolve_nak_user_message(
            {"reply": "device offline", "error_message": "device_offline"},
            "device_offline",
        )
        assert msg == "device offline"

    def test_resolve_nak_user_message_never_returns_category_token(self):
        msg = _resolve_nak_user_message(
            {"reply": "", "error_message": "device_offline"},
            "device_offline",
        )
        assert msg != "device_offline"
        assert "设备" in msg or "device" in msg.lower() or "TabTin" in msg

    def test_validate_blocks_rejects_non_dict_item(self):
        assert "must be an object" in (_validate_blocks(["nope"]) or "")

    def test_validate_blocks_rejects_oversize_content(self):
        big = "x" * (_MAX_BLOCK_CONTENT_BYTES + 1)
        err = _validate_blocks([{"content": big}])
        assert err is not None and "too large" in err

    def test_validate_blocks_accepts_normal_content(self):
        assert _validate_blocks([{"content": "small text"}]) is None

    def test_has_user_content_accepts_image_block_without_text(self):
        assert _has_user_content(
            "",
            [{"type": "image", "source": {"type": "url", "url": "https://example.com/a.png"}}],
            None,
        ) is True

    def test_has_user_content_accepts_image_attachment_without_text(self):
        assert _has_user_content(
            "",
            None,
            [{"type": "image", "url": "https://example.com/a.png"}],
        ) is True

    def test_has_user_content_rejects_empty_image_attachment_without_url(self):
        assert _has_user_content("", None, [{"type": "image", "filename": "local.png"}]) is False

    def test_has_user_content_rejects_truly_empty_payload(self):
        assert _has_user_content("   ", [], []) is False

    def test_has_user_content_accepts_composer_preset_block_without_text(self):
        # ：Skill 表单卡远控发送——message 为空、内容在 composer_preset 块。
        assert _has_user_content(
            "",
            [{
                "type": "composer_preset",
                "preset_id": "app:tabdata/table-modeling",
                "params": {"subject": "天气记录", "dataShape": "每日一行"},
            }],
            None,
        ) is True

    def test_has_user_content_accepts_composer_preset_block_with_params_only(self):
        assert _has_user_content(
            "",
            [{"type": "composer_preset", "params": {"subject": "天气记录"}}],
            None,
        ) is True

    def test_has_user_content_rejects_empty_composer_preset_block(self):
        assert _has_user_content(
            "",
            [{"type": "composer_preset", "params": {}}],
            None,
        ) is False

    def test_filter_dict_drops_unknown_keys(self):
        cleaned = _filter_dict(
            {"current_app_type": "tabdoc", "billing_precheck_source": "EVIL"},
            _APP_CONTEXT_WHITELIST,
        )
        assert cleaned == {"current_app_type": "tabdoc"}

    def test_filter_dict_returns_none_for_non_dict(self):
        assert _filter_dict("nope", _APP_CONTEXT_WHITELIST) is None

    def test_filter_dict_returns_none_for_all_filtered(self):
        assert _filter_dict({"billing_precheck_source": "EVIL"}, _APP_CONTEXT_WHITELIST) is None

    def test_metadata_whitelist_does_not_leak_runtime_mode(self):
        assert "runtime_mode" not in _METADATA_WHITELIST

    def test_app_context_whitelist_does_not_leak_billing_source(self):
        assert "billing_precheck_source" not in _APP_CONTEXT_WHITELIST

    def test_app_context_whitelist_allows_user_time_zone(self):
        # 设备时区必须能透传——否则 Daemon current_datetime 回退 UTC，误判对话新旧。
        assert "user_time_zone" in _APP_CONTEXT_WHITELIST
        cleaned = _filter_dict(
            {"user_time_zone": "Asia/Shanghai", "billing_precheck_source": "EVIL"},
            _APP_CONTEXT_WHITELIST,
        )
        assert cleaned == {"user_time_zone": "Asia/Shanghai"}

    def test_allowed_roles_contains_gui_clients(self):
        assert _ALLOWED_ROLES == frozenset({"electron", "mobile", "admin", "web"})

    def test_map_http_error_404(self):
        mapped = _map_http_error(HttpError(404, "no such session"))
        assert mapped["error_code"] == "session_not_found"
        assert mapped["retryable"] is False

    def test_map_http_error_400(self):
        mapped = _map_http_error(HttpError(400, "bad input"))
        assert mapped["error_code"] == "schema_invalid"

    def test_map_http_error_403(self):
        mapped = _map_http_error(HttpError(403, "denied"))
        assert mapped["error_code"] == "permission_denied"

    def test_map_http_error_500(self):
        mapped = _map_http_error(HttpError(500, "boom"))
        assert mapped["error_code"] == "internal_error"
        assert mapped["retryable"] is True


# ---------------------------------------------------------------------------
# Handler integration
# ---------------------------------------------------------------------------


def _build_envelope(
    *,
    session_id: str = "00000000-0000-0000-0000-000000000001",
    message: str = "hello",
    client_event_id: str | None = None,
    blocks=None,
    attachments=None,
    metadata=None,
    app_context=None,
    skill_slash_invoke=None,
    model_id=None,
    request_id: str = "req-1",
):
    payload: dict = {
        "session_id": session_id,
        "message": message,
        "client_event_id": client_event_id or str(uuid.uuid4()),
    }
    if blocks is not None:
        payload["blocks"] = blocks
    if attachments is not None:
        payload["attachments"] = attachments
    if skill_slash_invoke is not None:
        payload["skill_slash_invoke"] = skill_slash_invoke
    if metadata is not None:
        payload["metadata"] = metadata
    if app_context is not None:
        payload["app_context"] = app_context
    if model_id is not None:
        payload["model_id"] = model_id
    return {
        "v": 1,
        "type": "chat.send_message",
        "request_id": request_id,
        "ts": int(time.time()),
        "device_id": "test-device",
        "role": "mobile",
        "payload": payload,
    }


def _patch_project_task_gate(return_value=None):
    return patch(
        "apps.services.common.ws.handlers.chat_send_message._evaluate_project_task_chat_send_gate",
        return_value=return_value,
    )


def _make_consumer(role: str = "mobile", user_id: str = "user-1"):
    consumer = MagicMock()
    consumer.role = role
    consumer.user_id = user_id
    consumer.user = MagicMock(id=user_id)
    consumer._send_envelope = AsyncMock()
    consumer._send_error = AsyncMock()
    return consumer


def _last_envelope(consumer):
    """从 consumer._send_envelope 取最后一次 send 的 envelope。"""
    assert consumer._send_envelope.call_count >= 1, "no envelope sent"
    return consumer._send_envelope.call_args.args[0]


class TestRoleGate:
    @pytest.mark.parametrize("bad_role", ["daemon", "device_runtime", "channel", "backend"])
    def test_non_gui_roles_get_permission_denied(self, bad_role):
        consumer = _make_consumer(role=bad_role)
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "permission_denied"
        assert "cannot send chat messages" in nak["payload"]["error_message"]


class TestClientEventIdValidation:
    def test_missing_client_event_id_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        env["payload"].pop("client_event_id")
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "schema_invalid"
        assert "client_event_id" in nak["payload"]["error_message"]

    def test_non_uuid_client_event_id_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(client_event_id="not-a-uuid")
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "schema_invalid"


class TestSchemaValidation:
    def test_missing_session_id_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        env["payload"]["session_id"] = ""
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "schema_invalid"

    def test_empty_message_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(message="   ")
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "schema_invalid"

    def test_image_only_block_is_valid_user_input(self):
        result = {
            "message_id": None,
            "reply": "ok",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "_remote_agent_task_id": "prompt_img_only",
        }
        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return result

        image_blocks = [{
            "type": "image",
            "source": {"type": "url", "url": "https://example.com/a.png"},
        }]
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(message="", blocks=image_blocks)

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=MagicMock(id="sess-1", is_paused=False, fork_copy_status=None)),
        ), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_capture,
        ):
            asyncio.run(handler(env))

        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert captured["message"] == ""
        assert captured["blocks"] == image_blocks

    def test_image_only_attachment_is_valid_user_input(self):
        result = {
            "message_id": None,
            "reply": "ok",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "_remote_agent_task_id": "prompt_img_only",
        }
        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return result

        image_attachments = [{"type": "image", "url": "https://example.com/a.png"}]
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(message="", attachments=image_attachments)

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=MagicMock(id="sess-1", is_paused=False, fork_copy_status=None)),
        ), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_capture,
        ):
            asyncio.run(handler(env))

        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert captured["message"] == ""
        assert captured["attachments"] == image_attachments

    def test_empty_image_attachment_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(message="", attachments=[{"type": "image", "filename": "a.png"}])
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "schema_invalid"

    def test_blocks_too_large_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        big = "x" * (_MAX_BLOCK_CONTENT_BYTES + 100)
        env = _build_envelope(blocks=[{"content": big}])
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "blocks_too_large"
        assert nak["payload"]["retryable"] is False

    def test_anonymous_user_nak(self):
        consumer = _make_consumer(user_id="")
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "auth_required"


class TestSessionResolution:
    def test_session_not_found_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=None),
        ):
            asyncio.run(handler(env))

        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "session_not_found"
        assert nak["payload"]["retryable"] is False

    def test_session_lookup_exception_nak(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(side_effect=RuntimeError("db down")),
        ):
            asyncio.run(handler(env))

        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "internal_error"
        assert nak["payload"]["retryable"] is True


class TestChatServiceIntegration:
    """覆盖 ChatService.send_message_sync 各种返回形态对应的 ack/nak。"""

    def _patch_resolve_session(self):
        return patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=MagicMock(id="sess-1", is_paused=False, fork_copy_status=None)),
        )

    def _run_with_chat_result(self, result, **handler_overrides):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(**handler_overrides)

        async def _fake_invoke(**kwargs):
            return result

        # asyncio.to_thread(fn, **kwargs) 会调 fn(**kwargs)，所以直接 patch
        # 内部 sync helper，让线程池里的调用立刻返回我们指定的结果。
        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=lambda **kw: result,
        ):
            asyncio.run(handler(env))
        return consumer

    def test_project_task_run_required_gate_naks_before_chatservice(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        invoke = MagicMock()

        with self._patch_resolve_session(), _patch_project_task_gate({
            "error_code": "project_task_run_required",
            "error_message": "请回到任务详情点击「重新运行」创建新的执行。",
            "error_category": "project_task_run_required",
            "retryable": False,
        }), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=invoke,
        ):
            asyncio.run(handler(env))

        invoke.assert_not_called()
        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "project_task_run_required"
        assert nak["payload"]["error_category"] == "project_task_run_required"
        assert nak["payload"]["retryable"] is False
        assert "重新运行" in nak["payload"]["error_message"]

    def test_success_ack_carries_full_payload(self):
        result = {
            "message_id": "msg-uuid-1",
            "reply": "hello back",
            "model_id": "model-uuid-1",
            "model_name": "tin-2",
            "trace_id": "trace-uuid-1",
        }
        consumer = self._run_with_chat_result(result)
        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        p = ack["payload"]
        assert p["message_id"] == "msg-uuid-1"
        assert p["task_id"] is None
        assert p["trace_id"] == "trace-uuid-1"
        assert p["model_id"] == "model-uuid-1"
        assert p["model_name"] == "tin-2"
        assert "delivery" not in p

    def test_success_ack_attaches_run_state_when_projection_exists(self):
        """#9051：ACK 可选带回 run_state，缩短远控发起端等待 WS 的空窗。"""
        result = {
            "message_id": "msg-uuid-1",
            "reply": "hello back",
            "model_id": "model-uuid-1",
            "model_name": "tin-2",
            "trace_id": "trace-uuid-1",
        }
        run_state = {
            "run_id": "11111111-1111-1111-1111-111111111111",
            "sequence": 2,
            "revision": 1,
            "status": "queued",
            "queue_depth": 0,
            "started_at": None,
            "state_changed_at": "2026-08-04T12:00:00+00:00",
            "ended_at": None,
            "stop_reason": None,
            "error_class": None,
            "waiting_interaction_id": None,
        }
        with patch(
            "apps.services.agent_engine.models.SessionRunProjection.objects.filter"
        ) as filter_mock, patch(
            "apps.services.agent_engine.services.session_run_state_service.serialize_run_state",
            return_value=run_state,
        ):
            filter_mock.return_value.first.return_value = MagicMock()
            consumer = self._run_with_chat_result(result)
        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert ack["payload"]["run_state"] == run_state

    @pytest.mark.django_db(transaction=True, databases=["default"])
    def test_success_ack_loads_run_state_from_db_outside_async_context(self, caplog):
        """真实 ORM 查询必须经 database_sync_to_async，不能在 async handler 直调。"""
        User = get_user_model()
        user = User.objects.create_user(
            username=f"ack_run_state_{uuid.uuid4().hex[:8]}",
            email=f"ack-run-state-{uuid.uuid4().hex[:8]}@example.com",
            password="testpass123",
        )
        session = ChatSession.objects.create(
            user=user,
            organization_id=str(uuid.uuid4()),
            title="ack run state",
        )
        now = timezone.now()
        run_id = uuid.uuid4()
        run = ExecutionRun.objects.create(
            run_id=run_id,
            thread_id=f"chat-session-{session.id}",
            graph_type="chat",
            session_id=str(session.id),
            organization_id=session.organization_id,
            user_id=str(user.id),
            sequence=1,
            revision=0,
            status=ExecutionRun.Status.QUEUED,
            state_changed_at=now,
        )
        SessionRunProjection.objects.create(
            session=session,
            current_run=run,
            sequence=1,
            revision=1,
            status=ExecutionRun.Status.QUEUED,
            queue_depth=0,
            state_changed_at=now,
        )
        result = {
            "message_id": "msg-uuid-1",
            "reply": "hello back",
            "model_id": "model-uuid-1",
            "model_name": "tin-2",
            "trace_id": "trace-uuid-1",
        }
        consumer = _make_consumer(user_id=str(user.id))
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(session_id=str(session.id))

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=session),
        ), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=lambda **kw: result,
        ), caplog.at_level("ERROR"):
            asyncio.run(handler(env))

        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert ack["payload"]["run_state"]["run_id"] == str(run_id)
        assert ack["payload"]["run_state"]["status"] == ExecutionRun.Status.QUEUED
        assert "attach run_state to ACK failed" not in caplog.text
        assert "SynchronousOnlyOperation" not in caplog.text

    def test_external_dispatch_uses_real_task_id(self):
        """外部 dispatch 成功时应优先返回 result['task_id']（PromptForward 真实 id）。"""
        result = {
            "message_id": "user-msg-uuid",
            "reply": "",
            "model_id": "model-uuid-1",
            "model_name": "tin-2",
            "trace_id": None,
            "dispatched_external": True,
            "task_id": "prompt_abc123def456",
        }
        consumer = self._run_with_chat_result(result)
        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert ack["payload"]["task_id"] == "prompt_abc123def456"
        assert ack["payload"]["message_id"] == "user-msg-uuid"

    def test_async_dispatched_without_message_id_returns_ok(self):
        """委托转发成功但 message_id=None 时不应误判为 internal_error。"""
        result = {
            "message_id": None,
            "reply": "ok",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "_remote_agent_task_id": "prompt_xyz789",
            "_remote_agent_runtime_mode": "local",
        }
        consumer = self._run_with_chat_result(result)
        ack = _last_envelope(consumer)
        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert ack["payload"]["delivery"] == "async_dispatched"
        assert ack["payload"]["task_id"] == "prompt_xyz789"
        assert ack["payload"]["message_id"] is None

    def test_rejected_concurrent_nak_is_retryable(self):
        result = {
            "message_id": "",
            "reply": "queued/rejected",
            "model_id": None,
            "model_name": None,
            "_rejected_concurrent": True,
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "concurrent_rejected"
        assert nak["payload"]["retryable"] is True

    def test_error_category_billing_nak(self):
        result = {
            "message_id": "",
            "reply": "Quota exceeded",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "error_category": "conversation_quota_exceeded",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "billing_precheck_failed"
        assert nak["payload"]["error_category"] == "conversation_quota_exceeded"
        assert "delivery" not in nak["payload"]
        assert "message_id" not in nak["payload"]

    def test_error_category_device_offline_nak_retryable(self):
        result = {
            "message_id": "persisted-user-message-id",
            "reply": "device offline",
            "model_id": None,
            "model_name": None,
            "error_category": "device_offline",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "device_offline"
        assert nak["payload"]["retryable"] is True
        assert nak["payload"]["message_id"] == "persisted-user-message-id"
        assert nak["payload"]["delivery"] == "persisted"
        assert nak["payload"]["execution_state"] == "awaiting_device"

    def test_error_category_device_offline_empty_reply_uses_localized_message(self):
        """#8418：reply 为空时不得把 snake_case category 当作 NAK error_message。"""
        result = {
            "message_id": "persisted-user-message-id",
            "reply": "",
            "model_id": None,
            "model_name": None,
            "error_category": "device_offline",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)

        assert nak["payload"]["error_code"] == "device_offline"
        assert nak["payload"]["error_message"] != "device_offline"
        assert "Daemon" in nak["payload"]["error_message"] or "设备" in nak["payload"]["error_message"]

    def test_error_category_skips_diagnostic_error_message(self):
        result = {
            "message_id": "persisted-user-message-id",
            "reply": "",
            "model_id": None,
            "model_name": None,
            "error_category": "device_offline",
            "error_message": "control_device sedas-MacBook-Air.local (darwin) status=offline",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)

        assert nak["payload"]["error_message"] != "device_offline"
        assert "status=" not in nak["payload"]["error_message"]
        assert "control_device" not in nak["payload"]["error_message"]

    def test_error_category_device_busy_empty_reply_uses_localized_message(self):
        result = {
            "message_id": "",
            "reply": "",
            "model_id": None,
            "model_name": None,
            "error_category": "device_busy",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)

        assert nak["payload"]["error_code"] == "device_offline"
        assert nak["payload"]["error_message"] != "device_busy"
        assert nak["payload"]["error_message"] != "device_offline"

    def test_error_category_respects_service_retryable_override(self):
        result = {
            "message_id": "persisted-user-message-id",
            "reply": "device requires user action",
            "model_id": None,
            "model_name": None,
            "error_category": "device_offline",
            "retryable": False,
        }

        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)

        assert nak["payload"]["error_code"] == "device_offline"
        assert nak["payload"]["retryable"] is False

    def test_route_none_nak_carries_persisted_user_and_service_retryable(self):
        result = {
            "message_id": "persisted-route-none-user",
            "reply": "no route",
            "model_id": None,
            "model_name": None,
            "error_category": "route_none",
            "retryable": True,
        }

        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)

        assert nak["payload"]["error_code"] == "route_failed"
        assert nak["payload"]["retryable"] is True
        assert nak["payload"]["message_id"] == "persisted-route-none-user"
        assert nak["payload"]["delivery"] == "persisted"

    def test_queue_full_nak_is_retryable_and_not_queued_ok(self):
        result = {
            "message_id": "persisted-queue-user",
            "reply": "queue full",
            "model_id": None,
            "model_name": None,
            "error_category": "queue_full",
            "retryable": True,
        }

        consumer = self._run_with_chat_result(result)
        envelope = _last_envelope(consumer)

        assert envelope["type"] == CHAT_SEND_MESSAGE_NAK
        assert envelope["payload"]["error_code"] == "rate_limited"
        assert envelope["payload"]["retryable"] is True
        assert envelope["payload"]["message_id"] == "persisted-queue-user"

    def test_queued_result_exposes_delivery_state(self):
        result = {
            "message_id": "queued-user-id",
            "reply": "queued",
            "model_id": None,
            "model_name": None,
            "trace_id": None,
            "delivery": "queued",
            "execution_state": "awaiting_run",
        }

        consumer = self._run_with_chat_result(result)
        ack = _last_envelope(consumer)

        assert ack["type"] == CHAT_SEND_MESSAGE_OK
        assert ack["payload"]["delivery"] == "queued"
        assert ack["payload"]["execution_state"] == "awaiting_run"

    @pytest.mark.parametrize("category, expected_code, expected_retryable", [
        ("device_busy", "device_offline", True),
        ("device_unreachable", "device_offline", True),
        ("device_dropped", "device_offline", True),
        ("owner_execution_device_unavailable", "device_offline", True),
        ("runtime_failed", "route_failed", True),
        ("missing_organization_id", "configuration_error", False),
        ("insufficient_credits", "billing_precheck_failed", False),
        ("organization_insufficient_credits", "billing_precheck_failed", False),
        ("member_monthly_limit", "billing_precheck_failed", False),
    ])
    def test_error_category_mapping_table(self, category, expected_code, expected_retryable):
        """覆盖 _ERROR_CATEGORY_TO_CODE 表里关键类目的精确映射。"""
        result = {
            "message_id": "",
            "reply": f"{category} occurred",
            "model_id": None,
            "model_name": None,
            "error_category": category,
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == expected_code
        assert nak["payload"]["error_category"] == category
        assert nak["payload"]["retryable"] is expected_retryable

    def test_error_category_unknown_defaults_to_internal_error(self):
        """Wave 3 隐患 2 修复：未收录的 category 默认走 internal_error 而非
        billing_precheck_failed —— 否则客户端会把"路由失败 / 配置错误 / 任何
        新增类目"全部误显示为"余额不足"，与真实原因完全错位。"""
        result = {
            "message_id": "",
            "reply": "some unmapped failure occurred",
            "model_id": None,
            "model_name": None,
            "error_category": "totally_new_category_not_in_mapping_table",
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "internal_error", (
            "未收录的 error_category 必须 fallback 到 internal_error，"
            "不能误标为 billing_precheck_failed"
        )
        assert nak["payload"]["error_category"] == "totally_new_category_not_in_mapping_table"

    def test_empty_message_id_nak_internal(self):
        result = {
            "message_id": "",
            "reply": "ok",
            "model_id": None,
            "model_name": None,
        }
        consumer = self._run_with_chat_result(result)
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "internal_error"
        assert nak["payload"]["retryable"] is True

    def test_http_error_404_maps_to_session_not_found(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=HttpError(404, "session gone"),
        ):
            asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "session_not_found"

    def test_missing_session_agent_nak_is_explicit_and_not_retryable(self):
        """配置缺失不能伪装成 internal_error，否则移动端会错误地继续重试。"""
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=EffectiveRuntimeConfigError("AGENT_REQUIRED", "会话没有当前 Agent"),
        ):
            asyncio.run(handler(env))

        nak = _last_envelope(consumer)
        assert nak["type"] == CHAT_SEND_MESSAGE_NAK
        assert nak["payload"]["error_code"] == "agent_required"
        assert nak["payload"]["error_message"] == "会话没有当前 Agent"
        assert nak["payload"]["retryable"] is False

    def test_unexpected_exception_nak_internal_retryable(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=RuntimeError("unexpected boom"),
        ):
            asyncio.run(handler(env))
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "internal_error"
        assert nak["payload"]["retryable"] is True

    def test_metadata_and_app_context_filtered_before_chatservice(self):
        """白名单确保 ChatService 拿到的 app_context 不含敏感字段，且
        允许的 metadata 字段以 _client_metadata_ 前缀合并进 app_context 透传。"""
        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return {
                "message_id": "msg-1",
                "reply": "ok",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
            }

        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(
            metadata={
                "client_app_version": "1.0.0",
                "client_locale": "zh-CN",
                "billing_precheck_source": "EVIL",
            },
            app_context={
                "current_app_type": "tabdoc",
                "billing_precheck_source": "EVIL",
                "runtime_mode": "EVIL",
            },
            skill_slash_invoke={
                "skill_key": "app:office/meeting-notes",
                "args": "整理今天的会议",
            },
        )

        with self._patch_resolve_session(), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_capture,
        ):
            asyncio.run(handler(env))

        ctx = captured.get("app_context") or {}
        assert ctx["_skill_slash_invoke"] == {
            "skill_key": "app:office/meeting-notes",
            "args": "整理今天的会议",
        }
        # 敏感字段不会出现在传给 ChatService 的 app_context 里。
        assert "billing_precheck_source" not in ctx
        assert "runtime_mode" not in ctx
        # 白名单内的 app_context 字段透传。
        assert ctx["current_app_type"] == "tabdoc"
        # 白名单内的 metadata 字段以 _client_metadata_ 前缀合并进 app_context。
        assert ctx["_client_metadata_client_app_version"] == "1.0.0"
        assert ctx["_client_metadata_client_locale"] == "zh-CN"
        # 黑名单字段不会通过 metadata 偷渡。
        assert "_client_metadata_billing_precheck_source" not in ctx

    def test_client_forged_execution_agent_id_is_stripped(self):
        """app_context 白名单不包含 `_execution_agent_id`，客户端伪造值不得透传。"""
        captured: dict = {}

        def _capture(**kwargs):
            captured.update(kwargs)
            return {
                "message_id": "msg-1",
                "reply": "ok",
                "model_id": None,
                "model_name": None,
                "trace_id": None,
            }

        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope(app_context={"_execution_agent_id": "client-forged"})
        session = MagicMock(
            id="sess-1",
            execution_agent_id="server-owned-agent",
            fork_copy_status=None,
            is_paused=False,
        )

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=session),
        ), _patch_project_task_gate(), patch(
            "apps.services.common.ws.handlers.chat_send_message._apply_turn_binding",
            new=AsyncMock(return_value=None),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
            side_effect=_capture,
        ):
            asyncio.run(handler(env))

        ctx = captured.get("app_context") or {}
        assert "_execution_agent_id" not in ctx
        assert "client-forged" not in str(ctx)

    def test_paused_session_rejects_new_message(self):
        consumer = _make_consumer()
        handler = create_chat_send_message_handler(consumer)
        env = _build_envelope()
        session = MagicMock(
            id="sess-1",
            is_paused=True,
            fork_copy_status=None,
        )

        with patch(
            "apps.services.common.ws.handlers.chat_send_message._resolve_session",
            new=AsyncMock(return_value=session),
        ), patch(
            "apps.services.common.ws.handlers.chat_send_message._invoke_chat_service_sync",
        ) as invoke:
            asyncio.run(handler(env))

        invoke.assert_not_called()
        nak = _last_envelope(consumer)
        assert nak["payload"]["error_code"] == "session_paused"
