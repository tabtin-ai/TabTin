"""
回归测试：ToolEmbeddingService — EQ-018 / EQ-019 / EQ-020

Mock 路径说明：
- _unified_embed 在 index_tool/search 函数内部 `from apps.services.llm.services.embedding import embed_text as _unified_embed`
  → patch 路径: apps.services.llm.services.embedding.embed_text
  这个层次同时屏蔽了 build_scene_call_context / resolve_model / check_billing 等下游真依赖，
  让测试能在不依赖真 PG 测试 DB 的环境下锁定 EQ-018 约定（ToolEmbeddingService 调
  _unified_embed 时必须传 organization_id='system' + user_id=''）。
- ToolEmbedding 在函数内部 `from apps.capabilities.models import ToolEmbedding`
  → patch 路径: apps.capabilities.models.ToolEmbedding
"""

import hashlib
import uuid
from unittest.mock import MagicMock, patch

from django.test import TestCase

from apps.capabilities.services.tool_embedding import (
    ToolEmbeddingService,
    _SYSTEM_ORGANIZATION_ID,
    _cleanup_tool_embedding_on_delete,
    _connect_registered_tool_signals,
    build_content_text,
)

# patch 路径常量（源模块路径，因为是函数内 import）
_PATCH_UNIFIED_EMBED = "apps.services.llm.services.embedding.embed_text"
_PATCH_TOOL_EMBEDDING_MODEL = "apps.capabilities.models.ToolEmbedding"
_PATCH_REGISTERED_TOOL_MODEL = "apps.capabilities.models.RegisteredTool"


# ─── 共用工厂 ────────────────────────────────────────────────────────────────

def _fake_vector():
    return [0.1] * 1536


def _make_mock_unified_embed_result(dimensions: int = 1536):
    """构造模拟 EmbeddingResult，dimensions 默认与 ToolEmbedding DDL 一致以通过守卫。"""
    mock_result = MagicMock()
    mock_result.vectors = [_fake_vector()]
    mock_result.dimensions = dimensions
    return mock_result


def _make_tool_kwargs(**overrides):
    base = dict(
        tool_id=str(uuid.uuid4()),
        tool_name="test_tool",
        display_name="Test Tool",
        description="A tool for testing",
        tags=["tag1"],
        category="platform",
        provider_id="test_provider",
        documentation="",
    )
    base.update(overrides)
    return base


def _make_mock_te_qs(existing_hash=None):
    """构造模拟 ToolEmbedding ORM QuerySet。"""
    mock_qs = MagicMock()
    mock_qs.filter.return_value.values_list.return_value.first.return_value = existing_hash
    mock_qs.update_or_create.return_value = (MagicMock(), True)
    return mock_qs


# ─── EQ-020: content_hash 完整性 ────────────────────────────────────────────

class TestContentHashFullLength(TestCase):
    """EQ-020: content_hash 必须使用完整 64 字符 hexdigest，不截断。"""

    def test_sha256_full_hexdigest_is_64_chars(self):
        """sha256 hexdigest 为完整 64 字符（旧截断 [:16] 是错误的）。"""
        content = build_content_text("tool_x", "Tool X", "description of tool x")
        full_hash = hashlib.sha256(content.encode()).hexdigest()
        self.assertEqual(len(full_hash), 64)
        self.assertNotEqual(full_hash, full_hash[:16])

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_index_tool_writes_64_char_hash(self, mock_te_cls, mock_unified_embed):
        """index_tool 写入 ToolEmbedding 时 content_hash 必须是完整 64 字符。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        mock_qs = _make_mock_te_qs(existing_hash=None)
        mock_te_cls.objects.using.return_value = mock_qs

        ToolEmbeddingService.index_tool(**_make_tool_kwargs())

        update_or_create_call = mock_qs.update_or_create.call_args
        self.assertIsNotNone(update_or_create_call)
        written_hash = update_or_create_call.kwargs["defaults"]["content_hash"]
        self.assertEqual(len(written_hash), 64, "content_hash 必须是 64 字符完整 hexdigest")

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_legacy_short_hash_skips_reindex(self, mock_te_cls, mock_unified_embed):
        """EQ-020 兼容：存量 16 字符短 hash 与当前内容匹配时跳过 embedding。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        # 与 _make_tool_kwargs 完全一致的参数计算 hash，确保匹配
        tool_kwargs = _make_tool_kwargs(
            tool_name="tool_x",
            display_name="Tool X",
            description="some description",
            documentation="",
        )
        content = build_content_text(
            tool_kwargs["tool_name"],
            tool_kwargs["display_name"],
            tool_kwargs["description"],
            tags=tool_kwargs.get("tags"),
            category=tool_kwargs.get("category", ""),
            provider_id=tool_kwargs.get("provider_id", ""),
            documentation=tool_kwargs.get("documentation", ""),
        )
        full_hash = hashlib.sha256(content.encode()).hexdigest()
        short_hash = full_hash[:16]

        mock_qs = _make_mock_te_qs(existing_hash=short_hash)
        mock_te_cls.objects.using.return_value = mock_qs

        result = ToolEmbeddingService.index_tool(**tool_kwargs)

        self.assertFalse(result, "存量短 hash 命中时应跳过（兼容逻辑）")
        mock_unified_embed.assert_not_called()

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_changed_content_triggers_reindex(self, mock_te_cls, mock_unified_embed):
        """内容变化（hash 完全不匹配）时必须触发重新 embedding。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        mock_qs = _make_mock_te_qs(existing_hash="aabbccdd11223344")  # 不匹配当前内容
        mock_te_cls.objects.using.return_value = mock_qs

        result = ToolEmbeddingService.index_tool(**_make_tool_kwargs(
            description="completely different description xyz 12345",
        ))

        self.assertTrue(result, "内容变化时应触发重新 embedding")
        mock_unified_embed.assert_called_once()


# ─── EQ-018: 平台级 embedding 系统标识 ──────────────────────────────────────

class TestSystemEmbeddingNoBilling(TestCase):
    """EQ-018: embed_text 调用传 organization_id='system'，user_id='' 跳过点券计费。"""

    def test_system_organization_id_constant(self):
        """_SYSTEM_ORGANIZATION_ID 常量值必须为 'system'。"""
        self.assertEqual(_SYSTEM_ORGANIZATION_ID, "system")

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_index_tool_passes_system_organization_id(self, mock_te_cls, mock_unified_embed):
        """index_tool 调用 _unified_embed 必须传 organization_id='system'，不传 user_id。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        mock_qs = _make_mock_te_qs(existing_hash=None)
        mock_te_cls.objects.using.return_value = mock_qs

        ToolEmbeddingService.index_tool(**_make_tool_kwargs())

        mock_unified_embed.assert_called_once()
        call_kwargs = mock_unified_embed.call_args.kwargs
        self.assertEqual(
            call_kwargs.get("organization_id"),
            _SYSTEM_ORGANIZATION_ID,
            "index_tool 必须传 organization_id='system' 以标记平台级操作",
        )
        user_id = call_kwargs.get("user_id", "")
        self.assertEqual(user_id, "", "index_tool 不应传 user_id（平台操作不扣点券）")
        self.assertEqual(
            call_kwargs.get("scene_key"),
            "rag_index_tool",
            "index_tool 必须使用 rag_index_tool scene",
        )

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_search_passes_system_organization_id(self, mock_te_cls, mock_unified_embed):
        """search 调用 _unified_embed 必须传 organization_id='system'。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        # 让 ORM 链返回空列表使 search 快速退出
        mock_qs = MagicMock()
        sliced = MagicMock()
        sliced.__iter__ = MagicMock(return_value=iter([]))
        sliced.__len__ = MagicMock(return_value=0)
        mock_qs.annotate.return_value.filter.return_value.order_by.return_value.values_list.return_value.__getitem__ = MagicMock(return_value=sliced)
        mock_te_cls.objects.using.return_value = mock_qs

        with patch(_PATCH_REGISTERED_TOOL_MODEL):
            try:
                ToolEmbeddingService.search("test query")
            except Exception:
                pass  # pgvector CosineDistance 未安装时允许内部异常

        self.assertTrue(mock_unified_embed.called, "search 必须调用 _unified_embed")
        call_kwargs = mock_unified_embed.call_args.kwargs
        self.assertEqual(
            call_kwargs.get("organization_id"),
            _SYSTEM_ORGANIZATION_ID,
            "search 必须传 organization_id='system'",
        )
        self.assertEqual(
            call_kwargs.get("scene_key"),
            "rag_search_query",
            "search 必须使用 rag_search_query scene",
        )


# ─── EQ-019: RegisteredTool 删除 Signal 兜底 ────────────────────────────────

class TestRegisteredToolDeleteSignal(TestCase):
    """EQ-019: 删除 RegisteredTool 时自动清理对应 ToolEmbedding。"""

    def setUp(self):
        _connect_registered_tool_signals()

    @patch("apps.capabilities.services.tool_embedding.ToolEmbeddingService.remove_tool")
    def test_cleanup_called_with_matching_embedding(self, mock_remove):
        """有对应向量记录时，remove_tool 应被调用。"""
        mock_remove.return_value = True
        instance = MagicMock()
        instance.name = "my_tool"

        _cleanup_tool_embedding_on_delete(sender=None, instance=instance)

        mock_remove.assert_called_once_with("my_tool")

    @patch("apps.capabilities.services.tool_embedding.ToolEmbeddingService.remove_tool")
    def test_cleanup_called_without_embedding(self, mock_remove):
        """无对应向量记录时，remove_tool 也应被调用，且不抛异常。"""
        mock_remove.return_value = False
        instance = MagicMock()
        instance.name = "nonexistent_tool"

        _cleanup_tool_embedding_on_delete(sender=None, instance=instance)

        mock_remove.assert_called_once_with("nonexistent_tool")

    @patch("apps.capabilities.services.tool_embedding.ToolEmbeddingService.remove_tool")
    def test_cleanup_exception_does_not_propagate(self, mock_remove):
        """remove_tool 抛异常时 handler 必须捕获，不阻断 delete 事务。"""
        mock_remove.side_effect = Exception("DB error")
        instance = MagicMock()
        instance.name = "error_tool"

        try:
            _cleanup_tool_embedding_on_delete(sender=None, instance=instance)
        except Exception as exc:
            self.fail(f"signal handler 不应向外传播异常: {exc}")

    def test_signal_triggers_cleanup_on_post_delete(self):
        """发送 post_delete 信号时，cleanup handler 应被触发。"""
        from django.db.models.signals import post_delete
        from apps.capabilities.models import RegisteredTool

        with patch(
            "apps.capabilities.services.tool_embedding.ToolEmbeddingService.remove_tool",
        ) as mock_remove:
            mock_remove.return_value = True
            instance = MagicMock()
            instance.name = "signal_test_tool"
            post_delete.send(sender=RegisteredTool, instance=instance)
            mock_remove.assert_called_with("signal_test_tool")

    def test_connect_signals_idempotent(self):
        """多次注册 signal 不应造成 handler 被调用多次（dispatch_uid 去重）。"""
        from django.db.models.signals import post_delete
        from apps.capabilities.models import RegisteredTool

        _connect_registered_tool_signals()
        _connect_registered_tool_signals()
        _connect_registered_tool_signals()

        with patch(
            "apps.capabilities.services.tool_embedding.ToolEmbeddingService.remove_tool",
        ) as mock_remove:
            mock_remove.return_value = True
            instance = MagicMock()
            instance.name = "idempotent_test_tool"
            post_delete.send(sender=RegisteredTool, instance=instance)
            self.assertEqual(
                mock_remove.call_count, 1,
                "dispatch_uid 应保证 handler 仅触发一次",
            )


# ─── build_content_text 基础行为验证 ─────────────────────────────────────────

class TestBuildContentText(TestCase):
    def test_basic_concat(self):
        text = build_content_text("my_tool", "My Tool", "does something")
        self.assertIn("my_tool", text)
        self.assertIn("My Tool", text)
        self.assertIn("does something", text)

    def test_tags_included(self):
        text = build_content_text("t", "T", "desc", tags=["a", "b"])
        self.assertIn("tags: a, b", text)

    def test_empty_optional_fields_excluded(self):
        text = build_content_text("t", "T", "desc")
        self.assertNotIn("category:", text)
        self.assertNotIn("provider:", text)

    def test_documentation_truncated(self):
        from apps.capabilities.constants import MAX_DOC_FOR_EMBEDDING
        long_doc = "x" * (MAX_DOC_FOR_EMBEDDING + 100)
        text = build_content_text("t", "T", "desc", documentation=long_doc)
        doc_part = text.split(" | ")[-1]
        self.assertLessEqual(len(doc_part), MAX_DOC_FOR_EMBEDDING)

    def test_separator_is_pipe(self):
        text = build_content_text("t", "T", "desc", category="platform")
        self.assertIn(" | ", text)


# ─── EB-020: update_or_create 必须指定 .using(DB) ────────────────────────────

class TestToolEmbeddingUsesCorrectDatabase(TestCase):
    """
    EB-020 回归测试：ToolEmbedding 写入操作必须显式指定 .using('postgresql')。

    问题背景：若不指定 .using(DB)，Django router 配置有误时会路由到 MySQL，
    而 MySQL 不支持 pgvector，立即报错导致功能不可用。
    防御性测试：即使 router 配置正确，代码也必须显式指定数据库以防止配置漂移。
    """

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_index_tool_update_or_create_uses_postgresql(self, mock_te_cls, mock_unified_embed):
        """index_tool 的 update_or_create 必须通过 .using('postgresql') 调用。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        mock_qs = _make_mock_te_qs(existing_hash=None)
        mock_te_cls.objects.using.return_value = mock_qs

        ToolEmbeddingService.index_tool(**_make_tool_kwargs())

        # 验证 .using() 被调用且参数为 'postgresql'
        using_calls = mock_te_cls.objects.using.call_args_list
        used_dbs = [call.args[0] for call in using_calls]
        self.assertIn(
            "postgresql",
            used_dbs,
            "index_tool 必须对 ToolEmbedding 使用 .using('postgresql')，"
            "防止 router 配置有误时写入 MySQL（MySQL 不支持 pgvector）",
        )
        # 验证 update_or_create 确实被调用（写入动作存在）
        self.assertTrue(
            mock_qs.update_or_create.called,
            "index_tool 在内容变更时必须调用 update_or_create",
        )

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_index_tool_read_query_uses_postgresql(self, mock_te_cls, mock_unified_embed):
        """index_tool 的存量 hash 查询也必须通过 .using('postgresql')。"""
        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        mock_qs = _make_mock_te_qs(existing_hash=None)
        mock_te_cls.objects.using.return_value = mock_qs

        ToolEmbeddingService.index_tool(**_make_tool_kwargs())

        # 读写操作均需要 .using('postgresql')
        all_using_calls = mock_te_cls.objects.using.call_args_list
        self.assertGreaterEqual(
            len(all_using_calls), 2,
            "至少应有 2 次 .using() 调用（一次读查询 + 一次 update_or_create）",
        )
        for call in all_using_calls:
            self.assertEqual(
                call.args[0],
                "postgresql",
                f".using() 的每次调用都必须指定 'postgresql'，实际: {call.args[0]}",
            )

    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_remove_tool_uses_postgresql(self, mock_te_cls):
        """remove_tool 的 delete 操作必须通过 .using('postgresql')。"""
        mock_qs = MagicMock()
        mock_qs.filter.return_value.delete.return_value = (1, {})
        mock_te_cls.objects.using.return_value = mock_qs

        ToolEmbeddingService.remove_tool("test_tool")

        mock_te_cls.objects.using.assert_called_with("postgresql")

    @patch(_PATCH_UNIFIED_EMBED)
    @patch(_PATCH_TOOL_EMBEDDING_MODEL)
    def test_index_all_inner_calls_use_postgresql(self, mock_te_cls, mock_unified_embed):
        """index_all 遍历工具时内部 index_tool 调用必须使用 .using('postgresql')。"""
        from unittest.mock import patch as mock_patch

        mock_unified_embed.return_value = _make_mock_unified_embed_result()

        # 构造一个工具记录
        fake_tool = MagicMock()
        fake_tool.id = uuid.uuid4()
        fake_tool.name = "batch_tool"
        fake_tool.display_name = "Batch Tool"
        fake_tool.description = "batch test"
        fake_tool.tags = []
        fake_tool.category = "platform"
        fake_tool.provider_id = "test"
        fake_tool.documentation = ""

        mock_qs = _make_mock_te_qs(existing_hash=None)
        mock_te_cls.objects.using.return_value = mock_qs

        with mock_patch(_PATCH_REGISTERED_TOOL_MODEL) as mock_rt_cls:
            mock_rt_qs = MagicMock()
            mock_rt_qs.count.return_value = 1
            mock_rt_qs.iterator.return_value = iter([fake_tool])
            mock_rt_cls.objects.using.return_value.filter.return_value = mock_rt_qs

            ToolEmbeddingService.index_all()

        # RegisteredTool 查询也必须经过 postgresql
        mock_rt_cls.objects.using.assert_called_with("postgresql")
