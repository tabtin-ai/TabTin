"""
ECI-016 / ECI-017 回归测试

ECI-016: `_precheck_billing` 中 user_id 有值但 organization_id 为空时不调用计费函数
ECI-017: `_resolve_docparse_context` 中 except Exception 静默吞异常改为记录 debug 日志
"""

import uuid
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase


# =====================================================================
# ECI-016: _precheck_billing 空 organization_id 防护
# =====================================================================


class PrecheckBillingOrganizationIdGuardTest(SimpleTestCase):
    """ECI-016: _precheck_billing 在 user_id 有值但 organization_id 为空时应提前返回，
    不调用任何计费相关函数。"""

    def _get_precheck(self):
        from apps.rag.services.embedding_service import EmbeddingService
        return EmbeddingService._precheck_billing

    def test_empty_organization_id_does_not_call_balance_check(self):
        """user_id 有值，organization_id 为空字符串时不调用余额检查函数。"""
        precheck = self._get_precheck()
        with patch("apps.rag.services.embedding_service._check_balance_before_request") as mock_balance, \
             patch("apps.rag.services.embedding_service._check_budget_before_request") as mock_budget, \
             patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True):
            # 不应抛出任何异常
            precheck("user-123", "")
            mock_balance.assert_not_called()
            mock_budget.assert_not_called()

    def test_none_organization_id_does_not_call_balance_check(self):
        """user_id 有值，organization_id 为 None 时不调用余额检查函数。"""
        precheck = self._get_precheck()
        with patch("apps.rag.services.embedding_service._check_balance_before_request") as mock_balance, \
             patch("apps.rag.services.embedding_service._check_budget_before_request") as mock_budget, \
             patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True):
            precheck("user-123", None)
            mock_balance.assert_not_called()
            mock_budget.assert_not_called()

    def test_empty_organization_id_logs_debug(self):
        """user_id 有值，organization_id 为空时应记录 debug 日志。"""
        precheck = self._get_precheck()
        with patch("apps.rag.services.embedding_service.logger") as mock_logger, \
             patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True):
            precheck("user-abc", "")
            mock_logger.debug.assert_called_once()
            call_args = mock_logger.debug.call_args[0]
            self.assertIn("user-abc", str(call_args))

    def test_both_empty_returns_early_without_error(self):
        """user_id 和 organization_id 均为空时应提前返回，不报错。"""
        precheck = self._get_precheck()
        with patch("apps.rag.services.embedding_service._check_balance_before_request") as mock_balance:
            precheck("", "")
            mock_balance.assert_not_called()

    def test_valid_ids_calls_balance_check(self):
        """user_id 和 organization_id 均有值且计费可用时，应正常调用余额检查函数（正常路径回归）。"""
        precheck = self._get_precheck()
        with patch("apps.rag.services.embedding_service._check_balance_before_request", return_value=False) as mock_balance, \
             patch("apps.rag.services.embedding_service._check_budget_before_request", return_value=False) as mock_budget, \
             patch("apps.rag.services.embedding_service._BILLING_AVAILABLE", True):
            precheck("user-123", "ws-456")
            mock_budget.assert_called_once_with("ws-456")
            mock_balance.assert_called_once_with("user-123", "ws-456")


# =====================================================================
# ECI-017: _resolve_docparse_context 异常记录（不再静默吞掉）
# =====================================================================


class ResolveDocparseContextExceptionLoggingTest(SimpleTestCase):
    """ECI-017: _resolve_docparse_context 中模块 context lookup 失败时应记录 debug
    日志，不再静默吞掉异常，返回空值而非崩溃。"""

    def _make_parsed_doc_with_usage(self, module, ctx_id):
        parsed_doc = MagicMock()
        fr = MagicMock()
        fr.upload_user_id = uuid.uuid4()
        fr.metadata = {}

        usage = MagicMock()
        usage.module = module
        usage.context_id = str(ctx_id)
        fr.usages.filter.return_value = [usage]

        parsed_doc.file_record = fr
        return parsed_doc

    def test_tabdoc_lookup_exception_logs_debug(self):
        """tabdoc context lookup 失败时应记录 debug 日志，不抛出异常。"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ctx_id = uuid.uuid4()
        parsed_doc = self._make_parsed_doc_with_usage("tabdoc", ctx_id)

        with patch("apps.tabdoc.models.Document.objects") as mock_qs, \
             patch("apps.rag.tasks.logger") as mock_logger:
            mock_qs.filter.side_effect = Exception("DB connection failed")

            # 不应抛出异常
            result = _resolve_docparse_contexts(parsed_doc)

            # 结果为空列表（无法解析到 context）
            self.assertEqual(result, [])

            # 应记录 debug 日志，包含 ctx_id
            debug_calls = [str(call) for call in mock_logger.debug.call_args_list]
            logged = " ".join(debug_calls)
            self.assertIn(str(ctx_id), logged)

    def test_tabdata_lookup_exception_logs_debug(self):
        """tabdata context lookup 失败时应记录 debug 日志，不抛出异常。"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ctx_id = uuid.uuid4()
        parsed_doc = self._make_parsed_doc_with_usage("tabdata", ctx_id)

        with patch("apps.tabdata.models.Table.objects") as mock_qs, \
             patch("apps.rag.tasks.logger") as mock_logger:
            mock_qs.filter.side_effect = Exception("table not found")

            result = _resolve_docparse_contexts(parsed_doc)
            self.assertEqual(result, [])

            debug_calls = [str(call) for call in mock_logger.debug.call_args_list]
            logged = " ".join(debug_calls)
            self.assertIn(str(ctx_id), logged)

    def test_chat_lookup_exception_logs_debug(self):
        """chat context lookup 失败时应记录 debug 日志，不抛出异常。"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ctx_id = uuid.uuid4()
        parsed_doc = self._make_parsed_doc_with_usage("chat", ctx_id)

        with patch("apps.chat.conversation.models.ChatSession.objects") as mock_qs, \
             patch("apps.rag.tasks.logger") as mock_logger:
            mock_qs.filter.side_effect = Exception("session lookup error")

            result = _resolve_docparse_contexts(parsed_doc)
            self.assertEqual(result, [])

            debug_calls = [str(call) for call in mock_logger.debug.call_args_list]
            logged = " ".join(debug_calls)
            self.assertIn(str(ctx_id), logged)

    def test_crawl_lookup_exception_logs_debug(self):
        """crawl context lookup 失败时应记录 debug 日志，不抛出异常。"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ctx_id = uuid.uuid4()
        parsed_doc = self._make_parsed_doc_with_usage("crawl", ctx_id)

        with patch("apps.tabtinspace.models.Workspace.objects") as mock_qs, \
             patch("apps.rag.tasks.logger") as mock_logger:
            mock_qs.filter.side_effect = Exception("space not found")

            result = _resolve_docparse_contexts(parsed_doc)
            self.assertEqual(result, [])

            debug_calls = [str(call) for call in mock_logger.debug.call_args_list]
            logged = " ".join(debug_calls)
            self.assertIn(str(ctx_id), logged)

    def test_lookup_exception_does_not_raise(self):
        """任意模块 lookup 异常时，函数整体不应抛出异常（安全降级）。"""
        from apps.rag.tasks import _resolve_docparse_context

        ctx_id = uuid.uuid4()
        parsed_doc = self._make_parsed_doc_with_usage("tabdoc", ctx_id)

        with patch("apps.tabdoc.models.Document.objects") as mock_qs:
            mock_qs.filter.side_effect = RuntimeError("unexpected error")

            # _resolve_docparse_context 是向后兼容包装器，也不应抛出
            user_id, organization_id, space_id = _resolve_docparse_context(parsed_doc)
            self.assertEqual(user_id, "")
            self.assertIsNone(organization_id)
            self.assertIsNone(space_id)

    def test_successful_lookup_still_returns_context(self):
        """lookup 正常时应仍能返回正确的上下文（正常路径回归）。"""
        from apps.rag.tasks import _resolve_docparse_contexts

        ws_id = uuid.uuid4()
        sp_id = uuid.uuid4()
        ctx_id = uuid.uuid4()

        parsed_doc = self._make_parsed_doc_with_usage("tabdoc", ctx_id)

        with patch("apps.tabdoc.models.Document.objects") as mock_qs:
            mock_doc = MagicMock()
            mock_doc.organization_id = ws_id
            mock_doc.space_id = sp_id
            mock_qs.filter.return_value.only.return_value.first.return_value = mock_doc

            result = _resolve_docparse_contexts(parsed_doc)
            self.assertEqual(len(result), 1)
            _, result_ws, result_sp = result[0]
            self.assertEqual(result_ws, ws_id)
            self.assertEqual(result_sp, sp_id)
