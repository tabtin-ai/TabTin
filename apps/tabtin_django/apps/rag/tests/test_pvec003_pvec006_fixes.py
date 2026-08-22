"""
PVEC-003 / PVEC-006 回归测试

PVEC-003: organization_id__in 多值过滤导致 HNSW 索引失效 —
  当 accessible_organization_ids 只有一个值时，应使用精确过滤 `organization_id=`，
  而非 `organization_id__in=[...]`，避免 pgvector < 0.8 下 HNSW 完全不生效。

PVEC-006: HNSW pre-filtering（iterative scan）完全未启用 —
  `_hnsw_iterative_scan` 上下文管理器应在查询前注入
  `SET LOCAL hnsw.iterative_scan = 'relaxed_order'`。

运行方式:
    cd apps/tabtin_django
    source venv/bin/activate
    DJANGO_SETTINGS_MODULE=tabtin.settings python -m pytest apps/rag/tests/test_pvec003_pvec006_fixes.py -v
"""

import os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

import django
django.setup()

import uuid
import inspect
from unittest.mock import MagicMock, patch, call
import pytest


# ━━ PVEC-003: _apply_organization_filter 单值精确过滤 ━━━━━━━━━━━━━━━━━━━━


class TestApplyOrganizationFilter:
    """PVEC-003: _apply_organization_filter 函数行为验证。"""

    def test_single_value_uses_exact_filter(self):
        """单个 organization_id 时必须用精确过滤，而非 __in。"""
        from apps.rag.services.unified_search_service import _apply_organization_filter

        filters = {}
        wid = str(uuid.uuid4())
        _apply_organization_filter(filters, [wid])

        assert "organization_id" in filters, "单值时应写入 organization_id 精确过滤键"
        assert filters["organization_id"] == wid
        assert "organization_id__in" not in filters, "单值时不应出现 organization_id__in"

    def test_multiple_values_uses_in_filter(self):
        """多个 organization_id 时应保留 __in 过滤（多租户场景）。"""
        from apps.rag.services.unified_search_service import _apply_organization_filter

        filters = {}
        wids = [str(uuid.uuid4()), str(uuid.uuid4())]
        _apply_organization_filter(filters, wids)

        assert "organization_id__in" in filters, "多值时应写入 organization_id__in"
        assert filters["organization_id__in"] == wids
        assert "organization_id" not in filters, "多值时不应出现精确过滤键 organization_id"

    def test_single_value_does_not_degrade_to_in_query(self):
        """确认 _apply_organization_filter([x]) 不会退化为 __in=[x]（防止回归）。"""
        from apps.rag.services.unified_search_service import _apply_organization_filter

        filters = {}
        wid = str(uuid.uuid4())
        _apply_organization_filter(filters, [wid])

        # 关键回归断言：不能用 __in 包装单个值
        assert "organization_id__in" not in filters


# ━━ PVEC-003: 子检索器单值 organization 路径走精确过滤 ━━━━━━━━━━━━━━━━━━━━


class TestSearcherOrganizationFilterPath:
    """PVEC-003: 子检索器在单 accessible_organization_ids 场景下使用精确过滤。"""

    def _capture_filter_kwargs(self, searcher_fn, extra_patch_targets=None):
        """辅助：拦截 ORM filter() 调用，捕获传入的 kwargs。"""
        return []

    def test_search_tables_single_organization_uses_exact_filter(self):
        """_search_tables：accessible_organization_ids 单值时 ORM 过滤不含 organization_id__in。"""
        from apps.rag.services.unified_search_service import _search_tables

        wid = str(uuid.uuid4())
        captured_filters = {}

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])

        with patch("apps.rag.models.TableEmbedding.objects") as mock_mgr, \
             patch("apps.rag.services.unified_search_service._hnsw_iterative_scan") as mock_scan:
            mock_scan.return_value.__enter__ = MagicMock(return_value=None)
            mock_scan.return_value.__exit__ = MagicMock(return_value=False)
            mock_mgr.filter.return_value = mock_qs

            _search_tables(
                query_vector=[0.1] * 3,
                user_id=str(uuid.uuid4()),
                organization_id=None,
                accessible_organization_ids=[wid],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

            assert mock_mgr.filter.called, "filter 应被调用"
            call_kwargs = mock_mgr.filter.call_args[1]
            assert "organization_id__in" not in call_kwargs, (
                "单值 accessible_organization_ids 时不应出现 organization_id__in"
            )
            assert call_kwargs.get("organization_id") == wid, (
                "单值 accessible_organization_ids 时应使用精确过滤"
            )

    def test_search_records_single_organization_uses_exact_filter(self):
        """_search_records：accessible_organization_ids 单值时 ORM 过滤不含 organization_id__in。"""
        from apps.rag.services.unified_search_service import _search_records

        wid = str(uuid.uuid4())

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])

        with patch("apps.rag.models.RecordEmbedding.objects") as mock_mgr, \
             patch("apps.rag.services.unified_search_service._hnsw_iterative_scan") as mock_scan:
            mock_scan.return_value.__enter__ = MagicMock(return_value=None)
            mock_scan.return_value.__exit__ = MagicMock(return_value=False)
            mock_mgr.filter.return_value = mock_qs

            _search_records(
                query_vector=[0.1] * 3,
                user_id=str(uuid.uuid4()),
                organization_id=None,
                accessible_organization_ids=[wid],
                top_k=5,
                threshold=0.7,
                scope=None,
            )

            assert mock_mgr.filter.called
            call_kwargs = mock_mgr.filter.call_args[1]
            assert "organization_id__in" not in call_kwargs, (
                "单值时不应出现 organization_id__in"
            )
            assert call_kwargs.get("organization_id") == wid

    def test_search_tables_multi_organization_uses_in_filter(self):
        """_search_tables：accessible_organization_ids 多值时应保留 organization_id__in。"""
        from apps.rag.services.unified_search_service import _search_tables

        wids = [str(uuid.uuid4()), str(uuid.uuid4())]

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])

        with patch("apps.rag.models.TableEmbedding.objects") as mock_mgr, \
             patch("apps.rag.services.unified_search_service._hnsw_iterative_scan") as mock_scan:
            mock_scan.return_value.__enter__ = MagicMock(return_value=None)
            mock_scan.return_value.__exit__ = MagicMock(return_value=False)
            mock_mgr.filter.return_value = mock_qs

            _search_tables(
                query_vector=[0.1] * 3,
                user_id=str(uuid.uuid4()),
                organization_id=None,
                accessible_organization_ids=wids,
                top_k=5,
                threshold=0.7,
                scope=None,
            )

            call_kwargs = mock_mgr.filter.call_args[1]
            assert "organization_id__in" in call_kwargs, (
                "多值时应使用 organization_id__in"
            )


# ━━ PVEC-006: _hnsw_iterative_scan 上下文管理器行为验证 ━━━━━━━━━━━━━━━━━━━━


class TestHnswIterativeScan:
    """PVEC-006: _hnsw_iterative_scan 上下文管理器正确注入 SET LOCAL 语句。"""

    def test_executes_set_local_statement(self):
        """进入上下文时应执行 SET LOCAL hnsw.iterative_scan 语句。"""
        from apps.rag.services.unified_search_service import _hnsw_iterative_scan

        mock_cursor = MagicMock()
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)

        with patch("apps.rag.services.unified_search_service.connections") as mock_conns:
            mock_conns.__getitem__ = MagicMock(return_value=mock_conn)

            with _hnsw_iterative_scan("postgresql"):
                pass

        assert mock_cursor.execute.called, "应执行 SET LOCAL 语句"
        executed_sql = mock_cursor.execute.call_args[0][0]
        assert "hnsw.iterative_scan" in executed_sql, (
            f"SQL 中应包含 hnsw.iterative_scan，实际为: {executed_sql}"
        )
        assert "relaxed_order" in executed_sql, (
            f"SQL 中应包含 relaxed_order，实际为: {executed_sql}"
        )

    def test_disabled_when_setting_is_falsy(self):
        """RAG_HNSW_ITERATIVE_SCAN 设置为空字符串时，应跳过 SET LOCAL。"""
        from apps.rag.services.unified_search_service import _hnsw_iterative_scan

        mock_conn = MagicMock()

        with patch("apps.rag.services.unified_search_service.connections") as mock_conns, \
             patch("apps.rag.services.unified_search_service.settings") as mock_settings:
            mock_settings.RAG_HNSW_ITERATIVE_SCAN = ""
            mock_conns.__getitem__ = MagicMock(return_value=mock_conn)

            with _hnsw_iterative_scan("postgresql"):
                pass

        assert not mock_conn.cursor.called, (
            "RAG_HNSW_ITERATIVE_SCAN 为空时不应执行 cursor 操作"
        )

    def test_yields_even_on_db_error(self):
        """数据库执行 SET LOCAL 失败时，上下文管理器应静默降级，不抛出异常。"""
        from apps.rag.services.unified_search_service import _hnsw_iterative_scan

        mock_cursor = MagicMock()
        mock_cursor.execute.side_effect = Exception("PG error: unrecognized configuration")
        mock_conn = MagicMock()
        mock_conn.cursor.return_value.__enter__ = MagicMock(return_value=mock_cursor)
        mock_conn.cursor.return_value.__exit__ = MagicMock(return_value=False)

        with patch("apps.rag.services.unified_search_service.connections") as mock_conns:
            mock_conns.__getitem__ = MagicMock(return_value=mock_conn)

            reached_inside = False
            try:
                with _hnsw_iterative_scan("postgresql"):
                    reached_inside = True
            except Exception:
                pytest.fail("_hnsw_iterative_scan 不应在 DB 错误时向外抛出异常")

        assert reached_inside, "即使 SET LOCAL 失败，yield 后的代码也应正常执行"

    def test_uses_default_postgresql_alias(self):
        """默认 db_alias 应为 'postgresql'（RAG 数据路由到 PostgreSQL）。"""
        import inspect
        from apps.rag.services.unified_search_service import _hnsw_iterative_scan

        sig = inspect.signature(_hnsw_iterative_scan)
        default_alias = sig.parameters["db_alias"].default
        assert default_alias == "postgresql", (
            f"默认 db_alias 应为 postgresql，当前为 {default_alias}"
        )


# ━━ PVEC-006: 子检索器调用路径包含 iterative scan 注入 ━━━━━━━━━━━━━━━━━━━━


class TestSearcherCallsIterativeScan:
    """PVEC-006: 核心子检索器在查询时调用了 _hnsw_iterative_scan 上下文管理器。"""

    def _assert_searcher_calls_iterative_scan(self, searcher_fn, model_path, extra_kwargs=None):
        """通用断言：searcher_fn 在查询前调用了 _hnsw_iterative_scan。"""
        scan_entered = []

        import contextlib

        @contextlib.contextmanager
        def mock_scan(db_alias="postgresql"):
            scan_entered.append(db_alias)
            yield

        mock_qs = MagicMock()
        mock_qs.filter.return_value = mock_qs
        mock_qs.annotate.return_value = mock_qs
        mock_qs.exclude.return_value = mock_qs
        mock_qs.select_related.return_value = mock_qs
        mock_qs.order_by.return_value.__getitem__ = MagicMock(return_value=[])

        wid = str(uuid.uuid4())
        kwargs = dict(
            query_vector=[0.1] * 3,
            user_id=str(uuid.uuid4()),
            organization_id=wid,
            accessible_organization_ids=[wid],
            top_k=5,
            threshold=0.7,
            scope=None,
        )
        if extra_kwargs:
            kwargs.update(extra_kwargs)

        with patch(model_path) as mock_mgr, \
             patch(
                 "apps.rag.services.unified_search_service._hnsw_iterative_scan",
                 side_effect=mock_scan,
             ):
            mock_mgr.objects.filter.return_value = mock_qs
            mock_mgr.objects.exclude.return_value = mock_qs

            try:
                searcher_fn(**kwargs)
            except Exception:
                pass

        assert len(scan_entered) >= 1, (
            f"{searcher_fn.__name__} 应调用 _hnsw_iterative_scan，但未检测到调用"
        )

    def test_search_tables_calls_iterative_scan(self):
        from apps.rag.services.unified_search_service import _search_tables
        self._assert_searcher_calls_iterative_scan(
            _search_tables, "apps.rag.models.TableEmbedding"
        )

    def test_search_records_calls_iterative_scan(self):
        from apps.rag.services.unified_search_service import _search_records
        self._assert_searcher_calls_iterative_scan(
            _search_records, "apps.rag.models.RecordEmbedding"
        )

    def test_search_documents_calls_iterative_scan(self):
        from apps.rag.services.unified_search_service import _search_documents
        self._assert_searcher_calls_iterative_scan(
            _search_documents, "apps.rag.models.DocumentEmbedding"
        )

    @pytest.mark.skip(reason="TabCode semantic search retired")
    def test_search_code_calls_iterative_scan(self):
        from apps.rag.services.unified_search_service import _search_code
        self._assert_searcher_calls_iterative_scan(
            _search_code, "apps.rag.models.CodeChunkEmbedding"
        )
