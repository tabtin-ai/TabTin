"""
RC-004 / RC-005 / RC-017 回归测试

覆盖：
- RC-004: build_table_context 传入 v2 hit（含 similarity 而非 similarity_score）时不抛 KeyError
- RC-005: build_record_context 传入 v2 hit 时相似度正确读取，不静默返回 0
- RC-017: build_hybrid_context 调用时发出 DeprecationWarning
"""

import warnings

from django.test import SimpleTestCase, override_settings

from apps.rag.services.context_service import ContextService


def _table_v1(n=2):
    return [
        {
            "table_name": f"TableV1_{i}",
            "similarity_score": 0.9 - i * 0.1,
            "metadata": {"description": f"desc_{i}", "fields": ["f1", "f2"]},
        }
        for i in range(n)
    ]


def _table_v2(n=2):
    """v2 SearchHit 格式：similarity 代替 similarity_score"""
    return [
        {
            "table_name": f"TableV2_{i}",
            "similarity": 0.85 - i * 0.1,
            "metadata": {"description": f"desc_{i}", "fields": ["f1", "f2"]},
        }
        for i in range(n)
    ]


def _record_v1(n=2):
    return [
        {
            "table_name": f"RecV1_{i}",
            "similarity_score": 0.88 - i * 0.1,
            "content": f"content_{i}",
        }
        for i in range(n)
    ]


def _record_v2(n=2):
    """v2 SearchHit 格式：similarity 代替 similarity_score"""
    return [
        {
            "table_name": f"RecV2_{i}",
            "similarity": 0.88 - i * 0.1,
            "content": f"content_{i}",
        }
        for i in range(n)
    ]


# =====================================================================
# RC-004: build_table_context v2 字段兼容
# =====================================================================


class RC004TableContextV2CompatTest(SimpleTestCase):
    """RC-004: build_table_context 传入 v2 hit 不应抛 KeyError。"""

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v2_hit_no_key_error(self):
        """传入只含 similarity（v2）字段的 table hit，不 crash。"""
        svc = ContextService()
        result = svc.build_table_context(_table_v2())
        self.assertIsInstance(result, str)
        self.assertIn("TableV2_0", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v2_hit_similarity_rendered_correctly(self):
        """v2 hit 的相似度应正确渲染到输出，而非 KeyError 或 0.00。"""
        svc = ContextService()
        result = svc.build_table_context(_table_v2(n=1))
        # 0.85 应被渲染为 0.85
        self.assertIn("0.85", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v1_hit_still_works(self):
        """v1 hit 仍然正常工作，不受兼容修复影响。"""
        svc = ContextService()
        result = svc.build_table_context(_table_v1(n=2))
        self.assertIn("TableV1_0", result)
        self.assertIn("0.90", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_mixed_v1_v2_hits(self):
        """v1 和 v2 混合传入，全部正确渲染。"""
        svc = ContextService()
        mixed = _table_v1(n=1) + _table_v2(n=1)
        result = svc.build_table_context(mixed)
        self.assertIn("TableV1_0", result)
        self.assertIn("TableV2_0", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_empty_list_returns_empty_string(self):
        svc = ContextService()
        self.assertEqual(svc.build_table_context([]), "")


# =====================================================================
# RC-005: build_record_context v2 字段兼容
# =====================================================================


class RC005RecordContextV2CompatTest(SimpleTestCase):
    """RC-005: build_record_context 传入 v2 hit 相似度不应静默返回 0.00。"""

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v2_hit_no_zero_similarity(self):
        """v2 hit 相似度应正确读取，而非静默为 0.00。"""
        svc = ContextService()
        result = svc.build_record_context(_record_v2(n=1))
        # 0.88 应被正确渲染
        self.assertIn("0.88", result)
        # 相似度为 0 时才会出现 0.00（此处不应出现）
        self.assertNotIn("0.00", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v2_hit_content_rendered(self):
        """v2 hit 内容字段正常渲染。"""
        svc = ContextService()
        result = svc.build_record_context(_record_v2(n=1))
        self.assertIn("content_0", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_v1_hit_still_works(self):
        """v1 hit 仍然正常工作。"""
        svc = ContextService()
        result = svc.build_record_context(_record_v1(n=2))
        self.assertIn("RecV1_0", result)
        self.assertIn("0.88", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_mixed_v1_v2_hits(self):
        """混合 v1/v2，全部相似度均正确渲染。"""
        svc = ContextService()
        mixed = _record_v1(n=1) + _record_v2(n=1)
        result = svc.build_record_context(mixed)
        self.assertIn("RecV1_0", result)
        self.assertIn("RecV2_0", result)
        # 两条记录相似度都应渲染为非零
        self.assertNotIn("(相似度: 0.00)", result)

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_empty_list_returns_empty_string(self):
        svc = ContextService()
        self.assertEqual(svc.build_record_context([]), "")


# =====================================================================
# RC-017: build_hybrid_context 废弃警告
# =====================================================================


class RC017DeprecationWarningTest(SimpleTestCase):
    """RC-017: build_hybrid_context 调用时必须发出 DeprecationWarning。"""

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_deprecation_warning_raised(self):
        """调用 build_hybrid_context 应触发 DeprecationWarning。"""
        svc = ContextService()
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            svc.build_hybrid_context(_table_v1(), _record_v1(), "test query")
            deprecation_warnings = [
                x for x in w if issubclass(x.category, DeprecationWarning)
            ]
            self.assertTrue(
                len(deprecation_warnings) >= 1,
                "build_hybrid_context 应发出 DeprecationWarning，但未发出任何警告",
            )

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_deprecation_warning_message_mentions_unified(self):
        """废弃警告文本应提及推荐的替代方法 build_unified_context。"""
        svc = ContextService()
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            svc.build_hybrid_context([], [], "q")
            dep_msgs = [
                str(x.message)
                for x in w
                if issubclass(x.category, DeprecationWarning)
            ]
            self.assertTrue(
                any("build_unified_context" in msg for msg in dep_msgs),
                f"警告文本未提及 build_unified_context，实际警告：{dep_msgs}",
            )

    @override_settings(RAG_MAX_CONTEXT_TOKENS=10000)
    def test_deprecated_method_still_functional(self):
        """废弃后函数仍应返回有效字符串，不影响向后兼容。"""
        svc = ContextService()
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            result = svc.build_hybrid_context(
                _table_v1(n=1), _record_v1(n=1), "test"
            )
        self.assertIsInstance(result, str)
        self.assertIn("相关知识库内容", result)
