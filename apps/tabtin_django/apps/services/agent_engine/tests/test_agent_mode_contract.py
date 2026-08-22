"""
agent_mode_contract.py 单元测试 — 防止 TS / Python 双端漂移。

核心断言：
  1. JSON 文件能被加载且 schema 完整（5 个 mode、有 metadata / tool_policy）。
  2. JSON 中的 modes 列表与 `agent_mode.ALL_AGENT_MODES` 严格一致。
  3. 每个 mode 的 metadata.authorization_preset 与 `agent_mode.py` 中预设实例对齐。
  4. 在一组代表性工具上，`is_tool_allowed_for_mode`（基于 contract）与
     "工具自声明 available_modes"（Django 既有过滤逻辑）输出一致 — 这保证两套机制
     不会在 plan 模式下给模型看到不同的工具集。
  5. ToolModeFilterDecision 的 reason 字段对常见情形给出可解释的标签。

任何 TS 端修改 agent-mode-contract 而忘记更新 JSON 文件、或 Python 端调整
`agent_mode.py` 而 contract 没跟上，都会被本测试拦截。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from apps.services.agent_engine import agent_mode_contract
from apps.services.agent_engine.agent_mode import ALL_AGENT_MODES, get_agent_mode
from apps.services.agent_engine.agent_mode_contract import (
    AGENT_MODE_CONTRACT,
    EXPECTED_CONTRACT_VERSION,
    explain_tool_mode_decision,
    filter_tool_names_for_mode,
    get_metadata,
    get_mode_config,
    get_tool_policy,
    has_prompt_section,
    is_tool_allowed_for_mode,
)


# 与 packages/agent-runtime/tests/agent-modes.test.ts 中
# buildRepresentativeToolSet() 同构 — 保证两端在"同一组工具"上得到等价决策。
# isReadOnly 标记须与 packages/agent-runtime/src/tools/*.ts 中实际的工具元数据一致。
# Wave 4.5 (2026-05-10)：`think` 工具已下线，依赖 LLM 原生 thinking block；TS 端
# representative set 已同步移除，本列表保持双端一致。
REPRESENTATIVE_TOOLS: list[tuple[str, bool]] = [
    # Core
    ("run_terminal_command", False),
    # W4 R3 (2026-05-11): ask_user（替代 ask_choice，AskUserQuestion 协议）
    # + ask_form（多字段填表）。
    # （2026-07-08）：request_approval 已下架。
    ("ask_user", True),
    ("ask_form", True),
    ("todo_write", False),
    # Web
    ("web_search", True),
    # Code / local files
    ("read_file", True),
    ("write_file", False),
    ("edit_file", False),
    ("delete_file", False),
    # Document
    ("parse_document", True),
    # W3 (2026-05-10): `summarize_context` / `retrieve_tool_result` 已删（auto-condense
    # 让 LLM 主动 condense 的机制整套下线；大输出走 disk path +
    # read_file 引导）。`tool_search` 在 W2 已下线（2026-05-05）。三者均不应再出现
    # 在 representative tools / contract 期望中。
    # Presentation (实际 isReadOnly=true — present_to_user 显示而非修改业务数据)
    ("present_to_user", True),
    # Sub-agent
    ("agent", False),
    # MCP (W3: 收敛为 mcp_call_tool 单入口)
    ("mcp_call_tool", False),
    # Plan family (W1-C / W2-A 后接入)
    ("plan_create", False),
    ("plan_update_todos", False),
    # 未来某个不知名的写工具（默认应被拒绝）
    ("tabdoc_update_document", False),
]


# ---------------------------------------------------------------------------
# Schema / Version 校验
# ---------------------------------------------------------------------------


class TestContractSchema:
    def test_contract_loaded_with_expected_version(self):
        assert AGENT_MODE_CONTRACT["version"] == EXPECTED_CONTRACT_VERSION

    def test_modes_match_python_enum(self):
        # JSON 中的 modes 顺序必须与 ALL_AGENT_MODES 完全一致。
        assert AGENT_MODE_CONTRACT["modes"] == list(ALL_AGENT_MODES)

    def test_every_mode_has_complete_config(self):
        for mode in ALL_AGENT_MODES:
            cfg = get_mode_config(mode)
            assert "metadata" in cfg
            assert "tool_policy" in cfg
            assert "has_prompt_section" in cfg

            md = cfg["metadata"]
            assert md["name"] == mode
            assert md["label"]
            assert md["description"]
            # PR1 (2026-05-18)：扩展为三档；`full_auto` 仅 yolo 档使用。
            assert md["authorization_preset"] in {"cautious", "collaborative", "full_auto"}
            assert isinstance(md["skip_execution_section"], bool)

            policy = cfg["tool_policy"]
            assert policy["kind"] in {"all", "restricted"}
            assert isinstance(policy["allow_tool_names"], list)
            assert isinstance(policy["deny_tool_names"], list)
            assert isinstance(policy["default_allow_read_only"], bool)
            assert isinstance(policy["mcp_read_only_only"], bool)

    def test_contract_tool_policy_uses_canonical_tool_names_only(self):
        """
        contract 的 allow_tool_names 不应该含已退役工具名——这表示 contract 在
        显式放行不存在的工具，是 hygiene 问题。

        deny_tool_names 含已退役工具名是允许的——作为 regression guard 防止
        未来加同名工具被 default_read_only 兜底放行（W3 testing pattern）。
        """
        retired_names = {
            "bash",
            "web_fetch",
            "skills.search",
            "plan_exit",
            "ask_question",
            # Wave 4.5（2026-05-10）：think_tool 双端下线，让
            # LLM 走原生 thinking block；contract 不允许任何 mode 显式 allow 此名。
            "think_tool",
            # W3（2026-05-10）：summarize_context / retrieve_tool_result / tool_search
            # 全部下线（context-tools 模块整体删除）；contract allow 列表不允许引用，
            # 但 deny 列表保留作 regression guard（防 default_read_only 兜底放行）。
            "summarize_context",
            "retrieve_tool_result",
            "tool_search",
            # W4 R3（2026-05-11）：`ask_choice` 由 `ask_user` 兼容（多选问答 HITL）；
            # `ask_form` 是 TabTin HITL 扩展，依然在用。
            # `ask_question` 已在上方列出（更早退役名）。
            "ask_choice",
            # （2026-07-08）：`request_approval` 下架——审批意图由 ask_user /
            # 纯文本承接，高危动作安全兜底由系统拦截（judge 管线）承担。
            "request_approval",
        }
        for mode in ALL_AGENT_MODES:
            policy = get_tool_policy(mode)
            # 只检查 allow_tool_names — 显式放行已退役工具是 hygiene 问题。
            # deny_tool_names 含退役名属于"防御性 hygiene"，是合理的（W3 引入的模式）。
            allow_names = set(policy["allow_tool_names"])
            leaked = allow_names & retired_names
            assert not leaked, (
                f"mode {mode!r} contract still allow_tool_names retired FC names: "
                f"{sorted(leaked)!r}"
            )

    def test_degraded_contract_uses_canonical_tool_names_only(self):
        retired_names = {
            "bash",
            "web_fetch",
            "skills.search",
            "plan_exit",
            "ask_question",
            # Wave 4.5（2026-05-10）：think_tool 双端下线，degraded fallback
            # 也不允许复活；与 _build_degraded_contract() 注释（约 line 123）SSoT 对齐。
            "think_tool",
            # W4 R3（2026-05-11）：`ask_choice` 已由 `ask_user` 兼容；不允许 degraded
            # fallback 复活。`ask_form` 仍在用，不列入退役。
            "ask_choice",
            # （2026-07-08）：`request_approval` 下架，degraded fallback 不复活。
            "request_approval",
        }
        contract = agent_mode_contract._build_degraded_contract()
        for mode in ALL_AGENT_MODES:
            policy = contract["configs"][mode]["tool_policy"]
            current_names = set(policy["allow_tool_names"]) | set(policy["deny_tool_names"])
            leaked = current_names & retired_names
            assert not leaked, (
                f"mode {mode!r} degraded contract still references retired FC names: "
                f"{sorted(leaked)!r}"
            )


# ---------------------------------------------------------------------------
# 与 agent_mode.py 中的 AgentMode 实例对齐
# ---------------------------------------------------------------------------


class TestContractAlignsWithPythonEnum:
    def test_authorization_preset_matches_python_enum(self):
        for mode in ALL_AGENT_MODES:
            md = get_metadata(mode)
            python_mode = get_agent_mode(mode)
            assert md["authorization_preset"] == python_mode.authorization_preset, (
                f"contract preset for {mode!r} ({md['authorization_preset']!r}) "
                f"diverges from agent_mode.py ({python_mode.authorization_preset!r}); "
                "请同步两端定义。"
            )

    def test_yolo_uses_full_auto_preset(self):
        # PR1 (2026-05-18)：yolo 档独占 `full_auto` 预设;其他 5 档必须 cautious /
        # collaborative。daemon sandbox_policy 派生与 electron judge.ts step3 都依赖该字段做分支。
        for mode in ALL_AGENT_MODES:
            preset = get_metadata(mode)["authorization_preset"]
            if mode == "yolo":
                assert preset == "full_auto", (
                    f"yolo mode 必须使用 full_auto preset,实际 {preset!r}"
                )
            else:
                assert preset in {"cautious", "collaborative"}, (
                    f"非 yolo 模式 {mode!r} 不允许使用 full_auto 预设,实际 {preset!r}"
                )

    def test_skip_execution_section_matches_python_enum(self):
        for mode in ALL_AGENT_MODES:
            md = get_metadata(mode)
            python_mode = get_agent_mode(mode)
            assert md["skip_execution_section"] == python_mode.skip_execution_section, (
                f"contract skip_execution_section for {mode!r} diverges from "
                f"agent_mode.py — 双端必须一致"
            )

    def test_label_matches_python_agent_mode(self):
        for mode in ALL_AGENT_MODES:
            md = get_metadata(mode)
            python_mode = get_agent_mode(mode)
            assert md["label"] == python_mode.label, (
                f"contract label for {mode!r} ({md['label']!r}) "
                f"diverges from agent_mode.py ({python_mode.label!r}); "
                "请同步两端定义。"
            )

    def test_agent_mode_has_no_prompt_section(self):
        # 'agent' 模式是回归基线 — 不能注入额外段，否则会污染既有行为。
        assert has_prompt_section("agent") is False

    def test_yolo_mode_has_no_prompt_section(self):
        # PR1 (2026-05-18)：yolo 与 agent 在 prompt 注入上等价（差异仅在
        # authorization_preset / sandbox preset），同样不携带 <agent_mode> 段。
        assert has_prompt_section("yolo") is False

    def test_non_agent_modes_have_prompt_section(self):
        # PR1：yolo 与 agent 对齐,不在受限/教学/协作 prompt section 之列。
        for mode in ("ask", "plan", "study", "group"):
            assert has_prompt_section(mode), (
                f"mode {mode!r} should ship a <agent_mode> prompt section "
                "(参考 packages/agent-runtime/src/agent-modes/prompt-sections.ts)"
            )


# ---------------------------------------------------------------------------
# 工具过滤决策
# ---------------------------------------------------------------------------


class TestToolFilterDecisions:
    def test_agent_mode_allows_everything(self):
        for name, ro in REPRESENTATIVE_TOOLS:
            assert is_tool_allowed_for_mode("agent", name, ro), (
                f"agent mode 不应过滤任何工具，但 {name!r} 被拒绝了"
            )

    def test_group_mode_allows_everything(self):
        for name, ro in REPRESENTATIVE_TOOLS:
            assert is_tool_allowed_for_mode("group", name, ro)

    def test_yolo_mode_allows_everything(self):
        # PR1 (2026-05-18)：yolo 工具集复用 `ALL_MODE_POLICY`(同 agent / group)。
        # 工具放行不变（差异在授权预设上）。
        for name, ro in REPRESENTATIVE_TOOLS:
            assert is_tool_allowed_for_mode("yolo", name, ro)

    def test_yolo_inherits_agent_tool_decisions(self):
        """
        M3（PRD v3 §1.4 + DR-15 + reviewer-C MEDIUM-5）：yolo 工具集 = agent 工具集。

        实现层 `_decide("yolo", ...)` 直接转发给 `_decide("agent", ...)`,所以
        无论 representative tools 也好、未来某个新工具也好,yolo 和 agent 必须
        给出 *相同* 的 allowed/reason。本测试通过对比双 mode 在 representative
        tool set 上的完整决策来兜底——任何漂移（哪怕 contract.json 单边漂移）都会被
        测试拦截。
        """
        # 含一个"未来未知写工具" + 一个"未来未知读工具",覆盖默认拒绝/默认放行两路径。
        sample = [*REPRESENTATIVE_TOOLS,
                  ("future_unknown_writer", False),
                  ("future_unknown_reader", True)]
        for name, ro in sample:
            agent_decision = explain_tool_mode_decision("agent", name, ro)
            yolo_decision = explain_tool_mode_decision("yolo", name, ro)
            assert agent_decision.allowed == yolo_decision.allowed, (
                f"yolo / agent 对 {name!r} (read_only={ro}) 裁定不一致: "
                f"agent={agent_decision.allowed} vs yolo={yolo_decision.allowed}"
            )
            assert agent_decision.reason == yolo_decision.reason, (
                f"yolo / agent 对 {name!r} (read_only={ro}) reason 不一致: "
                f"agent={agent_decision.reason!r} vs yolo={yolo_decision.reason!r}"
            )
            # decision.mode 字段保留调用方传入的 mode 名,便于 telemetry 追溯。
            assert yolo_decision.mode == "yolo"

    def test_yolo_inherits_read_only_classification(self):
        """
        M3：agent 默认 default_allow_read_only=True;yolo 通过继承应得到一样的行为。
        即,未在白/黑名单的 read-only 工具在 yolo 下也被允许,reason 与 agent 对齐
        （agent 走 'policy_all' 因为 agent 的 policy.kind='all',yolo 转发后同样
        取得 'policy_all' reason）。
        """
        decision = explain_tool_mode_decision("yolo", "some_read_only_tool", True)
        assert decision.allowed
        assert decision.reason == "policy_all"

        # 写工具:agent 在 'all' policy 下也允许,yolo 应当镜像。
        decision_w = explain_tool_mode_decision("yolo", "some_writer", False)
        assert decision_w.allowed
        assert decision_w.reason == "policy_all"

    def test_plan_mode_excludes_writes(self):
        # 写工具必须被拒绝 — 这是 Plan 模式产品承诺的硬约束
        # **L16 W5.5**：run_terminal_command 不再整体拒绝；它现在通过
        # restricted_shell_allowlist='tabtin-readonly' 在 shell.ts 入口做 input 级
        # 过滤（只放行 tabtin 只读 CLI 子命令）。所以 contract 层 deny 不含它。
        for name in [
            "mcp_call_tool",
            "write_file",
            "edit_file",
            "delete_file",
            "tabdoc_update_document",
            "agent",
        ]:
            decision = explain_tool_mode_decision("plan", name, False)
            assert not decision.allowed, f"plan mode 应当拒绝 {name!r}"

    def test_plan_mode_allows_run_terminal_command_with_input_gate(self):
        # L16 W5.5：run_terminal_command 进入受限模式工具列表（绕过 isReadOnly=false 默认排除），
        # 但 contract 中 restricted_shell_allowlist 字段告诉 runtime 在 input 级再做白名单过滤。
        decision = explain_tool_mode_decision("plan", "run_terminal_command", False)
        assert decision.allowed, "plan mode 应当让 run_terminal_command 进入工具列表（input 级过滤由 runtime 做）"
        assert decision.reason == "explicit_allow"

        policy = get_tool_policy("plan")
        assert policy.get("restricted_shell_allowlist") == "tabtin-readonly", (
            "plan/ask/study 模式 contract 必须声明 restricted_shell_allowlist='tabtin-readonly' "
            "才能让 runtime 端 shell.ts 入口走 input 级过滤"
        )

        for mode in ("ask", "study"):
            mode_policy = get_tool_policy(mode)
            assert mode_policy.get("restricted_shell_allowlist") == "tabtin-readonly"

    def test_plan_mode_includes_read_tools(self):
        # Wave 4.5：`think` 工具已下线，从 read-only 样本列表中移除。
        # W3 (2026-05-10): `retrieve_tool_result` / `tool_search` 已下线，从期望列表中移除。
        #  (2026-07-08): `request_approval` 已下架，从期望列表中移除。
        for name in [
            "ask_user", "ask_form",
            "web_search", "read_file", "parse_document",
        ]:
            assert is_tool_allowed_for_mode("plan", name, True)

    # W4 R2 (P2-9, 2026-05-11): test_plan_mode_excludes_w3_retired_tools 已删除——
    # contract.ts WRITE_TOOLS_DENYLIST 不再显式列 summarize_context / retrieve_tool_result /
    # tool_search（W3 工具早已删除，工具不存在时 deny 无意义）。这些工具如未来通过
    # PR review 重新引入会经过显式审查，不需要 contract 层 regression guard。

    def test_plan_mode_includes_todo_write_explicitly(self):
        # todo_write 是 isReadOnly=False 但白名单显式放行
        assert is_tool_allowed_for_mode("plan", "todo_write", False)
        decision = explain_tool_mode_decision("plan", "todo_write", False)
        assert decision.reason == "explicit_allow"

    def test_plan_family_tools_pre_registered(self):
        # plan_exit 已删除：执行由 PlanProposalCard 触发，LLM 只保留二件套
        for name in ["plan_create", "plan_update_todos"]:
            assert is_tool_allowed_for_mode("plan", name, False)

    def test_plan_mode_excludes_subagent_tool(self):
        # 不允许 fork 子 agent 绕过 Plan 模式约束
        assert not is_tool_allowed_for_mode("plan", "agent", False)

    def test_ask_mode_excludes_todo_write(self):
        # Ask 模式纯问答，不需要 todo
        assert not is_tool_allowed_for_mode("ask", "todo_write", False)

    def test_ask_mode_excludes_plan_family(self):
        # Ask 模式不写 plan 文档
        assert not is_tool_allowed_for_mode("ask", "plan_create", False)

    def test_study_mode_includes_present_to_user(self):
        # Study 模式允许 present_to_user 用于教学展示
        assert is_tool_allowed_for_mode("study", "present_to_user", False)


# ---------------------------------------------------------------------------
# Reason 标签
# ---------------------------------------------------------------------------


class TestDecisionReasons:
    def test_explicit_deny_takes_priority(self):
        # write_file 同时是 isReadOnly=False 默认拒绝 + 显式 deny 列表
        # （L16 W5.5 后 run_terminal_command 不再在 deny 列表，改用 write_file 作样本）
        decision = explain_tool_mode_decision("plan", "write_file", False)
        assert decision.reason == "explicit_deny"
        assert not decision.allowed

    def test_default_read_only(self):
        decision = explain_tool_mode_decision("plan", "read_file", True)
        assert decision.reason == "default_read_only"
        assert decision.allowed

    def test_default_deny_for_unknown_writer(self):
        decision = explain_tool_mode_decision("plan", "future_writer_xyz", False)
        assert decision.reason == "default_deny"
        assert not decision.allowed

    def test_mcp_read_only_only(self):
        decision = explain_tool_mode_decision("plan", "mcp_call_tool", False)
        # mcp_call_tool 在 deny_tool_names 里，所以应当走 explicit_deny
        assert decision.reason == "explicit_deny"
        # 而 mcp_unknown_writer 这种没在 deny / allow 列表的 mcp_* 工具会被
        # mcp_read_only_only 兜底拒绝
        decision2 = explain_tool_mode_decision("plan", "mcp_unknown_writer", False)
        assert decision2.reason == "mcp_read_only_only"
        assert not decision2.allowed
        decision3 = explain_tool_mode_decision("plan", "mcp_unknown_reader", True)
        assert decision3.reason == "mcp_read_only_only"
        assert decision3.allowed

    def test_policy_all(self):
        decision = explain_tool_mode_decision("agent", "run_terminal_command", False)
        assert decision.reason == "policy_all"
        assert decision.allowed


# ---------------------------------------------------------------------------
# filter_tool_names_for_mode
# ---------------------------------------------------------------------------


class TestFilterToolNames:
    def test_filter_preserves_input_order(self):
        plan_allowed = filter_tool_names_for_mode("plan", REPRESENTATIVE_TOOLS)
        # L16 W5.5：run_terminal_command 现在 plan 模式下白名单放行（input 级过滤
        # 由 runtime 的 restricted_shell_allowlist checker 做）；保留旧的"input 顺序保留"
        # 断言但用 write_file 作"被过滤掉"样本。
        assert "run_terminal_command" in plan_allowed
        assert "write_file" not in plan_allowed
        # run_terminal_command 是输入第一个，过滤后应仍是首位
        assert plan_allowed[0] == "run_terminal_command"

    def test_filter_agent_mode_returns_all(self):
        all_names = [n for n, _ in REPRESENTATIVE_TOOLS]
        agent_allowed = filter_tool_names_for_mode("agent", REPRESENTATIVE_TOOLS)
        assert agent_allowed == all_names

    def test_filter_ask_mode_aligns_with_decision_function(self):
        ask_allowed = set(filter_tool_names_for_mode("ask", REPRESENTATIVE_TOOLS))
        for name, ro in REPRESENTATIVE_TOOLS:
            expected = is_tool_allowed_for_mode("ask", name, ro)
            actual = name in ask_allowed
            assert expected == actual


# ---------------------------------------------------------------------------
# JSON ↔ 加载结果一致性 (round-trip 在文件层面)
# ---------------------------------------------------------------------------


class TestJsonRoundTrip:
    def test_loaded_contract_matches_raw_json(self):
        # 直接 read 一份 JSON 与模块加载结果对比，捕获将来某次重构改了
        # _load_contract 但忘记同步 JSON parse 行为的情况。
        repo_root = Path(__file__).resolve().parents[6]
        raw_path = repo_root / "packages" / "agent-runtime" / "agent-mode-contract.json"
        raw = json.loads(raw_path.read_text(encoding="utf-8"))
        assert raw == AGENT_MODE_CONTRACT


# ---------------------------------------------------------------------------
# 与 Django 工具自声明（available_modes）对齐 — 单工具样本
# ---------------------------------------------------------------------------


class TestAlignmentWithDjangoToolSelfDeclaration:
    """
    Django 主流程目前用 `BaseTool.available_modes` 自声明做工具过滤（见
    `apps/services/agent_engine/agents/tin_agent.py:572`）。本 Wave 不打算改 Django
    的过滤路径，但要保证 contract 给出的"应当允许的工具集"与 Django 工具自声明
    在主要 mode 上不矛盾。

    这里只校验"已知工具样本"，不强制要求 Django 端所有工具都对齐 contract —
    后续可以在 W1-C / W2-A / 后端工具治理时引入更全面的对齐 lint。
    """

    @pytest.mark.parametrize(
        "tool_module_name,tool_class_name,expected_modes",
        [
            (
                "apps.services.tools.domains.common.todo_tool",
                "TodoWriteTool",
                ("agent", "plan", "study", "group"),
            ),
            # Wave 4.5（2026-05-10）：`ThinkTool` 已物理下线（TabTin 双端契约
            # 让 LLM 走原生 thinking block），样本随之移除。
            # 后续若新增"4 mode 全可见且 isReadOnly=True"的工具，再补 entry。
        ],
    )
    def test_django_known_tools_available_modes_match_contract(
        self, tool_module_name, tool_class_name, expected_modes
    ):
        # 校验思路：取 Django 工具的 available_modes 声明，逐一在 contract 里
        # 验证这些 mode 下该工具 *应该* 是允许的。完整 audit 留待 W1-C。
        import importlib

        module = importlib.import_module(tool_module_name)
        tool_cls = getattr(module, tool_class_name)

        # tool_cls 是 Pydantic v2 BaseTool 的子类。available_modes 通过 Pydantic
        # `Field(default=...)` 声明，实际默认值需要从 model_fields 拿。直接访问
        # tool_cls.available_modes 在某些 Pydantic 版本会返回 None / FieldInfo。
        decl_modes = self._get_pydantic_default(tool_cls, "available_modes")
        tool_name = self._get_pydantic_default(tool_cls, "name")

        assert decl_modes == expected_modes, (
            f"{tool_class_name}.available_modes (Django 声明) "
            f"与测试期待 {expected_modes!r} 不符。如果是有意改动，请同步更新 "
            "agent-mode-contract.json + 本测试的 expected_modes。"
        )
        for mode in expected_modes:
            # contract 不一定显式列出工具名（取决于 isReadOnly / 默认策略），
            # 但至少不能显式 deny — 否则两端会冲突。
            policy = get_tool_policy(mode)
            assert tool_name not in policy["deny_tool_names"], (
                f"contract 在 mode {mode!r} 下 deny 了 {tool_name!r}，"
                f"但 Django {tool_class_name} 自声明可见 — 不一致"
            )

    @staticmethod
    def _get_pydantic_default(tool_cls, field_name):
        """从 Pydantic v2 BaseTool 子类提取字段默认值。"""
        # 优先走 model_fields（Pydantic v2 标准 API）
        model_fields = getattr(tool_cls, "model_fields", None)
        if model_fields and field_name in model_fields:
            return model_fields[field_name].default
        # 兜底走类属性（兼容老版本或非 Pydantic 字段）
        attr = getattr(tool_cls, field_name, None)
        if hasattr(attr, "default"):
            return attr.default
        return attr


# ---------------------------------------------------------------------------
# Historical: full Django BaseTool ↔ contract drift audit (W6 archived)
# ---------------------------------------------------------------------------
#
# Up through W2-QC this file used to contain a full ToolHub.get_tools() walk
# plus a ~230-entry ``_KNOWN_DRIFT_BASELINE`` that policed the contract vs
# Django ``BaseTool.available_modes`` divergence across every registered
# domain. With W6 (2026-05-04) the Python ToolHub has been retired — no
# BaseTool reaches the LLM anymore, so the scan is permanently empty and
# the baseline cannot stay aligned with reality. The drift contract now
# lives entirely on the TS side; see
# ``packages/agent-runtime/tests/agent-modes.test.ts`` for the equivalent
# audit against the Capability + ToolProvider sources of truth.
#
# The historical scan helpers (_scan_django_tool_drift, _ScanResult,
# _AUDIT_SKIP_DOMAINS, _format_drift_lines, etc.) and the
# TestAllDjangoToolsAlignWithContract class were removed in the W6 cleanup.
# Recover them from git history if a future Wave reintroduces server-side
# tool registration.
