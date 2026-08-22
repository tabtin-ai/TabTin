"""error_protocol_audit 规则单测。

边界说明（foundation + django-core + app + platform + tins/wecom）：
1. 在役工具发现走 domain collector（HTTP/CLI BaseTool），不依赖已退役 ToolHub，
   因此审计不会因 ToolHub 空注册而静默通过。
2. 失败路径契约用 AST 声明式检查（识别 canonical ``build_tool_error`` /
   ``json_tool_error`` 调用、内联失败 dict，以及同一函数内「简单赋值 dict 后
   return 变量 / ``json.dumps(变量)``」是否含 error/error_kind/hint），不执行工具
   run()。嵌套函数与 lambda 隔离；不做跨函数、属性写入或复杂分支数据流分析。
3. Wave3 收口后在役 inventory 与 ``ERROR_ENVELOPE_COMPLIANT_TOOLS`` 对齐：全部
   ``contract_ok``、``pending_migration == 0``。发现列表为空、合规项缺失或
   collector 失败 → 硬失败。
"""
from __future__ import annotations

import json
from textwrap import dedent
from types import SimpleNamespace

import pytest

from apps.services.tools import BaseTool
from apps.services.tools.domains.common.show_widget import ShowWidgetTool
from apps.services.tools.domains.common.show_flow_view import ShowFlowViewTool
from apps.services.tools.domains.common.web_search import WebSearchTool
from apps.services.tools.error_envelope import build_tool_error, tool_result_success
from apps.services.tools.error_protocol_audit import (
    CollectorFailure,
    ContractEvidence,
    DiscoveryResult,
    ERROR_ENVELOPE_COMPLIANT_TOOLS,
    ProtocolFinding,
    analyze_tool_error_contract,
    audit_error_protocol,
    check_source_error_contract,
    discover_in_service_tools,
    discover_in_service_tools_result,
    summarize_error_protocol,
)

_dynamic_runtime = SimpleNamespace(result=lambda: {"status": "unknown"})


def test_discover_in_service_tools_is_non_empty_without_toolhub():
    tools = discover_in_service_tools()
    names = {t.name for t in tools}
    assert tools, "domain collectors must yield in-service BaseTool inventory"
    assert "web_search" in names
    # ToolHub 退役后 list_domains 为空；发现路径不得退回 ToolHub
    from apps.services.tools.hub import ToolHub

    assert ToolHub.list_domains() == []


def test_web_search_is_marked_compliant_for_wave1():
    assert "web_search" in ERROR_ENVELOPE_COMPLIANT_TOOLS


def test_wave2_django_core_tools_are_marked_compliant():
    for name in (
        "rag_search",
        "parse_document",
        "credential_lookup",
        "credential_retrieve",
    ):
        assert name in ERROR_ENVELOPE_COMPLIANT_TOOLS
    discovered = {t.name for t in discover_in_service_tools()}
    for name in (
        "rag_search",
        "parse_document",
        "credential_lookup",
        "credential_retrieve",
        "web_search",
    ):
        assert name in discovered


def test_app_domain_tools_are_marked_compliant():
    app_prefixes = ("tabmemo_", "tabsite_")
    app_names = sorted(
        name
        for name in ERROR_ENVELOPE_COMPLIANT_TOOLS
        if name.startswith(app_prefixes)
    )
    assert len(app_names) == 25
    discovered = {t.name for t in discover_in_service_tools()}
    for name in app_names:
        assert name in discovered


def test_wave3_platform_tools_are_marked_compliant():
    platform_names = {
        "get_automation_status",
        "get_battery_info",
        "get_device_info",
        "get_location",
        "get_network_info",
        "get_system_setting",
        "launch_with_intent",
        "list_installed_apps",
        "list_monitors",
        "make_call",
        "monitor_process",
        "plan_create",
        "plan_update_todos",
        "present_to_user",
        "read_calendar",
        "read_call_log",
        "read_contacts",
        "read_media",
        "read_notifications",
        "read_sms",
        "save_to_device",
        "screen_capture",
        "screen_find_element",
        "screen_force_stop_app",
        "screen_get_context",
        "screen_key_event",
        "screen_launch_app",
        "screen_long_press",
        "screen_long_press_element",
        "screen_open_app",
        "screen_snapshot",
        "screen_swipe",
        "screen_tap",
        "screen_tap_area",
        "screen_tap_element",
        "screen_type_in_element",
        "screen_type_secret",
        "screen_type_text",
        "screen_ui_tree",
        "screen_wait_for_element",
        "screen_wait_for_idle",
        "search_contacts",
        "send_sms",
        "set_stealth_mode",
        "set_system_setting",
        "show_widget",
        "stop_monitor",
        "tool_search",
        "web_scraper_scrape_url",
    }
    assert platform_names <= ERROR_ENVELOPE_COMPLIANT_TOOLS
    assert len(platform_names) == 49
    discovered = {t.name for t in discover_in_service_tools()}
    assert platform_names <= discovered
    assert "retrieve_tool_result" not in discovered


def test_wave3_tins_wecom_tools_are_marked_compliant():
    discovered = {t.name for t in discover_in_service_tools()}
    tins_wecom = {
        name for name in discovered if name.startswith(("tin_", "wecom_"))
    }
    assert len(tins_wecom) == 17
    assert tins_wecom <= ERROR_ENVELOPE_COMPLIANT_TOOLS
    assert ERROR_ENVELOPE_COMPLIANT_TOOLS == discovered
    assert len(ERROR_ENVELOPE_COMPLIANT_TOOLS) == 126


def test_discovery_keeps_partial_inventory_and_records_collector_call_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    def failed_collector():
        raise RuntimeError("fixture collector failed")

    modules = {
        "fixture.ok": SimpleNamespace(get_all_tools=lambda: [WebSearchTool()]),
        "fixture.failed": SimpleNamespace(get_all_tools=failed_collector),
    }
    monkeypatch.setattr(
        "apps.services.tools.error_protocol_audit._DOMAIN_COLLECTORS",
        (
            ("common", "fixture.ok", "get_all_tools"),
            ("device", "fixture.failed", "get_all_tools"),
        ),
    )
    monkeypatch.setattr(
        "apps.services.tools.error_protocol_audit.importlib.import_module",
        lambda module_path: modules[module_path],
    )

    result = discover_in_service_tools_result()
    assert [tool.name for tool in result.tools] == ["web_search"]
    assert result.collector_failures == (
        CollectorFailure(
            domain="device",
            collector="fixture.failed.get_all_tools",
            phase="call",
            error_type="RuntimeError",
            message="fixture collector failed",
        ),
    )


def test_check_source_accepts_helper_backed_failure_paths():
    source = dedent(
        '''
        from apps.services.tools.error_envelope import json_tool_error

        class DemoTool:
            def run(self, q: str) -> str:
                if not q:
                    return json_tool_error(
                        "q required",
                        error_kind="missing_required_param",
                        hint="pass q",
                    )
                return '{"ok": true}'
        '''
    )
    violations = check_source_error_contract(source, class_name="DemoTool")
    assert violations == []


def test_check_source_flags_success_false_dict_missing_error_kind_or_hint():
    source = dedent(
        '''
        class LegacyTool:
            def run(self) -> dict:
                return {"success": False, "error": "boom"}
        '''
    )
    violations = check_source_error_contract(source, class_name="LegacyTool")
    assert any("error_kind" in v or "hint" in v for v in violations)


def test_check_source_accepts_inline_dict_with_required_fields():
    source = dedent(
        '''
        class OkTool:
            def run(self) -> dict:
                return {
                    "success": False,
                    "error": "boom",
                    "error_kind": "internal_error",
                    "hint": "retry later",
                }
        '''
    )
    assert check_source_error_contract(source, class_name="OkTool") == []


def test_check_source_flags_assigned_failure_dict_missing_contract_fields():
    source = dedent(
        '''
        class LegacyTool:
            def run(self) -> dict:
                payload = {"success": False, "error": "boom"}
                return payload
        '''
    )
    violations = check_source_error_contract(source, class_name="LegacyTool")
    assert any("error_kind" in v and "hint" in v for v in violations)


def test_check_source_accepts_assigned_failure_dict_with_required_fields():
    source = dedent(
        '''
        class OkTool:
            def run(self) -> dict:
                payload = {
                    "success": False,
                    "error": "boom",
                    "error_kind": "internal_error",
                    "hint": "retry later",
                }
                return payload
        '''
    )
    assert check_source_error_contract(source, class_name="OkTool") == []


def test_check_source_flags_json_dumps_of_assigned_failure_dict():
    source = dedent(
        '''
        import json

        class LegacyTool:
            def run(self) -> str:
                payload = {"success": False, "error": "boom"}
                return json.dumps(payload)
        '''
    )
    violations = check_source_error_contract(source, class_name="LegacyTool")
    assert any("error_kind" in v and "hint" in v for v in violations)


def test_check_source_accepts_json_dumps_of_compliant_assigned_failure_dict():
    source = dedent(
        '''
        import json

        class OkTool:
            def run(self) -> str:
                payload = {
                    "success": False,
                    "error": "boom",
                    "error_kind": "internal_error",
                    "hint": "retry later",
                }
                return json.dumps(payload)
        '''
    )
    assert check_source_error_contract(source, class_name="OkTool") == []


def test_nested_function_scopes_do_not_hide_outer_assigned_failure_dict():
    source = dedent(
        '''
        class LegacyTool:
            def run(self) -> dict:
                payload = {"success": False, "error": "outer failure"}

                def nested():
                    payload = {"success": True}
                    return payload

                async def nested_async():
                    payload = {"success": True}
                    return payload

                nested_lambda = lambda: (
                    payload := {"success": True}
                )
                return payload
        '''
    )
    violations = check_source_error_contract(source, class_name="LegacyTool")
    assert any("error_kind" in v and "hint" in v for v in violations)


def test_nested_scopes_are_audited_once_each():
    source = dedent(
        '''
        class LegacyTool:
            def run(self) -> dict:
                def nested():
                    return {"success": False, "error": "sync failure"}

                async def nested_async():
                    return {"success": False, "error": "async failure"}

                class LocalHelper:
                    def fail(self):
                        return {"success": False, "error": "class failure"}

                nested_lambda = lambda: {
                    "success": False,
                    "error": "lambda failure",
                }
                return {"success": True}
        '''
    )
    violations = check_source_error_contract(source, class_name="LegacyTool")
    assert len(violations) == 4
    assert all("error_kind" in v and "hint" in v for v in violations)


def test_audit_error_protocol_wave3_inventory_fully_compliant():
    discovery = discover_in_service_tools_result()
    findings = audit_error_protocol()
    summary = summarize_error_protocol(findings)

    inventory = {tool.name for tool in discovery.tools}
    assert any(f.code == "inventory_non_empty" for f in findings)
    assert discovery.collector_failures == ()
    assert len(inventory) == 126
    assert len(ERROR_ENVELOPE_COMPLIANT_TOOLS) == 126
    assert inventory == ERROR_ENVELOPE_COMPLIANT_TOOLS

    pending = [f for f in findings if f.code == "pending_migration"]
    violations = [f for f in findings if f.code == "contract_violation"]
    unresolved = [
        f
        for f in findings
        if f.severity == "fail" and "not statically resolved" in f.message
    ]
    contract_ok = {f.tool_name for f in findings if f.code == "contract_ok"}
    hard = [f for f in findings if f.severity == "fail"]

    assert pending == []
    assert violations == []
    assert unresolved == []
    assert hard == []
    assert contract_ok == inventory
    assert summary["discovered"] == len(inventory)
    assert summary["pending"] == 0
    assert summary["hard_failures"] == 0


def test_audit_error_protocol_empty_inventory_is_hard_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setattr(
        "apps.services.tools.error_protocol_audit.discover_in_service_tools_result",
        lambda: DiscoveryResult(tools=(), collector_failures=()),
    )
    findings = audit_error_protocol()
    assert any(f.code == "empty_inventory" and f.severity == "fail" for f in findings)
    summary = summarize_error_protocol(findings)
    assert summary["hard_failures"] >= 1


def test_audit_error_protocol_missing_compliant_tool_is_hard_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    tools = discover_in_service_tools()
    without_web_search = tuple(t for t in tools if t.name != "web_search")
    assert without_web_search
    monkeypatch.setattr(
        "apps.services.tools.error_protocol_audit.discover_in_service_tools_result",
        lambda: DiscoveryResult(tools=without_web_search, collector_failures=()),
    )
    findings = audit_error_protocol()
    assert any(
        f.code == "compliant_missing"
        and f.tool_name == "web_search"
        and f.severity == "fail"
        for f in findings
    )


def test_audit_error_protocol_reports_partial_collector_failure(
    monkeypatch: pytest.MonkeyPatch,
):
    # 保留全部 compliant 工具，避免因 Wave 2 allowlist 扩容误报 compliant_missing
    compliant_tools = tuple(
        t for t in discover_in_service_tools() if t.name in ERROR_ENVELOPE_COMPLIANT_TOOLS
    )
    assert compliant_tools
    monkeypatch.setattr(
        "apps.services.tools.error_protocol_audit.discover_in_service_tools_result",
        lambda: DiscoveryResult(
            tools=compliant_tools,
            collector_failures=(
                CollectorFailure(
                    domain="device",
                    collector="apps.services.tools.domains.device.tool_registry.get_all_tools",
                    phase="call",
                    error_type="RuntimeError",
                    message="fixture collector failed",
                ),
            ),
        ),
    )
    findings = audit_error_protocol()
    assert any(
        f.code == "collector_failure"
        and f.tool_name == "device"
        and f.severity == "fail"
        for f in findings
    )
    assert not any(f.code == "compliant_missing" for f in findings)


def test_protocol_finding_shape():
    finding = ProtocolFinding(
        tool_name="web_search",
        severity="pass",
        code="contract_ok",
        message="ok",
    )
    assert finding.tool_name == "web_search"
    assert finding.severity == "pass"


def _legacy_device_error(*args, **kwargs):
    return {"success": False, "error": "legacy wrapper"}


def test_device_thin_subclasses_trace_to_audited_wrapper():
    tools = [
        tool
        for tool in discover_in_service_tools()
        if tool.domain == "device"
    ]
    assert len(tools) == 40

    for tool in tools:
        analysis = analyze_tool_error_contract(tool.tool_cls)
        assert analysis.violations == (), (tool.name, analysis.violations)
        assert any(
            evidence.kind in {"direct_helper", "audited_call_chain"}
            for evidence in analysis.evidence
        ), (tool.name, analysis.evidence)


def test_broken_shared_wrapper_fails_all_dependent_device_tools(
    monkeypatch: pytest.MonkeyPatch,
):
    from apps.services.tools.domains.device import device_query_tools

    monkeypatch.setattr(
        device_query_tools,
        "_device_tool_error",
        _legacy_device_error,
    )
    device_tools = tuple(
        tool
        for tool in discover_in_service_tools()
        if tool.domain == "device"
    )
    findings = audit_error_protocol(tools=device_tools)
    failed_names = {
        finding.tool_name
        for finding in findings
        if finding.code == "contract_violation"
    }
    assert failed_names == {tool.name for tool in device_tools}


def test_show_widget_has_explicit_safe_no_failure_evidence():
    analysis = analyze_tool_error_contract(ShowWidgetTool)
    assert analysis.violations == ()
    assert analysis.evidence == (
        ContractEvidence(
            kind="safe_no_failure",
            path="ShowWidgetTool.run",
            detail="all statically resolved returns are success-only",
        ),
    )


def test_show_flow_view_has_explicit_safe_no_failure_evidence():
    analysis = analyze_tool_error_contract(ShowFlowViewTool)
    assert analysis.violations == ()
    assert analysis.evidence == (
        ContractEvidence(
            kind="safe_no_failure",
            path="ShowFlowViewTool.run",
            detail="all statically resolved returns are success-only",
        ),
    )


def test_wave3_platform_49_tools_have_explainable_contract_evidence():
    platform_domains = {
        "common",
        "device",
        "plan",
        "runtime",
        "table",
        "think",
        "web_scraper",
    }
    tools = [
        tool
        for tool in discover_in_service_tools()
        if tool.domain in platform_domains and tool.name != "web_search"
    ]
    assert len(tools) == 49

    findings = audit_error_protocol()
    by_name = {
        finding.tool_name: finding
        for finding in findings
        if finding.code == "contract_ok"
    }
    assert set(by_name).issuperset(tool.name for tool in tools)
    for tool in tools:
        finding = by_name[tool.name]
        assert finding.message.startswith("verified evidence: ")
        assert any(
            marker in finding.message
            for marker in (
                "direct_helper=",
                "inline_standard_failure=",
                "audited_call_chain=",
                "safe_no_failure=",
            )
        )


def test_callable_cycle_is_a_contract_violation():
    class CyclicTool(BaseTool):
        name: str = "cyclic_tool"
        description: str = "Fixture tool with a recursive wrapper chain."

        def run(self) -> dict:
            return self._cycle()

        def _cycle(self) -> dict:
            return self.run()

    analysis = analyze_tool_error_contract(CyclicTool)
    assert any("cycle detected" in violation for violation in analysis.violations)
    assert analysis.evidence == ()


def test_mixed_helper_and_unresolved_return_keeps_violation():
    class MixedBranchTool(BaseTool):
        name: str = "mixed_branch_tool"
        description: str = "Fixture with one compliant and one unresolved branch."

        def run(self, fail: bool) -> dict:
            if fail:
                return build_tool_error(
                    "failed",
                    error_kind="internal_error",
                    hint="retry",
                )
            return _dynamic_runtime.result()

    analysis = analyze_tool_error_contract(MixedBranchTool)
    assert any("not statically resolved" in item for item in analysis.violations)


def test_status_failed_dict_is_not_safe_no_failure():
    class FailedStatusTool(BaseTool):
        name: str = "failed_status_tool"
        description: str = "Fixture returning a failed status."

        def run(self) -> dict:
            return {"status": "failed", "message": "boom"}

    analysis = analyze_tool_error_contract(FailedStatusTool)
    assert analysis.evidence == ()
    assert any("status" in item for item in analysis.violations)


def test_dynamic_success_value_is_not_statically_successful():
    class DynamicSuccessTool(BaseTool):
        name: str = "dynamic_success_tool"
        description: str = "Fixture returning a dynamic success value."

        def run(self, succeeded: bool) -> dict:
            return {"success": succeeded, "data": {}}

    analysis = analyze_tool_error_contract(DynamicSuccessTool)
    assert analysis.evidence == ()
    assert any("success" in item for item in analysis.violations)


def test_literal_success_true_with_failure_keys_is_not_safe():
    class ContradictorySuccessTool(BaseTool):
        name: str = "contradictory_success_tool"
        description: str = "Fixture returning success with failure fields."

        def run(self) -> dict:
            return {
                "success": True,
                "error": "actually failed",
                "error_kind": "internal_error",
            }

    analysis = analyze_tool_error_contract(ContradictorySuccessTool)
    assert analysis.violations == (
        "ContradictorySuccessTool.run: literal success dict contains "
        "failure markers error, error_kind",
    )
    assert analysis.evidence == ()


def test_literal_success_true_with_failure_status_is_not_safe():
    class ContradictoryStatusTool(BaseTool):
        name: str = "contradictory_status_tool"
        description: str = "Fixture returning success with a failure status."

        def run(self) -> dict:
            return {"success": True, "status": "error"}

    analysis = analyze_tool_error_contract(ContradictoryStatusTool)
    assert any("status" in item for item in analysis.violations)
    assert analysis.evidence == ()


def test_literal_success_true_with_ok_status_is_safe():
    class SuccessfulStatusTool(BaseTool):
        name: str = "successful_status_tool"
        description: str = "Fixture returning a consistent success status."

        def run(self) -> dict:
            return {"success": True, "status": "ok"}

    analysis = analyze_tool_error_contract(SuccessfulStatusTool)
    assert analysis.violations == ()
    assert any(item.kind == "safe_no_failure" for item in analysis.evidence)


def test_success_status_with_failure_markers_is_not_safe():
    class ContradictoryStatusTool(BaseTool):
        name: str = "contradictory_status_tool"
        description: str = "Fixture returning a success status with failure fields."

        def run(self) -> dict:
            return {
                "status": "completed",
                "error_kind": "internal_error",
                "hint": "retry",
            }

    analysis = analyze_tool_error_contract(ContradictoryStatusTool)
    assert any("failure markers" in item for item in analysis.violations)
    assert analysis.evidence == ()


def test_unknown_dict_return_is_not_safe_no_failure():
    class UnknownDictTool(BaseTool):
        name: str = "unknown_dict_tool"
        description: str = "Fixture returning an unknown mapping."

        def run(self, payload: dict) -> dict:
            return payload

    analysis = analyze_tool_error_contract(UnknownDictTool)
    assert analysis.evidence == ()
    assert any("not statically resolved" in item for item in analysis.violations)


def test_unmarked_literal_dict_is_not_safe_no_failure():
    class UnknownLiteralDictTool(BaseTool):
        name: str = "unknown_literal_dict_tool"
        description: str = "Fixture returning an unmarked literal mapping."

        def run(self) -> dict:
            return {"data": {"value": 1}}

    analysis = analyze_tool_error_contract(UnknownLiteralDictTool)
    assert analysis.evidence == ()
    assert any("explicit success" in item for item in analysis.violations)


def test_failure_guard_does_not_infer_success_for_unknown_passthrough():
    class GuardedPassthroughTool(BaseTool):
        name: str = "guarded_passthrough_tool"
        description: str = "Fixture with an explicit failure guard."

        def run(self, payload: dict) -> dict:
            if payload.get("success") is False:
                return build_tool_error(
                    "failed",
                    error_kind="upstream_error",
                    hint="retry",
                )
            return payload

    analysis = analyze_tool_error_contract(GuardedPassthroughTool)
    assert analysis.evidence == () or any(
        "not statically resolved" in item or "explicit success" in item
        for item in analysis.violations
    )
    assert any(
        "not statically resolved" in item or "explicit success" in item
        for item in analysis.violations
    )


def test_explicit_success_helper_allows_dynamic_success_result():
    class DeclaredSuccessTool(BaseTool):
        name: str = "declared_success_tool"
        description: str = "Fixture using an explicit success-only helper."

        def run(self):
            return tool_result_success(_dynamic_runtime.result())

    analysis = analyze_tool_error_contract(DeclaredSuccessTool)
    assert analysis.violations == ()
    assert any(
        item.kind == "safe_no_failure"
        and "explicit successful tool-result helper" in item.detail
        for item in analysis.evidence
    )


def test_success_helper_wrapping_failure_dict_is_violation():
    class WrappedFailureTool(BaseTool):
        name: str = "wrapped_failure_tool"
        description: str = "Fixture wrapping a failure inside tool_result_success."

        def run(self) -> dict:
            return tool_result_success(
                {"success": False, "error": "legacy"}
            )

    analysis = analyze_tool_error_contract(WrappedFailureTool)
    assert analysis.evidence == ()
    assert any("success helper" in item for item in analysis.violations)


def test_success_helper_rejects_success_true_with_error_kind():
    class WrappedErrorKindTool(BaseTool):
        name: str = "wrapped_error_kind_tool"
        description: str = "Fixture wrapping a failure marker as success."

        def run(self) -> dict:
            return tool_result_success(
                {"success": True, "error_kind": "internal_error"}
            )

    analysis = analyze_tool_error_contract(WrappedErrorKindTool)
    assert any("success helper" in item for item in analysis.violations)
    assert analysis.evidence == ()


def test_success_helper_rejects_success_true_with_failure_status():
    class WrappedFailureStatusTool(BaseTool):
        name: str = "wrapped_failure_status_tool"
        description: str = "Fixture wrapping a failure status as success."

        def run(self) -> dict:
            return tool_result_success({"success": True, "status": "error"})

    analysis = analyze_tool_error_contract(WrappedFailureStatusTool)
    assert any("success helper" in item for item in analysis.violations)
    assert analysis.evidence == ()


def test_success_helper_allows_success_true_with_ok_status():
    class WrappedSuccessfulStatusTool(BaseTool):
        name: str = "wrapped_successful_status_tool"
        description: str = "Fixture wrapping a consistent success status."

        def run(self) -> dict:
            return tool_result_success({"success": True, "status": "ok"})

    analysis = analyze_tool_error_contract(WrappedSuccessfulStatusTool)
    assert analysis.violations == ()
    assert any(item.kind == "safe_no_failure" for item in analysis.evidence)


def test_success_helper_rejects_serialized_failure_markers():
    class WrappedSerializedFailureTool(BaseTool):
        name: str = "wrapped_serialized_failure_tool"
        description: str = "Fixture wrapping serialized failure markers as success."

        def run(self) -> str:
            return tool_result_success(
                json.dumps(
                    {
                        "success": True,
                        "error": "actually failed",
                        "error_kind": "internal_error",
                    }
                )
            )

    analysis = analyze_tool_error_contract(WrappedSerializedFailureTool)
    assert any("success helper" in item for item in analysis.violations)
    assert analysis.evidence == ()


def test_success_helper_allows_serialized_success_payload():
    class WrappedSerializedSuccessTool(BaseTool):
        name: str = "wrapped_serialized_success_tool"
        description: str = "Fixture wrapping serialized success data."

        def run(self) -> str:
            return tool_result_success(json.dumps({"data": {"value": 1}}))

    analysis = analyze_tool_error_contract(WrappedSerializedSuccessTool)
    assert analysis.violations == ()
    assert any(item.kind == "safe_no_failure" for item in analysis.evidence)


def test_local_success_helper_shadow_is_not_canonical():
    class ShadowedSuccessHelperTool(BaseTool):
        name: str = "shadowed_success_helper_tool"
        description: str = "Fixture with a local tool_result_success shadow."

        def run(self) -> dict:
            def tool_result_success(value):
                return value

            return tool_result_success({"ok": True})

    analysis = analyze_tool_error_contract(ShadowedSuccessHelperTool)
    assert analysis.evidence == ()
    assert any(
        "not statically resolved" in item or "canonical" in item
        for item in analysis.violations
    )


@pytest.mark.parametrize("helper_name", ["build_tool_error", "tool_result_success"])
def test_canonical_helper_parameter_shadow_is_not_trusted(helper_name: str):
    if helper_name == "build_tool_error":
        class ParameterShadowTool(BaseTool):
            name: str = "parameter_shadow_tool"
            description: str = "Fixture shadowing build_tool_error with a parameter."

            def run(self, build_tool_error=build_tool_error) -> dict:
                return build_tool_error(
                    "failed",
                    error_kind="internal_error",
                    hint="retry",
                )
    else:
        class ParameterShadowTool(BaseTool):
            name: str = "parameter_shadow_tool"
            description: str = "Fixture shadowing tool_result_success with a parameter."

            def run(self, tool_result_success=tool_result_success) -> dict:
                return tool_result_success(_dynamic_runtime.result())

    analysis = analyze_tool_error_contract(ParameterShadowTool)
    assert analysis.evidence == ()
    assert any("canonical" in item for item in analysis.violations)


def test_control_flow_assignment_shadow_is_not_canonical():
    class ControlFlowShadowTool(BaseTool):
        name: str = "control_flow_shadow_tool"
        description: str = "Fixture shadowing a helper inside control flow."

        def run(self, shadow: bool) -> dict:
            if shadow:
                tool_result_success = lambda value: value
            return tool_result_success(_dynamic_runtime.result())

    analysis = analyze_tool_error_contract(ControlFlowShadowTool)
    assert analysis.evidence == ()
    assert any("canonical" in item for item in analysis.violations)


@pytest.mark.parametrize(
    "binding_kind",
    ["for", "with", "except", "import", "try", "walrus"],
)
def test_scope_binding_targets_shadow_canonical_helper(binding_kind: str):
    if binding_kind == "for":
        class ScopeShadowTool(BaseTool):
            name: str = "for_shadow_tool"
            description: str = "Fixture with a for-target helper shadow."

            def run(self) -> dict:
                for tool_result_success in (lambda value: value,):
                    pass
                return tool_result_success(_dynamic_runtime.result())
    elif binding_kind == "with":
        class _Context:
            def __enter__(self):
                return lambda value: value

            def __exit__(self, *args):
                return False

        class ScopeShadowTool(BaseTool):
            name: str = "with_shadow_tool"
            description: str = "Fixture with a with-target helper shadow."

            def run(self) -> dict:
                with _Context() as tool_result_success:
                    pass
                return tool_result_success(_dynamic_runtime.result())
    elif binding_kind == "except":
        class ScopeShadowTool(BaseTool):
            name: str = "except_shadow_tool"
            description: str = "Fixture with an except-target helper shadow."

            def run(self) -> dict:
                try:
                    raise RuntimeError("fixture")
                except RuntimeError as tool_result_success:
                    pass
                return tool_result_success(_dynamic_runtime.result())
    elif binding_kind == "import":
        class ScopeShadowTool(BaseTool):
            name: str = "import_shadow_tool"
            description: str = "Fixture with an import-target helper shadow."

            def run(self) -> dict:
                import json as tool_result_success

                return tool_result_success(_dynamic_runtime.result())
    elif binding_kind == "try":
        class ScopeShadowTool(BaseTool):
            name: str = "try_shadow_tool"
            description: str = "Fixture with a try-body helper shadow."

            def run(self) -> dict:
                try:
                    tool_result_success = lambda value: value
                finally:
                    pass
                return tool_result_success(_dynamic_runtime.result())
    else:
        class ScopeShadowTool(BaseTool):
            name: str = "walrus_shadow_tool"
            description: str = "Fixture with a walrus helper shadow."

            def run(self) -> dict:
                if (tool_result_success := lambda value: value):
                    pass
                return tool_result_success(_dynamic_runtime.result())

    analysis = analyze_tool_error_contract(ScopeShadowTool)
    assert analysis.evidence == ()
    assert any("canonical" in item for item in analysis.violations)


def test_module_level_canonical_helper_import_remains_trusted():
    class CanonicalImportTool(BaseTool):
        name: str = "canonical_import_tool"
        description: str = "Fixture using the canonical module-level import."

        def run(self) -> dict:
            return build_tool_error(
                "failed",
                error_kind="internal_error",
                hint="retry",
            )

    analysis = analyze_tool_error_contract(CanonicalImportTool)
    assert analysis.violations == ()
    assert any(item.kind == "direct_helper" for item in analysis.evidence)


def test_current_scope_direct_canonical_import_is_trusted():
    class CurrentImportTool(BaseTool):
        name: str = "current_import_tool"
        description: str = "Fixture importing the canonical helper in run."

        def run(self) -> dict:
            from apps.services.tools.error_envelope import build_tool_error

            return build_tool_error(
                "failed",
                error_kind="internal_error",
                hint="retry",
            )

    analysis = analyze_tool_error_contract(CurrentImportTool)
    assert analysis.violations == ()
    assert any(item.kind == "direct_helper" for item in analysis.evidence)


def test_current_scope_aliased_canonical_import_is_trusted():
    class CurrentAliasImportTool(BaseTool):
        name: str = "current_alias_import_tool"
        description: str = "Fixture aliasing the canonical helper in run."

        def run(self) -> dict:
            from apps.services.tools.error_envelope import (
                build_tool_error as canonical_failure,
            )

            return canonical_failure(
                "failed",
                error_kind="internal_error",
                hint="retry",
            )

    analysis = analyze_tool_error_contract(CurrentAliasImportTool)
    assert analysis.violations == ()
    assert any(item.kind == "direct_helper" for item in analysis.evidence)


def test_nested_canonical_import_does_not_bind_outer_scope():
    class NestedImportTool(BaseTool):
        name: str = "nested_import_tool"
        description: str = "Fixture whose helper import exists only in a nested scope."

        def run(self) -> dict:
            def nested():
                from apps.services.tools.error_envelope import (
                    build_tool_error as nested_failure,
                )

                return nested_failure(
                    "failed",
                    error_kind="internal_error",
                    hint="retry",
                )

            return nested_failure(
                "failed",
                error_kind="internal_error",
                hint="retry",
            )

    analysis = analyze_tool_error_contract(NestedImportTool)
    assert analysis.evidence == ()
    assert any("not statically resolved" in item for item in analysis.violations)


@pytest.mark.parametrize("shadow_kind", ["parameter", "assignment"])
def test_current_scope_canonical_import_loses_to_shadow(shadow_kind: str):
    if shadow_kind == "parameter":
        class ImportShadowTool(BaseTool):
            name: str = "parameter_import_shadow_tool"
            description: str = "Fixture with parameter shadow plus canonical import."

            def run(self, canonical_failure=None) -> dict:
                from apps.services.tools.error_envelope import (
                    build_tool_error as canonical_failure,
                )

                return canonical_failure(
                    "failed",
                    error_kind="internal_error",
                    hint="retry",
                )
    else:
        class ImportShadowTool(BaseTool):
            name: str = "assignment_import_shadow_tool"
            description: str = "Fixture with assignment shadow plus canonical import."

            def run(self, shadow: bool) -> dict:
                from apps.services.tools.error_envelope import (
                    build_tool_error as canonical_failure,
                )

                if shadow:
                    canonical_failure = lambda *args, **kwargs: {"success": True}
                return canonical_failure(
                    "failed",
                    error_kind="internal_error",
                    hint="retry",
                )

    analysis = analyze_tool_error_contract(ImportShadowTool)
    assert analysis.evidence == ()
    assert any("not statically resolved" in item for item in analysis.violations)


def test_serialized_unknown_dict_is_unresolved():
    class SerializedUnknownTool(BaseTool):
        name: str = "serialized_unknown_tool"
        description: str = "Fixture serializing an unknown dict."

        def run(self) -> str:
            import json

            return json.dumps({"message": "failed"})

    analysis = analyze_tool_error_contract(SerializedUnknownTool)
    assert analysis.evidence == ()
    assert any(
        "serialized" in item or "explicit success" in item
        for item in analysis.violations
    )


def test_status_completed_with_error_is_not_safe():
    class CompletedWithErrorTool(BaseTool):
        name: str = "completed_with_error_tool"
        description: str = "Fixture returning completed status plus error."

        def run(self) -> dict:
            return {"status": "completed", "error": "actually failed"}

    analysis = analyze_tool_error_contract(CompletedWithErrorTool)
    assert analysis.evidence == ()
    assert any("status" in item or "error" in item for item in analysis.violations)


def test_dynamic_status_is_not_statically_successful():
    class DynamicStatusTool(BaseTool):
        name: str = "dynamic_status_tool"
        description: str = "Fixture returning a dynamic status value."

        def run(self, status: str) -> dict:
            return {"status": status}

    analysis = analyze_tool_error_contract(DynamicStatusTool)
    assert analysis.evidence == ()
    assert any("status" in item for item in analysis.violations)


def test_inline_failure_missing_error_is_violation():
    class MissingErrorFieldTool(BaseTool):
        name: str = "missing_error_field_tool"
        description: str = "Fixture missing the required error field."

        def run(self) -> dict:
            return {
                "success": False,
                "error_kind": "internal_error",
                "hint": "retry",
            }

    analysis = analyze_tool_error_contract(MissingErrorFieldTool)
    assert analysis.evidence == ()
    assert any("error" in item for item in analysis.violations)


def test_guarded_passthrough_with_success_helper_is_green():
    class GuardedDeclaredSuccessTool(BaseTool):
        name: str = "guarded_declared_success_tool"
        description: str = "Fixture that marks passthrough success explicitly."

        def run(self, payload: dict) -> dict:
            if payload.get("success") is False:
                return build_tool_error(
                    "failed",
                    error_kind="upstream_error",
                    hint="retry",
                )
            return tool_result_success(payload)

    analysis = analyze_tool_error_contract(GuardedDeclaredSuccessTool)
    assert analysis.violations == ()
    assert any(item.kind == "direct_helper" for item in analysis.evidence)
    assert any(item.kind == "safe_no_failure" for item in analysis.evidence)
