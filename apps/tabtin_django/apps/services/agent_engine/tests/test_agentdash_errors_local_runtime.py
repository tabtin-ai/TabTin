"""H2-A 运维 Review P0 修复验证：agentdash_api 错误端点支持本地 Runtime trace。

背景：
  - 原实现：`get_trace_errors` / `get_error_stats` 只查 `event_type='error'`
  - 云端 TinAgent 走 `TraceRecorder.record_event(event_type='error', ...)`
    → 命中
  - 本地 Runtime 走 `relay_trace_writer._make_trace_event` → `event_type` 是
    stream 短名（`done` / `lifecycle` / `tool` 等）→ 不命中 → AdminDash 错误 Tab
    对本地 Runtime trace 完全空壳

修复：扩展 filter 接受"`error` 字段非空"的事件，覆盖本地 Runtime 错误。

本测试用 mock ORM 验证 query filter 的 Q 表达式构造正确（不依赖真实 DB
setup，避免 test database 的循环依赖问题；filter 的真实行为由 Django ORM
保证，本测试只验证"我们传给 ORM 的查询条件覆盖了本地 Runtime 形态"）。
"""
from __future__ import annotations

import os
import sys
from unittest.mock import MagicMock, patch

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "tabtin.settings")

if "test" not in sys.argv:
    sys.argv.append("test")

import django  # noqa: E402

django.setup()

import pytest  # noqa: E402
from django.db.models import Q  # noqa: E402


@pytest.fixture
def mock_event_qs():
    """mock TraceEvent.objects.filter 链 — 让我们能断言传入 ORM 的 Q 表达式。"""
    with patch(
        "apps.services.agent_engine.api.agentdash_api.TraceEvent"
    ) as mock_cls, patch(
        "apps.services.agent_engine.api.agentdash_api.ExecutionTrace"
    ) as mock_trace_cls:
        # 让 ExecutionTrace.objects.filter().first() 返回一个 trace，避免 404
        trace_instance = MagicMock()
        trace_instance.trace_id = "test-trace-id"
        mock_trace_cls.objects.filter.return_value.first.return_value = trace_instance

        # filter().filter() 链返回 mock queryset
        # 第一次 filter(trace=trace) 返回链头
        # 第二次 filter(Q...) 返回链头（保留供断言）
        first_filter = MagicMock()
        second_filter = MagicMock()
        first_filter.filter.return_value = second_filter
        # .select_related().order_by() → 返回 mock queryset
        select_related = MagicMock()
        select_related.order_by.return_value = []  # 测试只关心 filter 调用，无需真实数据
        second_filter.select_related.return_value = select_related
        mock_cls.objects.filter.return_value = first_filter

        yield {
            "trace_cls": mock_trace_cls,
            "event_cls": mock_cls,
            "first_filter": first_filter,
            "second_filter": second_filter,
        }


class TestGetTraceErrorsFilterCoversLocalRuntime:
    """get_trace_errors 必须用 Q(event_type='error') | Q(error 非空) 复合条件。

    关键修复（运维 Review P0）：之前只查 `event_type='error'`，本地 Runtime
    的 done(error=true) / lifecycle(phase=error) 永远不命中。修复后用
    Q 表达式同时覆盖两种来源。
    """

    def test_filter_uses_or_of_event_type_and_error_field(self, mock_event_qs):
        from apps.services.agent_engine.api.agentdash_api import get_trace_errors

        class MockRequest:
            pass

        get_trace_errors(MockRequest(), "test-trace-id")

        # 验证 TraceEvent.objects.filter(trace=trace) 后跟 .filter(Q(...)) 链
        assert mock_event_qs["first_filter"].filter.called, \
            "expected chained filter call after filter(trace=trace)"

        # 提取传给第二次 filter 的 Q 表达式
        q_arg = mock_event_qs["first_filter"].filter.call_args.args[0]
        assert isinstance(q_arg, Q), "expected a Q expression"

        # Q 是 OR 连接（'OR'）— event_type='error' OR error 非空
        assert q_arg.connector == "OR", \
            f"expected OR connector to cover both cloud + local sources, got {q_arg.connector}"

        # 子句应包含 event_type='error'（云端兼容）
        q_str = str(q_arg)
        assert "event_type" in q_str
        assert "error" in q_str
        # 子句应处理 error 字段非空（本地 Runtime 路径）
        # 具体子表达式可能是 Q(error__isnull=False) | ~Q(error="") 形态
        # 用 str 检测（避免遍历 Q.children 嵌套）
        assert "error__isnull" in q_str or "error__exact" in q_str, \
            f"expected Q condition on `error` field, got: {q_str}"


class TestGetErrorStatsFilterCoversLocalRuntime:
    """get_error_stats 同样用 Q 复合条件 + Coalesce category 含 error_class fallback。"""

    def test_filter_includes_local_runtime_error_path(self, mock_event_qs):
        from apps.services.agent_engine.api.agentdash_api import get_error_stats

        # mock 链需要扩展：annotate / values / annotate / order_by 链
        # mock_event_qs 已经只 mock 到 select_related/order_by；
        # get_error_stats 走另一条链（filter().filter().annotate().values()...）
        # 重新搭：filter(started_at__gte=since) → filter(Q...) → annotate → values → annotate → order_by
        with patch(
            "apps.services.agent_engine.api.agentdash_api.TraceEvent"
        ) as mock_cls, patch(
            "apps.services.agent_engine.api.agentdash_api.ExecutionTrace"
        ) as mock_trace_cls:
            # ExecutionTrace 总数 / 错误数（被 .count() 调用）
            mock_trace_cls.objects.filter.return_value.count.return_value = 0

            # event_cls.objects.filter(started_at).filter(Q).annotate(...).values(...).annotate(...).order_by()
            link = MagicMock()
            link.filter.return_value = link
            link.annotate.return_value = link
            link.values.return_value = link
            link.order_by.return_value = []  # 空结果
            mock_cls.objects.filter.return_value = link

            class MockRequest:
                GET = {"hours": "24"}

            get_error_stats(MockRequest())

            # filter 至少被调两次（第一次 started_at__gte，第二次 Q 表达式）
            assert mock_cls.objects.filter.called
            assert link.filter.called, \
                "expected chained filter(Q) for cloud+local OR coverage"

            q_arg = link.filter.call_args.args[0]
            assert isinstance(q_arg, Q)
            assert q_arg.connector == "OR", "expected OR for cloud+local"
            q_str = str(q_arg)
            assert "event_type" in q_str and "error" in q_str

    def test_category_coalesce_includes_error_class_fallback(self, mock_event_qs):
        """category 聚合应该把本地 Runtime 的 input.error_class 作为 fallback。"""
        from apps.services.agent_engine.api.agentdash_api import get_error_stats

        with patch(
            "apps.services.agent_engine.api.agentdash_api.TraceEvent"
        ) as mock_cls, patch(
            "apps.services.agent_engine.api.agentdash_api.ExecutionTrace"
        ) as mock_trace_cls, patch(
            "apps.services.agent_engine.api.agentdash_api.Coalesce"
        ) as mock_coalesce:
            mock_trace_cls.objects.filter.return_value.count.return_value = 0
            link = MagicMock()
            link.filter.return_value = link
            link.annotate.return_value = link
            link.values.return_value = link
            link.order_by.return_value = []
            mock_cls.objects.filter.return_value = link

            class MockRequest:
                GET = {"hours": "24"}

            get_error_stats(MockRequest())

            # Coalesce 至少被调一次，参数 ≥ 3 个（云端 category / 本地 error_class / 兜底）
            assert mock_coalesce.called
            args = mock_coalesce.call_args.args
            assert len(args) >= 3, \
                f"expected Coalesce(category, error_class, ...) — at least 3 args, got {len(args)}"
