"""Wave 4 SearchTool 单元测试（PRD 3.9.B Function Call 入口）。

覆盖维度：
    - 正常路径：调 search_service.search 正确传 SearchParams + user_id
    - 越权防御：跨 Organization 搜索被拒（PERMISSION_DENIED）
    - 必填校验：缺 user_id / 缺 thread_context organization_id / 空 q 被拒
    - C1 fail-close：thread_context 为空时不允许用 LLM 输入兜底
    - C2 invoke 链路：通过 LangChain BaseTool.invoke() 而非直 run，验证生产路径
    - B2 no_accessible_spaces：明确区分"无访问"vs"真零结果"
    - 降级处理：should_fallback() 决策走 fallback_search
    - ES 故障：search() raise → 自动 fallback 一次
    - 双路径全失败：返回 INTERNAL_ERROR（不 raise）
    - 结果截断：超过 SEARCH_TOOL_RESULTS_LIMIT 自动截断
    - 集成验证：get_capabilities_tools() 含 SearchTool

测试模式与 capabilities/tests/test_tool_embedding.py 一致：mock 所有外部依赖，
不依赖真实 DB / ES / Redis。
"""

from __future__ import annotations

import json
from contextlib import ExitStack
from unittest.mock import MagicMock, patch

from django.test import SimpleTestCase

from apps.capabilities.search_tool import (
    SEARCH_TOOL_RESULTS_LIMIT,
    SearchTool,
    SearchToolInput,
)


class _FakeFallbackDecision:
    def __init__(self, fallback: bool, reason: str | None = None) -> None:
        self.fallback = fallback
        self.reason = reason


class _FakeAccessibleSpaces:
    def __init__(self, has_access: bool = True) -> None:
        self._has = has_access

    def has_any_access(self) -> bool:
        return self._has


def _fake_search_response(*, results=None, degraded=False, degraded_reason=None) -> MagicMock:
    """构造一个最简 SearchResponse-like mock 对象（含 model_dump）。"""
    response = MagicMock()
    payload = {
        "results": results or [],
        "total": len(results or []),
        "facets": {"messages": 0, "resources": 0, "agents": 0, "spaces": 0, "memos": 0, "im": 0},
        "suggestions": [],
        "took_ms": 12,
        "search_mode": "fallback" if degraded else "normal",
        "degraded": degraded,
        "degraded_reason": degraded_reason,
        "partial_indices": [],
    }
    response.model_dump = MagicMock(return_value=payload)
    return response


def _patch_full_stack(
    *,
    ctx_organization: str | None = "wt-1",
    has_access: bool = True,
    fallback: bool = False,
    fallback_reason: str | None = None,
    search_response=None,
    fallback_response=None,
    search_side_effect=None,
    fallback_side_effect=None,
):
    """组合 patch helper：thread_context + acl + should_fallback + search + fallback。

    用 ExitStack 一次性管理多个 patch，调用方按需 enter/exit。
    """
    stack = ExitStack()
    mocks = {}
    mocks["ctx"] = stack.enter_context(
        patch(
            "apps.services.common.thread_context.get_current_organization_id",
            return_value=ctx_organization,
        ),
    )
    mocks["acl"] = stack.enter_context(
        patch(
            "apps.fts.services.acl_service.get_user_accessible_spaces",
            return_value=_FakeAccessibleSpaces(has_access=has_access),
        ),
    )
    mocks["should"] = stack.enter_context(
        patch("apps.fts.services.fallback_service.should_fallback"),
    )
    mocks["should"].return_value = _FakeFallbackDecision(fallback, reason=fallback_reason)
    mocks["search"] = stack.enter_context(
        patch("apps.fts.services.search_service.search"),
    )
    if search_side_effect is not None:
        mocks["search"].side_effect = search_side_effect
    else:
        mocks["search"].return_value = search_response or _fake_search_response()
    mocks["fallback"] = stack.enter_context(
        patch("apps.fts.services.fallback_service.fallback_search"),
    )
    if fallback_side_effect is not None:
        mocks["fallback"].side_effect = fallback_side_effect
    else:
        mocks["fallback"].return_value = fallback_response or _fake_search_response(
            degraded=True, degraded_reason=fallback_reason or "engine_disabled",
        )
    return stack, mocks


# ── 1. 正常路径 ────────────────────────────────────────────────────


class TestSearchToolHappyPath(SimpleTestCase):
    """should_fallback=False → search_service.search 正常返回。"""

    def test_passes_search_params_correctly(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(
            ctx_organization="wt-1",
            search_response=_fake_search_response(
                results=[{"id": "r-1", "type": "message", "title": "hi", "snippet": "",
                         "highlight": {}, "score": 1.0, "rrf_score": 0.5, "metadata": {}}],
            ),
        )
        with stack:
            raw = tool.run(
                q="python",
                organization_id="wt-1",
                user_id="u-1",
                types="messages,resources",
                space_id="sp-1",
                agent_id="ag-1",
                creator_type="agent",
                role="assistant",
                limit=5,
                offset=10,
            )

            mocks["search"].assert_called_once()
            call_args = mocks["search"].call_args
            params = call_args[0][0]
            assert params.q == "python"
            assert params.organization_id == "wt-1"
            assert params.types == "messages,resources"
            assert params.space_id == "sp-1"
            assert params.agent_id == "ag-1"
            assert params.creator_type == "agent"
            assert params.role == "assistant"
            assert params.limit == 5
            assert params.offset == 10
            assert call_args.kwargs.get("user_id") == "u-1"

            data = json.loads(raw)
            assert data["total"] == 1
            assert data["degraded"] is False

    def test_returns_json_string_not_object(self):
        tool = SearchTool()
        stack, _ = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            result = tool.run(q="hi", organization_id="wt-1", user_id="u-1")
            assert isinstance(result, str)
            json.loads(result)


# ── 2. 越权防御 ────────────────────────────────────────────────────


class TestSearchToolCrossOrganizationGuard(SimpleTestCase):
    """Agent 不能跨 Organization 搜索（防御 LLM 越权）。"""

    def test_explicit_cross_organization_rejected(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            raw = tool.run(
                q="leak",
                organization_id="wt-evil",  # 显式越权
                user_id="u-1",
            )
            mocks["should"].assert_not_called()  # 不应进入搜索
            mocks["search"].assert_not_called()
            data = json.loads(raw)
            assert data["success"] is False
            assert data["error_code"] == "PERMISSION_DENIED"
            assert "Organization" in data["error"]

    def test_default_organization_from_thread_context(self):
        """不传 organization_id → 用 thread_context 注入。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-ctx")
        with stack:
            raw = tool.run(q="hi", user_id="u-1")
            params = mocks["search"].call_args[0][0]
            assert params.organization_id == "wt-ctx"
            json.loads(raw)


# ── 3. 必填校验 + C1 fail-close ────────────────────────────────────


class TestSearchToolValidation(SimpleTestCase):
    def test_missing_user_id(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id=None)
            mocks["should"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "AUTH_MISSING"

    def test_thread_context_empty_fails_closed(self):
        """C1 修复：thread_context 为空时**不允许**用 LLM 输入兜底，必须 fail-close。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="")  # 空 ctx
        with stack:
            # LLM 试图用自己传入的 organization_id 充作身份
            raw = tool.run(q="hi", organization_id="wt-attempt", user_id="u-1")
            mocks["should"].assert_not_called()  # 不应进入搜索
            mocks["search"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "AUTH_MISSING"
            assert "thread_context" in data["error"] or "organization_id" in data["error"]

    def test_thread_context_none_fails_closed(self):
        """C1 + 用户视角 H1：thread_context 返回 None 也 fail-close（不退化为空字符串）。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization=None)
        with stack:
            raw = tool.run(q="hi", organization_id="wt-attempt", user_id="u-1")
            mocks["should"].assert_not_called()
            mocks["search"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "AUTH_MISSING"

    def test_empty_q(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            raw = tool.run(q="   ", organization_id="wt-1", user_id="u-1")
            mocks["should"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "VALIDATION_ERROR"


# ── 4. 降级路径 ────────────────────────────────────────────────────


class TestSearchToolFallbackDecision(SimpleTestCase):
    def test_should_fallback_engine_disabled(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(
            ctx_organization="wt-1",
            fallback=True,
            fallback_reason="engine_disabled",
        )
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id="u-1")

            mocks["fallback"].assert_called_once()
            mocks["search"].assert_not_called()
            kw = mocks["fallback"].call_args.kwargs
            assert kw["reason"] == "engine_disabled"
            assert kw["user_id"] == "u-1"
            data = json.loads(raw)
            assert data["degraded"] is True
            assert data["degraded_reason"] == "engine_disabled"

    def test_search_raises_falls_back_once(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(
            ctx_organization="wt-1",
            search_side_effect=RuntimeError("ES connection lost"),
            fallback_response=_fake_search_response(
                degraded=True, degraded_reason="opensearch_unavailable",
            ),
        )
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id="u-1")

            mocks["search"].assert_called_once()
            mocks["fallback"].assert_called_once()
            kw = mocks["fallback"].call_args.kwargs
            assert kw["reason"] == "opensearch_unavailable"
            data = json.loads(raw)
            assert data["degraded"] is True

    def test_both_paths_fail_returns_internal_error(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(
            ctx_organization="wt-1",
            search_side_effect=RuntimeError("ES dead"),
            fallback_side_effect=RuntimeError("PG dead too"),
        )
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id="u-1")
            data = json.loads(raw)
            assert data["success"] is False
            assert data["error_code"] == "INTERNAL_ERROR"


# ── 5. 结果截断 ────────────────────────────────────────────────────


class TestSearchToolResultsLimit(SimpleTestCase):
    """避免一次搜索吃掉 LLM context window。"""

    def test_truncate_to_limit(self):
        tool = SearchTool()
        many_results = [
            {"id": f"r-{i}", "type": "message", "title": f"t{i}", "snippet": "",
             "highlight": {}, "score": 1.0, "rrf_score": 0.5, "metadata": {}}
            for i in range(20)
        ]
        stack, _ = _patch_full_stack(
            ctx_organization="wt-1",
            search_response=_fake_search_response(results=many_results),
        )
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id="u-1")
            data = json.loads(raw)
            assert len(data["results"]) == SEARCH_TOOL_RESULTS_LIMIT


# ── 6. B2: no_accessible_spaces 区分 ───────────────────────────────


class TestSearchToolNoAccessibleSpaces(SimpleTestCase):
    """Wave 4 Review B2：用户/Agent 在该 Organization 下没任何可访问 Space 时，
    应返回明确的 notice 字段，避免 LLM 把"权限错配"误读为"用户没数据"。
    """

    def test_no_access_returns_notice_field(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1", has_access=False)
        with stack:
            raw = tool.run(q="leak", organization_id="wt-1", user_id="u-1")
            mocks["should"].assert_not_called()  # 不应进入搜索
            mocks["search"].assert_not_called()
            mocks["fallback"].assert_not_called()
            data = json.loads(raw)
            assert data["results"] == []
            assert data["notice"] == "no_accessible_spaces"
            assert "Agent" in data["notice_message"]
            # facets 全 0 但 6 类齐全（前端 / LLM 不缺 key）
            assert all(t in data["facets"] for t in ["messages", "resources", "agents", "spaces", "memos", "im"])

    def test_no_access_respects_types_filter(self):
        """若 types 限定，notice 响应的 facets 只含限定类型。"""
        tool = SearchTool()
        stack, _ = _patch_full_stack(ctx_organization="wt-1", has_access=False)
        with stack:
            raw = tool.run(
                q="leak", organization_id="wt-1", user_id="u-1",
                types="messages,resources",
            )
            data = json.loads(raw)
            assert set(data["facets"].keys()) == {"messages", "resources"}


# ── 7. C2: invoke 链路（生产路径）──────────────────────────────────


class TestSearchToolInvokeLink(SimpleTestCase):
    """Wave 4 Review C2：通过 LangChain BaseTool.invoke() 验证生产真实调用路径。

    真实链路：LLM → tool.invoke(args) → _run_entry_permission_checks
        → super().run() → _run → run()
    """

    def test_invoke_normal_path(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            # tool.invoke 是 LangChain 标准调用入口
            raw = tool.invoke({
                "q": "python",
                "user_id": "u-1",
                "organization_id": "wt-1",
            })
            assert isinstance(raw, str)
            mocks["search"].assert_called_once()
            data = json.loads(raw)
            assert data["degraded"] is False

    def test_invoke_cross_organization_rejected(self):
        """invoke 链路下越权也应被拒（与 run() 路径一致）。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            raw = tool.invoke({
                "q": "leak",
                "user_id": "u-1",
                "organization_id": "wt-evil",
            })
            mocks["search"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "PERMISSION_DENIED"

    def test_invoke_thread_context_empty_fails_closed(self):
        """invoke 链路下 thread_context 缺失也 fail-close。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="")
        with stack:
            raw = tool.invoke({
                "q": "hi",
                "user_id": "u-1",
                "organization_id": "wt-attempt",
            })
            mocks["search"].assert_not_called()
            data = json.loads(raw)
            assert data["error_code"] == "AUTH_MISSING"


# ── 8. 集成：注册到 ToolHub provider ───────────────────────────────


class TestSearchToolRegistration(SimpleTestCase):
    def test_in_get_capabilities_tools_list(self):
        from apps.capabilities.tools import get_capabilities_tools

        tools = get_capabilities_tools()
        names = [t.name for t in tools]
        assert "tabtin_search" in names
        assert "discover_tools" in names

    def test_search_tool_metadata(self):
        tool = SearchTool()
        assert tool.name == "tabtin_search"
        assert tool.execution_mode == "server"
        assert tool.risk_level == "safe"
        assert tool.cacheable is False
        assert "搜索" in tool.description
        # B1 修复：description 必须含 4 段关键提示
        assert "不能跨 Organization" in tool.description
        assert "<em>" in tool.description  # 提示 LLM 处理高亮标签
        assert "degraded" in tool.description
        assert "offset" in tool.description  # 翻页提示
        assert tool.args_schema is SearchToolInput

    def test_input_schema_includes_injected_state(self):
        """user_id / organization_id 必须带 InjectedState marker。"""
        from apps.services.common.state.injected_state import InjectedState

        injected_keys = set()
        for field_name, field_info in SearchToolInput.model_fields.items():
            for meta in (field_info.metadata or []):
                if isinstance(meta, InjectedState):
                    injected_keys.add(field_name)

        assert "user_id" in injected_keys
        assert "organization_id" in injected_keys

    def test_tool_call_schema_hides_injected_state(self):
        """InjectedState 字段不能暴露给 LLM 工具入参 schema。"""
        props = SearchTool().tool_call_schema.model_json_schema().get("properties", {})

        assert "user_id" not in props
        assert "organization_id" not in props
        assert "q" in props

    def test_input_schema_enum_strict(self):
        """H1 技术修复：creator_type / role 必须是 Literal enum 而非 str。"""
        ct_field = SearchToolInput.model_fields["creator_type"]
        role_field = SearchToolInput.model_fields["role"]
        # Literal annotation 在 metadata 中不会显示，但 pydantic 校验时会拒绝非法值
        # → 验证 pydantic 真的拒绝非法 enum
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SearchToolInput(q="hi", creator_type="evil_value", organization_id="x")
        with self.assertRaises(ValidationError):
            SearchToolInput(q="hi", role="evil_value", organization_id="x")

    def test_q_max_length_enforced(self):
        """H1 技术修复：q 必须 max_length=512。"""
        from pydantic import ValidationError
        with self.assertRaises(ValidationError):
            SearchToolInput(q="x" * 513, organization_id="x")
        # 边界：512 字符通过
        SearchToolInput(q="x" * 512, organization_id="x")

    def test_mode_field_intentionally_omitted(self):
        """H1 技术修复：mode 字段意图缺省（防 Agent 主动让自己降级）。"""
        assert "mode" not in SearchToolInput.model_fields
        # 但 SearchToolInput 的 docstring 应说明这是有意为之
        assert "mode" in (SearchToolInput.__doc__ or "")


# ── 9. 参数过滤特殊场景 ────────────────────────────────────────────


class TestSearchToolEdgeCases(SimpleTestCase):
    def test_creator_type_any_passed_through(self):
        """creator_type='any' 也是合法值。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            tool.run(q="hi", organization_id="wt-1", user_id="u-1", creator_type="any")
            params = mocks["search"].call_args[0][0]
            assert params.creator_type == "any"

    def test_phrase_query_passes_through(self):
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            tool.run(q='"Cannot read property"', organization_id="wt-1", user_id="u-1")
            params = mocks["search"].call_args[0][0]
            assert params.q == '"Cannot read property"'

    def test_invalid_creator_type_raises_validation_error(self):
        """非法 creator_type 应被 SearchParams pydantic 拒绝 → 工具返回 VALIDATION_ERROR。"""
        tool = SearchTool()
        stack, mocks = _patch_full_stack(ctx_organization="wt-1")
        with stack:
            raw = tool.run(q="hi", organization_id="wt-1", user_id="u-1", creator_type="evil_type")
            mocks["should"].assert_not_called()
            data = json.loads(raw)
            assert data["success"] is False
            assert data["error_code"] == "VALIDATION_ERROR"
