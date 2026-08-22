"""
F19 回归测试：幂等键/计费遗漏修复（FND-01, FND-06, FND-07）

FND-01: Vision 计费 biz_id 每次调用必须唯一
FND-06: 摘要与记忆刷新 biz_id 每次调用必须唯一
FND-07: 结构化输出仅有 organization_id 时不应跳过计费
"""

import sys
from types import SimpleNamespace, ModuleType
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


def _ensure_mock_module(name):
    """在 sys.modules 中注入一个 mock module，避免真实 import 失败。"""
    if name not in sys.modules:
        sys.modules[name] = MagicMock()


# ──────────────────────────────────────────────────────────
# FND-01: VisionParser biz_id 唯一性
# ──────────────────────────────────────────────────────────

class VisionParserBizIdUniquenessTests(SimpleTestCase):
    """FND-01: 同一用户多次 Vision 解析的 biz_id 必须不同。"""

    def _get_parser_class(self):
        _ensure_mock_module("fitz")
        _ensure_mock_module("pdfplumber")
        _ensure_mock_module("json_repair")
        from apps.services.docparse.parsers.vision_parser import VisionParser
        return VisionParser

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_multiple_calls_produce_unique_biz_ids(self, mock_charge):
        VisionParser = self._get_parser_class()
        parser = VisionParser(model="test/model", user_id="user_001", organization_id="ws_001")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        parser._charge_usage(MagicMock(), fake_result)
        parser._charge_usage(MagicMock(), fake_result)
        parser._charge_usage(MagicMock(), fake_result)

        self.assertEqual(mock_charge.call_count, 3)
        biz_ids = [c.kwargs["biz_id"] for c in mock_charge.call_args_list]
        self.assertEqual(len(set(biz_ids)), 3, f"biz_id 应唯一，实际: {biz_ids}")
        for bid in biz_ids:
            self.assertTrue(bid.startswith("docparse:vision:"), f"前缀错误: {bid}")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_biz_id_not_fixed_to_user_organization(self, mock_charge):
        VisionParser = self._get_parser_class()
        parser = VisionParser(user_id="u1", organization_id="w1")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        parser._charge_usage(MagicMock(), fake_result)
        biz_id = mock_charge.call_args.kwargs["biz_id"]
        self.assertNotEqual(biz_id, "docparse:vision:u1:w1",
                            "biz_id 不应仅由 user_id:organization_id 组成")


# ──────────────────────────────────────────────────────────
# FND-06: SummarizationService biz_id 唯一性
# ──────────────────────────────────────────────────────────

class SummarizationBizIdUniquenessTests(SimpleTestCase):
    """FND-06: 摘要服务多次调用的 biz_id 必须不同。"""

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_multiple_calls_produce_unique_biz_ids(self, mock_charge):
        from apps.services.llm.services.summarization import SummarizationService
        svc = SummarizationService(user_id="user_001", organization_id="ws_001")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        svc._charge_usage(MagicMock(), fake_result)
        svc._charge_usage(MagicMock(), fake_result)

        self.assertEqual(mock_charge.call_count, 2)
        biz_ids = [c.kwargs["biz_id"] for c in mock_charge.call_args_list]
        self.assertEqual(len(set(biz_ids)), 2, f"biz_id 应唯一，实际: {biz_ids}")
        for bid in biz_ids:
            self.assertTrue(bid.startswith("llm:summarization:"), f"前缀错误: {bid}")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_biz_id_not_fixed(self, mock_charge):
        from apps.services.llm.services.summarization import SummarizationService
        svc = SummarizationService(user_id="u1", organization_id="w1")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        svc._charge_usage(MagicMock(), fake_result)
        biz_id = mock_charge.call_args.kwargs["biz_id"]
        self.assertNotEqual(biz_id, "llm:summarization:u1:w1")


# ──────────────────────────────────────────────────────────
# FND-06: MemoryFlushService biz_id 唯一性
# ──────────────────────────────────────────────────────────

class MemoryFlushBizIdUniquenessTests(SimpleTestCase):
    """FND-06: 记忆刷新多次调用的 biz_id 必须不同。"""

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_multiple_calls_produce_unique_biz_ids(self, mock_charge):
        from apps.services.llm.services.memory_flush import MemoryFlushService
        svc = MemoryFlushService(model_id="test-model", user_id="user_001", organization_id="ws_001")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        svc._charge_usage(MagicMock(), fake_result)
        svc._charge_usage(MagicMock(), fake_result)

        self.assertEqual(mock_charge.call_count, 2)
        biz_ids = [c.kwargs["biz_id"] for c in mock_charge.call_args_list]
        self.assertEqual(len(set(biz_ids)), 2, f"biz_id 应唯一，实际: {biz_ids}")
        for bid in biz_ids:
            self.assertTrue(bid.startswith("memory_flush:"), f"前缀错误: {bid}")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_biz_id_not_fixed(self, mock_charge):
        from apps.services.llm.services.memory_flush import MemoryFlushService
        svc = MemoryFlushService(model_id="test-model", user_id="u1", organization_id="w1")
        fake_result = {"success": True, "usage": {"input_tokens": 10, "output_tokens": 5}}

        svc._charge_usage(MagicMock(), fake_result)
        biz_id = mock_charge.call_args.kwargs["biz_id"]
        self.assertNotEqual(biz_id, "memory_flush:u1:w1")


# ──────────────────────────────────────────────────────────
# FND-07: StructuredOutputWrapper organization-only 计费
# ──────────────────────────────────────────────────────────

def _get_structured_output_wrapper():
    """延迟导入 StructuredOutputWrapper，提前 mock langchain 依赖。"""
    _ensure_mock_module("langchain_openai")
    _ensure_mock_module("langchain_core")
    _ensure_mock_module("langchain_core.messages")
    _ensure_mock_module("tenacity")

    mock_tenacity = sys.modules["tenacity"]
    mock_tenacity.stop_after_attempt = lambda n: n

    from apps.services.llm.services.structured_output import StructuredOutputWrapper
    return StructuredOutputWrapper


class StructuredOutputWorkspaceOnlyBillingTests(SimpleTestCase):
    """FND-07: 仅有 organization_id 时不应跳过计费。"""

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_main_path_charges_when_only_organization_id(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="", organization_id="ws_enterprise_001",
        )

        raw_msg = MagicMock()
        raw_msg.response_metadata = {
            "token_usage": {"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150}
        }
        raw_msg.usage_metadata = None

        wrapper._charge_main_path_usage(raw_msg)

        mock_charge.assert_called_once()
        kwargs = mock_charge.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], "ws_enterprise_001")
        self.assertEqual(kwargs["source"], "structured_output:main")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_fallback_charges_when_only_organization_id(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="", organization_id="ws_enterprise_001",
        )
        fake_result = {"success": True, "usage": {"input_tokens": 50, "output_tokens": 20}}

        wrapper._charge_fallback_usage(fake_result)

        mock_charge.assert_called_once()
        kwargs = mock_charge.call_args.kwargs
        self.assertEqual(kwargs["organization_id"], "ws_enterprise_001")
        self.assertEqual(kwargs["source"], "structured_output:fallback")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_main_path_skips_when_no_identifiers(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="", organization_id="",
        )
        raw_msg = MagicMock()
        raw_msg.response_metadata = {"token_usage": {"prompt_tokens": 100, "completion_tokens": 50}}

        wrapper._charge_main_path_usage(raw_msg)
        mock_charge.assert_not_called()

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_fallback_skips_when_no_identifiers(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="", organization_id="",
        )
        wrapper._charge_fallback_usage({"success": True})
        mock_charge.assert_not_called()


class StructuredOutputBizIdUniquenessTests(SimpleTestCase):
    """附带修复: 结构化输出 biz_id 唯一性。"""

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_main_path_unique_biz_ids(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="user_001", organization_id="ws_001",
        )
        raw_msg = MagicMock()
        raw_msg.response_metadata = {
            "token_usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
        }
        raw_msg.usage_metadata = None

        wrapper._charge_main_path_usage(raw_msg)
        wrapper._charge_main_path_usage(raw_msg)

        self.assertEqual(mock_charge.call_count, 2)
        biz_ids = [c.kwargs["biz_id"] for c in mock_charge.call_args_list]
        self.assertEqual(len(set(biz_ids)), 2, f"biz_id 应唯一，实际: {biz_ids}")

    @patch("apps.services.llm.services.billed_call.safe_charge_usage")
    def test_fallback_unique_biz_ids(self, mock_charge):
        Wrapper = _get_structured_output_wrapper()
        wrapper = Wrapper(
            service=MagicMock(), schema_cls=MagicMock(), max_retries=1,
            user_id="user_001", organization_id="ws_001",
        )
        fake_result = {"success": True, "usage": {"input_tokens": 50, "output_tokens": 20}}

        wrapper._charge_fallback_usage(fake_result)
        wrapper._charge_fallback_usage(fake_result)

        self.assertEqual(mock_charge.call_count, 2)
        biz_ids = [c.kwargs["biz_id"] for c in mock_charge.call_args_list]
        self.assertEqual(len(set(biz_ids)), 2, f"biz_id 应唯一，实际: {biz_ids}")
