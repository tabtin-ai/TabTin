"""W1c · probe 框架单元测试。

覆盖:
- 6 个 probe prepare_body 输出形态
- expected_capability 推断
- compare drift 判定
- dry_run 集成(基于 mock model)
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.services.llm.wire_adapter.probes import (
    ALL_PROBES,
    BasicChatProbe,
    ImageBase64Probe,
    ImageUrlProbe,
    JsonSchemaProbe,
    ParallelToolProbe,
    ProbeResult,
    ToolCallProbe,
    _compare,
    get_probe_by_name,
    run_probes,
)
from apps.services.llm.wire_adapter.resolved_capabilities import (
    ImageCaps,
    ResolvedCapabilities,
    ToolCaps,
)


def _mock_model(*, model_name="m", caps=None, provider_name="openai"):
    m = SimpleNamespace(
        id="aabbccdd-1111-2222-3333-aabbccddeeff",
        model_name=model_name,
        provider=SimpleNamespace(name=provider_name),
        capabilities_config={"wire_adapter": (caps.to_json() if caps else {})},
        is_active=True,
        mode="chat",
    )
    return m


class CompareTests(SimpleTestCase):

    def test_pass_pass(self):
        self.assertEqual(_compare("pass", "pass"), "none")

    def test_gated_gated(self):
        self.assertEqual(_compare("capability_gated", "capability_gated"), "gated_aligned")

    def test_regression(self):
        self.assertEqual(_compare("capability_gated", "pass"), "regression")

    def test_under_claim(self):
        self.assertEqual(_compare("pass", "capability_gated"), "under_claim")


class ProbeRegistryTests(SimpleTestCase):

    def test_all_probes_registered(self):
        names = {p.name for p in ALL_PROBES}
        self.assertEqual(names, {
            "basic_chat", "image_base64", "image_url",
            "tool_call", "parallel_tool", "json_schema",
        })

    def test_get_probe_by_name(self):
        self.assertIsInstance(get_probe_by_name("basic_chat"), BasicChatProbe)
        self.assertIsNone(get_probe_by_name("nonexistent"))


class BasicChatProbeTests(SimpleTestCase):

    def test_prepare_body(self):
        p = BasicChatProbe()
        body = p.prepare_body(_mock_model())
        self.assertIn("messages", body)
        self.assertEqual(body["messages"][0]["role"], "user")

    def test_expected_always_pass(self):
        p = BasicChatProbe()
        caps = ResolvedCapabilities()
        self.assertEqual(p.expected_capability(_mock_model(), caps), "pass")


class ImageBase64ProbeTests(SimpleTestCase):

    def test_gated_when_image_disabled(self):
        p = ImageBase64Probe()
        caps = ResolvedCapabilities()  # image.enabled=False
        self.assertEqual(p.expected_capability(_mock_model(), caps), "capability_gated")

    def test_pass_when_base64_supported(self):
        p = ImageBase64Probe()
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64", "url"))
        self.assertEqual(p.expected_capability(_mock_model(), caps), "pass")


class ImageUrlProbeTests(SimpleTestCase):

    def test_gated_when_url_not_supported(self):
        p = ImageUrlProbe()
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64",))
        self.assertEqual(p.expected_capability(_mock_model(), caps), "capability_gated")


class ToolCallProbeTests(SimpleTestCase):

    def test_gated_when_tool_disabled(self):
        p = ToolCallProbe()
        caps = ResolvedCapabilities()  # tool.enabled=False
        self.assertEqual(p.expected_capability(_mock_model(), caps), "capability_gated")

    def test_pass_when_tool_enabled(self):
        p = ToolCallProbe()
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto",))
        self.assertEqual(p.expected_capability(_mock_model(), caps), "pass")


class ParallelToolProbeTests(SimpleTestCase):

    def test_prepare_body_has_two_tools(self):
        p = ParallelToolProbe()
        body = p.prepare_body(_mock_model())
        self.assertEqual(len(body["tools"]), 2)
        self.assertTrue(body["parallel_tool_calls"])


class JsonSchemaProbeTests(SimpleTestCase):

    def test_prepare_body_has_response_format(self):
        p = JsonSchemaProbe()
        body = p.prepare_body(_mock_model())
        self.assertEqual(body["response_format"]["type"], "json_schema")


class DryRunIntegrationTests(SimpleTestCase):
    """dry_run + adapt_request 集成,确保 capability gate 行为。

    用 patch 把 ``_resolve_caps_for_probe`` 替换成返回测试 caps,
    避免依赖真 ``resolve_for_wire`` 的第 2 级 service.CAPABILITIES fallback。
    """

    def test_basic_chat_passes_for_minimal_caps(self):
        caps = ResolvedCapabilities()
        caps.is_configured = True
        m = _mock_model(caps=caps)
        with patch(
            "apps.services.llm.wire_adapter.probes._resolve_caps_for_probe",
            return_value=caps,
        ):
            result = BasicChatProbe().dry_run(m)
        self.assertEqual(result.observed, "pass")
        self.assertEqual(result.declared, "pass")
        self.assertEqual(result.drift_type, "none")

    def test_image_base64_gated_when_image_disabled(self):
        caps = ResolvedCapabilities()
        # image.enabled=False(默认)→ adapt_request raises CapabilityGateError
        caps.is_configured = True
        m = _mock_model(caps=caps)
        with patch(
            "apps.services.llm.wire_adapter.probes._resolve_caps_for_probe",
            return_value=caps,
        ):
            result = ImageBase64Probe().dry_run(m)
        self.assertEqual(result.observed, "capability_gated")
        self.assertEqual(result.declared, "capability_gated")
        self.assertEqual(result.drift_type, "gated_aligned")

    def test_image_url_safely_skipped_when_input_via_lacks_url(self):
        """input_via=base64-only 时 dry_run 不真下载,直接报告 gated。"""
        caps = ResolvedCapabilities()
        caps.image = ImageCaps(enabled=True, input_via=("base64",))
        caps.is_configured = True
        m = _mock_model(caps=caps)
        with patch(
            "apps.services.llm.wire_adapter.probes._resolve_caps_for_probe",
            return_value=caps,
        ):
            result = ImageUrlProbe().dry_run(m)
        self.assertEqual(result.observed, "capability_gated")
        self.assertEqual(result.declared, "capability_gated")


class RunProbesTests(SimpleTestCase):

    def test_run_probes_returns_m_times_p_results(self):
        caps = ResolvedCapabilities()
        caps.tool = ToolCaps(enabled=True, choice_modes=("auto",))
        caps.is_configured = True
        models = [_mock_model(caps=caps), _mock_model(caps=caps, model_name="m2")]
        # 仅跑 BasicChat + ToolCall(2 probe)→ 2*2=4 results
        results = run_probes(models, probes=[BasicChatProbe(), ToolCallProbe()], dry_run=True)
        self.assertEqual(len(results), 4)
        for r in results:
            self.assertIsInstance(r, ProbeResult)
