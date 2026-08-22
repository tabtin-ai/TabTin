"""回归：DeepSeek V4 思考模式下采样参数应被 param_adaptor 剥离。

DeepSeek V4 默认开启 thinking，``temperature`` / ``top_p`` / ``frequency_penalty`` /
``presence_penalty`` 在思考模式下被上游忽略（不报错但无效）。param_adaptor 的
reasoning_strip_sampling 规则应命中 deepseek-v4-* 并移除这些参数，避免误导性配置。
参考 https://api-docs.deepseek.com/guides/thinking_mode
"""

from __future__ import annotations

from django.test import SimpleTestCase

from apps.services.llm.utils.param_adaptor import adapt_params

_SAMPLING = ("temperature", "top_p", "frequency_penalty", "presence_penalty")


class DeepSeekParamAdaptorTest(SimpleTestCase):
    def _base_params(self) -> dict:
        return {
            "model": "",
            "messages": [],
            "max_tokens": 1024,
            "temperature": 0.7,
            "top_p": 1.0,
            "frequency_penalty": 0.0,
            "presence_penalty": 0.0,
        }

    def test_v4_flash_strips_sampling_params(self):
        params = adapt_params(self._base_params(), "deepseek-v4-flash")
        for key in _SAMPLING:
            self.assertNotIn(key, params, f"deepseek-v4-flash 应剥离 {key}")

    def test_v4_pro_strips_sampling_params(self):
        params = adapt_params(self._base_params(), "deepseek-v4-pro")
        for key in _SAMPLING:
            self.assertNotIn(key, params, f"deepseek-v4-pro 应剥离 {key}")

    def test_non_reasoning_model_keeps_sampling_params(self):
        params = adapt_params(self._base_params(), "gpt-4o")
        for key in _SAMPLING:
            self.assertIn(key, params, f"非思考模型应保留 {key}")
