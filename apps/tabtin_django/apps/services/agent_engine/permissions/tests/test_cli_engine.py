"""``CliPermissionEngine`` + ``merge_decisions`` 单元测试（A3 启动包）。

覆盖 PRD-v3 §5.1 第 3 项 5 层评估顺序、合并算子单调性、
AI 分类器 fail-close、A2 audit 兼容性、singleton 化等关键路径。

启动包验收要求（不可让步）：
  - happy: 每个 5 层都有覆盖
  - error: 合并算子尝试放宽必须 fail
  - error: AI 分类器抛异常时 fail-close（保持 spec 原 risk_level）
  - edge:  A2 未就绪时 import 失败兜底
  - edge:  strict binary 不在 strict_allowlist → 直接 deny
  - edge:  matched_rule_pattern 为 None + safe → AI 分类器被调用
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from apps.services.agent_engine.cli.parser import CliInvocationParser
from apps.services.agent_engine.cli.spec import (
    RISK_REVIEW,
    RISK_SAFE,
    RISK_STRICT,
    CliInvocationSpec,
)
from apps.services.agent_engine.permissions.cli_engine import (
    CliPermissionEngine,
    Decision,
    get_default_engine,
    get_default_parser,
    merge_decisions,
    reset_default_singletons_for_testing,
)


# ── Fixtures ──────────────────────────────────────────────────────


@pytest.fixture
def parser() -> CliInvocationParser:
    return CliInvocationParser()


@pytest.fixture
def engine() -> CliPermissionEngine:
    """默认 engine：strict_allowlist 为空（任何 strict 一律 deny），AI 分类器开启。

    注意：
    - ``ai_classifier_enabled=True`` 不等于 AI 真的会被调用——
      AI 分类器自身还有 ``AGENT_ENGINE_AI_CLASSIFIER_ENABLED`` Django settings 开关，
      默认 False；测试用 ``patch`` 控制开关。
    - ``ai_uplift_yaml_safe`` 默认 False：仅当 YAML 未命中（matched_rule_pattern 为空）
      的 safe spec 才进 AI。测试 YAML 命中场景的 AI uplift 需要 ``deep_engine`` fixture。
    """
    return CliPermissionEngine()


@pytest.fixture
def deep_engine() -> CliPermissionEngine:
    """防御深度模式 engine：所有 safe spec 都进 AI 加严（含 YAML 显式命中 safe）。

    用于测试"AI 加严 YAML 命中 safe"等防御深度场景。
    """
    return CliPermissionEngine(ai_uplift_yaml_safe=True)


@pytest.fixture(autouse=True)
def _reset_singletons():
    """每个测试前后重置 module-level singleton，避免 fixture 污染。"""
    reset_default_singletons_for_testing()
    yield
    reset_default_singletons_for_testing()


# ── Layer 1: 硬底线（strict + 不在 allowlist → deny）────────────


class TestLayer1Hardline:
    """Layer 1：硬底线 — strict spec 默认拒绝，allowlist 命中降级 review。"""

    def test_unknown_binary_strict_deny(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """未知 binary（如 ``foo bar baz``）→ A1 parser 标 strict → 硬底线 deny。"""
        spec = parser.parse("foo bar baz")
        assert spec.risk_level == RISK_STRICT
        assert spec.binary == "foo"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "deny"
        assert d.source == "hardline"
        assert "strict_allowlist" in d.reason

    def test_create_in_prod_strict_deny(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """``*.create_in_prod`` → A1 parser YAML 命中 strict → 硬底线 deny。

        即使 binary=tabtin（KNOWN_BINARY），strict_allowlist 默认为空集，
        ``"tabtin" not in frozenset()`` 为 True → deny。
        """
        spec = parser.parse("tabtin table create_in_prod --name=订单")
        assert spec.risk_level == RISK_STRICT
        assert spec.binary == "tabtin"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "deny"
        assert d.source == "hardline"

    def test_strict_in_allowlist_downgrades_to_review(self, parser: CliInvocationParser):
        """strict spec 命中 allowlist → 降级 review（仍需 HITL，不直接 allow，fail-close 语义）。"""
        spec = parser.parse("foo bar baz")
        custom_engine = CliPermissionEngine(strict_allowlist=frozenset({"foo"}))

        d = custom_engine.evaluate_cli_spec(spec)
        assert d.action == "review"
        assert d.source == "allowlist_downgrade"
        assert "strict_allowlist" in d.reason


# ── Layer 2 & 3: spec 静态解析 + YAML 已匹配 ────────────────────


class TestLayer2Static:
    """Layer 2/3：spec.risk_level → 静态 Decision；YAML 由 A1 parser 已完成。"""

    def test_records_delete_review_static(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """``records.delete`` 命中 ``*.delete`` 通配 review → 静态 review，source=static。"""
        spec = parser.parse("tabtin records delete --table=tbl_demo --text=hello")
        assert spec.risk_level == RISK_REVIEW
        assert spec.matched_rule_pattern == "*.delete"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "review"
        assert d.source == "static"
        assert d.matched_rule_pattern == "*.delete"

    def test_records_list_safe_static(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """``records.list`` 命中 ``*.list`` 通配 → safe → allow。

        默认 AI 分类器 settings 关闭，layer 4 不会真正调 AI，直接走 layer 5 静态返回 allow。
        """
        spec = parser.parse("tabtin records list --table=tbl_demo")
        assert spec.risk_level == RISK_SAFE
        assert spec.matched_rule_pattern == "*.list"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "allow"
        assert d.source == "static"
        assert d.matched_rule_pattern == "*.list"

    def test_tabtin_table_query_safe_static(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """``tabtin table query`` → SSoT 生成表→ safe。"""
        spec = parser.parse('tabtin table query --name="订单表"')
        assert spec.risk_level == RISK_SAFE
        assert spec.matched_rule_pattern == "tabtin-commands:table query"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "allow"
        assert d.source == "static"

    def test_wildcard_delete_review(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """已登记命令 SSoT 命中→ review（值与原 ``*.delete`` 规则一致）。"""
        spec = parser.parse("tabtin table delete --table-id=tbl_x")
        assert spec.risk_level == RISK_REVIEW
        assert spec.matched_rule_pattern == "tabtin-commands:table delete"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "review"
        assert d.source == "static"


# ── Layer 4: AI 分类器尝试加严 safe → review ──────────────────────


class TestLayer4AIUplift:
    """Layer 4：AI 分类器仅对 safe 加严；绝不放宽。

    关键设计（PRD §5.1 第 3 项收紧 + 防御深度可配置）：
    - 默认 engine（``ai_uplift_yaml_safe=False``）：仅当 YAML 未命中（matched_rule_pattern 为空）
      的 safe spec 才进 AI；YAML 命中 safe 直接信任，不调 LLM
    - 防御深度 engine（``ai_uplift_yaml_safe=True``）：所有 safe spec 都过 AI
    """

    # ── 默认模式（YAML 命中 safe 不调 AI）────────────────────────

    def test_yaml_hit_safe_skips_ai_by_default(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """**PRD §5.1 第 3 项收紧**：规则命中的 safe spec 默认不调 AI（即使 AI 开启）。

         起 tabtin 已登记命令来源是 SSoT 生成表（pattern 非空同样视为
        "已有权威来源"，跳过 AI 加严——语义与 YAML 命中一致）。
        """
        spec = parser.parse('tabtin table query --name="订单表"')
        assert spec.risk_level == RISK_SAFE
        assert spec.matched_rule_pattern == "tabtin-commands:table query"  # SSoT 命中

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            d = engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "allow"
        assert d.source == "static"
        # YAML 命中 → AI 不应被调用
        mock_classify.assert_not_called()

    def test_yaml_miss_safe_calls_ai_by_default(self, engine: CliPermissionEngine):
        """**默认模式**：YAML 未命中的 safe spec（matched_rule_pattern == ""）进 AI 加严。

        构造 ``matched_rule_pattern=""`` 的 safe spec（不通过 parser；模拟未来 marketplace
        App 自定义 cliGrammar 把 spec 落到 safe 但无显式规则的边界场景）。
        """
        synthetic_spec = CliInvocationSpec(
            binary="tabtin",
            domain="custom",
            verb="op",
            risk_level=RISK_SAFE,
            matched_rule_pattern="",  # ← 未命中
            matched_rule_reason="",
        )

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            return_value=MagicMock(should_allow=False, reason="suspicious", confidence="medium"),
        ) as mock_classify:
            d = engine.evaluate_cli_spec(synthetic_spec, state={"user_id": "u1"})

        assert d.action == "review"
        assert d.source == "ai"
        assert "AI uplift" in d.reason
        mock_classify.assert_called_once()

    # ── 防御深度模式（所有 safe 都进 AI）──────────────────────

    def test_deep_engine_yaml_safe_calls_ai(
        self, parser: CliInvocationParser, deep_engine: CliPermissionEngine
    ):
        """**防御深度模式**：规则命中（SSoT/YAML）的 safe 也进 AI 加严。"""
        spec = parser.parse('tabtin table query --name="订单表"')
        assert spec.matched_rule_pattern == "tabtin-commands:table query"

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            return_value=MagicMock(should_allow=False, reason="paranoid", confidence="medium"),
        ):
            d = deep_engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "review"
        assert d.source == "ai"
        assert "uplifted from allow" in d.reason
        # 保留 static 的 pattern（ 起为 SSoT 来源标注）
        assert d.matched_rule_pattern == "tabtin-commands:table query"

    def test_deep_engine_ai_says_safe_keeps_allow(
        self, parser: CliInvocationParser, deep_engine: CliPermissionEngine
    ):
        """防御深度模式 + AI should_allow=True → 维持 spec 原 safe → allow。"""
        spec = parser.parse('tabtin table query --name="订单表"')

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            return_value=MagicMock(should_allow=True, reason="benign", confidence="high"),
        ):
            d = deep_engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "allow"
        assert d.source == "static"

    # ── AI 关闭与 fail-close ────────────────────────────────────

    def test_ai_disabled_safe_remains_allow(
        self, parser: CliInvocationParser, deep_engine: CliPermissionEngine
    ):
        """AI 分类器 settings 关闭 → safe spec 维持 allow（即使 deep_engine 也跳过）。"""
        spec = parser.parse("tabtin records list")
        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=False,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            d = deep_engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "allow"
        assert d.source == "static"
        mock_classify.assert_not_called()

    def test_ai_classifier_exception_fail_close(
        self, parser: CliInvocationParser, deep_engine: CliPermissionEngine
    ):
        """**核心 fail-close**：AI 分类器抛异常 → 维持 spec 原 risk_level（safe → allow）。"""
        spec = parser.parse("tabtin records list")

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            side_effect=RuntimeError("LLM endpoint down"),
        ):
            d = deep_engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "allow"
        assert d.source == "static"

    def test_ai_not_called_for_review_spec(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """spec.risk_level == review 时 AI 分类器**不被调用**（layer 4 跳过）。"""
        spec = parser.parse("tabtin records delete --table=tbl_demo --text=hello")
        assert spec.risk_level == RISK_REVIEW

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            d = engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "review"
        assert d.source == "static"
        mock_classify.assert_not_called()

    def test_ai_classifier_disabled_per_engine(self, parser: CliInvocationParser):
        """``CliPermissionEngine(ai_classifier_enabled=False)`` → 完全跳过 layer 4。"""
        spec = parser.parse("tabtin records list")
        custom_engine = CliPermissionEngine(ai_classifier_enabled=False, ai_uplift_yaml_safe=True)

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            d = custom_engine.evaluate_cli_spec(spec, state={"user_id": "u1"})

        assert d.action == "allow"
        assert d.source == "static"
        mock_classify.assert_not_called()


# ── Layer 5: 默认策略兜底 ────────────────────────────────────────


class TestLayer5Default:
    """Layer 5：A1 parser 已 fail-safe 到 review，此处主要兜底逻辑漏洞。"""

    def test_unmatched_command_default_review(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """``tabtin`` 缺 verb → A1 fail-safe 到 review → engine 直通 review。"""
        spec = parser.parse("tabtin")
        assert spec.risk_level == RISK_REVIEW

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "review"
        assert d.source == "static"

    def test_empty_command_default_review(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """空命令 → A1 fail-safe 到 review → engine 直通 review。"""
        spec = parser.parse("")
        assert spec.risk_level == RISK_REVIEW
        assert spec.binary == "<unparsed>"

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "review"


# ── 合并算子单调性（A1-L11 / L4 决策核心）─────────────────────


class TestMergeDecisions:
    """``merge_decisions``：动态层只能加严，绝不放宽。"""

    def test_dynamic_uplift_allow_to_review(self):
        """动态层 review > 静态层 allow → 采纳 dynamic。"""
        static = Decision(action="allow", reason="safe", source="static", matched_rule_pattern="*.list")
        dynamic = Decision(action="review", reason="ai uplift", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "review"
        assert merged.source == "ai"
        assert "ai uplift" in merged.reason
        assert "uplifted from allow" in merged.reason
        assert merged.matched_rule_pattern == "*.list"

    def test_dynamic_uplift_allow_to_deny(self):
        """动态层 deny > 静态层 allow → 采纳 dynamic（虽然实际 AI 不会返回 deny）。"""
        static = Decision(action="allow", reason="safe", source="static")
        dynamic = Decision(action="deny", reason="hard block", source="override")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "deny"
        assert merged.source == "override"

    def test_dynamic_uplift_review_to_deny(self):
        """动态层 deny > 静态层 review → 采纳 dynamic。"""
        static = Decision(action="review", reason="static review", source="static")
        dynamic = Decision(action="deny", reason="ai escalate", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "deny"
        assert merged.source == "ai"

    def test_dynamic_cannot_downgrade_review_to_allow(self):
        """**核心单调性**：动态层 allow 试图放宽静态 review → 必须保持 review。

        这是启动包"error: 合并算子尝试放宽必须 fail"的核心断言。
        """
        static = Decision(action="review", reason="static review", source="static")
        dynamic = Decision(action="allow", reason="ai 试图放宽", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "review"
        assert merged.source == "static"
        assert merged.reason == "static review"

    def test_dynamic_cannot_downgrade_deny_to_review(self):
        """动态层 review 试图放宽静态 deny → 必须保持 deny。"""
        static = Decision(action="deny", reason="hardline", source="static")
        dynamic = Decision(action="review", reason="ai 试图放宽", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "deny"
        assert merged.source == "static"

    def test_dynamic_cannot_downgrade_deny_to_allow(self):
        """动态层 allow 试图放宽静态 deny → 必须保持 deny。"""
        static = Decision(action="deny", reason="hardline", source="static")
        dynamic = Decision(action="allow", reason="ai 试图放宽", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "deny"
        assert merged.source == "static"

    def test_same_level_keeps_static(self):
        """同档（如静态 review + 动态 review）→ 维持 static 信息（保留 source/reason）。"""
        static = Decision(action="review", reason="static reason", source="static", matched_rule_pattern="*.delete")
        dynamic = Decision(action="review", reason="ai also says review", source="ai")
        merged = merge_decisions(static, dynamic)
        assert merged.action == "review"
        assert merged.source == "static"
        assert merged.reason == "static reason"
        assert merged.matched_rule_pattern == "*.delete"

    def test_invalid_action_raises_value_error(self):
        """**防御性校验**（消化技术 Review P1-5）：非法 action 抛 ValueError，不静默 KeyError。"""
        bad_static = Decision.__new__(Decision)
        # 绕开 dataclass 校验直接设字段（模拟跨模块边界传入畸形 Decision）
        object.__setattr__(bad_static, "action", "invalid_action")
        object.__setattr__(bad_static, "reason", "")
        object.__setattr__(bad_static, "source", "static")
        object.__setattr__(bad_static, "matched_rule_pattern", "")
        good_dynamic = Decision(action="review", reason="", source="ai")

        with pytest.raises(ValueError, match="Decision.action must be one of"):
            merge_decisions(bad_static, good_dynamic)
        with pytest.raises(ValueError, match="Decision.action must be one of"):
            merge_decisions(good_dynamic, bad_static)


# ── 结构化日志（PRD §9.3）──────────────────────────────────────


class TestStructuredLogging:
    """每条决策出口一行 JSON 日志，含 thread_id / user_id / decision 字段。"""

    def test_logs_json_payload_with_state_context(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """直接 patch ``cli_engine.logger.info`` 验证 JSON 结构。

        不用 ``caplog`` 是因为 Django logging config 可能影响 propagation；
        直接拦截 logger.info 是契约层面的最直接验证。
        """
        spec = parser.parse("tabtin records delete --table=tbl_demo --text=hi")
        with patch("apps.services.agent_engine.permissions.cli_engine.logger") as mock_logger:
            engine.evaluate_cli_spec(
                spec,
                state={"user_id": "u-42", "thread_id": "t-7", "organization_id": "w-1"},
            )

        # info 应被调用至少一次，且参数含 JSON 串
        json_calls = [
            c for c in mock_logger.info.call_args_list
            if len(c.args) >= 2 and "cli.permission.decided" in str(c.args[1])
        ]
        assert json_calls, f"no structured log call, info_calls={mock_logger.info.call_args_list}"

        import json as _json
        json_str = json_calls[-1].args[1]
        payload = _json.loads(json_str)

        assert payload["evt"] == "cli.permission.decided"
        assert payload["binary"] == "tabtin"
        assert payload["domain"] == "records"
        assert payload["verb"] == "delete"
        assert payload["risk_level"] == "review"
        assert payload["matched_rule_pattern"] == "*.delete"
        assert payload["decision_action"] == "review"
        assert payload["decision_source"] == "static"
        assert payload["thread_id"] == "t-7"
        assert payload["user_id"] == "u-42"
        assert payload["organization_id"] == "w-1"

    def test_logs_handle_missing_state(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """state 不传时 thread_id/user_id 应为 null（不抛错）。"""
        spec = parser.parse("tabtin records list")
        with patch("apps.services.agent_engine.permissions.cli_engine.logger") as mock_logger:
            engine.evaluate_cli_spec(spec)  # 不传 state

        import json as _json
        json_calls = [
            c for c in mock_logger.info.call_args_list
            if len(c.args) >= 2 and "cli.permission.decided" in str(c.args[1])
        ]
        assert json_calls, "no structured log emitted"
        payload = _json.loads(json_calls[-1].args[1])
        assert payload["thread_id"] is None
        assert payload["user_id"] is None
        assert payload["organization_id"] is None


# ── A2 audit 兼容性 ──────────────────────────────────────────────


class TestAuditCompatibility:
    """A2 audit 模块未就绪 / 写库失败 都不能阻塞决策路径。"""

    def test_audit_emit_failure_does_not_block(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """A2 audit 抛任何异常 → 决策仍正常返回（评估层 swallow）。

        含 ``CliAuditWriteError``（A2 fail-close 信号）也必须被评估层 swallow——
        真正的执行 fail-close 由 A5 执行层独立处理（PRD §5.1 第 5 项）。
        """
        with patch(
            "apps.services.agent_engine.cli.audit.emit_cli_audit_event",
            side_effect=RuntimeError("PG down"),
        ) as fake_emit:
            spec = parser.parse("tabtin records list")
            d = engine.evaluate_cli_spec(spec)

        assert d.action == "allow"
        fake_emit.assert_called_once()

    def test_audit_emit_passes_a2_signature(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """每次决策应调一次 ``emit_cli_audit_event``，参数符合 A2 实际签名。

        A2 接口：``emit_cli_audit_event(spec, *, thread_id, agent_id, user_id,
        rule_decision, hitl_required, ...)``
        """
        with patch(
            "apps.services.agent_engine.cli.audit.emit_cli_audit_event",
        ) as fake_emit:
            spec = parser.parse("tabtin records delete --table=tbl_demo --text=hi")
            d = engine.evaluate_cli_spec(
                spec,
                state={"thread_id": "t-1", "agent_id": "a-1", "user_id": "u-1"},
            )

        assert d.action == "review"
        fake_emit.assert_called_once()
        # 第一个 positional 是 spec
        assert fake_emit.call_args.args[0] is spec
        kwargs = fake_emit.call_args.kwargs
        assert kwargs["thread_id"] == "t-1"
        assert kwargs["agent_id"] == "a-1"
        assert kwargs["user_id"] == "u-1"
        assert kwargs["rule_decision"] == "review"
        assert kwargs["hitl_required"] is True

    def test_audit_emit_with_missing_state_uses_none(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """state 不传时，audit 调用方仍尝试写（A2 内部 ``_coerce_uuid`` 接受 None）。"""
        with patch(
            "apps.services.agent_engine.cli.audit.emit_cli_audit_event",
        ) as fake_emit:
            spec = parser.parse("tabtin records list")
            engine.evaluate_cli_spec(spec)

        fake_emit.assert_called_once()
        kwargs = fake_emit.call_args.kwargs
        assert kwargs["thread_id"] is None
        assert kwargs["agent_id"] is None
        assert kwargs["user_id"] is None
        assert kwargs["rule_decision"] == "allow"
        assert kwargs["hitl_required"] is False

    def test_audit_module_import_error_no_crash(
        self, parser: CliInvocationParser, engine: CliPermissionEngine
    ):
        """``cli.audit`` 不可 import 时（A2 未就绪场景）决策仍返回。

        模拟方式：临时让 import 失败。
        """
        import builtins
        real_import = builtins.__import__

        def fake_import(name, *args, **kwargs):
            if name == "apps.services.agent_engine.cli.audit":
                raise ImportError("simulated A2 missing")
            return real_import(name, *args, **kwargs)

        with patch("builtins.__import__", side_effect=fake_import):
            spec = parser.parse("tabtin records list")
            d = engine.evaluate_cli_spec(spec)

        assert d.action == "allow"


# ── Singleton 化（A1-L7 升级）────────────────────────────────────


class TestSingletons:
    """``get_default_parser`` / ``get_default_engine`` 进程级单例。"""

    def test_default_parser_singleton(self):
        p1 = get_default_parser()
        p2 = get_default_parser()
        assert p1 is p2

    def test_default_engine_singleton(self):
        e1 = get_default_engine()
        e2 = get_default_engine()
        assert e1 is e2

    def test_reset_for_testing_creates_new_instance(self):
        p1 = get_default_parser()
        e1 = get_default_engine()
        reset_default_singletons_for_testing()
        p2 = get_default_parser()
        e2 = get_default_engine()
        assert p1 is not p2
        assert e1 is not e2


# ── PermissionRuleEngine 集成（并行模式）─────────────────────────


class TestPermissionRuleEngineIntegration:
    """``PermissionRuleEngine.evaluate_cli_spec`` 入口（并行模式不破坏旧 evaluate）。"""

    def test_evaluate_cli_spec_via_old_engine(self, parser: CliInvocationParser):
        """``PermissionRuleEngine().evaluate_cli_spec(spec)`` 走 cli_engine singleton。"""
        from apps.services.agent_engine.permissions.rule_engine import PermissionRuleEngine

        old_engine = PermissionRuleEngine()
        spec = parser.parse("tabtin records delete --table=tbl_demo --text=hi")
        d = old_engine.evaluate_cli_spec(spec)
        assert d.action == "review"
        assert d.source == "static"

    def test_old_evaluate_method_unaffected(self):
        """既有 ``evaluate(tool_name, args, state)`` 行为不变（并行模式约束）。

        简单 smoke：调一次 evaluate 不应抛错；返回 PermissionAction 而非 Decision。
        """
        from apps.services.agent_engine.permissions.rule_engine import (
            PermissionAction,
            PermissionRuleEngine,
        )

        old_engine = PermissionRuleEngine()
        action = old_engine.evaluate(
            tool_name="some_safe_tool",
            args={},
            state={},
        )
        assert isinstance(action, PermissionAction)

    def test_cli_engine_dependency_injection(self, parser: CliInvocationParser):
        """``PermissionRuleEngine(cli_engine=...)`` 注入自定义 engine（消化技术 P1-2）。"""
        from apps.services.agent_engine.permissions.rule_engine import PermissionRuleEngine

        # 构造自定义 engine：strict_allowlist 命中 "foo" → 降级 review
        custom = CliPermissionEngine(strict_allowlist=frozenset({"foo"}))
        old_engine = PermissionRuleEngine(cli_engine=custom)

        spec = parser.parse("foo bar baz")
        d = old_engine.evaluate_cli_spec(spec)
        # 自定义 engine 把 foo 加入 allowlist → 降级 review，而非 deny
        assert d.action == "review"
        assert d.source == "allowlist_downgrade"


# ── Settings 集成 + 配置入口 ─────────────────────────────────────


class TestSettingsIntegration:
    """``get_default_engine`` 从 Django settings 读配置（消化用户 P1-2 运维通道）。"""

    def test_settings_strict_allowlist(self, monkeypatch: pytest.MonkeyPatch):
        """``settings.AGENT_ENGINE_CLI_STRICT_ALLOWLIST`` 注入到 default engine。"""
        from django.conf import settings

        monkeypatch.setattr(settings, "AGENT_ENGINE_CLI_STRICT_ALLOWLIST", ("foo", "baz"), raising=False)
        reset_default_singletons_for_testing()
        try:
            engine = get_default_engine()
            assert "foo" in engine.strict_allowlist
            assert "baz" in engine.strict_allowlist
        finally:
            reset_default_singletons_for_testing()

    def test_settings_ai_uplift_yaml_safe(self, monkeypatch: pytest.MonkeyPatch):
        """``settings.AGENT_ENGINE_CLI_AI_UPLIFT_YAML_SAFE`` 注入到 default engine。"""
        from django.conf import settings

        monkeypatch.setattr(settings, "AGENT_ENGINE_CLI_AI_UPLIFT_YAML_SAFE", True, raising=False)
        reset_default_singletons_for_testing()
        try:
            engine = get_default_engine()
            assert engine.ai_uplift_yaml_safe is True
        finally:
            reset_default_singletons_for_testing()

    def test_configure_default_engine_overrides_singleton(self):
        """``configure_default_engine`` 显式替换 singleton（运维热更新场景）。"""
        from apps.services.agent_engine.permissions.cli_engine import configure_default_engine

        original = get_default_engine()
        custom = CliPermissionEngine(strict_allowlist=frozenset({"trusted_tool"}))
        configure_default_engine(custom)
        try:
            assert get_default_engine() is custom
            assert "trusted_tool" in get_default_engine().strict_allowlist
        finally:
            configure_default_engine(None)
            assert get_default_engine() is not custom
            assert get_default_engine() is not original  # 重置后是新 singleton


# ── 边界用例 ──────────────────────────────────────────────────────


class TestEdgeCases:
    """启动包"edge"项要求覆盖。"""

    def test_strict_binary_not_in_allowlist_directly_deny(self, parser: CliInvocationParser, engine: CliPermissionEngine):
        """**启动包必跑**：strict binary 不在 strict_allowlist → 直接 deny。"""
        spec = parser.parse("malicious-tool wipe everything")
        assert spec.risk_level == RISK_STRICT

        d = engine.evaluate_cli_spec(spec)
        assert d.action == "deny"

    def test_decision_dataclass_immutable(self):
        """``Decision`` 是 frozen dataclass，不可变。"""
        d = Decision(action="allow", reason="r", source="static")
        with pytest.raises(Exception):
            # frozen dataclass 设置字段会抛 FrozenInstanceError
            d.action = "deny"  # type: ignore[misc]

    def test_decision_helper_properties(self):
        """``Decision`` 的 ``is_allowed`` / ``requires_hitl`` / ``is_blocking`` 三态。"""
        allow_d = Decision(action="allow", reason="", source="static")
        review_d = Decision(action="review", reason="", source="static")
        deny_d = Decision(action="deny", reason="", source="hardline")

        assert allow_d.is_allowed and not allow_d.requires_hitl and not allow_d.is_blocking
        assert review_d.requires_hitl and not review_d.is_allowed and not review_d.is_blocking
        assert deny_d.is_blocking and not deny_d.is_allowed and not deny_d.requires_hitl

    def test_decision_to_permission_action(self):
        """``Decision.to_permission_action`` 把 CLI 决策映射回既有 PermissionAction。"""
        from apps.services.agent_engine.permissions.rule_engine import PermissionAction

        assert Decision(action="allow", reason="", source="static").to_permission_action() == PermissionAction.ALLOW
        assert Decision(action="review", reason="", source="static").to_permission_action() == PermissionAction.ASK
        assert Decision(action="deny", reason="", source="hardline").to_permission_action() == PermissionAction.DENY


# ── try_uplift_safe_to_review 直接单测（最小改动验证）─────────────


class TestTryUpliftDirectly:
    """直接调 ``try_uplift_safe_to_review`` 验证最小改动语义。"""

    def test_returns_none_for_review_spec(self, parser: CliInvocationParser):
        """spec.risk_level != safe 时立即返回 None（不调 AI）。"""
        from apps.services.agent_engine.permissions.ai_classifier import try_uplift_safe_to_review

        spec = parser.parse("tabtin records delete --table=tbl_demo --text=hi")
        assert spec.risk_level == RISK_REVIEW

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            result = try_uplift_safe_to_review(spec, state={"user_id": "u1"})

        assert result is None
        mock_classify.assert_not_called()

    def test_returns_none_when_classifier_disabled(self, parser: CliInvocationParser):
        """classifier_enabled=False → 立即返回 None。"""
        from apps.services.agent_engine.permissions.ai_classifier import try_uplift_safe_to_review

        spec = parser.parse("tabtin records list")
        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=False,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
        ) as mock_classify:
            result = try_uplift_safe_to_review(spec, state={})
        assert result is None
        mock_classify.assert_not_called()

    def test_returns_decision_for_unsafe_safe_spec(self, parser: CliInvocationParser):
        """spec safe + AI 觉得不安全 → 返回 Decision(action='review', source='ai')。"""
        from apps.services.agent_engine.permissions.ai_classifier import try_uplift_safe_to_review

        spec = parser.parse("tabtin records list")
        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            return_value=MagicMock(should_allow=False, reason="risky", confidence="medium"),
        ):
            result = try_uplift_safe_to_review(spec, state={"user_id": "u1"})

        assert result is not None
        assert result.action == "review"
        assert result.source == "ai"
        assert "AI uplift" in result.reason

    def test_never_returns_allow_or_deny(self, parser: CliInvocationParser):
        """无论 AI 返回什么，``try_uplift_safe_to_review`` 永不返回 action=allow/deny。

        这是单调合并的最后一道防线（即使调用方忘了用 ``merge_decisions``，也不会出错）。
        """
        from apps.services.agent_engine.permissions.ai_classifier import try_uplift_safe_to_review

        spec = parser.parse("tabtin records list")
        # AI 错误返回 should_allow=True → 函数返回 None（信任 spec）
        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            return_value=MagicMock(should_allow=True, reason="benign", confidence="high"),
        ):
            result = try_uplift_safe_to_review(spec, state={"user_id": "u1"})
        assert result is None  # 不返回 allow（保持 spec safe）

        # AI 抛异常 → fail-close 返回 None（保持 spec safe）
        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ), patch(
            "apps.services.agent_engine.permissions.ai_classifier.classify_risk",
            side_effect=RuntimeError("boom"),
        ):
            result = try_uplift_safe_to_review(spec, state={"user_id": "u1"})
        assert result is None

    def test_spec_to_dict_failure_fail_close(self):
        """spec.to_dict 抛异常 → fail-close 返回 None。"""
        from apps.services.agent_engine.permissions.ai_classifier import try_uplift_safe_to_review

        broken_spec = MagicMock()
        broken_spec.risk_level = RISK_SAFE
        broken_spec.binary = "tabtin"
        broken_spec.domain = "x"
        broken_spec.verb = "y"
        broken_spec.matched_rule_pattern = ""
        broken_spec.to_dict.side_effect = RuntimeError("serialization failure")

        with patch(
            "apps.services.agent_engine.permissions.ai_classifier._is_classifier_enabled",
            return_value=True,
        ):
            result = try_uplift_safe_to_review(broken_spec, state={})
        assert result is None


# ── _parse_classifier_response 鲁棒性（消化技术 P1-6 / 用户 P1-3）──


class TestParseClassifierResponseRobustness:
    """``_parse_classifier_response`` 对畸形 LLM 输出的兜底必须 fail-close 到 should_allow=False。"""

    @pytest.mark.parametrize(
        "raw_content",
        [
            "",                                     # 完全空
            "not even json",                        # 非 JSON 文本
            '{"safe": "yes"}',                      # safe 字段类型错（字符串）
            '{"safe": true}',                       # 缺 confidence
            '{"safe": true, "confidence": "ultra"}', # confidence 不在 (high/medium/low)
            "```json\n{broken json\n```",           # markdown fence + 损坏 JSON
            '{"safe": null, "confidence": null}',   # null 字段
        ],
    )
    def test_malformed_response_falls_back_to_safe_false(self, raw_content: str):
        """所有畸形输入应解析为 should_allow=False（不会反向放宽）。"""
        from apps.services.agent_engine.permissions.ai_classifier import _parse_classifier_response

        result = _parse_classifier_response(raw_content)
        # 关键：不能让 should_allow 在异常输入下意外为 True
        assert result.should_allow is False

    def test_well_formed_high_confidence_safe_returns_allow(self):
        """高置信 + safe=True 才放行（既有契约不变）。"""
        from apps.services.agent_engine.permissions.ai_classifier import _parse_classifier_response

        result = _parse_classifier_response('{"safe": true, "confidence": "high", "reason": "ok"}')
        assert result.should_allow is True
        assert result.confidence == "high"

    def test_low_confidence_safe_does_not_allow(self):
        """低置信即使 safe=True 也不放行。"""
        from apps.services.agent_engine.permissions.ai_classifier import _parse_classifier_response

        result = _parse_classifier_response('{"safe": true, "confidence": "low", "reason": "uncertain"}')
        assert result.should_allow is False
