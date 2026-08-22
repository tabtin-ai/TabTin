"""stream_upstream 强制工具调用（tool_choice）通用降级测试。

背景：login-wall-gate 门禁轮带 tool_choice='required'（+ thinking disabled），
但部分模型（如 kimi-k2.7-code 思考不可关）会对这类请求返回 400。通用降级
策略不维护静态模型名单：

1. 撞墙路径：上游 400 且请求带 tool_choice → 摘除 tool_choice/thinking，
   原地重试一次；重试仍失败照常抛 ProxyError。
2. 预判路径：同进程内该模型已拒收过 → 请求前直接摘除，跳过白撞。
3. 边界：400 但请求不带 tool_choice → 不重试，照常抛 ProxyError。
4. 边界：正常 200 请求不受影响。

用户侧静默（2026-07-22 产品口径）：门禁轮降级**不向客户端发
capability_downgrade 气泡**——登录门禁是用户不感知的内部机制，用户只需
看到 ask_user 登录卡片；排障走服务端日志。
"""

from __future__ import annotations

import json
from unittest import mock
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.services import proxy_service
from apps.services.llm.services.proxy_service import (
    ProxyContext,
    ProxyError,
    reset_upstream_client,
    stream_upstream,
)


def _make_ctx(model_name: str = "kimi-k2.7-code") -> ProxyContext:
    ctx = ProxyContext()
    ctx.model_name = model_name
    ctx.api_base = "https://upstream.test/v1"
    ctx.api_key = "sk-fake"
    ctx.model_instance = MagicMock()
    return ctx


def _resp_400(message: str = "invalid thinking: only type=enabled is allowed"):
    resp = MagicMock()
    resp.status_code = 400
    resp.read.return_value = json.dumps(
        {"error": {"message": message}},
    ).encode("utf-8")
    return resp


def _resp_200():
    resp = MagicMock()
    resp.status_code = 200
    resp.iter_lines.return_value = iter([
        'data: {"choices":[{"delta":{"content":"ok"}}]}',
        "data: [DONE]",
    ])
    return resp


def _stream_cm(resp):
    """把 response mock 包成 client.stream(...) 返回的 context manager。"""
    cm = MagicMock()
    cm.__enter__.return_value = resp
    cm.__exit__.return_value = False
    return cm


def _gated_body(model: str = "kimi-k2.7-code") -> dict:
    """模拟 login-wall-gate 门禁轮请求：带 tool_choice + thinking。"""
    return {
        "model": model,
        "messages": [{"role": "user", "content": "hi"}],
        "tools": [{"type": "function", "function": {"name": "ask_user"}}],
        "tool_choice": "required",
        "thinking": {"type": "disabled"},
    }


@mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "false"})
class ForcedToolChoiceDegradeTests(SimpleTestCase):
    def setUp(self):
        super().setUp()
        reset_upstream_client()
        self.addCleanup(reset_upstream_client)
        proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS.clear()
        self.addCleanup(proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS.clear)

    @patch("httpx.Client")
    def test_400_with_tool_choice_degrades_and_retries(self, MockClient):
        """撞墙路径：首发 400 → 摘除 tool_choice/thinking 重试，第二发 200 成功。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_400()),
            _stream_cm(_resp_200()),
        ]

        chunks = list(stream_upstream(_make_ctx(), _gated_body()))

        # 发了两次；第二次请求体已摘除 tool_choice/thinking
        self.assertEqual(MockClient.return_value.stream.call_count, 2)
        retry_body = MockClient.return_value.stream.call_args_list[1].kwargs["json"]
        self.assertNotIn("tool_choice", retry_body)
        self.assertNotIn("thinking", retry_body)
        # tools 保留（工具收窄仍生效，只是不再强制调用）
        self.assertIn("tools", retry_body)

        # 用户侧静默：不向客户端发 capability_downgrade 气泡
        self.assertFalse(any("capability_downgrade" in c for c in chunks))

        # 正常数据 chunk 透传
        self.assertTrue(any('"content":"ok"' in c for c in chunks))
        # 模型进了进程级记忆
        self.assertIn(
            "kimi-k2.7-code",
            proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS,
        )

    @patch("httpx.Client")
    def test_unrelated_400_retries_but_not_memorized(self, MockClient):
        """#6920：门禁轮撞到与互斥无关的 400（如消息配对错误）→ 仍摘参重试
        一次（救活措辞变体），但不把模型写入进程级记忆——不能因一次无关失败
        永久软化该模型的强制工具调用。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_400("invalid messages: tool call id mismatch")),
            _stream_cm(_resp_200()),
        ]

        chunks = list(stream_upstream(_make_ctx(), _gated_body()))

        # 重试仍发生（第二发摘掉了 tool_choice/thinking 且成功）
        self.assertEqual(MockClient.return_value.stream.call_count, 2)
        retry_body = MockClient.return_value.stream.call_args_list[1].kwargs["json"]
        self.assertNotIn("tool_choice", retry_body)
        self.assertTrue(any('"content":"ok"' in c for c in chunks))
        # 关键：不入记忆——下一个门禁轮仍会先带 tool_choice 试真强制
        self.assertNotIn(
            "kimi-k2.7-code",
            proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS,
        )

    @patch("httpx.Client")
    def test_retry_still_400_raises_proxy_error(self, MockClient):
        """撞墙路径：重试仍 400 → 照常抛 ProxyError，不无限重试。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_400()),
            _stream_cm(_resp_400("still broken")),
        ]

        with self.assertRaises(ProxyError) as caught:
            list(stream_upstream(_make_ctx(), _gated_body()))

        self.assertEqual(MockClient.return_value.stream.call_count, 2)
        self.assertEqual(caught.exception.status, 400)

    @patch("httpx.Client")
    def test_400_without_tool_choice_raises_without_retry(self, MockClient):
        """边界：400 但请求不带 tool_choice → 不重试，照常抛 ProxyError。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_400("some other bad request")),
        ]
        body = _gated_body()
        body.pop("tool_choice")
        body.pop("thinking")

        with self.assertRaises(ProxyError):
            list(stream_upstream(_make_ctx(), body))

        self.assertEqual(MockClient.return_value.stream.call_count, 1)
        self.assertEqual(
            len(proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS), 0,
        )

    @patch("httpx.Client")
    def test_known_rejected_model_strips_proactively(self, MockClient):
        """预判路径：模型已在进程级记忆 → 请求前直接摘除，只发一次。"""
        proxy_service._FORCED_TOOL_CHOICE_REJECTED_MODELS.add("kimi-k2.7-code")
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_200()),
        ]

        chunks = list(stream_upstream(_make_ctx(), _gated_body()))

        self.assertEqual(MockClient.return_value.stream.call_count, 1)
        sent_body = MockClient.return_value.stream.call_args.kwargs["json"]
        self.assertNotIn("tool_choice", sent_body)
        self.assertNotIn("thinking", sent_body)
        # 用户侧静默：不向客户端发 capability_downgrade 气泡
        self.assertFalse(any("capability_downgrade" in c for c in chunks))

    @patch("httpx.Client")
    def test_gate_turn_silences_wire_adapter_downgrade_events(self, MockClient):
        """门禁轮（带 tool_choice）：wire_adapter 的 tool_choice/reasoning 降级
        事件不发给客户端；其他 stage 的事件照常发。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_200()),
        ]
        fake_events = [
            {"event": "capability_downgrade", "stage": "tool_choice",
             "reason": "required_tool_choice_unsupported", "message": "x"},
            {"event": "capability_downgrade", "stage": "reasoning",
             "reason": "reasoning_unsupported_dropped", "message": "y"},
            {"event": "capability_downgrade", "stage": "json_mode",
             "reason": "json_schema_unsupported", "message": "z"},
        ]
        body = _gated_body()
        with patch(
            "apps.services.llm.services.proxy_service.is_wire_adapter_enabled",
            return_value=True,
        ), patch(
            "apps.services.llm.services.proxy_service.resolve_for_wire",
            return_value=MagicMock(),
        ), patch(
            "apps.services.llm.services.proxy_service.adapt_request",
            return_value=(dict(body), fake_events),
        ):
            chunks = list(stream_upstream(_make_ctx(), body))

        downgrade_chunks = [c for c in chunks if "capability_downgrade" in c]
        # 只有 json_mode 这条非门禁相关事件透出
        self.assertEqual(len(downgrade_chunks), 1)
        self.assertIn("json_schema_unsupported", downgrade_chunks[0])

    @patch("httpx.Client")
    def test_non_gate_turn_keeps_downgrade_events(self, MockClient):
        """非门禁轮（无 tool_choice）：降级事件照常发给客户端（其余场景保持现状）。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_200()),
        ]
        fake_events = [
            {"event": "capability_downgrade", "stage": "reasoning",
             "reason": "reasoning_unsupported_dropped", "message": "y"},
        ]
        body = {
            "model": "some-model",
            "messages": [{"role": "user", "content": "hi"}],
        }
        with patch(
            "apps.services.llm.services.proxy_service.is_wire_adapter_enabled",
            return_value=True,
        ), patch(
            "apps.services.llm.services.proxy_service.resolve_for_wire",
            return_value=MagicMock(),
        ), patch(
            "apps.services.llm.services.proxy_service.adapt_request",
            return_value=(dict(body), fake_events),
        ):
            chunks = list(stream_upstream(_make_ctx("some-model"), body))

        downgrade_chunks = [c for c in chunks if "capability_downgrade" in c]
        self.assertEqual(len(downgrade_chunks), 1)
        self.assertIn("reasoning_unsupported_dropped", downgrade_chunks[0])

    @patch("httpx.Client")
    def test_normal_request_untouched(self, MockClient):
        """边界：不带 tool_choice 的正常请求完全不受影响。"""
        MockClient.return_value.stream.side_effect = [
            _stream_cm(_resp_200()),
        ]
        body = {
            "model": "kimi-k2.7-code",
            "messages": [{"role": "user", "content": "hi"}],
        }

        chunks = list(stream_upstream(_make_ctx(), body))

        self.assertEqual(MockClient.return_value.stream.call_count, 1)
        self.assertFalse(any("capability_downgrade" in c for c in chunks))
        self.assertTrue(any('"content":"ok"' in c for c in chunks))
