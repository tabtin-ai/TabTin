"""LLM Proxy 出站请求归一化回归测试。"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.services.llm.services.proxy_service import (
    ProxyContext,
    ProxyError,
    _normalize_upstream_request_params,
    _merge_model_param_overrides,
    _proxy_error_to_friendly,
    _sanitize_openai_tool_pairing,
)


class ProxyRequestNormalizationTests(SimpleTestCase):
    def test_model_param_overrides_merge_scalar_values(self):
        upstream_body = {"model": "reasoner", "messages": []}
        body = {
            "model_param_overrides": {
                "reasoning_effort": "high",
                "verbosity": "concise",
            },
        }

        _merge_model_param_overrides(upstream_body, body)

        self.assertEqual(upstream_body["reasoning_effort"], "high")
        self.assertNotIn("verbosity", upstream_body)

    def test_nested_param_paths_are_not_expanded_by_proxy(self):
        """#8793 契约:proxy 不做嵌套展开,客户端也不做。

        厂商侧的嵌套形态由 wire_adapter 按模型能力生成
        (见 ``_normalize_reasoning_param`` 的 ``extra_body.*`` 分支),
        catalog 的 ``param_path`` 只表达顶层 canonical 字段名。
        """
        upstream_body = {"model": "nested-reasoner", "messages": []}
        body = {
            "model_param_overrides": {
                "reasoning.effort": "xhigh",
            },
        }

        _merge_model_param_overrides(upstream_body, body)

        self.assertNotIn("reasoning", upstream_body)
        self.assertNotIn("reasoning.effort", upstream_body)

    def test_model_param_overrides_ignore_reserved_keys(self):
        upstream_body = {"model": "gpt-5", "messages": []}
        body = {
            "model_param_overrides": {
                "model": "evil",
                "messages.role": "evil",
                "messages": "evil",
                "reasoning_effort": "low",
            },
        }

        _merge_model_param_overrides(upstream_body, body)

        self.assertEqual(upstream_body["model"], "gpt-5")
        self.assertEqual(upstream_body["messages"], [])
        self.assertEqual(upstream_body["reasoning_effort"], "low")

    def test_model_param_overrides_only_pass_reasoning_effort(self):
        upstream_body = {"model": "reasoner", "messages": []}
        body = {
            "model_param_overrides": {
                "reasoning_effort": "max",
                "thinking.type": "enabled",
                "service_tier": "priority",
                "speed": "fast",
            },
        }

        _merge_model_param_overrides(upstream_body, body)

        self.assertEqual(upstream_body["reasoning_effort"], "max")
        self.assertNotIn("thinking", upstream_body)
        self.assertNotIn("service_tier", upstream_body)
        self.assertNotIn("speed", upstream_body)

    def test_direct_reasoning_effort_is_compatibility_fallback(self):
        upstream_body = {"model": "reasoner", "messages": []}

        _merge_model_param_overrides(
            upstream_body,
            {"reasoning_effort": "max"},
        )

        self.assertEqual(upstream_body["reasoning_effort"], "max")

    def test_reasoning_effort_value_is_not_validated(self):
        upstream_body = {"model": "reasoner", "messages": []}
        value = {"provider_specific": True}

        _merge_model_param_overrides(
            upstream_body,
            {"model_param_overrides": {"reasoning_effort": value}},
        )

        self.assertEqual(upstream_body["reasoning_effort"], value)

    def test_model_param_overrides_take_precedence_over_direct_value(self):
        upstream_body = {"model": "reasoner", "messages": []}

        _merge_model_param_overrides(
            upstream_body,
            {
                "reasoning_effort": "low",
                "model_param_overrides": {"reasoning_effort": "high"},
            },
        )

        self.assertEqual(upstream_body["reasoning_effort"], "high")

    def test_kimi_k26_temperature_is_forced_to_one(self):
        ctx = ProxyContext(request_id="req-temp", model_name="kimi-k2.6")
        body = {
            "model": "kimi-k2.6",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.3,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 1)

    def test_kimi_k27_code_temperature_is_forced_to_one(self):
        """compact 摘要硬编码 temperature=0.3；k2.7-code 上游只接受 1。"""
        ctx = ProxyContext(request_id="req-temp-k27", model_name="kimi-k2.7-code")
        body = {
            "model": "kimi-k2.7-code",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.3,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 1)

    def test_kimi_k27_prefixed_model_temperature_is_forced_to_one(self):
        ctx = ProxyContext(request_id="req-temp-k27-pfx", model_name="moonshot/kimi-k2.7-code")
        body = {
            "model": "moonshot/kimi-k2.7-code",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 1)

    def test_kimi_k3_temperature_is_forced_to_one(self):
        ctx = ProxyContext(request_id="req-temp-k3", model_name="kimi-k3")
        body = {
            "model": "kimi-k3",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.3,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 1)

    def test_non_kimi_temperature_is_preserved(self):
        ctx = ProxyContext(request_id="req-temp", model_name="gpt-4o")
        body = {
            "model": "gpt-4o",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.3,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 0.3)

    def test_orphan_tool_message_is_dropped(self):
        messages = [
            {"role": "assistant", "content": ""},
            {"role": "tool", "tool_call_id": "call_1", "content": "late result"},
            {"role": "user", "content": "next"},
        ]

        sanitized, changed = _sanitize_openai_tool_pairing(messages)

        self.assertTrue(changed)
        self.assertEqual(
            sanitized,
            [
                {"role": "assistant", "content": ""},
                {"role": "user", "content": "next"},
            ],
        )

    def test_legal_tool_pairing_is_preserved(self):
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "lookup", "arguments": "{}"},
                    },
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
        ]

        sanitized, changed = _sanitize_openai_tool_pairing(messages)

        self.assertFalse(changed)
        self.assertIs(sanitized, messages)

    def test_partial_tool_results_keep_only_satisfied_tool_calls(self):
        messages = [
            {
                "role": "assistant",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {"name": "one", "arguments": "{}"},
                    },
                    {
                        "id": "call_2",
                        "type": "function",
                        "function": {"name": "two", "arguments": "{}"},
                    },
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
            {"role": "user", "content": "next"},
        ]

        sanitized, changed = _sanitize_openai_tool_pairing(messages)

        self.assertTrue(changed)
        self.assertEqual(
            sanitized,
            [
                {
                    "role": "assistant",
                    "tool_calls": [
                        {
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "one", "arguments": "{}"},
                        },
                    ],
                },
                {"role": "tool", "tool_call_id": "call_1", "content": "ok"},
                {"role": "user", "content": "next"},
            ],
        )

    def test_upstream_request_format_error_says_not_balance(self):
        err = ProxyError(
            400,
            "upstream_error",
            "detail=Invalid request: messages with role 'tool' must be a response to a preceeding message with 'tool_calls'",
        )

        user_message, _technical_detail, extras = _proxy_error_to_friendly(err, "kimi-k2.6")

        self.assertIn("不是组织余额不足", user_message)
        self.assertIn("模型调用参数或上下文格式不兼容", user_message)
        self.assertEqual(extras["upstream_reason"], "request_format")
