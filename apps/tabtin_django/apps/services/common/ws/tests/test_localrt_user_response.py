"""localrt.user_response handler 回归测试（MB-23）。

覆盖 Electron-only runtime 场景下 HITL 回传路径：
  - device 解析增 Electron fallback（对齐 prompt.forward）
  - device_offline 时**不** SETNX consumed（允许重试）
  - 成功路径：先 forward 再 mirror approval_resolved
"""

from __future__ import annotations

import json
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

from django.test import SimpleTestCase

from apps.services.common.agent_protocol.namespace import device_action_topic
from apps.services.common.agent_protocol.constants import AgentStreamEvent
from apps.services.common.ws.handlers.relay_handler import _record_hitl_pending_owner
from apps.services.common.ws.handlers.localrt_user_response import (
    LOCALRT_CONSUMED_PREFIX,
    LOCALRT_DELIVERY_ACK_PREFIX,
    LOCALRT_DELIVERY_EVENT_TYPE,
    LOCALRT_DELIVERY_RESPONSE_OK,
    LOCALRT_RESPONSE_NAK,
    LOCALRT_RESPONSE_OK,
    create_localrt_user_response_delivery_handler,
    create_localrt_user_response_handler,
    record_pending_owner,
    _publish_approval_resolved_to_mirror,
    _resolve_runtime_device_fp,
    _resolve_runtime_device_fp_for_hitl,
)
from apps.services.common.ws.tests.test_e2e_action import (
    _FakeChannelLayer,
    _FakeConsumer,
    _FakeRedis,
    _envelope,
    _make_publish,
    _run,
)


class ResolveRuntimeDeviceFpTests(SimpleTestCase):
    thread_id = "chat-session-sess-001"
    bound_fp = "fp-bound"
    daemon_fp = "fp-daemon"
    electron_fp = "fp-electron"

    def _mock_service(self, *, bound=None, daemon=None):
        svc = MagicMock()
        svc.get_action_device.return_value = bound
        svc._resolve_daemon_fingerprint.return_value = daemon
        svc.redis_client = _FakeRedis()
        return svc

    def test_prefers_redis_action_device_binding(self):
        svc = self._mock_service(bound=self.bound_fp, daemon=self.daemon_fp)
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            self.assertEqual(_resolve_runtime_device_fp(self.thread_id), self.bound_fp)

    def test_redis_action_device_binding_accepts_raw_session_key(self):
        svc = self._mock_service(bound=None, daemon=self.daemon_fp)
        svc.get_action_device.side_effect = (
            lambda key: self.bound_fp if key == self.thread_id.removeprefix("chat-session-") else None
        )
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            self.assertEqual(_resolve_runtime_device_fp(self.thread_id), self.bound_fp)

    def test_falls_back_to_daemon_when_no_binding(self):
        svc = self._mock_service(bound=None, daemon=self.daemon_fp)
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            self.assertEqual(_resolve_runtime_device_fp(self.thread_id), self.daemon_fp)

    def test_electron_fallback_prefers_explicit_control_device(self):
        svc = self._mock_service(bound=None, daemon=None)
        fake_space = SimpleNamespace(organization_id="wt-1", agent_id="agent-1")
        fake_session = SimpleNamespace(user_id="owner-1", workspace_id="wt-1")
        control_fp = "fp-explicit-electron"
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_space_for_thread",
            return_value=fake_space,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_session_for_thread",
            return_value=fake_session,
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService._resolve_electron_control_fingerprint",
            return_value=control_fp,
        ) as mock_control, patch(
            "apps.services.common.ws.bus.is_device_ws_connected",
            return_value=True,
        ):
            self.assertEqual(_resolve_runtime_device_fp(self.thread_id), control_fp)
            mock_control.assert_called_once_with(
                fake_space,
                agent_id="agent-1",
                execution_owner_user_id="owner-1",
            )

    def test_no_org_electron_fallback_when_no_binding_or_daemon(self):
        """#7529：无显式 control_device 时不再回退到同 org 任意 Electron。"""
        svc = self._mock_service(bound=None, daemon=None)
        fake_space = SimpleNamespace(organization_id="wt-1", agent_id="agent-1")
        fake_session = SimpleNamespace(user_id="owner-1", workspace_id="wt-1")
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_space_for_thread",
            return_value=fake_space,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_session_for_thread",
            return_value=fake_session,
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService._resolve_electron_control_fingerprint",
            return_value=None,
        ), patch(
            "apps.services.common.ws.bus.is_device_ws_connected",
            return_value=True,
        ):
            self.assertIsNone(_resolve_runtime_device_fp(self.thread_id))

    def test_returns_none_when_electron_offline(self):
        svc = self._mock_service(bound=None, daemon=None)
        fake_space = SimpleNamespace(organization_id="wt-1", agent_id="agent-1")
        fake_session = SimpleNamespace(user_id="owner-1", workspace_id="wt-1")
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_space_for_thread",
            return_value=fake_space,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_session_for_thread",
            return_value=fake_session,
        ), patch(
            "apps.services.agent_engine.services.prompt_forward_service.PromptForwardService._resolve_electron_control_fingerprint",
            return_value=self.electron_fp,
        ), patch(
            "apps.services.common.ws.bus.is_device_ws_connected",
            return_value=False,
        ):
            self.assertIsNone(_resolve_runtime_device_fp(self.thread_id))


class LocalrtUserResponseHandlerTests(SimpleTestCase):
    thread_id = "chat-session-sess-hitl"
    batch_id = "batch-abc-123"
    request_hitl_id = "request-approval-123"
    electron_fp = "fp-electron-hitl"

    def setUp(self):
        self.channel_layer = _FakeChannelLayer()
        self.fake_redis = _FakeRedis()
        self.mobile = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="mobile",
            user_id="user-hitl",
            device_fingerprint="fp-mobile",
        )
        self.daemon_channel = f"ch_daemon_{uuid.uuid4().hex[:6]}"
        _run(self.mobile.channel_layer.group_add(
            device_action_topic(self.electron_fp).replace(".", "."),
            self.daemon_channel,
        ))
        for target in (
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_tool_approval_async",
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_single_hitl_async",
        ):
            patcher = patch(target, return_value=True)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _batch_payload(self):
        return {
            "thread_id": self.thread_id,
            "request_id": self.batch_id,
            "response": {
                "batch_id": self.batch_id,
                "decisions": [
                    {
                        "request_id": "req-1",
                        "tool_call_id": "tc-1",
                        "outcome": "allow",
                        "scope": "once",
                    }
                ],
            },
        }

    def _request_payload(self):
        return {
            "thread_id": self.thread_id,
            "request_id": self.request_hitl_id,
            "response": {"approved": True},
        }

    def _service_mock(self):
        svc = MagicMock()
        svc.get_action_device.return_value = None
        svc._resolve_daemon_fingerprint.return_value = None
        svc.redis_client = self.fake_redis
        return svc

    def _run_handler(self, envelope, *, resolve_fp=None, publish_side_effect=None, wait_ack=None):
        handler = create_localrt_user_response_handler(self.mobile)
        svc = self._service_mock()
        patches = [
            patch(
                "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
                return_value=svc,
            ),
            patch(
                "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
                return_value=resolve_fp,
            ),
        ]
        if resolve_fp is not None:
            patches.append(
                patch(
                    "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp",
                    return_value=resolve_fp,
                )
            )
        publish = publish_side_effect or _make_publish(self.channel_layer)
        patches.append(
            patch(
                "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
                side_effect=lambda device_fp, envelope: publish(
                    device_action_topic(device_fp), envelope
                ),
            )
        )
        patches.append(
            patch(
                "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
            )
        )
        if wait_ack is None:
            wait_ack = AsyncMock(return_value={"status": "delivered"})
        patches.append(
            patch(
                "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
                wait_ack,
            )
        )
        ctx = [p.start() for p in patches]
        try:
            _run(handler(envelope))
        finally:
            for p in reversed(patches):
                p.stop()
        return svc

    def test_device_offline_does_not_consume_batch(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        self._run_handler(env, resolve_fp=None)

        consumed_key = f"{LOCALRT_CONSUMED_PREFIX}batch:{self.batch_id}"
        self.assertNotIn(consumed_key, self.fake_redis._data)

        naks = self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        self.assertEqual(naks[0]["payload"]["error_code"], "device_offline")
        self.assertTrue(naks[0]["payload"]["retryable"])

    def test_device_offline_then_retry_succeeds(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )

        # 第一次：device_offline
        self._run_handler(env, resolve_fp=None)
        self.assertEqual(
            self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)[0]["payload"]["error_code"],
            "device_offline",
        )

        # 第二次：Electron 在线 —— 不应 already_consumed
        self._run_handler(env, resolve_fp=self.electron_fp)
        naks = self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        oks = self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)
        self.assertEqual(len(oks), 1)
        self.assertFalse(oks[0]["payload"]["buffered"])

        consumed_key = f"{LOCALRT_CONSUMED_PREFIX}batch:{self.batch_id}"
        self.assertEqual(self.fake_redis.get(consumed_key), "1")

    def test_success_forwards_before_mirror_and_ok(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        call_order: list[str] = []

        def tracking_publish(topic, envelope):
            call_order.append(f"publish:{envelope['type']}")
            return _make_publish(self.channel_layer)(topic, envelope)

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=self._service_mock(),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp",
            return_value=self.electron_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=self.electron_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
            side_effect=lambda device_fp, envelope: tracking_publish(
                device_action_topic(device_fp), envelope
            ),
        ) as mock_publish, patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
            side_effect=lambda *a, **k: call_order.append("mirror"),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
            AsyncMock(return_value={"status": "delivered"}),
        ):
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        self.assertEqual(len(self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)), 1)
        self.assertEqual(mock_publish.call_count, 1)
        forwarded = mock_publish.call_args.args[1]
        decision = forwarded["payload"]["response"]["decisions"][0]
        self.assertEqual(decision["approver_identity"]["user_id"], self.mobile.user_id)
        self.assertEqual(call_order[0], "publish:localrt.user_response")
        self.assertEqual(call_order[1], "mirror")

    def test_non_owner_team_space_batch_response_is_rejected(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_tool_approval_async",
            AsyncMock(return_value=False),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
        ) as publish:
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        publish.assert_not_called()
        self.assertEqual(len(self.mobile._errors), 1)
        self.assertEqual(self.mobile._errors[0]["payload"]["code"], "WS_1005_PERMISSION_DENIED")

    def test_non_owner_team_space_single_request_response_is_rejected(self):
        """#2355：ask_choice / ask_form / permission_request 与 tool_approval 同一 owner 门控。"""
        env = _envelope(
            "localrt.user_response",
            self._request_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._can_user_resolve_single_hitl_async",
            AsyncMock(return_value=False),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
        ) as publish:
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        publish.assert_not_called()
        self.assertEqual(len(self.mobile._errors), 1)
        self.assertEqual(self.mobile._errors[0]["payload"]["code"], "WS_1005_PERMISSION_DENIED")

    def test_owner_mapping_routes_by_batch_id_before_thread_fallback(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        owner_fp = "fp-owner-runtime"
        svc = self._service_mock()
        topics: list[str] = []

        def tracking_publish(topic, envelope):
            topics.append(topic)
            return _make_publish(self.channel_layer)(topic, envelope)

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            record_pending_owner(
                thread_id=self.thread_id,
                target_id=self.batch_id,
                device_fingerprint=owner_fp,
                kind="batch",
            )
            self.assertEqual(
                _resolve_runtime_device_fp_for_hitl(
                    self.thread_id,
                    kind="batch",
                    target_id=self.batch_id,
                ),
                owner_fp,
            )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp",
            return_value="fp-wrong-fallback",
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=owner_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
            side_effect=lambda device_fp, envelope: tracking_publish(
                device_action_topic(device_fp), envelope
            ),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
            AsyncMock(return_value={"status": "delivered"}),
        ):
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        self.assertEqual(topics, [device_action_topic(owner_fp)])
        self.assertEqual(len(self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)), 1)

    def test_owner_mapping_accepts_raw_and_chat_session_thread_forms(self):
        owner_fp = "fp-owner-runtime"
        svc = self._service_mock()

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            record_pending_owner(
                thread_id=self.thread_id,
                target_id=self.batch_id,
                device_fingerprint=owner_fp,
                kind="batch",
            )
            self.assertEqual(
                _resolve_runtime_device_fp_for_hitl(
                    self.thread_id.removeprefix("chat-session-"),
                    kind="batch",
                    target_id=self.batch_id,
                ),
                owner_fp,
            )

    def test_request_owner_mapping_routes_single_request_before_thread_fallback(self):
        env = _envelope(
            "localrt.user_response",
            self._request_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        owner_fp = "fp-owner-runtime"
        svc = self._service_mock()
        topics: list[str] = []

        def tracking_publish(topic, envelope):
            topics.append(topic)
            return _make_publish(self.channel_layer)(topic, envelope)

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            record_pending_owner(
                thread_id=self.thread_id.removeprefix("chat-session-"),
                target_id=self.request_hitl_id,
                device_fingerprint=owner_fp,
                kind="request",
            )
            self.assertEqual(
                _resolve_runtime_device_fp_for_hitl(
                    self.thread_id,
                    kind="request",
                    target_id=self.request_hitl_id,
                ),
                owner_fp,
            )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp",
            return_value="fp-wrong-fallback",
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=owner_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
            side_effect=lambda device_fp, envelope: tracking_publish(
                device_action_topic(device_fp), envelope
            ),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._wait_for_delivery_ack",
            AsyncMock(return_value={"status": "delivered"}),
        ):
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        self.assertEqual(topics, [device_action_topic(owner_fp)])
        self.assertEqual(len(self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)), 1)

    def test_relay_owner_mapping_records_request_id_aliases(self):
        """Runtime HITL event aliases must not break mobile submit routing."""
        owner_fp = "fp-owner-runtime"
        svc = self._service_mock()
        request_id = "request-id-visible-to-mobile"
        interrupt_id = "interrupt-id-runtime-internal"

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            _record_hitl_pending_owner(
                thread_id=self.thread_id,
                short_name=AgentStreamEvent.REQUEST_APPROVAL_REQUIRED,
                event_payload={
                    "request_id": request_id,
                    "interrupt_id": interrupt_id,
                    "title": "Approve?",
                },
                device_fingerprint=owner_fp,
            )

            self.assertEqual(
                _resolve_runtime_device_fp_for_hitl(
                    self.thread_id,
                    kind="request",
                    target_id=request_id,
                ),
                owner_fp,
            )
            self.assertEqual(
                _resolve_runtime_device_fp_for_hitl(
                    self.thread_id,
                    kind="request",
                    target_id=interrupt_id,
                ),
                owner_fp,
            )

    def test_ok_waits_for_runtime_delivery_ack(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        svc = self._service_mock()
        seen_submit_ids: list[str] = []

        def publish_and_ack(topic, envelope):
            submit_id = envelope["payload"]["submit_id"]
            seen_submit_ids.append(submit_id)
            self.fake_redis.set(
                f"{LOCALRT_DELIVERY_ACK_PREFIX}{submit_id}",
                json.dumps({"submit_id": submit_id, "status": "delivered"}),
            )
            return _make_publish(self.channel_layer)(topic, envelope)

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._resolve_runtime_device_fp",
            return_value=self.electron_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_frozen_runtime_device_fp",
            return_value=self.electron_fp,
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_device_ws_event_exact",
            side_effect=lambda device_fp, envelope: publish_and_ack(
                device_action_topic(device_fp), envelope
            ),
        ), patch(
            "apps.services.common.ws.handlers.localrt_user_response._publish_approval_resolved_to_mirror",
        ):
            handler = create_localrt_user_response_handler(self.mobile)
            _run(handler(env))

        self.assertEqual(len(seen_submit_ids), 1)
        oks = self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)
        self.assertEqual(len(oks), 1)
        self.assertTrue(oks[0]["payload"]["delivered"])

    def test_mirror_resolved_marks_pending_interaction_after_delivery(self):
        response = self._batch_payload()["response"]

        with patch(
            "apps.services.agent_engine.services.pending_interaction_service.mark_tool_approval_resolved_from_payload",
        ) as mark_resolved, patch(
            "apps.services.common.ws.handlers.localrt_user_response.publish_ws_event_reliable",
        ) as publish_reliable:
            _publish_approval_resolved_to_mirror(self.thread_id, response)

        mark_resolved.assert_called_once_with(
            thread_id=self.thread_id,
            payload={
                "batch_id": self.batch_id,
                "decisions": response["decisions"],
                "schema_version": 1,
            },
            publish=True,
        )
        publish_reliable.assert_called_once()
        envelope = publish_reliable.call_args.args[1]
        self.assertEqual(envelope["type"], "agent.stream.approval_resolved")
        self.assertEqual(envelope["payload"]["batch_id"], self.batch_id)

    def test_single_request_marks_pending_interaction_after_delivery(self):
        env = _envelope(
            "localrt.user_response",
            self._request_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._mark_single_hitl_pending_interaction",
        ) as mark_single:
            self._run_handler(env, resolve_fp=self.electron_fp)

        mark_single.assert_called_once_with(
            thread_id=self.thread_id,
            request_id=self.request_hitl_id,
            response_obj={"approved": True},
            status="resolved",
        )
        oks = self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)
        self.assertEqual(len(oks), 1)
        self.assertTrue(oks[0]["payload"]["delivered"])

    def test_pending_not_found_does_not_consume_and_returns_nak(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        self._run_handler(
            env,
            resolve_fp=self.electron_fp,
            wait_ack=AsyncMock(return_value={
                "status": "pending_not_found",
                "error_code": "pending_not_found",
                "error_message": "No pending approval batch on this runtime",
                "retryable": False,
            }),
        )

        consumed_key = f"{LOCALRT_CONSUMED_PREFIX}batch:{self.batch_id}"
        self.assertNotIn(consumed_key, self.fake_redis._data)
        naks = self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        self.assertEqual(naks[0]["payload"]["error_code"], "pending_not_found")
        self.assertFalse(naks[0]["payload"]["retryable"])

    def test_delivery_handler_persists_ack(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            user_id="daemon-user",
            device_fingerprint=self.electron_fp,
        )
        env = _envelope(
            LOCALRT_DELIVERY_EVENT_TYPE,
            {"submit_id": "submit-1", "status": "delivered", "batch_id": self.batch_id},
            role="daemon",
            device_id=self.electron_fp,
            thread_id=self.thread_id,
        )
        svc = self._service_mock()
        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._get_action_service",
            return_value=svc,
        ):
            handler = create_localrt_user_response_delivery_handler(daemon)
            _run(handler(env))

        ack = json.loads(self.fake_redis.get(f"{LOCALRT_DELIVERY_ACK_PREFIX}submit-1"))
        self.assertEqual(ack["status"], "delivered")
        self.assertEqual(ack["device_fingerprint"], self.electron_fp)
        self.assertEqual(len(daemon.sent_of_type(LOCALRT_DELIVERY_RESPONSE_OK)), 1)

    def test_unverified_runtime_cannot_ack_delivery(self):
        daemon = _FakeConsumer(
            channel_layer=self.channel_layer,
            role="daemon",
            user_id="daemon-user",
            device_fingerprint=self.electron_fp,
        )
        daemon.device_identity_verified = False
        env = _envelope(
            LOCALRT_DELIVERY_EVENT_TYPE,
            {"submit_id": "submit-unverified", "status": "delivered"},
            role="daemon",
            device_id=self.electron_fp,
            thread_id=self.thread_id,
        )

        _run(create_localrt_user_response_delivery_handler(daemon)(env))

        self.assertIsNone(
            self.fake_redis.get(f"{LOCALRT_DELIVERY_ACK_PREFIX}submit-unverified")
        )
        self.assertIn("not verified", daemon._errors[0]["payload"]["message"])

    def test_duplicate_submit_returns_already_consumed(self):
        env = _envelope(
            "localrt.user_response",
            self._batch_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )
        self._run_handler(env, resolve_fp=self.electron_fp)
        self._run_handler(env, resolve_fp=self.electron_fp)

        naks = self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        self.assertEqual(naks[0]["payload"]["error_code"], "already_consumed")
        self.assertFalse(naks[0]["payload"]["retryable"])
        self.assertEqual(len(self.mobile.sent_of_type(LOCALRT_RESPONSE_OK)), 1)

    def test_duplicate_single_request_marks_pending_interaction_resolved(self):
        env = _envelope(
            "localrt.user_response",
            self._request_payload(),
            role="mobile",
            device_id="fp-mobile",
            thread_id=self.thread_id,
        )

        with patch(
            "apps.services.common.ws.handlers.localrt_user_response._mark_single_hitl_pending_interaction",
        ) as mark_single:
            self._run_handler(env, resolve_fp=self.electron_fp)
            mark_single.reset_mock()
            self._run_handler(env, resolve_fp=self.electron_fp)

        mark_single.assert_called_once_with(
            thread_id=self.thread_id,
            request_id=self.request_hitl_id,
            response_obj={"approved": True},
            status="resolved",
            reason="already_consumed",
        )
        naks = self.mobile.sent_of_type(LOCALRT_RESPONSE_NAK)
        self.assertEqual(len(naks), 1)
        self.assertEqual(naks[0]["payload"]["error_code"], "already_consumed")
        self.assertFalse(naks[0]["payload"]["retryable"])
