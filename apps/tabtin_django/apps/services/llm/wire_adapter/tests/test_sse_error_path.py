"""SSE error 流透传 + 4 处 ProxyError 抛点 + view 层 _stream_error_response 测试。

覆盖总控 § 0 副指标 1 + W0 验收里 4 种 ProxyError 抛点:
- budget_exceeded(billing_precheck:178)
- missing_api_base(build_upstream_config:136)
- all_keys_exhausted(build_upstream_config:130)
- freeze_failed(billing_precheck:200)

以及 stream_upstream 内 upstream_error 抛点(:476)。

每条都验证:
1. 客户端拿到 200 OK + SSE 流(不是 fetch reject)
2. 第一行 chunk 含 chunk.error 字段(中文 user_message)
3. 流以 [DONE] 结束
"""

from __future__ import annotations

import json
from typing import List
from unittest.mock import patch, MagicMock

from django.test import SimpleTestCase

from apps.services.llm.services.proxy_service import (
    ProxyContext,
    ProxyError,
    build_sse_error_chunk,
    proxy_stream_events,
    stream_proxy_error_as_sse,
    _proxy_error_to_friendly,
)
from apps.services.llm.wire_adapter import ImageFetchError


class TestBuildSSEErrorChunk(SimpleTestCase):
    def test_format_with_status(self):
        line = build_sse_error_chunk(
            user_message="测试消息",
            technical_detail="stage=test",
            error_code="test_error",
            status=400,
        )
        self.assertTrue(line.startswith("data: "))
        self.assertTrue(line.endswith("\n\n"))
        payload = json.loads(line[6:].strip())
        self.assertEqual(payload["error"]["message"], "测试消息")
        self.assertEqual(payload["error"]["type"], "test_error")
        self.assertEqual(payload["error"]["status"], 400)
        self.assertEqual(payload["error"]["technical_detail"], "stage=test")

    def test_chinese_chars_not_ascii_escaped(self):
        line = build_sse_error_chunk(user_message="预算超限", error_code="t")
        # ensure_ascii=False:中文不应变成 \uXXXX
        self.assertIn("预算超限", line)
        self.assertNotIn("\\u", line)


class TestStreamProxyErrorAsSSE(SimpleTestCase):
    def test_yields_error_then_done(self):
        chunks = list(stream_proxy_error_as_sse(
            user_message="错了",
            error_code="boom",
            status=500,
        ))
        self.assertEqual(len(chunks), 2)
        # 第一条:error chunk
        first = json.loads(chunks[0][6:].strip())
        self.assertIn("error", first)
        self.assertEqual(first["error"]["message"], "错了")
        # 第二条:[DONE]
        self.assertEqual(chunks[1].strip(), "data: [DONE]")


class TestProxyErrorToFriendly(SimpleTestCase):
    """`_proxy_error_to_friendly` 返回三元组 (user_message, technical_detail, extras)。

    extras 至少含 `backend_error_type`,供前端 errorHandler 区分按钮/重试策略。
    """

    def test_budget_exceeded_renders_chinese(self):
        exc = ProxyError(402, "budget_exceeded", "预算超限")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertIn("预算", user_msg)
        self.assertEqual(extras["backend_error_type"], "budget_exceeded")

    def test_freeze_failed_renders_chinese(self):
        exc = ProxyError(402, "freeze_failed", "冻结点券失败,余额可能不足")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertIn("余额", user_msg)
        self.assertEqual(extras["backend_error_type"], "freeze_failed")

    def test_all_keys_exhausted_renders_chinese(self):
        exc = ProxyError(503, "all_keys_exhausted", "所有 API Key 均不可用")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertIn("Key", user_msg)
        self.assertEqual(extras["backend_error_type"], "all_keys_exhausted")

    def test_missing_api_base_renders_chinese(self):
        exc = ProxyError(500, "missing_api_base", "模型未配置 api_base")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        # missing_api_base 模板含 model_name 占位但 caller 没传(detail 用做兜底),
        # 重要的是能渲染出中文文案 + 兜底引导
        self.assertIn("配置", user_msg)
        self.assertEqual(extras["backend_error_type"], "missing_api_base")

    def test_upstream_error_5xx_uses_5xx_template(self):
        exc = ProxyError(502, "upstream_error", "上游 502")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertIn("502", user_msg)
        self.assertEqual(extras["backend_error_type"], "upstream_error")

    def test_upstream_error_4xx_uses_4xx_template(self):
        exc = ProxyError(400, "upstream_error", "bad request")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertIn("400", user_msg)
        self.assertEqual(extras["backend_error_type"], "upstream_error")

    def test_upstream_rate_limited_uses_model_unavailable_copy(self):
        """#8818：火山 burst / 上游 429 → 模型暂不可用，而非网络错误。"""
        exc = ProxyError(
            429,
            "upstream_rate_limited",
            "System protection triggered by request burst. Please slow down.",
        )
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertEqual(user_msg, "该模型暂无法使用，请稍后重试或更换模型")
        self.assertEqual(extras["backend_error_type"], "upstream_rate_limited")
        self.assertEqual(extras["upstream_reason"], "rate_limited")

    def test_upstream_error_burst_fingerprint_maps_to_rate_limited(self):
        exc = ProxyError(
            400,
            "upstream_error",
            "上游服务返回错误，status=400, detail=System protection "
            "triggered by request burst. Please slow down traffic growth.",
        )
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertEqual(user_msg, "该模型暂无法使用，请稍后重试或更换模型")
        self.assertEqual(extras["backend_error_type"], "upstream_rate_limited")

    def test_unknown_error_code_falls_back_to_detail(self):
        exc = ProxyError(403, "weird_unknown_code", "原始 detail 文本")
        user_msg, _, extras = _proxy_error_to_friendly(exc)
        self.assertEqual(user_msg, "原始 detail 文本")
        # 未识别 error_code 也仍然带 backend_error_type 给排障用
        self.assertEqual(extras["backend_error_type"], "weird_unknown_code")


class TestProxyStreamEventsErrorCatch(SimpleTestCase):
    """proxy_stream_events 的各 except 分支必须 yield SSE error + [DONE]。"""

    def _make_ctx(self):
        return ProxyContext(
            request_id="req-test",
            user_id="u-1",
            organization_id="wt-1",
            model_name="test-model",
            api_base="http://upstream",
            api_key="k",
        )

    def test_proxy_error_in_stream_yields_sse_error_and_done(self):
        """副指标 1:stream 内 ProxyError → yield error data + [DONE]。"""
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ProxyError(402, "budget_exceeded", "预算超限")
            yield  # 让函数成为 generator

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        # 必须有 error chunk + [DONE]
        self.assertEqual(len(chunks), 2)
        first = json.loads(chunks[0][6:].strip())
        self.assertIn("error", first)
        self.assertIn("预算", first["error"]["message"])
        self.assertEqual(first["error"]["type"], "budget_exceeded")
        self.assertEqual(chunks[1].strip(), "data: [DONE]")

    def test_image_fetch_error_yields_sse_error_with_host(self):
        """W1b 风 ImageFetchError(直接 user_message=...) 路径:user_message 透传。"""
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ImageFetchError(
                user_message="图片下载超时(主机:oss.example.com,超时 5.0s)",
                technical_detail="stage=image_fetch",
                status=504,
                error_code="image_fetch_timeout",
            )
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        self.assertEqual(len(chunks), 2)
        first = json.loads(chunks[0][6:].strip())
        self.assertIn("oss.example.com", first["error"]["message"])
        self.assertEqual(first["error"]["type"], "image_fetch_timeout")
        self.assertEqual(first["error"]["status"], 504)
        self.assertEqual(chunks[1].strip(), "data: [DONE]")

    def test_image_fetch_error_reason_only_renders_chinese(self):
        """W0 风 ImageFetchError(image_fetcher 抛,reason='timeout' 等)路径:
        proxy_stream_events 走 render_error 重新渲染中文文案。

        覆盖 proxy_service.py 第 ~755-770 行 W0 风分支(视角 3 测试覆盖盲区补)。
        """
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            # image_fetcher 实际抛的样子:reason / host / status / failed_count
            # 都齐全,但 user_message 为空(不预渲染,留给 caller 走模板表)
            raise ImageFetchError(
                reason="timeout",
                host="oss.cn-beijing.aliyuncs.com",
                status=None,
                timeout=5.0,
                total_count=3,
                failed_count=2,
                detail="image normalize failed 2/3: timeout",
            )
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        self.assertEqual(len(chunks), 2)
        first = json.loads(chunks[0][6:].strip())
        # 中文文案应含 host + 多图统计 + 超时提示
        self.assertIn("oss.cn-beijing.aliyuncs.com", first["error"]["message"])
        self.assertIn("超时", first["error"]["message"])
        self.assertIn("共 3 张图", first["error"]["message"])
        self.assertIn("2 张失败", first["error"]["message"])
        # extras 含结构化字段(给前端 errorClassMap 用)
        self.assertEqual(first["error"]["stage"], "image_fetch")
        self.assertEqual(first["error"]["reason"], "timeout")
        self.assertEqual(first["error"]["host"], "oss.cn-beijing.aliyuncs.com")
        self.assertEqual(first["error"]["failed_count"], 2)
        self.assertEqual(first["error"]["total_count"], 3)
        self.assertEqual(chunks[1].strip(), "data: [DONE]")

    def test_capability_gate_error_yields_sse_error_with_extras(self):
        """CapabilityGateError 路径:user_message 透传 + extras 含 stage=capability_gate.

        wire_adapter.adapt_request._normalize_images 抛 CapabilityGateError 的真实场景。
        """
        from apps.services.llm.wire_adapter import CapabilityGateError
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise CapabilityGateError(
                user_message=(
                    '当前模型 "MiniMax-Text-01" 不支持图片输入。'
                    "建议:换一个模型(如 Claude/GPT-4o/Qwen-VL),或移除图片后重发。"
                ),
                technical_detail=(
                    "stage=capability_gate | capability=image | "
                    "reason=unsupported_via | model_name=MiniMax-Text-01"
                ),
                error_code="image_not_supported",
                status=400,
            )
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        self.assertEqual(len(chunks), 2)
        first = json.loads(chunks[0][6:].strip())
        # 中文文案
        self.assertIn("不支持图片输入", first["error"]["message"])
        self.assertIn("换一个模型", first["error"]["message"])
        # error_code = image_not_supported(前端 mapBackendErrorTypeToCategory
        # 会路由到 switch_model 让 ChatPanel 显示"切换模型"按钮)
        self.assertEqual(first["error"]["code"], "image_not_supported")
        self.assertEqual(first["error"]["status"], 400)
        # extras stage 让前端能区分"capability gate"vs"image_fetch 失败"
        self.assertEqual(first["error"]["stage"], "capability_gate")
        self.assertEqual(chunks[1].strip(), "data: [DONE]")

    def test_all_keys_exhausted_yields_sse_error(self):
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ProxyError(503, "all_keys_exhausted", "所有 API Key 均不可用")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["type"], "all_keys_exhausted")
        # 中文文案
        self.assertIn("Key", first["error"]["message"])

    def test_missing_api_base_yields_sse_error(self):
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ProxyError(500, "missing_api_base", "模型未配置 api_base")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["type"], "missing_api_base")

    def test_freeze_failed_yields_sse_error(self):
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ProxyError(402, "freeze_failed", "冻结点券失败")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["type"], "freeze_failed")
        self.assertIn("余额", first["error"]["message"])

    def test_upstream_4xx_in_stream_yields_chinese(self):
        """stream_upstream 内抛 ProxyError(upstream_error, 400)→ 中文文案。"""
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise ProxyError(400, "upstream_error", "上游服务返回错误,status=400")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["status"], 400)
        # 应该走 (upstream, *, 4xx) 模板,含 4xx 提示
        self.assertIn("400", first["error"]["message"])

    def test_httpx_timeout_yields_chinese(self):
        import httpx
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise httpx.ReadTimeout("upstream timeout")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["type"], "upstream_timeout")
        # 中文文案
        self.assertIn("超时", first["error"]["message"])

    def test_unexpected_exception_yields_chinese(self):
        ctx = self._make_ctx()

        def fake_stream(*args, **kwargs):
            raise RuntimeError("kapow")
            yield

        with patch(
            "apps.services.llm.services.proxy_service.stream_upstream",
            new=fake_stream,
        ):
            chunks = list(proxy_stream_events(ctx, {"messages": []}))

        # 兜底也必须有中文 + [DONE]
        first = json.loads(chunks[0][6:].strip())
        self.assertEqual(first["error"]["type"], "internal_error")
        self.assertIn("上游", first["error"]["message"])
        self.assertEqual(chunks[1].strip(), "data: [DONE]")
