"""回归测试：ECI-007 / ECI-008 / ECI-009 — 文档 embedding 计费三盲区修复

ECI-007: index_document 未传 user_id 时应从 doc.created_by_id 自动解析
ECI-008: _BILLING_AVAILABLE=False 时 _charge_embedding_usage 应调用 track_billing_degradation
ECI-009: consume_credits 返回 charged=False 时应记录 warning
"""
from __future__ import annotations

import os
import sys
import unittest
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()


# ─────────────────────────────────────────────────────────────────────────────
# ECI-007: DocumentEmbeddingService 自动从 created_by_id 解析 user_id
# ─────────────────────────────────────────────────────────────────────────────

class TestECI007UserIdAutoResolve(unittest.TestCase):
    """index_document 在调用方未传 user_id 时，应从 doc.created_by_id 自动填充。"""

    def _make_doc(self, doc_id="doc-1", created_by_id="user-42", organization_id="ws-1", space_id="sp-1"):
        doc = MagicMock()
        doc.id = doc_id
        doc.title = "Test Doc"
        doc.description_plaintext = "Some content for embedding"
        doc.description_json = None
        doc.organization_id = organization_id
        doc.space_id = space_id
        doc.status = "active"
        doc.trashed_at = None
        doc.created_by_id = created_by_id
        return doc

    def _common_patches(self, mock_doc, mock_embed_svc, content_hash="hash-test"):
        """构建所有公共 patch，包含 cache.add 始终返回 True（模拟无并发锁竞争）。"""
        from unittest.mock import patch as _patch

        def _make_patches():
            patches = [
                _patch("apps.tabdoc.models.Document.objects"),
                _patch("apps.rag.models.DocumentEmbedding.objects"),
                _patch("apps.rag.services.embedding_service.get_embedding_service",
                       return_value=mock_embed_svc),
                _patch("apps.rag.utils.calculate_content_hash", return_value=content_hash),
                _patch("django.db.transaction.atomic"),
                # 关键：mock cache.add 始终返回 True，模拟无锁竞争，确保 embed 路径不被跳过
                _patch("django.core.cache.cache.add", return_value=True),
                _patch("django.core.cache.cache.delete"),
            ]
            return patches

        return _make_patches()

    def test_user_id_auto_resolved_from_created_by_id(self):
        """调用方不传 user_id 时，embed_text 应收到 doc.created_by_id 作为 user_id。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = self._make_doc(created_by_id="user-42")
        mock_embed_svc = MagicMock()
        mock_embed_svc.embed_text.return_value = [0.1] * 10

        patches = self._common_patches(mock_doc, mock_embed_svc, "hash-abc-007a")
        with patches[0] as mock_qs, patches[1] as mock_emb_qs, \
             patches[2], patches[3], patches[4] as mock_tx, patches[5], patches[6]:

            mock_tx.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.return_value.__exit__ = MagicMock(return_value=False)

            filter_mock = MagicMock()
            filter_mock.only.return_value.first.return_value = mock_doc
            mock_qs.filter.return_value = filter_mock

            emb_filter = MagicMock()
            emb_filter.first.return_value = None
            mock_emb_qs.filter.return_value = emb_filter
            mock_emb_qs.update_or_create.return_value = (MagicMock(), True)

            DocumentEmbeddingService.index_document("doc-1", force=True, user_id="")

            self.assertTrue(mock_embed_svc.embed_text.called, "embed_text 应被调用")
            actual_user_id = mock_embed_svc.embed_text.call_args.kwargs.get("user_id", "")
            self.assertEqual(
                actual_user_id, "user-42",
                "user_id 应自动从 created_by_id 解析为 'user-42'",
            )

    def test_explicit_user_id_takes_precedence(self):
        """调用方显式传入 user_id 时，应优先使用，而非 created_by_id。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = self._make_doc(created_by_id="owner-999")
        mock_embed_svc = MagicMock()
        mock_embed_svc.embed_text.return_value = [0.1] * 10

        patches = self._common_patches(mock_doc, mock_embed_svc, "hash-xyz-007b")
        with patches[0] as mock_qs, patches[1] as mock_emb_qs, \
             patches[2], patches[3], patches[4] as mock_tx, patches[5], patches[6]:

            mock_tx.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.return_value.__exit__ = MagicMock(return_value=False)

            filter_mock = MagicMock()
            filter_mock.only.return_value.first.return_value = mock_doc
            mock_qs.filter.return_value = filter_mock

            emb_filter = MagicMock()
            emb_filter.first.return_value = None
            mock_emb_qs.filter.return_value = emb_filter
            mock_emb_qs.update_or_create.return_value = (MagicMock(), True)

            DocumentEmbeddingService.index_document("doc-1", force=True, user_id="explicit-user")

            actual_user_id = mock_embed_svc.embed_text.call_args.kwargs.get("user_id", "")
            self.assertEqual(
                actual_user_id, "explicit-user",
                "显式传入的 user_id 应优先于 created_by_id",
            )

    def test_no_user_id_when_created_by_is_none(self):
        """doc.created_by_id 为 None 时，effective_user_id 应为空字符串（不崩溃）。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        mock_doc = self._make_doc(created_by_id=None)
        mock_embed_svc = MagicMock()
        mock_embed_svc.embed_text.return_value = [0.1] * 10

        patches = self._common_patches(mock_doc, mock_embed_svc, "hash-null-007c")
        with patches[0] as mock_qs, patches[1] as mock_emb_qs, \
             patches[2], patches[3], patches[4] as mock_tx, patches[5], patches[6]:

            mock_tx.return_value.__enter__ = MagicMock(return_value=None)
            mock_tx.return_value.__exit__ = MagicMock(return_value=False)

            filter_mock = MagicMock()
            filter_mock.only.return_value.first.return_value = mock_doc
            mock_qs.filter.return_value = filter_mock

            emb_filter = MagicMock()
            emb_filter.first.return_value = None
            mock_emb_qs.filter.return_value = emb_filter
            mock_emb_qs.update_or_create.return_value = (MagicMock(), True)

            # 不应抛出异常
            DocumentEmbeddingService.index_document("doc-1", force=True, user_id="")

            actual_user_id = mock_embed_svc.embed_text.call_args.kwargs.get("user_id", "")
            self.assertEqual(actual_user_id, "", "created_by_id 为 None 时 user_id 应为空字符串")


# ─────────────────────────────────────────────────────────────────────────────
# ECI-008: _BILLING_AVAILABLE=False 时补调 track_billing_degradation
# ─────────────────────────────────────────────────────────────────────────────

class TestECI008BillingUnavailableDegradation(unittest.TestCase):
    """_charge_embedding_usage：计费模块不可用时应调用 track_billing_degradation。"""

    def _make_svc(self):
        import apps.rag.services.embedding_service as es_mod
        svc = object.__new__(es_mod.EmbeddingService)
        svc.provider = "openai"
        svc.model = "text-embedding-3-small"
        return svc, es_mod

    def test_track_degradation_called_when_billing_unavailable(self):
        """_BILLING_AVAILABLE=False 时，_charge_embedding_usage 应调用 track_billing_degradation。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=500, prompt_tokens=500))
        mock_track = MagicMock()

        with patch.object(es_mod, "_BILLING_AVAILABLE", False), \
             patch(
                 "apps.services.billing.services.degradation_tracker.track_billing_degradation",
                 mock_track,
             ):
            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1")

        mock_track.assert_called_once()
        kwargs = mock_track.call_args.kwargs
        self.assertEqual(kwargs.get("meter_key"), "rag.embedding")
        self.assertEqual(kwargs.get("organization_id"), "ws-1")
        self.assertEqual(kwargs.get("error"), "billing_module_unavailable")

    def test_no_track_when_user_id_empty(self):
        """user_id 为空时应直接返回，不调用 track。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=500, prompt_tokens=500))
        mock_track = MagicMock()

        with patch.object(es_mod, "_BILLING_AVAILABLE", False), \
             patch(
                 "apps.services.billing.services.degradation_tracker.track_billing_degradation",
                 mock_track,
             ):
            svc._charge_embedding_usage(mock_response, user_id="", organization_id="ws-1")

        mock_track.assert_not_called()

    def test_degradation_tracker_import_fails_gracefully(self):
        """track_billing_degradation import 失败时应静默 warning，不抛异常。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=100, prompt_tokens=100))

        with patch.object(es_mod, "_BILLING_AVAILABLE", False), \
             patch(
                 "apps.services.billing.services.degradation_tracker.track_billing_degradation",
                 side_effect=ImportError("not found"),
             ), \
             patch.object(es_mod.logger, "warning") as mock_warn:
            # 不应抛出异常
            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1")

        # 应有 warning 记录
        self.assertTrue(mock_warn.called, "失败时应记录 warning")


# ─────────────────────────────────────────────────────────────────────────────
# ECI-009: consume_credits 返回 charged=False 时记录 warning
# ─────────────────────────────────────────────────────────────────────────────

class TestECI009ConsumeCreditsReturnValueCheck(unittest.TestCase):
    """_charge_embedding_usage：consume_credits 返回 charged=False 时应记录 warning。"""

    def _make_svc(self):
        import apps.rag.services.embedding_service as es_mod
        svc = object.__new__(es_mod.EmbeddingService)
        svc.provider = "openai"
        svc.model = "text-embedding-3-small"
        return svc, es_mod

    def test_warning_logged_when_charged_false_missing_organization(self):
        """consume_credits 返回 charged=False reason=missing_organization_id 时应 warning。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=1000, prompt_tokens=1000))
        mock_consume = MagicMock(return_value={"charged": False, "reason": "missing_organization_id"})

        mock_credits_cls = MagicMock()
        mock_credits_cls.consume_credits = mock_consume

        with patch.object(es_mod, "_BILLING_AVAILABLE", True), \
             patch.object(es_mod, "_CreditsService", mock_credits_cls), \
             patch.object(es_mod.logger, "warning") as mock_warn:

            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1", charge_id="cid-1")

        mock_consume.assert_called_once()
        warning_calls = [str(c) for c in mock_warn.call_args_list]
        self.assertTrue(
            any("missing_organization_id" in w for w in warning_calls),
            f"应记录含 'missing_organization_id' 的 warning，实际: {warning_calls}",
        )

    def test_warning_logged_when_charged_false_missing_user(self):
        """consume_credits 返回 charged=False reason=missing_user_id 时应 warning。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=500, prompt_tokens=500))
        mock_consume = MagicMock(return_value={"charged": False, "reason": "missing_user_id"})

        mock_credits_cls = MagicMock()
        mock_credits_cls.consume_credits = mock_consume

        with patch.object(es_mod, "_BILLING_AVAILABLE", True), \
             patch.object(es_mod, "_CreditsService", mock_credits_cls), \
             patch.object(es_mod.logger, "warning") as mock_warn:

            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1", charge_id="cid-2")

        warning_calls = [str(c) for c in mock_warn.call_args_list]
        self.assertTrue(
            any("missing_user_id" in w for w in warning_calls),
            f"应记录含 'missing_user_id' 的 warning，实际: {warning_calls}",
        )

    def test_no_skip_warning_when_charged_true(self):
        """consume_credits 返回 charged=True 时不应记录'计费跳过' warning。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=1000, prompt_tokens=1000))
        mock_consume = MagicMock(return_value={"charged": True, "amount": Decimal("0.001")})

        mock_credits_cls = MagicMock()
        mock_credits_cls.consume_credits = mock_consume

        with patch.object(es_mod, "_BILLING_AVAILABLE", True), \
             patch.object(es_mod, "_CreditsService", mock_credits_cls), \
             patch.object(es_mod.logger, "warning") as mock_warn:

            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1", charge_id="cid-3")

        skip_warnings = [c for c in mock_warn.call_args_list if "计费跳过" in str(c)]
        self.assertEqual(len(skip_warnings), 0, "charged=True 时不应记录'计费跳过' warning")

    def test_no_crash_when_consume_returns_none(self):
        """consume_credits 返回 None 时不应崩溃。"""
        svc, es_mod = self._make_svc()

        mock_response = SimpleNamespace(usage=SimpleNamespace(total_tokens=500, prompt_tokens=500))
        mock_consume = MagicMock(return_value=None)

        mock_credits_cls = MagicMock()
        mock_credits_cls.consume_credits = mock_consume

        with patch.object(es_mod, "_BILLING_AVAILABLE", True), \
             patch.object(es_mod, "_CreditsService", mock_credits_cls):

            # 不应抛出异常
            svc._charge_embedding_usage(mock_response, user_id="u-1", organization_id="ws-1")


if __name__ == "__main__":
    unittest.main()
