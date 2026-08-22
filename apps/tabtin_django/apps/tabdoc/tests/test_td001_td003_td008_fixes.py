"""
回归测试：TD-001、TD-003、TD-008 修复

TD-001: 双路径并发写入竞态（TOCTOU）— cache 分布式锁防止重复 embed_text 调用
TD-003: 防抖盲区 — API 直接 Document.save() 在防抖窗口内应通过 pending 机制补偿索引
TD-008: on_commit(using='postgresql') 不匹配问题 — 改为不指定 using 参数
"""
from __future__ import annotations

import contextlib
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch, call


def _make_doc(
    doc_id="doc-test-1",
    title="Test Doc",
    plaintext="some content",
    pm_json=None,
    organization_id="ws-uuid-1",
    space_id="sp-uuid-1",
    status="active",
    trashed_at=None,
    created_by_id=None,
):
    return SimpleNamespace(
        id=doc_id,
        title=title,
        description_plaintext=plaintext,
        description_json=pm_json,
        organization_id=organization_id,
        space_id=space_id,
        status=status,
        trashed_at=trashed_at,
        created_by_id=created_by_id,
    )


# ======================================================================
# TD-001: cache 锁防止并发双重 embed
# ======================================================================

class TestTD001ConcurrentEmbedLock(unittest.TestCase):
    """TD-001: 并发双路径同时调用 index_document() 时，第二个应被锁拦截，只触发一次 embed_text。"""

    def test_first_caller_acquires_lock_and_embeds(self):
        """首个调用者抢到锁后应正常执行 embed_text。"""
        from apps.tabdoc.services.document_embedding_service import (
            DocumentEmbeddingService,
            _resolve_doc_embedding_ddl_dim,
        )

        doc = _make_doc()
        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = [0.1] * 1536
        # EB-005 维度守卫：svc.dimensions 必须等于 DDL 约定维度，否则在 embed 前被拦截。
        mock_svc.dimensions = _resolve_doc_embedding_ddl_dim()

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="hash-abc"), \
             patch("django.core.cache.cache.add", return_value=True), \
             patch("django.core.cache.cache.delete"), \
             patch("django.db.transaction.atomic"):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc
            result = DocumentEmbeddingService.index_document("doc-test-1", force=False)

        self.assertIn(result["status"], ("success", "failed"))
        mock_svc.embed_text.assert_called_once()

    def test_second_caller_blocked_by_lock(self):
        """第二个并发调用者（cache.add 返回 False）应被拦截，不调用 embed_text。"""
        from apps.tabdoc.services.document_embedding_service import DocumentEmbeddingService

        doc = _make_doc()
        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None

        mock_svc = MagicMock()

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="hash-abc"), \
             patch("django.core.cache.cache.add", return_value=False), \
             patch("django.core.cache.cache.delete"):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc
            result = DocumentEmbeddingService.index_document("doc-test-1", force=False)

        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result.get("reason"), "concurrent_embed")
        mock_svc.embed_text.assert_not_called()

    def test_lock_released_on_embed_failure(self):
        """embed_text 失败时，锁应被主动释放（避免 120s 内无法重试）。"""
        from apps.tabdoc.services.document_embedding_service import (
            DocumentEmbeddingService,
            _resolve_doc_embedding_ddl_dim,
        )

        doc = _make_doc()
        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None

        mock_svc = MagicMock()
        mock_svc.dimensions = _resolve_doc_embedding_ddl_dim()
        mock_svc.embed_text.side_effect = RuntimeError("embedding service unavailable")

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="hash-abc"), \
             patch("django.core.cache.cache.add", return_value=True), \
             patch("django.core.cache.cache.delete") as mock_delete:
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc
            result = DocumentEmbeddingService.index_document("doc-test-1", force=False)

        # 确认走到了 embed 调用本身（维度守卫已通过），失败来自 embed_text。
        mock_svc.embed_text.assert_called_once()
        self.assertEqual(result["status"], "failed")
        # 锁必须被释放
        mock_delete.assert_called()

    def test_lock_released_on_db_write_failure(self):
        """DB 写入失败时，锁也应被释放。"""
        from apps.tabdoc.services.document_embedding_service import (
            DocumentEmbeddingService,
            _resolve_doc_embedding_ddl_dim,
        )

        doc = _make_doc()
        mock_emb_objects = MagicMock()
        mock_emb_objects.filter.return_value.first.return_value = None
        mock_emb_objects.update_or_create.side_effect = Exception("DB connection error")

        mock_svc = MagicMock()
        mock_svc.embed_text.return_value = [0.1] * 1536
        mock_svc.dimensions = _resolve_doc_embedding_ddl_dim()

        with patch("apps.tabdoc.models.Document.objects") as mock_doc_objects, \
             patch("apps.rag.models.DocumentEmbedding.objects", mock_emb_objects), \
             patch("apps.rag.services.embedding_service.get_embedding_service", return_value=mock_svc), \
             patch("apps.rag.utils.calculate_content_hash", return_value="hash-abc"), \
             patch("django.core.cache.cache.add", return_value=True), \
             patch("django.core.cache.cache.delete") as mock_delete, \
             patch("django.db.transaction.atomic", lambda *a, **k: contextlib.nullcontext()):
            mock_doc_objects.filter.return_value.only.return_value.first.return_value = doc
            result = DocumentEmbeddingService.index_document("doc-test-1", force=False)

        # 确认走到了 embed 之后的 DB 写入失败路径（update_or_create 抛错），
        # 而非更早被维度守卫等拦截 —— 否则 mock_delete 的断言会变成假阳性。
        mock_svc.embed_text.assert_called_once()
        self.assertEqual(result["status"], "failed")
        # DB 写入失败时锁必须被释放
        mock_delete.assert_called()


# ======================================================================
# TD-003: 防抖盲区 — pending 标记机制
# ======================================================================

class TestTD003DebouncePendingMechanism(unittest.TestCase):
    """TD-003: API 直接 Document.save() 在防抖窗口内被拦截时，应通过 pending 机制保证最终触发。"""

    def _get_signal_handler(self):
        from apps.rag.signals import auto_index_document
        return auto_index_document

    def test_first_save_passes_through(self):
        """第一次 Document.save() 信号应正常派发任务（leading edge 触发）。"""
        handler = self._get_signal_handler()
        instance = SimpleNamespace(id="doc-signal-1")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.conf.settings") as mock_settings, \
             patch("apps.rag.signals._should_index", return_value=True), \
             patch("django.core.cache.cache.delete"), \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            mock_settings.RAG_AUTO_EMBED_DOCUMENTS = True
            handler(sender=None, instance=instance, created=False, update_fields=None)
            mock_on_commit.assert_called_once()

    def test_second_save_in_cooldown_sets_pending(self):
        """防抖窗口内的第二次 save 被拦截时，应设置 pending 标记和调度 trailing 任务。"""
        handler = self._get_signal_handler()
        instance = SimpleNamespace(id="doc-signal-2")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.conf.settings") as mock_settings, \
             patch("apps.rag.signals._should_index", return_value=False), \
             patch("django.core.cache.cache.set") as mock_set, \
             patch("django.core.cache.cache.add", return_value=True) as mock_add, \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            mock_settings.RAG_AUTO_EMBED_DOCUMENTS = True
            handler(sender=None, instance=instance, created=False, update_fields=None)

            # pending_key 应被设置
            set_calls = [str(c) for c in mock_set.call_args_list]
            self.assertTrue(
                any("rag:doc_embed_pending:doc-signal-2" in c for c in set_calls),
                f"pending_key not set, cache.set calls: {set_calls}",
            )
            # trailing 任务应被注册（首次 trigger 时 on_commit 被调用）
            mock_on_commit.assert_called_once()

    def test_second_save_in_cooldown_no_duplicate_trailing(self):
        """防抖窗口内多次 save，trailing 任务只调度一次（trigger_key 防重复）。"""
        handler = self._get_signal_handler()
        instance = SimpleNamespace(id="doc-signal-3")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.conf.settings") as mock_settings, \
             patch("apps.rag.signals._should_index", return_value=False), \
             patch("django.core.cache.cache.set"), \
             patch("django.core.cache.cache.add", return_value=False) as mock_add, \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            mock_settings.RAG_AUTO_EMBED_DOCUMENTS = True
            # trigger_key 已存在（cache.add 返回 False），不再重复调度
            handler(sender=None, instance=instance, created=False, update_fields=None)
            mock_on_commit.assert_not_called()

    def test_rag_disabled_no_operation(self):
        """RAG 关闭时，信号处理器不做任何操作。"""
        handler = self._get_signal_handler()
        instance = SimpleNamespace(id="doc-signal-4")

        with patch("apps.rag.signals._is_rag_enabled", return_value=False), \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            handler(sender=None, instance=instance, created=False, update_fields=None)
            mock_on_commit.assert_not_called()

    def test_irrelevant_update_fields_no_indexing(self):
        """只更新非内容字段（如 status）时，不应触发 embedding 索引。"""
        handler = self._get_signal_handler()
        instance = SimpleNamespace(id="doc-signal-5")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.conf.settings") as mock_settings, \
             patch("apps.rag.signals._should_index") as mock_should_index, \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            mock_settings.RAG_AUTO_EMBED_DOCUMENTS = True
            handler(
                sender=None, instance=instance, created=False,
                update_fields=["status", "updated_at"],
            )
            mock_should_index.assert_not_called()
            mock_on_commit.assert_not_called()


# ======================================================================
# TD-008: on_commit 不指定 using 参数
# ======================================================================

class TestTD008OnCommitNoUsing(unittest.TestCase):
    """TD-008: auto_index_document 应使用 transaction.on_commit() 而非 on_commit(using='postgresql')。"""

    def test_on_commit_called_without_using_kwarg(self):
        """正常触发时，on_commit 调用不应传入 using='postgresql' 参数。"""
        from apps.rag.signals import auto_index_document
        instance = SimpleNamespace(id="doc-signal-td008")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.conf.settings") as mock_settings, \
             patch("apps.rag.signals._should_index", return_value=True), \
             patch("django.core.cache.cache.delete"), \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            mock_settings.RAG_AUTO_EMBED_DOCUMENTS = True
            auto_index_document(sender=None, instance=instance, created=False, update_fields=None)

            mock_on_commit.assert_called_once()
            _, kwargs = mock_on_commit.call_args
            self.assertNotIn(
                "using",
                kwargs,
                "on_commit should not pass using='postgresql' — TD-008 regression",
            )

    def test_delete_signal_on_commit_without_using_kwarg(self):
        """auto_delete_document_index 的 on_commit 调用也不应传入 using='postgresql'。"""
        from apps.rag.signals import auto_delete_document_index
        instance = SimpleNamespace(id="doc-del-td008")

        with patch("apps.rag.signals._is_rag_enabled", return_value=True), \
             patch("django.db.transaction.on_commit") as mock_on_commit:
            auto_delete_document_index(sender=None, instance=instance)

            mock_on_commit.assert_called_once()
            _, kwargs = mock_on_commit.call_args
            self.assertNotIn(
                "using",
                kwargs,
                "auto_delete_document_index on_commit should not pass using='postgresql'",
            )


if __name__ == "__main__":
    unittest.main()
