"""存量顶层 wire capability 文档的运行时兼容回归。"""

from types import SimpleNamespace

from django.test import SimpleTestCase

from apps.services.llm.utils.capabilities import resolve_for_wire


class LegacyTopLevelCapabilitiesTests(SimpleTestCase):
    def test_configured_volcengine_deepseek_profile_does_not_fall_back(self):
        provider = SimpleNamespace(
            name="volcengine",
            provider_key="volcengine",
            scope="platform",
        )
        model = SimpleNamespace(
            id="b6c23224-82fc-4acf-97fe-c9cb9bdab5c1",
            model_name="deepseek-v4-pro-260425",
            capability_domain="chat",
            wave_status="ready",
            capabilities_config={
                "wire": {
                    "request_protocol": "openai_chat_completions",
                    "response_protocol": "openai_chat_completions",
                    "stream_supported": True,
                },
                "tool": {
                    "enabled": True,
                    "choice_modes": ["auto", "required", "none"],
                },
                "is_configured": True,
                "supports_streaming": True,
                "supports_function_calling": True,
            },
            context_window_tokens=1_000_000,
            max_input_tokens=None,
            max_output_tokens=65_536,
            multimodal_limits={},
        )

        with self.assertNoLogs(
            "apps.services.llm.utils.capabilities",
            level="ERROR",
        ):
            capabilities = resolve_for_wire(model, provider)

        self.assertTrue(capabilities.is_configured)
        self.assertEqual(
            capabilities.wire.request_protocol,
            "openai_chat_completions",
        )
        self.assertTrue(capabilities.tool.enabled)
