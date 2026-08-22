"""LLMProxy stream_upstream 接入 wire_adapter 集成测试。

关键验收(harness 验收 § 8):
- feature flag ON 与 OFF 在 dogfood image 场景下行为等价(都能解封图片 + 错误透传)
- feature flag ON 时 wire_adapter.adapt_request 被真正调用
- feature flag OFF 时 fall back 到 wire_adapter.image_fetcher.normalize_image_urls
  (这是兜底路径,只解决 image URL → base64,不做 system/tool/json/reasoning 适配)
- CapabilityGateError 走 SSE error 路径(中文文案 + structured extras)
- ImageFetchError 走 SSE error 路径(reason/host/failed_count 渲染中文)
- capability_downgrade event 在 stream 开始前 yield(让客户端渲染降级提示气泡)
"""

from __future__ import annotations

import json
from unittest import mock
from unittest.mock import MagicMock, patch

import httpx
from django.test import SimpleTestCase, override_settings

from apps.services.llm.wire_adapter import (
    CapabilityGateError,
    ImageFetchError,
    ResolvedCapabilities,
)
from apps.services.llm.wire_adapter.resolved_capabilities import (
    CachingCaps,
    ImageCaps,
    JsonModeCaps,
    LimitsCaps,
    ReasoningCaps,
    ToolCaps,
    WireFormatCaps,
)


def _httpx_resp(status: int = 200, body: bytes = b"\xff", content_type: str = "image/png"):
    """构造 httpx.Response mock。

    注意:不用 spec=httpx.Response — spec 模式下 status_code 等只读 property
    赋值不可见,会触发 != 200 判定异常。
    """
    mock_obj = MagicMock()
    mock_obj.status_code = status
    mock_obj.content = body
    mock_obj.headers = {"content-type": content_type}
    return mock_obj


def _make_caps_for_kimi() -> ResolvedCapabilities:
    """模拟 Kimi K2.5 的 caps:支持 vision,但 input_via 只接受 base64。"""
    caps = ResolvedCapabilities()
    caps.is_configured = True
    caps.image = ImageCaps(
        enabled=True,
        input_via=("base64",),  # Kimi dogfood bug 关键点:不接受 url
        formats=("jpeg", "png", "webp"),
    )
    caps.tool = ToolCaps(enabled=True, choice_modes=("auto", "required", "none"))
    caps.wire = WireFormatCaps(system_message_style="messages_first_role_system")
    caps.json_mode = JsonModeCaps(modes=("text", "json_object", "json_schema"))
    return caps


def _make_caps_no_vision() -> ResolvedCapabilities:
    """模拟非 vision model:image.enabled=False。"""
    caps = ResolvedCapabilities()
    caps.is_configured = True
    caps.image = ImageCaps(enabled=False)
    caps.wire = WireFormatCaps(system_message_style="messages_first_role_system")
    return caps


def _fake_model(
    *,
    model_name: str = "test-model",
    wire_adapter_disabled: bool = False,
    caps: ResolvedCapabilities = None,
):
    """v0.1：原 obj.get_wire_capabilities mock 已退役（6c6b7a1ae 删除该方法）。

    现在调用方走 ``proxy_service.resolve_for_wire(model, provider=...)``；
    各测试类的 setUp 会 patch 这个 helper 让它从 ``model._test_caps`` 读 caps，
    所以这里只把 caps 挂在 model 上即可。
    """
    obj = MagicMock()
    obj.model_name = model_name
    obj.wire_adapter_disabled = wire_adapter_disabled
    obj.id = "00000000-0000-0000-0000-000000000001"
    # feature_flag 检查 capabilities_config / wire_adapter_disabled，给个空 dict
    # 让 wire_adapter_disabled 这条 fallback 路径仍然生效。
    obj.capabilities_config = {}
    obj._test_caps = caps or _make_caps_for_kimi()
    obj.provider = MagicMock()
    return obj


def _fake_ctx(model_instance, model_name="test-model"):
    from apps.services.llm.services.proxy_service import ProxyContext
    ctx = ProxyContext()
    ctx.model_name = model_name
    ctx.api_base = "https://upstream.test/v1"
    ctx.api_key = "sk-fake"
    ctx.model_instance = model_instance
    return ctx


class _ResolveForWirePatchMixin:
    """给所有用 _fake_model 的测试类装上 resolve_for_wire patch。

    v0.1：proxy_service 不再调 model.get_wire_capabilities()，改走
    utils.capabilities.resolve_for_wire（在 6c6b7a1ae 后修复）。本 mixin 把
    helper patch 成"从 model._test_caps 读 caps"，让原测试 fixture 数据继续生效。

    使用：``class XxxTests(_ResolveForWirePatchMixin, SimpleTestCase):``，
    各子类自己的 setUp 起头先 ``super().setUp()``。
    """

    def setUp(self):
        super().setUp()
        # 进程级上游连接池在用例间隔离：避免命中上一个用例缓存的 client，
        # 让每个 patch("httpx.Client") 都能重新构造 mock。
        from apps.services.llm.services.proxy_service import reset_upstream_client
        reset_upstream_client()
        self.addCleanup(reset_upstream_client)
        self._resolve_patch = patch(
            "apps.services.llm.services.proxy_service.resolve_for_wire",
            side_effect=lambda model, provider=None: model._test_caps,
        )
        self.mock_resolve = self._resolve_patch.start()
        self.addCleanup(self._resolve_patch.stop)


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ps-integration-tests",
    }
})
class FeatureFlagEquivalenceTests(_ResolveForWirePatchMixin, SimpleTestCase):
    """关键验收:feature flag ON/OFF 在 image 场景下行为等价。"""

    def setUp(self):
        super().setUp()
        from apps.services.llm.wire_adapter import image_fetcher as ifmod
        from django.core.cache import cache
        ifmod._l1_clear()
        cache.clear()

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_flag_on_image_url_normalized(self, MockClient):
        """flag=ON:wire_adapter 路径下 image url → base64.

        注:image_fetcher.httpx.Client 和 proxy_service.httpx.Client 实际指向
        同一个 httpx module,只能用全局 patch("httpx.Client") 不会被覆盖。
        通过 client_inst 的 get/stream 分别 mock 处理 image 下载 vs SSE 流。
        """
        client_inst = MockClient.return_value.__enter__.return_value
        # image fetch:status_code=200 + content=b'hello'
        client_inst.get.return_value = _httpx_resp(200, b"hello", "image/png")
        # 上游 SSE 200(短流)
        stream_resp = MagicMock()
        stream_resp.status_code = 200
        stream_resp.iter_lines.return_value = iter([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        ])
        # 上游 stream 走进程级连接池：pooled client = MockClient.return_value 本身
        # （不再 per-request `with httpx.Client()`）。image_fetcher 仍走 __enter__。
        MockClient.return_value.stream.return_value.__enter__.return_value = stream_resp

        from apps.services.llm.services.proxy_service import stream_upstream

        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://oss.test/a.png"}},
                ],
            }],
        }
        ctx = _fake_ctx(_fake_model(caps=_make_caps_for_kimi()))

        # 收集所有 yield 的 chunk
        chunks = list(stream_upstream(ctx, body))

        # 验证上游 stream 调用时 messages 内 image_url 已被替换为 data URL
        call_args = MockClient.return_value.stream.call_args
        upstream_body = call_args.kwargs.get("json") or call_args[1]["json"]
        sent_url = upstream_body["messages"][0]["content"][0]["image_url"]["url"]
        self.assertTrue(sent_url.startswith("data:image/png;base64,"))
        # resolve_for_wire 已被调用(确认走了 wire_adapter 路径)
        self.mock_resolve.assert_called_once()
        called_args, called_kwargs = self.mock_resolve.call_args
        # 第一参数是 model_instance
        self.assertIs(
            called_args[0] if called_args else called_kwargs.get("model_instance"),
            ctx.model_instance,
        )

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "false"})
    @patch("httpx.Client")
    def test_flag_off_falls_back_to_image_fetcher_only(self, MockClient):
        """flag=OFF:回退到仅 image_fetcher.normalize_image_urls 兜底,仍能下载 image base64。"""
        client_inst = MockClient.return_value.__enter__.return_value
        # 兜底路径用 image_fetcher.httpx.Client 拉 image(同一个 httpx module)
        client_inst.get.return_value = _httpx_resp(200, b"world", "image/jpeg")
        # 上游 stream
        stream_resp = MagicMock()
        stream_resp.status_code = 200
        stream_resp.iter_lines.return_value = iter([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        ])
        # 上游 stream 走进程级连接池：pooled client = MockClient.return_value 本身
        # （不再 per-request `with httpx.Client()`）。image_fetcher 仍走 __enter__。
        MockClient.return_value.stream.return_value.__enter__.return_value = stream_resp

        from apps.services.llm.services.proxy_service import stream_upstream

        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://oss.test/b.jpg"}},
                ],
            }],
        }
        ctx = _fake_ctx(_fake_model(caps=_make_caps_for_kimi()))

        chunks = list(stream_upstream(ctx, body))

        # 上游收到的 image_url 应为 data URL(image_fetcher 路径同样能解决)
        upstream_body = MockClient.return_value.stream.call_args.kwargs.get("json") \
            or MockClient.return_value.stream.call_args[1]["json"]
        sent_url = upstream_body["messages"][0]["content"][0]["image_url"]["url"]
        self.assertTrue(sent_url.startswith("data:"))
        # 关键等价性:resolve_for_wire 不应被调用(走 image_fetcher 兜底)
        self.mock_resolve.assert_not_called()

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_model_disabled_falls_back(self, MockClient):
        """LLMModel.wire_adapter_disabled=True 时 wire_adapter 不接管。"""
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _httpx_resp(200, b"x", "image/png")
        stream_resp = MagicMock()
        stream_resp.status_code = 200
        stream_resp.iter_lines.return_value = iter([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        ])
        # 上游 stream 走进程级连接池：pooled client = MockClient.return_value 本身
        # （不再 per-request `with httpx.Client()`）。image_fetcher 仍走 __enter__。
        MockClient.return_value.stream.return_value.__enter__.return_value = stream_resp

        from apps.services.llm.services.proxy_service import stream_upstream

        # 这次 model 禁用 wire_adapter
        ctx = _fake_ctx(_fake_model(
            wire_adapter_disabled=True,
            caps=_make_caps_for_kimi(),
        ))
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://oss.test/c.png"}},
                ],
            }],
        }
        list(stream_upstream(ctx, body))

        # resolve_for_wire 不应被调用(走 image_fetcher 兜底)
        self.mock_resolve.assert_not_called()


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ps-integration-gate-tests",
    }
})
class CapabilityGateSseTests(_ResolveForWirePatchMixin, SimpleTestCase):
    """capability gate 拒绝时走 SSE error 路径(与 ImageFetchError 同 SSE error pattern)。"""

    def setUp(self):
        super().setUp()
        from apps.services.llm.wire_adapter import image_fetcher as ifmod
        ifmod._l1_clear()

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    def test_image_gate_reject_yields_sse_error_chunk(self):
        """非 vision model 收到图片 → SSE error chunk 含中文文案 + [DONE]."""
        from apps.services.llm.services.proxy_service import (
            ProxyContext, proxy_stream_events,
        )

        ctx = _fake_ctx(_fake_model(caps=_make_caps_no_vision()))
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://oss.test/a.png"}},
                ],
            }],
            "_upstream_model_name": "test-model",
        }
        chunks = list(proxy_stream_events(ctx, body))
        self.assertGreaterEqual(len(chunks), 2)
        # 第一个 chunk 应是 SSE error
        first = chunks[0]
        self.assertTrue(first.startswith("data: "))
        payload = json.loads(first[6:].strip())
        self.assertIn("error", payload)
        self.assertIn("不支持图片输入", payload["error"]["user_message"])
        self.assertEqual(payload["error"]["code"], "image_not_supported")
        # 末尾 [DONE]
        self.assertIn("[DONE]", chunks[-1])


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ps-integration-downgrade-tests",
    }
})
class CapabilityDowngradeEventTests(_ResolveForWirePatchMixin, SimpleTestCase):
    """downgrade_events 通过 SSE 'event: capability_downgrade' 通知客户端."""

    def setUp(self):
        super().setUp()
        from apps.services.llm.wire_adapter import image_fetcher as ifmod
        ifmod._l1_clear()

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_qwen_json_schema_emits_capability_downgrade_sse_event(self, MockClient):
        """Qwen 不支持 json_schema → fallback to system prompt + emit
        'event: capability_downgrade' SSE event 在 stream 开始前."""
        # 上游 SSE 短流
        client_inst = MockClient.return_value.__enter__.return_value
        stream_resp = MagicMock()
        stream_resp.status_code = 200
        stream_resp.iter_lines.return_value = iter([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            "data: [DONE]",
        ])
        # 上游 stream 走进程级连接池：pooled client = MockClient.return_value 本身
        # （不再 per-request `with httpx.Client()`）。image_fetcher 仍走 __enter__。
        MockClient.return_value.stream.return_value.__enter__.return_value = stream_resp

        # 模拟 Qwen caps:json_modes 不含 schema,schema_fallback=True
        caps = ResolvedCapabilities()
        caps.is_configured = True
        caps.image = ImageCaps(enabled=False)
        caps.tool = ToolCaps(enabled=False)
        caps.wire = WireFormatCaps(system_message_style="messages_first_role_system")
        caps.json_mode = JsonModeCaps(
            modes=("text", "json_object"),
            schema_fallback=True,
        )

        from apps.services.llm.services.proxy_service import stream_upstream

        ctx = _fake_ctx(_fake_model(caps=caps), model_name="qwen-test")
        body = {
            "messages": [{"role": "user", "content": "weather?"}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {"name": "weather", "schema": {"type": "object"}},
            },
        }
        chunks = list(stream_upstream(ctx, body))

        # 第一个 chunk 是 capability_downgrade event
        first = chunks[0]
        self.assertIn("event: capability_downgrade", first)
        self.assertIn("capability_downgrade", first)
        # event payload 解析得到 capability=json_schema
        # SSE event 形如:"event: capability_downgrade\ndata: {...}\n\n"
        data_line = [
            ln for ln in first.split("\n") if ln.startswith("data: ")
        ][0]
        evt = json.loads(data_line[6:])
        self.assertEqual(evt["event"], "capability_downgrade")
        self.assertEqual(evt["feature"], "json_schema")
        self.assertEqual(evt["capability"], "json_schema")
        self.assertEqual(evt["fallback_to"], "system_prompt_hint")
        self.assertIn("JSON Schema", evt["message"])
        self.assertEqual(evt["model_name"], "qwen-test")


@override_settings(CACHES={
    "default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "ps-integration-image-fetch-tests",
    }
})
class ImageFetchErrorSseTests(_ResolveForWirePatchMixin, SimpleTestCase):
    """image_fetcher 抛 ImageFetchError → proxy_stream_events catch → SSE error chunk。

    覆盖端到端链路:image URL 下载失败/超时/oversize → ImageFetchError →
    proxy_stream_events 走 except ImageFetchError 分支 → render_error 渲染中文 →
    yield SSE error chunk + [DONE]。
    """

    def setUp(self):
        super().setUp()
        from apps.services.llm.wire_adapter import image_fetcher as ifmod
        ifmod._l1_clear()

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_image_fetch_404_yields_sse_error_chunk(self, MockClient):
        """image URL 返回 404 → SSE error chunk 含中文 host + 失败计数 + reason."""
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _httpx_resp(404, b"")

        from apps.services.llm.services.proxy_service import proxy_stream_events

        ctx = _fake_ctx(_fake_model(caps=_make_caps_for_kimi()))
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {
                        "url": "https://oss.test/missing.png",
                    }},
                ],
            }],
            "_upstream_model_name": "test-model",
        }
        chunks = list(proxy_stream_events(ctx, body))
        self.assertGreaterEqual(len(chunks), 2)
        first = chunks[0]
        self.assertTrue(first.startswith("data: "))
        payload = json.loads(first[6:].strip())
        self.assertIn("error", payload)
        # 中文文案应含主机名(确保 render_error 命中模板)
        self.assertIn("oss.test", payload["error"]["user_message"])
        # SSE error chunk 携带 image_fetch 结构化字段(extras)
        self.assertEqual(payload["error"].get("stage"), "image_fetch")
        self.assertEqual(payload["error"].get("reason"), "http_error")
        self.assertEqual(payload["error"].get("failed_count"), 1)
        self.assertEqual(payload["error"].get("total_count"), 1)
        # 末尾 [DONE]
        self.assertIn("[DONE]", chunks[-1])

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_image_fetch_partial_failure_aggregates_in_sse(self, MockClient):
        """3 张图,1 张 404,2 张成功 → SSE error chunk 含 failed=1/total=3 计数。

        当前产品决策与 668c 行为对齐:任一图失败即整请求失败,带 failed_count
        / total_count 计数让用户感知"3 张图中有 1 张挂了"。
        """
        client_inst = MockClient.return_value.__enter__.return_value

        def _side(url):
            if "missing" in url:
                return _httpx_resp(404, b"")
            return _httpx_resp(200, b"ok", "image/png")

        client_inst.get.side_effect = _side

        from apps.services.llm.services.proxy_service import proxy_stream_events

        ctx = _fake_ctx(_fake_model(caps=_make_caps_for_kimi()))
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {"url": "https://e1.com/a.png"}},
                    {"type": "image_url", "image_url": {"url": "https://e2.com/missing.png"}},
                    {"type": "image_url", "image_url": {"url": "https://e3.com/c.png"}},
                ],
            }],
            "_upstream_model_name": "test-model",
        }
        chunks = list(proxy_stream_events(ctx, body))
        first = chunks[0]
        payload = json.loads(first[6:].strip())
        self.assertIn("error", payload)
        # 多图聚合断言
        self.assertEqual(payload["error"].get("total_count"), 3)
        self.assertEqual(payload["error"].get("failed_count"), 1)
        # http_error 优先级最高,worst reason 应是 http_error
        self.assertEqual(payload["error"].get("reason"), "http_error")
        # 文案中应含失败计数占位
        self.assertIn("3", payload["error"]["user_message"])

    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "false"})
    @patch("httpx.Client")
    def test_flag_off_image_fetch_failure_also_yields_sse_error(self, MockClient):
        """flag OFF 时 image_fetcher.normalize_image_urls 同样抛 ImageFetchError →
        proxy_stream_events 仍走 SSE error 分支(等价行为,确保两条路径错误处理一致)。"""
        client_inst = MockClient.return_value.__enter__.return_value
        client_inst.get.return_value = _httpx_resp(404, b"")

        from apps.services.llm.services.proxy_service import proxy_stream_events

        ctx = _fake_ctx(_fake_model(caps=_make_caps_for_kimi()))
        body = {
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "image_url", "image_url": {
                        "url": "https://oss.test/broken.png",
                    }},
                ],
            }],
            "_upstream_model_name": "test-model",
        }
        chunks = list(proxy_stream_events(ctx, body))
        first = chunks[0]
        self.assertTrue(first.startswith("data: "))
        payload = json.loads(first[6:].strip())
        self.assertIn("error", payload)
        self.assertEqual(payload["error"].get("stage"), "image_fetch")
        # flag OFF 时 caps 不应被读
        self.mock_resolve.assert_not_called()


class ProxyRequestContractTests(_ResolveForWirePatchMixin, SimpleTestCase):
    @mock.patch.dict("os.environ", {"LLM_WIRE_ADAPTER_ENABLED": "true"})
    @patch("httpx.Client")
    def test_stream_disabled_uses_nonstream_upstream_and_wraps_response(self, MockClient):
        caps = _make_caps_for_kimi()
        caps.wire = WireFormatCaps(
            system_message_style="messages_first_role_system",
            stream_supported=False,
        )
        caps.caching = CachingCaps(mode="none")
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {
            "id": "chatcmpl-test",
            "model": "test-model",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": "完整回答"},
                "finish_reason": "stop",
            }],
            "usage": {
                "prompt_tokens": 3,
                "completion_tokens": 2,
                "total_tokens": 5,
                "prompt_tokens_details": {"cached_tokens": 2},
            },
        }
        MockClient.return_value.post.return_value = response

        from apps.services.llm.services.proxy_service import stream_upstream

        ctx = _fake_ctx(_fake_model(caps=caps))
        chunks = list(stream_upstream(
            ctx,
            {"messages": [{"role": "user", "content": "hi"}]},
        ))

        sent_body = MockClient.return_value.post.call_args.kwargs["json"]
        self.assertFalse(sent_body["stream"])
        self.assertNotIn("stream_options", sent_body)
        MockClient.return_value.stream.assert_not_called()
        self.assertTrue(any("完整回答" in chunk for chunk in chunks))
        # “不支持缓存”只是不主动发送缓存控制，不能吞掉厂商真实返回的
        # 缓存命中用量，否则成本记录会失真。
        self.assertEqual(ctx.accumulated_usage["cache_read_input_tokens"], 2)

    def test_request_payload_limit_rejects_before_network(self):
        from apps.services.llm.services.proxy_service import _enforce_request_payload_limit

        caps = ResolvedCapabilities()
        caps.limits = LimitsCaps(request_payload_max_mb=1)
        with self.assertRaises(CapabilityGateError) as cm:
            _enforce_request_payload_limit({"messages": [{"content": "x" * 1100000}]}, caps)

        self.assertEqual(cm.exception.error_code, "request_payload_too_large")
        self.assertEqual(cm.exception.status, 413)
