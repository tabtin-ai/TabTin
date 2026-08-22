"""BYOK Kimi For Coding：temperature 适配回归。"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.services.llm.services.proxy_service import ProxyContext, _normalize_upstream_request_params
from apps.services.llm.utils.param_adaptor import adapt_params, requires_kimi_temperature_one


class KimiCodingTemperatureAdaptorTests(SimpleTestCase):
    def test_coding_model_names_require_temperature_one(self):
        for name in (
            "kimi-for-coding",
            "kimi-for-coding-highspeed",
            "k3-256k",
            "moonshot/kimi-for-coding",
        ):
            self.assertTrue(requires_kimi_temperature_one(name), name)

    def test_adapt_params_strips_sampling_for_kimi_for_coding(self):
        """连通性探针曾硬编码 temperature=0，须在出站前剥掉/纠正。"""
        params = {
            "model": "kimi-for-coding",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0,
            "top_p": 1.0,
        }

        adapt_params(params, "kimi-for-coding")

        self.assertNotIn("temperature", params)
        self.assertNotIn("top_p", params)

    def test_adapt_params_strips_sampling_for_k3_256k(self):
        params = {
            "model": "k3-256k",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.7,
        }

        adapt_params(params, "k3-256k")

        self.assertNotIn("temperature", params)

    def test_proxy_forces_temperature_one_for_kimi_for_coding(self):
        ctx = ProxyContext(request_id="req-kimi-coding", model_name="kimi-for-coding")
        body = {
            "model": "kimi-for-coding",
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0,
        }

        _normalize_upstream_request_params(body, ctx)

        self.assertEqual(body["temperature"], 1)
