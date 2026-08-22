"""
BaseTool 错误协议审计骨架（静态 / 声明式）。

发现路径：各 domain 的 ``get_all_tools`` / 等价 collector（HTTP/CLI 在役
BaseTool），**不**走已退役 ToolHub，也**不**把工具重新注册回 LLM。

契约检查：从工具的有效 ``run``（含继承）开始做 AST/inspect 静态追踪：
- 直接调用 ``build_tool_error`` / ``json_tool_error``；
- 内联 ``{"success": False, ...}`` 必须含 ``error`` / ``error_kind`` / ``hint``；
- ``self._run_query`` 等父类方法、模块级 wrapper、赋值后返回的 wrapper
  参数会继续递归审计，循环/不可读源码硬失败；
- 任一 unresolved return 都硬失败，不会因另一分支已有 helper evidence 被清除；
- 无失败分支的工具只有在所有 return 都静态证明为 success-only 时，才记
  ``safe_no_failure``；动态结果必须经 ``tool_result_success`` 明确标记。

全程不实例化执行 ``run()``，避免审计触发网络/设备/写操作。

分阶段合规：
- ``ERROR_ENVELOPE_COMPLIANT_TOOLS`` 内工具必须通过契约（硬失败）。
- 其余在役工具记 ``pending_migration``（报告，不静默）。
- 任一 collector 加载/调用失败、任一合规工具未出现在 inventory → 硬失败。
- 发现列表为空 → ``empty_inventory`` 硬失败（防 ToolHub 空审计误绿）。
"""

from __future__ import annotations

import ast
import importlib
import importlib.util
import inspect
import symtable
import textwrap
from dataclasses import dataclass
from typing import Callable, Final, Iterable, Literal, Sequence

from apps.services.tools import error_envelope as _error_envelope
from apps.services.tools.base import BaseTool

Severity = Literal["fail", "warn", "pass", "info"]
EvidenceKind = Literal[
    "direct_helper",
    "inline_standard_failure",
    "audited_call_chain",
    "safe_no_failure",
]

# Wave 1 示范 + Wave 2 django-core/apps + Wave 3 platform/tins/wecom 并集（排序稳定）。
# 并行分支会改此集合；后续 PR 取并集即可。
ERROR_ENVELOPE_COMPLIANT_TOOLS: Final[frozenset[str]] = frozenset(
    {
        "credential_lookup",
        "credential_retrieve",
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
        "parse_document",
        "plan_create",
        "plan_update_todos",
        "present_to_user",
        "rag_search",
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
        "tabmemo_add_to_collection",
        "tabmemo_archive_memo",
        "tabmemo_batch_operate",
        "tabmemo_create_collection",
        "tabmemo_create_memo",
        "tabmemo_delete_collection",
        "tabmemo_get_memo",
        "tabmemo_list_attachments",
        "tabmemo_list_collections",
        "tabmemo_list_grants",
        "tabmemo_manage_grant",
        "tabmemo_remove_from_collection",
        "tabmemo_restore_from_trash",
        "tabmemo_restore_memo",
        "tabmemo_search_memos",
        "tabmemo_update_collection",
        "tabmemo_update_memo",
        "tabsite_archive_site",
        "tabsite_create_site",
        "tabsite_get_site",
        "tabsite_list_sites",
        "tabsite_provision_token",
        "tabsite_publish_site",
        "tabsite_rollback_site",
        "tabsite_update_site",
        "tin_activate",
        "tin_create",
        "tin_get_context",
        "tin_list",
        "tin_update_file",
        "tool_search",
        "web_scraper_scrape_url",
        "web_search",
        "wecom_cancel_meeting",
        "wecom_check_availability",
        "wecom_contact_lookup",
        "wecom_create_meeting",
        "wecom_create_schedule",
        "wecom_create_todo",
        "wecom_get_chat_list",
        "wecom_get_messages",
        "wecom_list_meetings",
        "wecom_list_schedules",
        "wecom_list_todos",
        "wecom_update_todo",
    }
)

# (domain, import_path, collector_attr)
_DOMAIN_COLLECTORS: Final[tuple[tuple[str, str, str], ...]] = (
    ("common", "apps.services.tools.domains.common.tool_registry", "get_all_tools"),
    ("credential", "apps.services.tools.domains.common.credential_tool", "get_credential_tools"),
    ("device", "apps.services.tools.domains.device.tool_registry", "get_all_tools"),
    ("docparse", "apps.services.tools.domains.docparse.tool_registry", "get_all_tools"),
    ("plan", "apps.services.tools.domains.plan.tool_registry", "get_all_tools"),
    ("rag", "apps.services.tools.domains.rag.tool_registry", "get_all_tools"),
    ("runtime", "apps.services.tools.domains.runtime.tool_registry", "get_all_tools"),
    ("table", "apps.services.tools.domains.table.tool_registry", "get_all_tools"),
    ("think", "apps.services.tools.domains.think.tool_registry", "get_all_tools"),
    ("web_scraper", "apps.services.tools.domains.web_scraper.tool_registry", "get_all_tools"),
    ("tabmemo", "apps.services.tools.domains.tabmemo", "get_tabmemo_tools"),
    ("tabsite", "apps.services.tools.domains.tabsite", "get_tabsite_tools"),
    ("tins", "apps.services.tools.domains.tins", "get_tins_tools"),
    ("wechat_work", "apps.services.tools.domains.wechat_work", "get_wechat_work_tools"),
)

_HELPER_NAMES: Final[frozenset[str]] = frozenset({"build_tool_error", "json_tool_error"})
_SUCCESS_HELPER_NAMES: Final[frozenset[str]] = frozenset({"tool_result_success"})
_REQUIRED_FAILURE_KEYS: Final[frozenset[str]] = frozenset({"error", "error_kind", "hint"})
_FAILURE_MARKER_KEYS: Final[frozenset[str]] = frozenset({"error", "error_kind"})
_CANONICAL_HELPERS: Final[dict[str, Callable[..., object]]] = {
    "build_tool_error": _error_envelope.build_tool_error,
    "json_tool_error": _error_envelope.json_tool_error,
    "tool_result_success": _error_envelope.tool_result_success,
}
_CANONICAL_HELPER_MODULE: Final[str] = "apps.services.tools.error_envelope"
_FAILURE_STATUS_VALUES: Final[frozenset[str]] = frozenset(
    {"error", "failed", "failure"}
)
_SUCCESS_STATUS_VALUES: Final[frozenset[str]] = frozenset(
    {
        "completed",
        "created",
        "deleted",
        "layout_applied",
        "ok",
        "success",
        "updated",
    }
)


@dataclass(frozen=True)
class InServiceTool:
    name: str
    domain: str
    module: str
    class_name: str
    tool_cls: type[BaseTool]


@dataclass(frozen=True)
class ProtocolFinding:
    tool_name: str
    severity: Severity
    code: str
    message: str


@dataclass(frozen=True)
class ContractEvidence:
    kind: EvidenceKind
    path: str
    detail: str


@dataclass(frozen=True)
class ContractAnalysis:
    violations: tuple[str, ...]
    evidence: tuple[ContractEvidence, ...]


@dataclass(frozen=True)
class CollectorFailure:
    domain: str
    collector: str
    phase: Literal["import", "call"]
    error_type: str
    message: str


@dataclass(frozen=True)
class DiscoveryResult:
    tools: tuple[InServiceTool, ...]
    collector_failures: tuple[CollectorFailure, ...]


def discover_in_service_tools_result() -> DiscoveryResult:
    """从 domain collector 收集在役 BaseTool，并保留 collector 失败。"""
    seen: set[str] = set()
    tools: list[InServiceTool] = []
    failures: list[CollectorFailure] = []
    for domain, module_path, attr in _DOMAIN_COLLECTORS:
        collector_name = f"{module_path}.{attr}"
        try:
            module = importlib.import_module(module_path)
            collector = getattr(module, attr)
        except Exception as exc:
            failures.append(
                CollectorFailure(
                    domain=domain,
                    collector=collector_name,
                    phase="import",
                    error_type=type(exc).__name__,
                    message=str(exc),
                )
            )
            continue
        if not callable(collector):
            failures.append(
                CollectorFailure(
                    domain=domain,
                    collector=collector_name,
                    phase="import",
                    error_type="TypeError",
                    message="collector is not callable",
                )
            )
            continue
        try:
            items = collector()
        except Exception as exc:
            failures.append(
                CollectorFailure(
                    domain=domain,
                    collector=collector_name,
                    phase="call",
                    error_type=type(exc).__name__,
                    message=str(exc),
                )
            )
            continue
        if not isinstance(items, Iterable):
            failures.append(
                CollectorFailure(
                    domain=domain,
                    collector=collector_name,
                    phase="call",
                    error_type="TypeError",
                    message="collector result is not iterable",
                )
            )
            continue
        for item in items:
            if not isinstance(item, BaseTool):
                continue
            name = getattr(item, "name", None)
            if not name or name in seen:
                continue
            seen.add(name)
            cls = type(item)
            tools.append(
                InServiceTool(
                    name=name,
                    domain=domain,
                    module=cls.__module__,
                    class_name=cls.__name__,
                    tool_cls=cls,
                )
            )
    return DiscoveryResult(
        tools=tuple(tools),
        collector_failures=tuple(failures),
    )


def discover_in_service_tools() -> list[InServiceTool]:
    """兼容调用方：仅返回发现的工具；审计使用带失败详情的 result API。"""
    return list(discover_in_service_tools_result().tools)


def discover_in_service_tool_records() -> list[dict[str, object]]:
    """供 ``audit_tools`` 复用的 backend tool 元数据记录。"""
    records: list[dict[str, object]] = []
    for tool in discover_in_service_tools():
        sample: BaseTool | None
        try:
            sample = tool.tool_cls()
        except Exception:
            sample = None
        src: object = sample if sample is not None else tool.tool_cls
        records.append(
            {
                "name": tool.name,
                "source": "builtin",
                "domain": tool.domain,
                "description": getattr(src, "description", "") or "",
                "risk_level": getattr(src, "risk_level", "safe") or "safe",
                "args_schema": getattr(src, "args_schema", None),
                "execution_mode": getattr(src, "execution_mode", "server") or "server",
                "available_modes": getattr(src, "available_modes", None),
                "required_permissions": list(getattr(src, "required_permissions", []) or []),
                "cacheable": bool(getattr(src, "cacheable", False)),
                "module": tool.module,
                "class_name": tool.class_name,
            }
        )
    return records


def _call_name(node: ast.Call) -> str | None:
    func = node.func
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return None


def _dict_string_keys(node: ast.Dict) -> set[str]:
    keys: set[str] = set()
    for key in node.keys:
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            keys.add(key.value)
    return keys


def _is_success_false_dict(node: ast.Dict) -> bool:
    for key, value in zip(node.keys, node.values):
        if (
            isinstance(key, ast.Constant)
            and key.value == "success"
            and isinstance(value, ast.Constant)
            and value.value is False
        ):
            return True
    return False


def _is_failure_status(node: ast.AST | None) -> bool:
    return (
        isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and node.value.lower() in _FAILURE_STATUS_VALUES
    )


def _iter_class_methods(tree: ast.AST, class_name: str) -> list[ast.AST]:
    bodies: list[ast.AST] = []
    for node in tree.body if isinstance(tree, ast.Module) else []:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            bodies.extend(node.body)
    return bodies


def check_source_error_contract(source: str, *, class_name: str) -> list[str]:
    """对单个工具类源码做失败 envelope 静态检查。

    支持边界：
    - ``return {"success": False, ...}``
    - ``return json.dumps({"success": False, ...})``
    - 同一函数内变量仅赋值一次且值为 dict，随后 ``return 变量`` 或
      ``return json.dumps(变量)``
    - 嵌套同步/异步函数、lambda、局部 class 各自在独立作用域中继续审计，
      不污染外层变量赋值计数

    刻意不推断跨函数返回、属性/下标写入、dict.update、变量多次赋值或
    复杂分支合流；这些路径应直接改用标准 helper，避免静态审计猜测。
    """
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return [f"source parse error: {exc}"]

    method_nodes = _iter_class_methods(tree, class_name)
    if not method_nodes:
        return [f"class {class_name} not found in source"]

    violations: list[str] = []

    class Visitor(ast.NodeVisitor):
        def __init__(self, root_scope: ast.AST) -> None:
            self.root_scope = root_scope
            self.assignments: dict[str, list[ast.AST]] = {}

        def _visit_scope(self, node: ast.AST) -> None:
            if node is self.root_scope:
                self.generic_visit(node)
            else:
                Visitor(node).visit(node)

        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            self._visit_scope(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            self._visit_scope(node)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            if node is self.root_scope:
                self._check_expr(node.body)
                self.generic_visit(node)
            else:
                Visitor(node).visit(node)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            self._visit_scope(node)

        def visit_Assign(self, node: ast.Assign) -> None:
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                self.assignments.setdefault(node.targets[0].id, []).append(node.value)
            self.generic_visit(node)

        def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
            if isinstance(node.target, ast.Name) and node.value is not None:
                self.assignments.setdefault(node.target.id, []).append(node.value)
            self.generic_visit(node)

        def visit_Return(self, node: ast.Return) -> None:
            value = node.value
            if value is None:
                return
            self._check_expr(value)
            self.generic_visit(node)

        def _check_expr(self, expr: ast.AST) -> None:
            if isinstance(expr, ast.Name):
                assigned = self.assignments.get(expr.id, [])
                if len(assigned) == 1 and isinstance(assigned[0], ast.Dict):
                    self._check_expr(assigned[0])
                return
            if isinstance(expr, ast.Call):
                name = _call_name(expr)
                if name in _HELPER_NAMES:
                    return
                # json.dumps({...}) / dumps({...})
                if name in {"dumps", "json_dumps"} and expr.args:
                    self._check_expr(expr.args[0])
                    return
                for arg in expr.args:
                    self._check_expr(arg)
                for kw in expr.keywords:
                    if kw.value is not None:
                        self._check_expr(kw.value)
                return
            if isinstance(expr, ast.Dict) and _is_success_false_dict(expr):
                keys = _dict_string_keys(expr)
                missing = sorted(_REQUIRED_FAILURE_KEYS - keys)
                if missing:
                    violations.append(
                        f"failure dict missing {', '.join(missing)} "
                        f"(need error + error_kind + hint, or use json_tool_error/build_tool_error)"
                    )

    for method in method_nodes:
        Visitor(method).visit(method)
    return violations


@dataclass
class _TraceResult:
    violations: list[str]
    evidence: list[ContractEvidence]
    safe: bool


def _callable_label(fn: Callable[..., object]) -> str:
    qualname = getattr(fn, "__qualname__", getattr(fn, "__name__", "<callable>"))
    return qualname.split(".<locals>.")[-1]


def _function_ast(
    fn: Callable[..., object],
) -> tuple[ast.FunctionDef | ast.AsyncFunctionDef | None, str | None]:
    try:
        source = textwrap.dedent(inspect.getsource(fn))
    except (OSError, TypeError) as exc:
        return None, f"cannot read callable source: {type(exc).__name__}"
    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        return None, f"callable source parse error: {exc}"
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            return node, None
    return None, "callable source has no function definition"


def _direct_scope_facts(
    root: ast.FunctionDef | ast.AsyncFunctionDef,
) -> tuple[list[ast.Return], dict[str, list[ast.AST]]]:
    returns: list[ast.Return] = []
    assignments: dict[str, list[ast.AST]] = {}

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            if node is root:
                self.generic_visit(node)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            if node is root:
                self.generic_visit(node)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            return

        def visit_Return(self, node: ast.Return) -> None:
            returns.append(node)

        def visit_Assign(self, node: ast.Assign) -> None:
            if len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                assignments.setdefault(node.targets[0].id, []).append(node.value)
            elif (
                len(node.targets) == 1
                and isinstance(node.targets[0], (ast.Tuple, ast.List))
            ):
                for index, target in enumerate(node.targets[0].elts):
                    if isinstance(target, ast.Name):
                        assignments.setdefault(target.id, []).append(
                            ast.Subscript(
                                value=node.value,
                                slice=ast.Constant(value=index),
                                ctx=ast.Load(),
                            )
                        )
            self.generic_visit(node)

        def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
            if isinstance(node.target, ast.Name) and node.value is not None:
                assignments.setdefault(node.target.id, []).append(node.value)
            self.generic_visit(node)

        def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
            if isinstance(node.target, ast.Name):
                assignments.setdefault(node.target.id, []).append(node.value)
            self.generic_visit(node)

    Visitor().visit(root)
    return returns, assignments


def _local_binding_names(fn: Callable[..., object]) -> set[str]:
    """Return Python's complete local-binding set for the current function.

    ``symtable`` follows Python scope semantics for parameters, assignments in
    any control-flow branch, loop/with/except targets, imports, and walrus
    expressions while keeping nested function/class scopes separate.
    """
    try:
        source = textwrap.dedent(inspect.getsource(fn))
        module_table = symtable.symtable(
            source,
            getattr(fn, "__code__", None).co_filename
            if getattr(fn, "__code__", None) is not None
            else "<audit>",
            "exec",
        )
    except (OSError, SyntaxError, TypeError):
        return set()

    function_name = getattr(fn, "__name__", "")
    candidates = [
        child
        for child in module_table.get_children()
        if child.get_type() == "function" and child.get_name() == function_name
    ]
    if not candidates:
        return set()
    table = candidates[0]
    return {
        symbol.get_name()
        for symbol in table.get_symbols()
        if symbol.is_local() or symbol.is_parameter() or symbol.is_imported()
    }


@dataclass(frozen=True)
class _ScopeBindingFacts:
    local_names: frozenset[str]
    shadow_names: frozenset[str]
    imports: tuple[tuple[str, str, str], ...]


def _current_scope_binding_facts(fn: Callable[..., object]) -> _ScopeBindingFacts:
    """Collect imports and non-import shadows from only the current function."""
    root, _ = _function_ast(fn)
    local_names = _local_binding_names(fn)
    if root is None:
        return _ScopeBindingFacts(
            local_names=frozenset(local_names),
            shadow_names=frozenset(),
            imports=(),
        )

    shadow_names: set[str] = set()
    imports: list[tuple[str, str, str]] = []

    def add_arguments(arguments: ast.arguments) -> None:
        for argument in (
            *arguments.posonlyargs,
            *arguments.args,
            *arguments.kwonlyargs,
        ):
            shadow_names.add(argument.arg)
        if arguments.vararg is not None:
            shadow_names.add(arguments.vararg.arg)
        if arguments.kwarg is not None:
            shadow_names.add(arguments.kwarg.arg)

    class Visitor(ast.NodeVisitor):
        def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
            if node is root:
                add_arguments(node.args)
                for statement in node.body:
                    self.visit(statement)
            else:
                shadow_names.add(node.name)

        def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
            if node is root:
                add_arguments(node.args)
                for statement in node.body:
                    self.visit(statement)
            else:
                shadow_names.add(node.name)

        def visit_ClassDef(self, node: ast.ClassDef) -> None:
            shadow_names.add(node.name)

        def visit_Lambda(self, node: ast.Lambda) -> None:
            return

        def _visit_comprehension(
            self,
            generators: list[ast.comprehension],
            values: Sequence[ast.AST],
        ) -> None:
            # Comprehension targets live in their own implicit function scope.
            for generator in generators:
                self.visit(generator.iter)
                for condition in generator.ifs:
                    self.visit(condition)
            for value in values:
                self.visit(value)

        def visit_ListComp(self, node: ast.ListComp) -> None:
            self._visit_comprehension(node.generators, [node.elt])

        def visit_SetComp(self, node: ast.SetComp) -> None:
            self._visit_comprehension(node.generators, [node.elt])

        def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
            self._visit_comprehension(node.generators, [node.elt])

        def visit_DictComp(self, node: ast.DictComp) -> None:
            self._visit_comprehension(node.generators, [node.key, node.value])

        def visit_Name(self, node: ast.Name) -> None:
            if isinstance(node.ctx, ast.Store):
                shadow_names.add(node.id)

        def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
            if isinstance(node.name, str):
                shadow_names.add(node.name)
            if node.type is not None:
                self.visit(node.type)
            for statement in node.body:
                self.visit(statement)

        def visit_Import(self, node: ast.Import) -> None:
            for alias in node.names:
                bound_name = alias.asname or alias.name.split(".", 1)[0]
                imports.append((bound_name, alias.name, ""))

        def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
            relative = "." * node.level + (node.module or "")
            try:
                module_name = importlib.util.resolve_name(relative, fn.__module__)
            except (ImportError, ValueError):
                return
            for alias in node.names:
                bound_name = alias.asname or alias.name
                imports.append((bound_name, module_name, alias.name))

    Visitor().visit(root)
    return _ScopeBindingFacts(
        local_names=frozenset(local_names),
        shadow_names=frozenset(shadow_names.intersection(local_names)),
        imports=tuple(imports),
    )


def _resolve_current_scope_import(
    bound_name: str,
    *,
    fn: Callable[..., object],
) -> Callable[..., object] | None:
    facts = _current_scope_binding_facts(fn)
    if bound_name in facts.shadow_names:
        return None
    matches = [
        (module_name, imported_name)
        for name, module_name, imported_name in facts.imports
        if name == bound_name and imported_name
    ]
    if len(matches) != 1:
        return None
    module_name, imported_name = matches[0]
    if not module_name.startswith("apps."):
        return None
    try:
        imported = importlib.import_module(module_name)
    except Exception:
        return None
    candidate = getattr(imported, imported_name, None)
    return candidate if inspect.isfunction(candidate) else None


def _resolve_static_call(
    call: ast.Call,
    *,
    fn: Callable[..., object],
    owner_cls: type[BaseTool],
) -> Callable[..., object] | None:
    target = call.func
    if isinstance(target, ast.Name):
        facts = _current_scope_binding_facts(fn)
        if target.id in facts.local_names:
            return _resolve_current_scope_import(target.id, fn=fn)
        else:
            candidate = fn.__globals__.get(target.id)
            if inspect.isfunction(candidate):
                return candidate
        return None
    if (
        isinstance(target, ast.Attribute)
        and isinstance(target.value, ast.Name)
        and target.value.id in {"self", "cls"}
    ):
        candidate = getattr(owner_cls, target.attr, None)
        if inspect.ismethod(candidate):
            candidate = candidate.__func__
        return candidate if inspect.isfunction(candidate) else None
    return None


def _canonical_helper_name(
    call: ast.Call,
    *,
    fn: Callable[..., object],
    owner_cls: type[BaseTool],
) -> str | None:
    """Return helper name only when the call resolves to the envelope definition."""
    resolved = _resolve_static_call(call, fn=fn, owner_cls=owner_cls)
    for canonical_name, helper in _CANONICAL_HELPERS.items():
        if resolved is helper:
            if isinstance(call.func, ast.Name):
                facts = _current_scope_binding_facts(fn)
                if call.func.id in facts.local_names:
                    matching_imports = [
                        (module_name, imported_name)
                        for bound_name, module_name, imported_name in facts.imports
                        if bound_name == call.func.id
                    ]
                    if matching_imports != [
                        (_CANONICAL_HELPER_MODULE, canonical_name)
                    ]:
                        return None
            return canonical_name
    return None


def _analyze_success_helper_argument(
    expr: ast.AST,
    *,
    fn: Callable[..., object],
    owner_cls: type[BaseTool],
    assignments: dict[str, list[ast.AST]],
    path: str,
    stack: tuple[int, ...],
    serialized: bool = False,
) -> _TraceResult:
    """Reject known failure literals wrapped by ``tool_result_success``."""
    if isinstance(expr, ast.Name):
        values = assignments.get(expr.id, [])
        if not values:
            # Dynamic / unresolved input is why callers use the success helper.
            return _TraceResult([], [], True)
        return _merge_trace(
            [
                _analyze_success_helper_argument(
                    value,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=path,
                    stack=stack,
                    serialized=serialized,
                )
                for value in values
            ]
        )
    if isinstance(expr, ast.Dict):
        if _is_success_false_dict(expr):
            return _TraceResult(
                [f"{path}: success helper cannot wrap a failure dict"],
                [],
                False,
            )
        success_value: ast.AST | None = None
        status_value: ast.AST | None = None
        keys = _dict_string_keys(expr)
        for key, value in zip(expr.keys, expr.values):
            if isinstance(key, ast.Constant) and key.value == "success":
                success_value = value
            if isinstance(key, ast.Constant) and key.value == "status":
                status_value = value
        if isinstance(success_value, ast.Constant) and success_value.value is True:
            if (_FAILURE_MARKER_KEYS & keys) or _is_failure_status(status_value):
                return _TraceResult(
                    [f"{path}: success helper cannot wrap a contradictory success dict"],
                    [],
                    False,
                )
            return _TraceResult([], [], True)
        if success_value is not None:
            return _TraceResult(
                [f"{path}: success helper cannot wrap a non-success dict"],
                [],
                False,
            )
        if status_value is not None:
            if _FAILURE_MARKER_KEYS & keys:
                return _TraceResult(
                    [f"{path}: success helper cannot wrap status+error dict"],
                    [],
                    False,
                )
            if (
                isinstance(status_value, ast.Constant)
                and isinstance(status_value.value, str)
                and status_value.value.lower() in _SUCCESS_STATUS_VALUES
            ):
                return _TraceResult([], [], True)
            if serialized and not _is_failure_status(status_value):
                return _TraceResult([], [], True)
            return _TraceResult(
                [f"{path}: success helper cannot wrap unsafe status dict"],
                [],
                False,
            )
        if _FAILURE_MARKER_KEYS & keys:
            return _TraceResult(
                [f"{path}: success helper cannot wrap error-bearing dict"],
                [],
                False,
            )
        if serialized:
            return _TraceResult([], [], True)
        return _TraceResult(
            [f"{path}: success helper cannot wrap unknown dict"],
            [],
            False,
        )
    if isinstance(expr, ast.Call):
        nested_helper = _canonical_helper_name(expr, fn=fn, owner_cls=owner_cls)
        if nested_helper in _HELPER_NAMES:
            return _TraceResult(
                [f"{path}: success helper cannot wrap a failure helper"],
                [],
                False,
            )
        if _call_name(expr) in {"dumps", "json_dumps"} and expr.args:
            return _analyze_success_helper_argument(
                expr.args[0],
                fn=fn,
                owner_cls=owner_cls,
                assignments=assignments,
                path=path,
                stack=stack,
                serialized=True,
            )
        return _TraceResult([], [], True)
    if isinstance(expr, (ast.Constant, ast.Attribute, ast.Subscript)):
        return _TraceResult([], [], True)
    if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
        return _merge_trace(
            [
                _analyze_success_helper_argument(
                    element,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=path,
                    stack=stack,
                    serialized=serialized,
                )
                for element in expr.elts
            ]
        )
    return _TraceResult([], [], True)


def _merge_trace(parts: Sequence[_TraceResult]) -> _TraceResult:
    return _TraceResult(
        violations=[item for part in parts for item in part.violations],
        evidence=[item for part in parts for item in part.evidence],
        safe=all(part.safe for part in parts),
    )


def _analyze_return_expr(
    expr: ast.AST | None,
    *,
    fn: Callable[..., object],
    owner_cls: type[BaseTool],
    assignments: dict[str, list[ast.AST]],
    path: str,
    stack: tuple[int, ...],
    serialized: bool = False,
) -> _TraceResult:
    if expr is None or isinstance(expr, ast.Constant):
        return _TraceResult([], [], True)
    if isinstance(expr, ast.Await):
        return _analyze_return_expr(
            expr.value,
            fn=fn,
            owner_cls=owner_cls,
            assignments=assignments,
            path=path,
            stack=stack,
            serialized=serialized,
        )
    if isinstance(expr, ast.IfExp):
        return _merge_trace(
            [
                _analyze_return_expr(
                    branch,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=path,
                    stack=stack,
                    serialized=serialized,
                )
                for branch in (expr.body, expr.orelse)
            ]
        )
    if isinstance(expr, ast.Name):
        values = assignments.get(expr.id, [])
        if not values:
            return _TraceResult(
                [f"{path}: return value {expr.id!r} is not statically resolved"],
                [],
                False,
            )
        return _merge_trace(
            [
                _analyze_return_expr(
                    value,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=path,
                    stack=stack,
                    serialized=serialized,
                )
                for value in values
            ]
        )
    if (
        isinstance(expr, ast.Subscript)
        and isinstance(expr.value, ast.Call)
        and isinstance(expr.slice, ast.Constant)
        and isinstance(expr.slice.value, int)
    ):
        dependency = _resolve_static_call(expr.value, fn=fn, owner_cls=owner_cls)
        if dependency is None:
            return _TraceResult(
                [f"{path}: tuple-producing call is not statically resolved"],
                [],
                False,
            )
        return _analyze_callable_tuple_element(
            dependency,
            index=expr.slice.value,
            owner_cls=owner_cls,
            path=f"{path} -> {_callable_label(dependency)}[{expr.slice.value}]",
            stack=stack,
        )
    if isinstance(expr, ast.Dict):
        keys = _dict_string_keys(expr)
        if _is_success_false_dict(expr):
            missing = sorted(_REQUIRED_FAILURE_KEYS - keys)
            if missing:
                return _TraceResult(
                    [
                        f"{path}: failure dict missing {', '.join(missing)} "
                        "(need error + error_kind + hint, or use a standard helper)"
                    ],
                    [],
                    False,
                )
            return _TraceResult(
                [],
                [
                    ContractEvidence(
                        kind="inline_standard_failure",
                        path=path,
                        detail="inline failure dict contains success:false/error/error_kind/hint",
                    )
                ],
                True,
            )
        success_value: ast.AST | None = None
        status_value: ast.AST | None = None
        for key, value in zip(expr.keys, expr.values):
            if isinstance(key, ast.Constant) and key.value == "success":
                success_value = value
            if isinstance(key, ast.Constant) and key.value == "status":
                status_value = value
        if isinstance(success_value, ast.Constant) and success_value.value is True:
            failure_markers = sorted(_FAILURE_MARKER_KEYS & keys)
            if failure_markers:
                return _TraceResult(
                    [
                        f"{path}: literal success dict contains failure markers "
                        f"{', '.join(failure_markers)}"
                    ],
                    [],
                    False,
                )
            if _is_failure_status(status_value):
                return _TraceResult(
                    [
                        f"{path}: literal success dict contains failure status "
                        f"{status_value.value!r}"
                    ],
                    [],
                    False,
                )
            return _TraceResult([], [], True)
        if success_value is not None:
            return _TraceResult(
                [f"{path}: success field is not the literal True/False contract"],
                [],
                False,
            )
        if status_value is not None:
            failure_markers = sorted(_FAILURE_MARKER_KEYS & keys)
            if failure_markers:
                return _TraceResult(
                    [
                        f"{path}: status dict contains failure markers "
                        f"{', '.join(failure_markers)}"
                    ],
                    [],
                    False,
                )
            if (
                isinstance(status_value, ast.Constant)
                and isinstance(status_value.value, str)
                and status_value.value.lower() in _SUCCESS_STATUS_VALUES
            ):
                return _TraceResult([], [], True)
            return _TraceResult(
                [f"{path}: status field is not a statically successful status"],
                [],
                False,
            )
        if "error" in keys:
            return _TraceResult(
                [
                    f"{path}: returned error dict has no success=false/error_kind/hint "
                    "contract"
                ],
                [],
                False,
            )
        if serialized:
            return _TraceResult(
                [
                    f"{path}: serialized dict lacks an explicit success contract"
                ],
                [],
                False,
            )
        return _TraceResult(
            [f"{path}: returned dict lacks an explicit success contract"],
            [],
            False,
        )
    if isinstance(expr, (ast.List, ast.Tuple, ast.Set)):
        return _merge_trace(
            [
                _analyze_return_expr(
                    element,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=path,
                    stack=stack,
                    serialized=serialized,
                )
                for element in expr.elts
            ]
        )
    if isinstance(expr, ast.Call):
        name = _call_name(expr)
        canonical = _canonical_helper_name(expr, fn=fn, owner_cls=owner_cls)
        if canonical in _HELPER_NAMES:
            return _TraceResult(
                [],
                [
                    ContractEvidence(
                        kind="direct_helper",
                        path=f"{path} -> {canonical}",
                        detail="calls standard error-envelope helper",
                    )
                ],
                True,
            )
        if canonical in _SUCCESS_HELPER_NAMES:
            arg_traces = [
                _analyze_success_helper_argument(
                    argument,
                    fn=fn,
                    owner_cls=owner_cls,
                    assignments=assignments,
                    path=f"{path} -> {canonical}",
                    stack=stack,
                )
                for argument in expr.args
            ]
            for keyword in expr.keywords:
                if keyword.value is not None:
                    arg_traces.append(
                        _analyze_success_helper_argument(
                            keyword.value,
                            fn=fn,
                            owner_cls=owner_cls,
                            assignments=assignments,
                            path=f"{path} -> {canonical}",
                            stack=stack,
                        )
                    )
            if arg_traces:
                merged_args = _merge_trace(arg_traces)
                if merged_args.violations:
                    return merged_args
            return _TraceResult(
                [],
                [
                    ContractEvidence(
                        kind="safe_no_failure",
                        path=f"{path} -> {canonical}",
                        detail="calls explicit successful tool-result helper",
                    )
                ],
                True,
            )
        if name in (_HELPER_NAMES | _SUCCESS_HELPER_NAMES) and canonical is None:
            return _TraceResult(
                [
                    f"{path}: call {name!r} is not the canonical error-envelope helper"
                ],
                [],
                False,
            )
        if name in {"dumps", "json_dumps"} and expr.args:
            return _analyze_return_expr(
                expr.args[0],
                fn=fn,
                owner_cls=owner_cls,
                assignments=assignments,
                path=path,
                stack=stack,
                serialized=True,
            )
        dependency = _resolve_static_call(expr, fn=fn, owner_cls=owner_cls)
        if dependency is None:
            return _TraceResult(
                [f"{path}: returned call {name or '<dynamic>'!r} is not statically resolved"],
                [],
                False,
            )
        dependency_label = _callable_label(dependency)
        traced = _analyze_callable_contract(
            dependency,
            owner_cls=owner_cls,
            path=f"{path} -> {dependency_label}",
            stack=stack,
        )
        argument_dependencies: list[_TraceResult] = []
        for argument in expr.args:
            if not isinstance(argument, ast.Name):
                continue
            for assigned in assignments.get(argument.id, []):
                if not isinstance(assigned, ast.Call):
                    continue
                assigned_dependency = _resolve_static_call(
                    assigned,
                    fn=fn,
                    owner_cls=owner_cls,
                )
                if assigned_dependency is None:
                    continue
                argument_dependencies.append(
                    _analyze_return_expr(
                        assigned,
                        fn=fn,
                        owner_cls=owner_cls,
                        assignments=assignments,
                        path=path,
                        stack=stack,
                    )
                )
        traced = _merge_trace([traced, *argument_dependencies])
        return _TraceResult(
            violations=traced.violations,
            evidence=[
                ContractEvidence(
                    kind=(
                        "audited_call_chain"
                        if evidence.kind != "safe_no_failure"
                        else evidence.kind
                    ),
                    path=evidence.path,
                    detail=(
                        "resolved callable chain reaches audited failure construction"
                        if evidence.kind != "safe_no_failure"
                        else evidence.detail
                    ),
                )
                for evidence in traced.evidence
            ],
            safe=traced.safe,
        )
    return _TraceResult(
        [f"{path}: return expression {type(expr).__name__} is not statically resolved"],
        [],
        False,
    )


def _analyze_callable_contract(
    fn: Callable[..., object],
    *,
    owner_cls: type[BaseTool],
    path: str,
    stack: tuple[int, ...],
) -> _TraceResult:
    identity = id(fn)
    if identity in stack:
        return _TraceResult(
            [f"{path}: callable cycle detected"],
            [],
            False,
        )
    root, error = _function_ast(fn)
    if error or root is None:
        return _TraceResult([f"{path}: {error or 'missing function source'}"], [], False)
    returns, assignments = _direct_scope_facts(root)
    if not returns:
        return _TraceResult([f"{path}: callable has no return path"], [], False)
    merged = _merge_trace(
        [
            _analyze_return_expr(
                node.value,
                fn=fn,
                owner_cls=owner_cls,
                assignments=assignments,
                path=path,
                stack=(*stack, identity),
            )
            for node in returns
        ]
    )
    return merged


def _analyze_callable_tuple_element(
    fn: Callable[..., object],
    *,
    index: int,
    owner_cls: type[BaseTool],
    path: str,
    stack: tuple[int, ...],
) -> _TraceResult:
    identity = id(fn)
    if identity in stack:
        return _TraceResult([f"{path}: callable cycle detected"], [], False)
    root, error = _function_ast(fn)
    if error or root is None:
        return _TraceResult([f"{path}: {error or 'missing function source'}"], [], False)
    returns, assignments = _direct_scope_facts(root)
    parts: list[_TraceResult] = []
    for node in returns:
        value = node.value
        if not isinstance(value, (ast.Tuple, ast.List)) or index >= len(value.elts):
            parts.append(
                _TraceResult(
                    [f"{path}: return is not a tuple with element {index}"],
                    [],
                    False,
                )
            )
            continue
        parts.append(
            _analyze_return_expr(
                value.elts[index],
                fn=fn,
                owner_cls=owner_cls,
                assignments=assignments,
                path=path,
                stack=(*stack, identity),
            )
        )
    return _merge_trace(parts)


def analyze_tool_error_contract(tool_cls: type[BaseTool]) -> ContractAnalysis:
    """Trace the effective run method through inherited methods/local wrappers."""
    run_fn = getattr(tool_cls, "run", None)
    if inspect.ismethod(run_fn):
        run_fn = run_fn.__func__
    if not inspect.isfunction(run_fn):
        return ContractAnalysis(
            violations=(f"{tool_cls.__name__}.run is not inspectable",),
            evidence=(),
        )
    root_path = f"{tool_cls.__name__}.run"
    traced = _analyze_callable_contract(
        run_fn,
        owner_cls=tool_cls,
        path=root_path,
        stack=(),
    )
    violations = tuple(dict.fromkeys(traced.violations))
    evidence = tuple(dict.fromkeys(traced.evidence))
    if not violations and not evidence:
        if traced.safe:
            evidence = (
                ContractEvidence(
                    kind="safe_no_failure",
                    path=root_path,
                    detail="all statically resolved returns are success-only",
                ),
            )
        else:
            violations = (f"{root_path}: no verifiable failure contract evidence",)
    return ContractAnalysis(violations=violations, evidence=evidence)


def _read_class_source(tool_cls: type[BaseTool]) -> tuple[str | None, str | None]:
    try:
        source = inspect.getsource(tool_cls)
        return source, None
    except (OSError, TypeError) as exc:
        return None, f"cannot read source: {exc}"


def audit_error_protocol(
    tools: Sequence[InServiceTool] | None = None,
) -> list[ProtocolFinding]:
    """对在役工具跑错误协议审计，返回 findings。"""
    if tools is None:
        discovery = discover_in_service_tools_result()
        inventory = list(discovery.tools)
        collector_failures = discovery.collector_failures
    else:
        inventory = list(tools)
        collector_failures = ()
    findings: list[ProtocolFinding] = []

    for failure in collector_failures:
        findings.append(
            ProtocolFinding(
                tool_name=failure.domain,
                severity="fail",
                code="collector_failure",
                message=(
                    f"{failure.collector} {failure.phase} failed: "
                    f"{failure.error_type}: {failure.message}"
                ),
            )
        )

    if not inventory:
        findings.append(
            ProtocolFinding(
                tool_name="*",
                severity="fail",
                code="empty_inventory",
                message=(
                    "未发现在役 BaseTool（domain collectors 为空）。"
                    "错误协议审计不能因 ToolHub 退役而静默通过。"
                ),
            )
        )
    else:
        findings.append(
            ProtocolFinding(
                tool_name="*",
                severity="pass",
                code="inventory_non_empty",
                message=f"发现 {len(inventory)} 个在役 BaseTool（domain collectors）",
            )
        )

    inventory_names = {tool.name for tool in inventory}
    for missing_name in sorted(ERROR_ENVELOPE_COMPLIANT_TOOLS - inventory_names):
        findings.append(
            ProtocolFinding(
                tool_name=missing_name,
                severity="fail",
                code="compliant_missing",
                message=(
                    "工具已声明 error-envelope compliant，"
                    "但未出现在 domain collector inventory"
                ),
            )
        )

    for tool in inventory:
        if tool.name in ERROR_ENVELOPE_COMPLIANT_TOOLS:
            analysis = analyze_tool_error_contract(tool.tool_cls)
            if analysis.violations:
                for msg in analysis.violations:
                    findings.append(
                        ProtocolFinding(
                            tool_name=tool.name,
                            severity="fail",
                            code="contract_violation",
                            message=msg,
                        )
                    )
            else:
                findings.append(
                    ProtocolFinding(
                        tool_name=tool.name,
                        severity="pass",
                        code="contract_ok",
                        message=(
                            "verified evidence: "
                            + "; ".join(
                                f"{evidence.kind}={evidence.path}"
                                for evidence in analysis.evidence
                            )
                        ),
                    )
                )
        else:
            findings.append(
                ProtocolFinding(
                    tool_name=tool.name,
                    severity="warn",
                    code="pending_migration",
                    message=(
                        f"domain={tool.domain} 尚未迁移到标准 error envelope "
                        f"（当前强制 {len(ERROR_ENVELOPE_COMPLIANT_TOOLS)} 个合规工具）"
                    ),
                )
            )

    return findings


def summarize_error_protocol(findings: Sequence[ProtocolFinding]) -> dict[str, int]:
    discovered = 0
    for f in findings:
        if f.code == "inventory_non_empty":
            # message: "发现 N 个..."
            parts = f.message.split()
            for i, part in enumerate(parts):
                if part.isdigit() and i + 1 < len(parts) and parts[i + 1].startswith("个"):
                    discovered = int(part)
                    break
    if discovered == 0:
        discovered = len({f.tool_name for f in findings if f.tool_name != "*"})

    return {
        "discovered": discovered,
        "compliant_checked": sum(1 for f in findings if f.code in {"contract_ok", "contract_violation"}),
        "pending": sum(1 for f in findings if f.code == "pending_migration"),
        "hard_failures": sum(1 for f in findings if f.severity == "fail"),
    }


def error_protocol_has_hard_failures(findings: Sequence[ProtocolFinding]) -> bool:
    return any(f.severity == "fail" for f in findings)


__all__ = [
    "CollectorFailure",
    "ContractAnalysis",
    "ContractEvidence",
    "DiscoveryResult",
    "ERROR_ENVELOPE_COMPLIANT_TOOLS",
    "InServiceTool",
    "ProtocolFinding",
    "analyze_tool_error_contract",
    "audit_error_protocol",
    "check_source_error_contract",
    "discover_in_service_tool_records",
    "discover_in_service_tools",
    "discover_in_service_tools_result",
    "error_protocol_has_hard_failures",
    "summarize_error_protocol",
]
