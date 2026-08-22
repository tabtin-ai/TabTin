"""
审计工具注册完整性（对照 BACKEND_TOOL / FRONTEND_TOOL / SKILL_GUIDE 规范）。

对必填项做格式校验（name 命名、risk_level 合法值、available_modes 一致性等），
可选项仅提示缺失。

用法:
    python manage.py audit_tools                      # 全部工具概览
    python manage.py audit_tools --tool sql_query      # 单个工具详情
    python manage.py audit_tools --domain sql          # 按域筛选
    python manage.py audit_tools --uncovered           # 仅无 Skill 覆盖的工具
    python manage.py audit_tools --strict              # 必填项失败时退出码 1
    python manage.py audit_tools --verbose             # 每个工具的详细检查
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from django.core.management.base import BaseCommand

from apps.services.repo_root import get_repo_root

_PROJECT_ROOT = get_repo_root()
_CLI_CMD_DIR = _PROJECT_ROOT / "packages" / "tabtin-cli-go" / "cmd"
_CLI_CORE_COMMANDS = _PROJECT_ROOT / "packages" / "tabtin-cli-go" / "cmd" / "apps.go"
_CLI_INDEX = _PROJECT_ROOT / "packages" / "tabtin-cli-go" / "cmd" / "root.go"
_CLI_EXTENSION_PROXY = _PROJECT_ROOT / "packages" / "tabtin-cli-go" / "cmd" / "apps.go"
_CLI_ROUTES_DIR = _PROJECT_ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "routes"
_CLI_SERVER = _PROJECT_ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "cli-server.ts"
_CLI_EXT_ROUTE = _CLI_ROUTES_DIR / "extensions.ts"
_EXT_URLS = _PROJECT_ROOT / "apps" / "tabtin_django" / "apps" / "extensions" / "urls.py"
_FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---", re.DOTALL)
_TOOL_NAME_RE = re.compile(r"^[a-z][a-z0-9]*([_-][a-z0-9]+)*(\.[a-z][a-z0-9]*([_-][a-z0-9]+)*)*$")

FAIL = "✗"
WARN = "⚠"
HINT = "ℹ"
PASS = "✓"
SKIP = "—"

_VALID_RISKS = frozenset({"safe", "review", "strict"})

# 不需要 cli-server 独立路由的 CLI 命令（直连 Django 或仅复用已有通用路由）
_CLI_NO_SERVER_ROUTE = frozenset({"doctor", "speech"})
_CLI_HELPER_MODULES = frozenset({"extension-proxy"})

# 允许的前后端双注册工具（已确认属于同名多实现策略，不应持续 WARN 轰炸）
_APPROVED_CROSS_SOURCE_NAMES = frozenset({
    "read_file", "write_file", "edit_file", "delete_file",
    "glob_search", "grep_search",
    "read_lints", "git_status", "git_diff",
    "execute_in_terminal", "write_to_terminal",
    "read_terminal_output", "list_terminal_sessions",
})

_LOAD_ERRORS: list[str] = []


def _record_load_error(scope: str, exc: Exception) -> None:
    _LOAD_ERRORS.append(f"{scope}: {type(exc).__name__}: {exc}")


def _cli_register_fn_name(app_name: str) -> str:
    parts = re.split(r"[^a-zA-Z0-9]+", app_name)
    pascal = "".join(part[:1].upper() + part[1:] for part in parts if part)
    return f"register{pascal}Command"


def _extract_core_command_meta(file_content: str, app_name: str) -> dict[str, Any] | None:
    if not file_content:
        return None
    pattern = re.compile(
        rf"\{{[^{{}}]*name:\s*['\"]{re.escape(app_name)}['\"][^{{}}]*"
        rf"uiVisible:\s*(true|false)[^{{}}]*"
        rf"requiresSkill:\s*(true|false)[^{{}}]*"
        rf"routeMode:\s*['\"]([^'\"]+)['\"][^{{}}]*\}}",
        re.DOTALL,
    )
    match = pattern.search(file_content)
    if not match:
        return None
    return {
        "ui_visible": match.group(1) == "true",
        "requires_skill": match.group(2) == "true",
        "route_mode": match.group(3),
    }

# ── 警告分类 ──
CAT_NAME = "name"
CAT_DESC = "desc"
CAT_RISK = "risk"
CAT_MODES = "modes"
CAT_SCHEMA = "schema"
CAT_PERMS = "perms"
CAT_PARAMS = "params"
CAT_SKILL = "skill"
CAT_CLI = "cli"
CAT_OTHER = "other"
CAT_CROSS = "cross"
CAT_ERROR_PROTOCOL = "error_protocol"

_CAT_LABELS: dict[str, str] = {
    CAT_SKILL: "Skill 覆盖缺失",
    CAT_MODES: "available_modes 未声明",
    CAT_CLI: "CLI 链路 / 文档缺失",
    CAT_DESC: "description 不足",
    CAT_SCHEMA: "args_schema 参数缺 description",
    CAT_PARAMS: "parameters 格式",
    CAT_CROSS: "前后端一致性",
    CAT_ERROR_PROTOCOL: "错误 envelope 协议",
    CAT_OTHER: "其他",
}


# ── Skill 扫描 ──

def _parse_yaml_list(content: str, field: str) -> list[str]:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return []
    fm = match.group(1)
    in_section = False
    items: list[str] = []
    for line in fm.split("\n"):
        stripped = line.strip()
        if stripped.startswith(f"{field}:"):
            remainder = stripped[len(f"{field}:"):].strip()
            if remainder.startswith("["):
                return [i.strip().strip("'\"") for i in remainder.strip("[]").split(",") if i.strip()]
            in_section = True
            continue
        if in_section:
            if stripped.startswith("- "):
                items.append(stripped[2:].strip().strip("'\""))
            elif stripped and not stripped.startswith("#"):
                break
    return items


def _parse_yaml_scalar(content: str, field: str) -> str:
    match = _FRONTMATTER_RE.match(content)
    if not match:
        return ""
    for line in match.group(1).split("\n"):
        stripped = line.strip()
        if stripped.startswith(f"{field}:"):
            return stripped[len(f"{field}:"):].strip().strip("'\"")
    return ""


def _get_extension_dirs() -> list[Path]:
    """从 ToolHub._domain_meta 获取 source=extension 的域名，推断 Extension 模块目录。"""
    ext_dirs: list[Path] = []
    try:
        from apps.services.tools.hub import ToolHub
        for domain, meta in ToolHub._domain_meta.items():
            if meta.get("source") == "extension":
                candidate = _PROJECT_ROOT / "apps" / "tabtin_django" / "apps" / domain
                if candidate.exists():
                    ext_dirs.append(candidate)
    except Exception as exc:
        _record_load_error("ToolHub._domain_meta(extension dirs)", exc)
    return ext_dirs


def _scan_all_skills() -> dict[str, dict]:
    """返回 {skill_name: {tools, activate_tools, sections, description, path}}。"""
    scan_dirs = [
        _PROJECT_ROOT / "packages",
        _PROJECT_ROOT / "apps" / "tabtin_django" / "apps" / "skills" / "bundled",
        *_get_extension_dirs(),
    ]
    result: dict[str, dict] = {}
    for base in scan_dirs:
        if not base.exists():
            continue
        for skill_md in base.rglob("SKILL.md"):
            try:
                content = skill_md.read_text(encoding="utf-8", errors="ignore")
            except Exception as exc:
                _record_load_error(f"read skill file: {skill_md}", exc)
                continue
            tools = _parse_yaml_list(content, "tools")
            activate = _parse_yaml_list(content, "_activate_tools")
            merged = list(dict.fromkeys(tools + activate))
            name = _parse_yaml_scalar(content, "name") or skill_md.parent.name
            desc = _parse_yaml_scalar(content, "description")
            sections = _parse_yaml_list(content, "sections")
            result[name] = {
                "tools": merged,
                "description": desc,
                "sections": sections,
                "path": str(skill_md.relative_to(_PROJECT_ROOT)),
            }
    return result


def _build_coverage(skill_map: dict[str, dict]) -> dict[str, list[str]]:
    cov: dict[str, list[str]] = {}
    for sk_name, sk_info in skill_map.items():
        for t in sk_info["tools"]:
            cov.setdefault(t, []).append(sk_name)
    return cov


# ── 工具收集 ──

def _collect_backend_tools() -> list[dict[str, Any]]:
    """Collect in-service Python BaseTool entries from domain collectors.

    W6 (2026-05-04): ToolHub is retired as the LLM tool registry and must
    not be re-wired here. Domain ``get_all_tools`` / equivalent collectors
    still expose HTTP/CLI-facing BaseTool implementations — that inventory
    is the audit discovery path so ``audit_tools`` never silently passes
    with an empty backend set after ToolHub retirement.
    """
    try:
        from apps.services.tools.error_protocol_audit import (
            discover_in_service_tool_records,
        )
        return discover_in_service_tool_records()  # type: ignore[return-value]
    except Exception as exc:
        _record_load_error("discover_in_service_tool_records", exc)
        return []


def _run_error_protocol_audit() -> tuple[list[tuple[str, str, str]], int]:
    """Run static error-envelope protocol audit.

    Returns (display_rows, hard_fail_count). Display rows are
    (dimension, status, message) compatible with the global check printer.
    """
    rows: list[tuple[str, str, str]] = []
    try:
        from apps.services.tools.error_protocol_audit import (
            audit_error_protocol,
            error_protocol_has_hard_failures,
            summarize_error_protocol,
        )
    except Exception as exc:
        rows.append((
            "错误协议",
            FAIL,
            f"[必填] 无法加载 error_protocol_audit: {type(exc).__name__}: {exc}",
        ))
        return rows, 1

    findings = audit_error_protocol()
    summary = summarize_error_protocol(findings)
    rows.append((
        "错误协议",
        PASS if summary["discovered"] > 0 else FAIL,
        (
            f"[必填] 在役 BaseTool 发现 {summary['discovered']} 个 "
            f"（compliant 已检 {summary['compliant_checked']} / "
            f"pending 迁移 {summary['pending']}）"
        ),
    ))
    pending_names: list[str] = []
    for finding in findings:
        if finding.code in {"inventory_non_empty", "pending_migration"}:
            if finding.code == "pending_migration":
                pending_names.append(finding.tool_name)
            continue
        if finding.severity == "fail":
            status = FAIL
        elif finding.severity == "warn":
            status = WARN
        elif finding.severity == "pass":
            status = PASS
        else:
            status = HINT
        label = finding.tool_name if finding.tool_name != "*" else "全局"
        rows.append((
            "错误协议",
            status,
            f"[{finding.code}] {label}: {finding.message}",
        ))
    if pending_names:
        preview = ", ".join(pending_names[:8])
        more = f" …(+{len(pending_names) - 8})" if len(pending_names) > 8 else ""
        rows.append((
            "错误协议",
            WARN,
            (
                f"[pending_migration] {len(pending_names)} 个在役工具待迁移到标准 envelope"
                f"（仅强制 ERROR_ENVELOPE_COMPLIANT_TOOLS）: {preview}{more}"
            ),
        ))

    hard = 1 if error_protocol_has_hard_failures(findings) else 0
    return rows, hard


def _collect_frontend_tools() -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    try:
        from apps.services.tools.domains.action_tool_manifest import load_action_tool_manifest
        manifest = load_action_tool_manifest()
        for tm in manifest.get("tools") or []:
            tools.append({
                "name": tm.get("name", ""), "source": "frontend",
                "domain": tm.get("appId", "unknown"),
                "description": tm.get("description", ""),
                "risk_level": tm.get("riskLevel", ""),
                "parameters": tm.get("parameters"),
                "tags": tm.get("tags", []),
            })
    except Exception as exc:
        _record_load_error("load_action_tool_manifest", exc)
    return tools


# ── 单工具格式校验 ──

def _check_backend_tool(tool: dict) -> list[tuple[str, str, str]]:
    """返回 [(status, message, category), ...]"""
    checks: list[tuple[str, str, str]] = []
    name = tool["name"]

    if _TOOL_NAME_RE.match(name):
        checks.append((PASS, f"[必填] name='{name}' 命名格式正确", CAT_NAME))
    else:
        checks.append((FAIL, f"[必填] name='{name}' 不符合 snake_case 规范（允许 namespace.tool_name）", CAT_NAME))

    desc = tool.get("description", "")
    if len(desc) >= 30:
        checks.append((PASS, f"[必填] description 足够详细 ({len(desc)} 字符)", CAT_DESC))
    elif desc:
        checks.append((WARN, f"[推荐] description 过短 ({len(desc)} 字符)，建议 ≥30 字符，包含功能+场景+约束", CAT_DESC))
    else:
        checks.append((FAIL, "[必填] 缺少 description", CAT_DESC))

    risk = tool.get("risk_level", "")
    if risk in _VALID_RISKS:
        checks.append((PASS, f"[必填] risk_level='{risk}'", CAT_RISK))
    else:
        checks.append((FAIL, f"[必填] risk_level='{risk}' 不合法（必须为 safe/review/strict）", CAT_RISK))

    modes = tool.get("available_modes")
    if risk in ("review", "strict"):
        if modes is not None:
            checks.append((PASS, f"[推荐] available_modes={modes}（写操作已声明模式限制）", CAT_MODES))
        else:
            checks.append((WARN, f"[推荐] risk_level='{risk}' 建议声明 available_modes=(\"agent\",)", CAT_MODES))
    elif risk == "safe" and modes is not None:
        checks.append((HINT, f"[可选] safe 工具声明了 available_modes={modes}（通常不需要）", CAT_MODES))

    schema = tool.get("args_schema")
    if schema is not None:
        checks.append((PASS, f"[推荐] args_schema: {schema.__name__}", CAT_SCHEMA))
        if hasattr(schema, "model_fields"):
            fields_without_desc = []
            injected_count = 0
            for fname, finfo in schema.model_fields.items():
                if not finfo.description:
                    meta = finfo.metadata or []
                    is_injected = any("InjectedState" in str(m) or "Injected" in str(type(m).__name__) for m in meta)
                    if is_injected:
                        injected_count += 1
                    else:
                        fields_without_desc.append(fname)
            if fields_without_desc:
                checks.append((WARN,
                    f"[推荐] args_schema 参数缺少 Field(description=...): {fields_without_desc}", CAT_SCHEMA))
            else:
                checks.append((PASS, "[推荐] args_schema 所有参数均有 description", CAT_SCHEMA))
            if injected_count > 0:
                checks.append((PASS, f"[推荐] {injected_count} 个 InjectedState 自动注入参数", CAT_SCHEMA))
    else:
        checks.append((HINT, "[可选] 未显式声明 args_schema", CAT_SCHEMA))

    exec_mode = tool.get("execution_mode", "server")
    valid_exec_modes = {"server", "client", "hybrid"}
    if exec_mode in valid_exec_modes:
        checks.append((PASS, f"[推荐] execution_mode='{exec_mode}'", CAT_OTHER))
    else:
        checks.append((WARN, f"[推荐] execution_mode='{exec_mode}' 不合法（应为 server/client/hybrid）", CAT_OTHER))

    perms = tool.get("required_permissions", [])
    if perms:
        checks.append((PASS, f"[可选] required_permissions={perms}", CAT_PERMS))

    return checks


def _check_frontend_tool(tool: dict) -> list[tuple[str, str, str]]:
    """返回 [(status, message, category), ...]"""
    checks: list[tuple[str, str, str]] = []
    name = tool["name"]

    if _TOOL_NAME_RE.match(name):
        checks.append((PASS, f"[必填] name='{name}' 命名格式正确", CAT_NAME))
    else:
        checks.append((FAIL, f"[必填] name='{name}' 不符合命名规范（snake_case 或 namespace.snake_case）", CAT_NAME))

    desc = tool.get("description", "")
    if len(desc) >= 20:
        checks.append((PASS, f"[必填] description 足够 ({len(desc)} 字符)", CAT_DESC))
    elif desc:
        checks.append((WARN, f"[推荐] description 过短 ({len(desc)} 字符)", CAT_DESC))
    else:
        checks.append((FAIL, "[必填] 缺少 description", CAT_DESC))

    risk = tool.get("risk_level", "")
    if risk in _VALID_RISKS:
        checks.append((PASS, f"[必填] riskLevel='{risk}'", CAT_RISK))
    elif risk:
        checks.append((FAIL, f"[必填] riskLevel='{risk}' 不合法（必须为 safe/review/strict）", CAT_RISK))
    else:
        checks.append((FAIL, "[必填] 缺少 riskLevel", CAT_RISK))

    params = tool.get("parameters")
    if params and isinstance(params, dict):
        if params.get("type") == "object" and params.get("properties"):
            n = len(params["properties"])
            checks.append((PASS, f"[必填] parameters: {n} 个参数，格式正确", CAT_PARAMS))
            req = params.get("required", [])
            if req:
                missing = [r for r in req if r not in params["properties"]]
                if missing:
                    checks.append((FAIL, f"[必填] required 中有未定义的参数: {missing}", CAT_PARAMS))
                else:
                    checks.append((PASS, f"[推荐] required 字段: {req}", CAT_PARAMS))
        elif params.get("type") == "object":
            checks.append((PASS, "[必填] parameters 格式正确（无参数工具）", CAT_PARAMS))
        else:
            checks.append((WARN, f"[推荐] parameters.type 应为 'object'，当前: {params.get('type')}", CAT_PARAMS))
    else:
        checks.append((FAIL, "[必填] 缺少 parameters 定义", CAT_PARAMS))

    return checks


def _read_file(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="ignore")
    except Exception:
        return ""


# ── CLI 命令链路检查 ──

def _check_cli_chain(skill_map: dict) -> list[tuple[str, str, str]]:
    """
    CLI 命令完整链路 + 质量审计（与 FC 审计深度对等）。

    连通性检查：
      1. Go CLI cmd/ 下命令定义存在
      2. Go CLI cmd/apps.go 中已注册
      3. Electron cli-server routes/{app}.ts
      4. cli-server.ts 路由挂载
      5. SKILL.md 中有 @cli 分区（必填）

    质量检查（对齐 FC 的 args_schema / risk_level / description 审计）：
      Q1. 参数定义：.option() / .argument() 且带 description
      Q2. 输出格式：支持 --format（Agent 需要 json 输出才能解析）
      Q3. 错误处理：使用 handleCommandError 或等效机制
      Q4. 管道兼容：stdout 输出纯数据（使用 formatOutput / process.stdout.write）
    """
    results: list[tuple[str, str, str]] = []

    if not _CLI_CMD_DIR.exists():
        results.append(("CLI", HINT, "[可选] Go CLI cmd/ 目录不存在，跳过 CLI 检查"))
        return results

    cli_files = sorted(_CLI_CMD_DIR.glob("*.ts"))
    cli_apps = [
        f.stem
        for f in cli_files
        if f.stem != "index" and f.stem not in _CLI_HELPER_MODULES
    ]

    if not cli_apps:
        results.append(("CLI", HINT, "[可选] 无 CLI 命令模块"))
        return results

    results.append(("CLI", PASS, f"发现 {len(cli_apps)} 个 CLI 命令模块: {', '.join(cli_apps)}"))

    core_commands_content = _read_file(_CLI_CORE_COMMANDS)
    cli_server_content = _read_file(_CLI_SERVER)

    cli_skills: dict[str, str] = {}
    for sk_name, sk_info in skill_map.items():
        if "cli" in sk_info.get("sections", []):
            cli_skills[sk_name] = sk_info["path"]

    quality_total = {"option": 0, "format": 0, "error_handling": 0, "pipe": 0}

    for app_name in cli_apps:
        cmd_file = _CLI_CMD_DIR / f"{app_name}.ts"
        cmd_content = _read_file(cmd_file)

        # ── 连通性检查 ──

        register_fn = _cli_register_fn_name(app_name)
        reg_pattern = re.compile(
            rf"(register:\s*{re.escape(register_fn)}\b|\b{re.escape(register_fn)}\s*\()",
        )
        core_meta = _extract_core_command_meta(core_commands_content, app_name)
        if core_commands_content and reg_pattern.search(core_commands_content):
            results.append(("CLI", PASS, f"[必填] {app_name}: Go CLI apps.go 已注册 {register_fn}"))
        elif core_commands_content:
            results.append(("CLI", FAIL, f"[必填] {app_name}: Go CLI apps.go 未注册 {register_fn}"))
        else:
            results.append(("CLI", FAIL, f"[必填] {app_name}: Go CLI apps.go 不可读"))

        route_mode = core_meta.get("route_mode") if core_meta else None
        if route_mode == "cli_server" or (route_mode is None and app_name not in _CLI_NO_SERVER_ROUTE):
            route_file = _CLI_ROUTES_DIR / f"{app_name}.ts"
            if route_file.exists():
                results.append(("CLI", PASS, f"[必填] {app_name}: CLI Server 路由 routes/{app_name}.ts"))
            else:
                results.append(("CLI", FAIL, f"[必填] {app_name}: 缺少 CLI Server 路由 routes/{app_name}.ts"))

            srv_pattern = re.compile(
                rf"(from\s+['\"].*/{re.escape(app_name)}['\"]"
                rf"|/{re.escape(app_name)}/)",
            )
            if cli_server_content and srv_pattern.search(cli_server_content):
                results.append(("CLI", PASS, f"[必填] {app_name}: cli-server.ts 已挂载"))
            elif cli_server_content:
                results.append(("CLI", FAIL, f"[必填] {app_name}: cli-server.ts 未找到挂载"))
        else:
            results.append(("CLI", PASS, f"[必填] {app_name}: 直连 Django/复用通用路由，无需独立 server route"))

        # ── @cli SKILL 分区（必填 — Agent 不读 SKILL 就不知道 CLI 存在） ──
        requires_skill = bool(core_meta.get("requires_skill")) if core_meta else True
        if requires_skill:
            found_skill = False
            for sk_name, sk_path in cli_skills.items():
                if app_name in sk_name.lower() or app_name in sk_path.lower():
                    found_skill = True
                    break
            if found_skill:
                results.append(("CLI", PASS, f"[必填] {app_name}: 有 SKILL.md @cli 分区"))
            else:
                results.append(("CLI", FAIL, f"[必填] {app_name}: 无 SKILL.md @cli 分区（Agent 无法发现此 CLI 能力）"))
        else:
            results.append(("CLI", HINT, f"[可选] {app_name}: 标记为无需 @cli SKILL"))

        # ── 质量检查 ──

        if not cmd_content:
            results.append(("CLI", WARN, f"[质量] {app_name}: 命令文件不可读，跳过质量检查"))
            continue

        # Q1: 参数定义（.option() 或 .argument() 带描述）
        option_matches = re.findall(r"\.\s*option\s*\(", cmd_content)
        arg_matches = re.findall(r"\.\s*argument\s*\(", cmd_content)
        param_count = len(option_matches) + len(arg_matches)
        if param_count > 0:
            quality_total["option"] += 1
            results.append(("CLI", PASS,
                f"[质量] {app_name}: 定义了 {param_count} 个参数 (.option/.argument)"))
        else:
            results.append(("CLI", WARN,
                f"[质量] {app_name}: 未发现 .option()/.argument() 参数定义"))

        # Q2: --format 支持（Agent 需要 json 输出）
        has_format = bool(re.search(r"--format|'-f,\s*--format|formatOutput|OutputFormat", cmd_content))
        if has_format:
            quality_total["format"] += 1
            results.append(("CLI", PASS,
                f"[质量] {app_name}: 支持 --format 输出格式"))
        else:
            results.append(("CLI", WARN,
                f"[质量] {app_name}: 未发现 --format 支持（Agent 依赖 --format json 解析输出）"))

        # Q3: 错误处理
        has_error = bool(re.search(
            r"handleCommandError|handleError|catch\s*\(|\.catch\s*\(|process\.exit\s*\(\s*1\s*\)",
            cmd_content,
        ))
        if has_error:
            quality_total["error_handling"] += 1
            results.append(("CLI", PASS,
                f"[质量] {app_name}: 有错误处理机制"))
        else:
            results.append(("CLI", WARN,
                f"[质量] {app_name}: 未发现错误处理（handleCommandError 或 catch）"))

        # Q4: 管道兼容（stdout 输出纯数据）
        has_stdout = bool(re.search(
            r"process\.stdout\.write|formatOutput|console\.log\s*\(\s*JSON\.stringify",
            cmd_content,
        ))
        if has_stdout:
            quality_total["pipe"] += 1
            results.append(("CLI", PASS,
                f"[质量] {app_name}: 管道兼容（stdout 输出结构化数据）"))
        else:
            results.append(("CLI", WARN,
                f"[质量] {app_name}: 未使用 process.stdout.write / formatOutput（管道传输可能混入日志）"))

    # ── 质量汇总 ──
    total = len(cli_apps)
    if total > 0:
        q_items = [
            ("参数定义", quality_total["option"]),
            ("--format", quality_total["format"]),
            ("错误处理", quality_total["error_handling"]),
            ("管道兼容", quality_total["pipe"]),
        ]
        all_pass = all(n == total for _, n in q_items)
        summary_parts = [f"{label}:{n}/{total}" for label, n in q_items]
        level = PASS if all_pass else WARN
        results.append(("CLI", level,
            f"[质量汇总-Core] {', '.join(summary_parts)}"))

    # ── Extension CLI 检查 ──
    ext_urls_content = _read_file(_EXT_URLS)
    cli_index_content = _read_file(_CLI_INDEX)
    cli_ext_route_content = _read_file(_CLI_EXT_ROUTE)
    if _CLI_EXTENSION_PROXY.exists():
        results.append(("CLI-Ext", PASS, "[必填] extension-proxy.ts 已存在"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] 缺少 Go CLI 扩展命令注册"))

    if ext_urls_content and "cli-commands/" in ext_urls_content:
        results.append(("CLI-Ext", PASS, "[必填] extensions/urls.py 已暴露 cli-commands/"))
    elif ext_urls_content:
        results.append(("CLI-Ext", FAIL, "[必填] extensions/urls.py 未暴露 cli-commands/"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] extensions/urls.py 不可读"))

    if cli_index_content and "/extensions/cli-commands" in cli_index_content:
        results.append(("CLI-Ext", PASS, "[必填] Go CLI 支持动态扩展命令加载"))
    elif cli_index_content:
        results.append(("CLI-Ext", FAIL, "[必填] Go CLI 未发现 /extensions/cli-commands 拉取逻辑"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] Go CLI root.go 不可读"))

    if cli_ext_route_content and "/api/extensions/cli-commands" in cli_ext_route_content:
        results.append(("CLI-Ext", PASS, "[必填] Electron CLI Server extensions 路由已代理到 Django"))
    elif cli_ext_route_content:
        results.append(("CLI-Ext", FAIL, "[必填] extensions CLI 路由存在但未代理 /api/extensions/cli-commands"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] Electron CLI routes/extensions.ts 不可读或缺失"))

    if (
        cli_ext_route_content
        and "/api/extensions${route}" in cli_ext_route_content
        and "djangoRequest(method, djangoPath, body" in cli_ext_route_content
    ):
        results.append(("CLI-Ext", PASS, "[必填] extensions.ts 已提供子命令通用代理（/extensions/* -> /api/extensions/*）"))
    elif cli_ext_route_content:
        results.append(("CLI-Ext", FAIL, "[必填] extensions.ts 缺少子命令通用代理（Extension CLI 无法执行）"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] extensions.ts 不可读，无法校验子命令通用代理"))

    if cli_server_content and "url.startsWith('/extensions/')" in cli_server_content:
        results.append(("CLI-Ext", PASS, "[必填] cli-server.ts 已挂载 /extensions/ 路由"))
    elif cli_server_content:
        results.append(("CLI-Ext", FAIL, "[必填] cli-server.ts 未挂载 /extensions/ 路由"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] cli-server.ts 不可读"))

    if (
        ext_urls_content
        and "execute_extension_cli_command" in ext_urls_content
        and "cli/<str:command_name>/" in ext_urls_content
    ):
        results.append(("CLI-Ext", PASS, "[必填] Django 已暴露 Extension CLI 执行桥接路由"))
    elif ext_urls_content:
        results.append(("CLI-Ext", FAIL, "[必填] Django 未暴露 Extension CLI 执行桥接路由"))
    else:
        results.append(("CLI-Ext", FAIL, "[必填] extensions/urls.py 不可读，无法校验执行桥接路由"))

    try:
        from apps.extensions.registry import ExtensionRegistry
        ext_cmds = ExtensionRegistry.get_all_cli_commands()
        if ext_cmds:
            results.append(("CLI-Ext", PASS,
                f"发现 {len(ext_cmds)} 个 Extension CLI 命令"))
            for cmd in ext_cmds:
                ext_id = cmd.get("extension_id", "?")
                name = cmd.get("name", "?")
                desc = cmd.get("description", "")
                opts = cmd.get("options", [])
                api_ep = cmd.get("api_endpoint", "")
                method = cmd.get("method", "")
                if not desc:
                    results.append(("CLI-Ext", FAIL,
                        f"[必填] {ext_id}.{name}: 缺少 description"))
                else:
                    results.append(("CLI-Ext", PASS,
                        f"[必填] {ext_id}.{name}: description 已声明"))
                if not api_ep:
                    results.append(("CLI-Ext", FAIL,
                        f"[必填] {ext_id}.{name}: 缺少 api_endpoint"))
                else:
                    results.append(("CLI-Ext", PASS,
                        f"[必填] {ext_id}.{name}: api_endpoint={api_ep}"))
                if method not in ("GET", "POST", "PUT", "DELETE", "PATCH"):
                    results.append(("CLI-Ext", WARN,
                        f"[推荐] {ext_id}.{name}: method='{method}' 不是常见 HTTP 方法"))
                if opts:
                    results.append(("CLI-Ext", PASS,
                        f"[质量] {ext_id}.{name}: 定义了 {len(opts)} 个参数选项"))
                    has_format_opt = any("--format" in o.get("flag", "") for o in opts)
                    if has_format_opt:
                        results.append(("CLI-Ext", PASS,
                            f"[质量] {ext_id}.{name}: 支持 --format"))
                    else:
                        results.append(("CLI-Ext", WARN,
                            f"[质量] {ext_id}.{name}: 未声明 --format 选项（Agent 依赖 json 输出）"))
                else:
                    results.append(("CLI-Ext", WARN,
                        f"[质量] {ext_id}.{name}: 未声明参数选项"))
        else:
            results.append(("CLI-Ext", HINT,
                "暂无 Extension CLI 命令注册"))
    except Exception as exc:
        results.append(("CLI-Ext", FAIL, f"[必填] ExtensionRegistry 加载异常: {type(exc).__name__}: {exc}"))

    return results


# ── 前后端 Schema 一致性 ──

def _extract_backend_param_names(tool: dict) -> set[str]:
    """从后端工具的 args_schema 中提取用户可见参数名（排除 InjectedState）。"""
    schema = tool.get("args_schema")
    if schema is None or not hasattr(schema, "model_fields"):
        return set()
    names: set[str] = set()
    for fname, finfo in schema.model_fields.items():
        meta = finfo.metadata or []
        is_injected = any(
            "InjectedState" in str(m) or "Injected" in str(type(m).__name__)
            for m in meta
        )
        if not is_injected:
            names.add(fname)
    return names


def _extract_frontend_param_names(tool: dict) -> set[str]:
    """从前端工具的 parameters 中提取用户可见参数名（排除 internal: true）。"""
    params = tool.get("parameters")
    if not params or not isinstance(params, dict):
        return set()
    props = params.get("properties", {})
    return {
        name for name, spec in props.items()
        if not (isinstance(spec, dict) and spec.get("internal"))
    }


def _check_cross_schema_consistency(
    backend_tools: list, frontend_tools: list,
) -> list[tuple[str, str, str]]:
    """G7: 检查前后端同名工具（双注册）的 risk_level 和 parameters 一致性。"""
    results: list[tuple[str, str, str]] = []

    backend_by_name: dict[str, list[dict[str, Any]]] = {}
    frontend_by_name: dict[str, list[dict[str, Any]]] = {}
    for t in backend_tools:
        backend_by_name.setdefault(t["name"], []).append(t)
    for t in frontend_tools:
        frontend_by_name.setdefault(t["name"], []).append(t)

    overlap = sorted(set(backend_by_name) & set(frontend_by_name))

    if not overlap:
        results.append(("一致性", PASS, "[推荐] 无前后端同名工具，跳过 Schema 一致性检查"))
        return results

    results.append(("一致性", HINT,
        f"[推荐] 发现 {len(overlap)} 个前后端同名工具（双注册），逐项校验一致性"))

    risk_ok = 0
    risk_fail = 0
    param_ok = 0
    param_fail = 0
    desc_same = 0
    desc_diff = 0

    for name in overlap:
        b_defs = backend_by_name[name]
        f_defs = frontend_by_name[name]
        bt = b_defs[0]
        ft = f_defs[0]

        if len(b_defs) > 1:
            domains = sorted({d.get("domain", "?") for d in b_defs})
            results.append(("一致性", WARN,
                f"[推荐] '{name}' 存在 {len(b_defs)} 个后端定义（domains={domains}），一致性仅对首个定义比对"))
        if len(f_defs) > 1:
            domains = sorted({d.get("domain", "?") for d in f_defs})
            results.append(("一致性", WARN,
                f"[推荐] '{name}' 存在 {len(f_defs)} 个前端定义（domains={domains}），一致性仅对首个定义比对"))

        # risk_level
        b_risk = bt.get("risk_level", "safe")
        f_risk = ft.get("risk_level", "")
        if b_risk == f_risk:
            risk_ok += 1
        else:
            risk_fail += 1
            results.append(("一致性", FAIL,
                f"[必填] '{name}' risk_level 不一致: 后端={b_risk}, 前端={f_risk}"))

        # parameters（排除 InjectedState / internal 后对比参数名集合）
        b_params = _extract_backend_param_names(bt)
        f_params = _extract_frontend_param_names(ft)
        only_backend = b_params - f_params
        only_frontend = f_params - b_params
        if only_backend or only_frontend:
            param_fail += 1
            detail_parts = []
            if only_backend:
                detail_parts.append(f"仅后端: {sorted(only_backend)}")
            if only_frontend:
                detail_parts.append(f"仅前端: {sorted(only_frontend)}")
            results.append(("一致性", WARN,
                f"[推荐] '{name}' 参数名不一致 — {', '.join(detail_parts)}"))
        else:
            param_ok += 1

        # description（仅作 info 提示，不阻断）
        b_desc = (bt.get("description") or "").strip()
        f_desc = (ft.get("description") or "").strip()
        if b_desc == f_desc:
            desc_same += 1
        else:
            desc_diff += 1

    # 汇总
    if risk_fail == 0:
        results.append(("一致性", PASS,
            f"[必填] risk_level 全部一致 ({risk_ok}/{len(overlap)})"))
    if param_fail == 0:
        results.append(("一致性", PASS,
            f"[推荐] 参数名全部一致 ({param_ok}/{len(overlap)})"))

    if desc_diff > 0:
        results.append(("一致性", HINT,
            f"[可选] description 不一致: {desc_diff}/{len(overlap)} 个"
            f"（建议以后端 Python 为准同步到前端 manifest）"))
    else:
        results.append(("一致性", PASS,
            f"[可选] description 全部一致 ({desc_same}/{len(overlap)})"))

    return results


# ── 全局检查 ──

def _check_global(backend_tools: list, frontend_tools: list, all_names: set,
                  skill_map: dict, coverage: dict) -> list[tuple[str, str, str]]:
    results: list[tuple[str, str, str]] = []

    if _LOAD_ERRORS:
        for err in _LOAD_ERRORS:
            results.append(("全局", FAIL, f"[必填] 审计数据收集异常: {err}"))

    # G1: 跨域工具名冲突（后端内部）
    name_domains: dict[str, list[str]] = {}
    for t in backend_tools:
        name_domains.setdefault(t["name"], []).append(t["domain"])
    conflicts = {n: ds for n, ds in name_domains.items() if len(ds) > 1}
    if conflicts:
        for n, ds in sorted(conflicts.items()):
            results.append(("全局", WARN, f"[推荐] 后端跨域重名: '{n}' → {ds}"))
    else:
        results.append(("全局", PASS, "[推荐] 后端无跨域工具名冲突"))

    # G1b: 跨 source（前后端）工具名冲突
    backend_names = {t["name"] for t in backend_tools}
    frontend_names = {t["name"] for t in frontend_tools}
    cross_conflicts = backend_names & frontend_names
    if cross_conflicts:
        approved = sorted(n for n in cross_conflicts if n in _APPROVED_CROSS_SOURCE_NAMES)
        unexpected = sorted(n for n in cross_conflicts if n not in _APPROVED_CROSS_SOURCE_NAMES)
        if approved:
            results.append(("全局", HINT,
                f"[可选] 已批准前后端双注册: {', '.join(approved)}"))
        for n in unexpected:
            results.append(("全局", WARN, f"[推荐] 前后端重名: '{n}'（未在批准名单内）"))
    else:
        results.append(("全局", PASS, "[推荐] 前后端无工具名冲突"))

    # G2: Skill → ToolHub
    skill_missing: dict[str, list[str]] = {}
    for sk_name, sk_info in skill_map.items():
        missing = [t for t in sk_info["tools"] if t not in all_names]
        if missing:
            skill_missing[sk_name] = missing
    if skill_missing:
        for sk_name, tools in sorted(skill_missing.items()):
            results.append(("全局", FAIL, f"[必填] Skill '{sk_name}' 声明了未注册工具: {', '.join(tools)}"))
    else:
        results.append(("全局", PASS, "[必填] 所有 Skill 声明的工具均已注册"))

    # G4: Skill 自身格式（浅层 + 深层）
    _KEBAB_RE = re.compile(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$")
    _SECTION_MARKER_RE = re.compile(r"<!--\s*@(\w+)\s*-->")
    for sk_name, sk_info in skill_map.items():
        if not sk_info["description"]:
            results.append(("全局", WARN, f"[推荐] Skill '{sk_name}' 缺少 description（Agent 无法判断何时激活）"))

        if _KEBAB_RE.match(sk_name):
            results.append(("全局", PASS, f"[推荐] Skill '{sk_name}' name 格式正确（kebab-case）"))
        else:
            results.append(("全局", WARN, f"[推荐] Skill '{sk_name}' name 不符合 kebab-case 规范"))

        declared_sections = sk_info.get("sections", [])
        skill_path_str = sk_info.get("path", "")
        skill_path = _PROJECT_ROOT / skill_path_str if skill_path_str else None

        # --- 深层格式检查（需要读文件内容） ---
        if skill_path and skill_path.exists():
            skill_body = _read_file(skill_path)

            # G4a: 声明的 section 是否有对应标记
            if declared_sections:
                for sec in declared_sections:
                    marker = f"<!-- @{sec} -->"
                    if marker in skill_body:
                        results.append(("全局", PASS,
                            f"[推荐] Skill '{sk_name}' 文档含 {marker} 标记"))
                    else:
                        results.append(("全局", WARN,
                            f"[推荐] Skill '{sk_name}' 声明 sections: [{sec}] 但文档缺少 {marker} 标记"))

            # G4b: 必须有 <!-- @common --> 标记
            has_common = "<!-- @common -->" in skill_body
            if has_common:
                results.append(("全局", PASS,
                    f"[必填] Skill '{sk_name}' 含 <!-- @common --> 标记"))
            else:
                results.append(("全局", FAIL,
                    f"[必填] Skill '{sk_name}' 缺少 <!-- @common --> 标记（Agent 读任何 section 都无共享上下文）"))

            # G4c: frontmatter 和第一个分区标记之间不应有实质内容（孤儿内容）
            fm_match = _FRONTMATTER_RE.match(skill_body)
            if fm_match:
                after_fm = skill_body[fm_match.end():]
                first_marker = _SECTION_MARKER_RE.search(after_fm)
                if first_marker:
                    orphan_text = after_fm[:first_marker.start()].strip()
                    orphan_lines = [l for l in orphan_text.split("\n") if l.strip()]
                    if orphan_lines:
                        preview = orphan_lines[0][:60]
                        results.append(("全局", FAIL,
                            f"[必填] Skill '{sk_name}' frontmatter 和首个分区标记之间有 {len(orphan_lines)} 行孤儿内容"
                            f"（不属于任何分区，Agent 读不到）: \"{preview}...\""))
                    else:
                        results.append(("全局", PASS,
                            f"[必填] Skill '{sk_name}' frontmatter 后无孤儿内容"))

            # G4d: @common 区域不能为空
            if has_common:
                common_start = skill_body.find("<!-- @common -->")
                common_after = skill_body[common_start + len("<!-- @common -->"):]
                next_marker = _SECTION_MARKER_RE.search(common_after)
                if next_marker:
                    common_content = common_after[:next_marker.start()].strip()
                else:
                    common_content = common_after.strip()
                common_lines = [l for l in common_content.split("\n") if l.strip()]
                if len(common_lines) < 2:
                    results.append(("全局", FAIL,
                        f"[必填] Skill '{sk_name}' @common 区域为空或过短（仅 {len(common_lines)} 行），"
                        f"Agent 读取时缺少必要的上下文概述"))
                else:
                    results.append(("全局", PASS,
                        f"[必填] Skill '{sk_name}' @common 区域有 {len(common_lines)} 行内容"))

        # G4e: frontmatter 应有 tools 字段（显式声明，哪怕为空）
        if not sk_info["tools"] and skill_path_str:
            if skill_path and skill_path.exists():
                raw = _read_file(skill_path)
                fm = _FRONTMATTER_RE.match(raw)
                if fm and "tools:" not in fm.group(1):
                    results.append(("全局", WARN,
                        f"[推荐] Skill '{sk_name}' frontmatter 缺少 tools 字段（建议显式声明 tools: []）"))

    # G5: CLI 命令链路完整性
    cli_checks = _check_cli_chain(skill_map)
    results.extend(cli_checks)

    # G6: DB 同步
    try:
        from apps.capabilities.models import RegisteredTool
        from apps.capabilities.constants import CAPABILITIES_DB
        db_count = RegisteredTool.objects.using(CAPABILITIES_DB).filter(is_deprecated=False).count()
        total = len(backend_tools) + len(frontend_tools)
        diff = abs(total - db_count)
        if diff > 5:
            results.append(("全局", WARN,
                f"[推荐] DB 工具数({db_count}) 与代码({total}) 差异 {diff}，建议运行 tools/sync"))
        else:
            results.append(("全局", PASS,
                f"[推荐] DB 同步正常（DB:{db_count} / 代码:{total}，差异 {diff}）"))
    except Exception:
        results.append(("全局", HINT, "[可选] DB 不可访问，跳过同步检查"))

    # G7: 前后端同名工具 Schema 一致性（双注册工具的 risk_level / parameters 对齐检查）
    results.extend(_check_cross_schema_consistency(backend_tools, frontend_tools))

    # G8: manifest.json 时效性
    manifest_path = _PROJECT_ROOT / "packages" / "action-tools" / "manifest.json"
    tools_src_dir = _PROJECT_ROOT / "packages" / "action-tools" / "src" / "tools"
    if manifest_path.exists() and tools_src_dir.exists():
        import json
        try:
            manifest_mtime = manifest_path.stat().st_mtime
            stale_files = []
            for ts_file in tools_src_dir.rglob("*.ts"):
                if ts_file.stat().st_mtime > manifest_mtime:
                    stale_files.append(ts_file.relative_to(_PROJECT_ROOT))
            if stale_files:
                results.append(("全局", WARN,
                    f"[推荐] manifest.json 可能过期: {len(stale_files)} 个源文件更新于 manifest 之后，"
                    f"建议执行 pnpm -C packages/action-tools build"))
            else:
                results.append(("全局", PASS,
                    "[推荐] manifest.json 时效性正常（无源文件更新于 manifest 之后）"))
        except Exception:
            results.append(("全局", HINT, "[可选] manifest 时效性检查异常，跳过"))

    # G9: 后端工具 InjectedState state_key 合法性
    # InjectedState 使用 __slots__ = ('field',)，通过 Pydantic v2 metadata 标注
    _KNOWN_STATE_KEYS = {
        "user_id", "organization_id", "current_space_id",
        "thread_id", "session_id", "device_id", "model_id",
        "agent_name", "agent_type", "parent_thread_id",
        "conversation_summary", "_remote_servers",
    }
    _STATE_KEY_PREFIX = "current_"
    injected_ok = 0
    injected_bad = 0
    for t in backend_tools:
        schema = t.get("args_schema")
        if not schema or not hasattr(schema, "model_fields"):
            continue
        try:
            for field_name, field_info in schema.model_fields.items():
                for md in (field_info.metadata or []):
                    state_key = getattr(md, "field", None)
                    if state_key is None:
                        continue
                    if type(md).__name__ != "InjectedState":
                        continue
                    if state_key in _KNOWN_STATE_KEYS or state_key.startswith(_STATE_KEY_PREFIX):
                        injected_ok += 1
                    else:
                        injected_bad += 1
                        results.append(("全局", WARN,
                            f"[推荐] 工具 '{t['name']}' 字段 '{field_name}' 的 "
                            f"InjectedState('{state_key}') 不在已知集合中"))
        except Exception as exc:
            results.append(("全局", WARN,
                f"[推荐] 工具 '{t['name']}' InjectedState 校验异常: {type(exc).__name__}: {exc}"))
    if injected_ok + injected_bad > 0:
        if injected_bad == 0:
            results.append(("全局", PASS,
                f"[推荐] InjectedState key 全部合法 ({injected_ok} 个字段)"))
        else:
            results.append(("全局", WARN,
                f"[推荐] {injected_bad} 个 InjectedState key 不在已知集合中"))
    else:
        results.append(("全局", HINT,
            "[可选] 未发现 InjectedState 标注字段，跳过 key 校验"))

    # G10: 后端工具用户可见参数 Field(description) 校验
    desc_ok = 0
    desc_missing = 0
    for t in backend_tools:
        schema = t.get("args_schema")
        if not schema or not hasattr(schema, "model_fields"):
            continue
        try:
            for field_name, field_info in schema.model_fields.items():
                is_injected = any(
                    type(md).__name__ == "InjectedState"
                    for md in (field_info.metadata or [])
                )
                if is_injected:
                    continue
                if field_info.description:
                    desc_ok += 1
                else:
                    desc_missing += 1
                    results.append(("全局", WARN,
                        f"[推荐] 工具 '{t['name']}' 参数 '{field_name}' "
                        f"缺少 Field(description=...)，LLM 无法理解该参数"))
        except Exception as exc:
            results.append(("全局", WARN,
                f"[推荐] 工具 '{t['name']}' 参数 description 校验异常: {type(exc).__name__}: {exc}"))
    if desc_ok + desc_missing > 0:
        if desc_missing == 0:
            results.append(("全局", PASS,
                f"[推荐] 用户可见参数全部有 description ({desc_ok} 个字段)"))
        else:
            results.append(("全局", WARN,
                f"[推荐] {desc_missing} 个用户可见参数缺少 description"))

    return results


class Command(BaseCommand):
    help = "审计工具注册完整性（对照 BACKEND_TOOL / FRONTEND_TOOL / SKILL_GUIDE 规范）"

    def add_arguments(self, parser):
        parser.add_argument("--tool", type=str, default=None, help="指定单个工具名")
        parser.add_argument("--domain", type=str, default=None, help="按域筛选")
        parser.add_argument("--source", type=str,
                            choices=["builtin", "extension", "frontend", "backend"],
                            default=None,
                            help="按来源筛选（backend 等同于 builtin，向后兼容）")
        parser.add_argument("--uncovered", action="store_true", help="仅显示无 Skill 覆盖的工具")
        parser.add_argument("--strict", action="store_true", help="必填项失败时退出码 1")
        parser.add_argument("--verbose", action="store_true", help="每个工具打印详细检查")

    def handle(self, *args, **options):
        _LOAD_ERRORS.clear()
        self.stdout.write(self.style.HTTP_INFO(
            f"\n{'='*80}\n  TabTin 工具审计报告\n{'='*80}\n"
        ))

        self.stdout.write("  收集数据...")
        backend = _collect_backend_tools()
        frontend = _collect_frontend_tools()
        all_tools = backend + frontend
        all_names = {t["name"] for t in all_tools}

        n_builtin = sum(1 for t in backend if t["source"] == "builtin")
        n_ext = sum(1 for t in backend if t["source"] == "extension")
        self.stdout.write(
            f"  builtin: {n_builtin} | extension: {n_ext} | frontend: {len(frontend)} | 合计: {len(all_tools)}"
        )

        skill_map = _scan_all_skills()
        coverage = _build_coverage(skill_map)
        self.stdout.write(f"  Skill: {len(skill_map)} | 覆盖工具: {len(coverage)}\n")

        # ── 全局检查 ──
        global_checks = _check_global(backend, frontend, all_names, skill_map, coverage)
        error_protocol_rows, _error_protocol_fails = _run_error_protocol_audit()
        global_checks = list(global_checks) + error_protocol_rows
        current_dim = ""
        global_fails = 0
        for dim, status, msg in global_checks:
            if dim != current_dim:
                current_dim = dim
                self.stdout.write(self.style.MIGRATE_HEADING(f"  [{dim}]"))
            if status == PASS:
                self.stdout.write(self.style.SUCCESS(f"    {status} {msg}"))
            elif status == FAIL:
                self.stdout.write(self.style.ERROR(f"    {status} {msg}"))
                global_fails += 1
            elif status == WARN:
                self.stdout.write(self.style.WARNING(f"    {status} {msg}"))
            else:
                self.stdout.write(f"    {status} {msg}")
        self.stdout.write("")

        # ── 筛选 ──
        filtered = all_tools
        if options["tool"]:
            filtered = [t for t in filtered if t["name"] == options["tool"]]
            if not filtered:
                self.stderr.write(self.style.ERROR(f"  工具 '{options['tool']}' 未找到。"))
                raise SystemExit(1)
        if options["domain"]:
            filtered = [t for t in filtered if t["domain"] == options["domain"]]
        if options["source"]:
            src_filter = options["source"]
            if src_filter == "backend":
                src_filter = "builtin"
            filtered = [t for t in filtered if t["source"] == src_filter]
        if options["uncovered"]:
            filtered = [t for t in filtered if t["name"] not in coverage]

        # ── 单工具详情 ──
        if options["tool"] and len(filtered) == 1:
            tool = filtered[0]
            self._detail(tool, coverage, skill_map)
            checks = _check_frontend_tool(tool) if tool["source"] == "frontend" else _check_backend_tool(tool)
            detail_has_fail = any(s == FAIL for s, _, _ in checks)
            if global_fails > 0:
                self.stdout.write(self.style.ERROR(f"  全局必填失败: {global_fails}（详见上方 [全局]/[CLI] 分组）"))
                self.stdout.write("")
            self._print_unchecked_notice()
            if (detail_has_fail or global_fails > 0) and options["strict"]:
                raise SystemExit(1)
            return

        # ── 概览 ──
        has_fails = self._overview(filtered, coverage, options)
        if global_fails > 0:
            self.stdout.write(self.style.ERROR(f"  全局必填失败: {global_fails}（详见上方 [全局]/[CLI] 分组）"))
            self.stdout.write("")
        self._print_unchecked_notice()

        if (has_fails or global_fails > 0) and options["strict"]:
            raise SystemExit(1)

    def _print_unchecked_notice(self):
        self.stdout.write(self.style.MIGRATE_HEADING("  [未检查项 — 需开发者自行验证]"))
        notices = [
            "后端工具 run() 返回值是否可 JSON 序列化",
            "前端工具 execute() 函数实现的完整性",
            "SKILL.md @fc 区域的工具用法示例是否与实际 args_schema 一致",
            "CLI 命令各子命令的 --format 选项覆盖完整度（当前仅检查模块级）",
            "错误协议：pending_migration 工具的完整域迁移（仅强制 ERROR_ENVELOPE_COMPLIANT_TOOLS）",
        ]
        for n in notices:
            self.stdout.write(f"    {HINT} {n}")
        self.stdout.write("")

    def _detail(self, tool: dict, coverage: dict, skill_map: dict):
        name = tool["name"]
        self.stdout.write(self.style.MIGRATE_HEADING(f"  工具详情: {name}"))
        self.stdout.write(f"    来源: {tool['source']} | 域: {tool['domain']}")
        self.stdout.write(f"    risk_level: {tool.get('risk_level', '未声明')}")

        desc = tool.get("description", "")
        if len(desc) > 80:
            desc = desc[:77] + "..."
        self.stdout.write(f"    description: {desc}")

        if tool["source"] != "frontend":
            self.stdout.write(f"    execution_mode: {tool.get('execution_mode', 'server')}")
            self.stdout.write(f"    available_modes: {tool.get('available_modes') or 'None (all modes)'}")
            schema = tool.get("args_schema")
            if schema and hasattr(schema, "model_fields"):
                self.stdout.write(f"    args_schema: {schema.__name__}")
                for fname, finfo in schema.model_fields.items():
                    fdesc = finfo.description or "(无 description)"
                    self.stdout.write(f"      - {fname}: {fdesc[:60]}")

        checks = _check_frontend_tool(tool) if tool["source"] == "frontend" else _check_backend_tool(tool)
        self.stdout.write(self.style.MIGRATE_HEADING("\n  格式校验:"))
        for status, msg, _cat in checks:
            if status == PASS:
                self.stdout.write(self.style.SUCCESS(f"    {status} {msg}"))
            elif status == FAIL:
                self.stdout.write(self.style.ERROR(f"    {status} {msg}"))
            elif status == WARN:
                self.stdout.write(self.style.WARNING(f"    {status} {msg}"))
            else:
                self.stdout.write(f"    {status} {msg}")

        covering = coverage.get(name, [])
        self.stdout.write(self.style.MIGRATE_HEADING("\n  Skill 覆盖:"))
        if covering:
            for sk in covering:
                self.stdout.write(self.style.SUCCESS(f"    {PASS} {sk}"))
        else:
            self.stdout.write(self.style.WARNING(f"    {WARN} [推荐] 未被任何 Skill 覆盖"))
        self.stdout.write("")

    def _overview(self, tools: list, coverage: dict, options: dict) -> bool:
        domains: dict[str, list[dict]] = {}
        for t in tools:
            domains.setdefault(t["domain"], []).append(t)

        domain_stats: list[dict] = []
        has_fails = False
        warn_by_cat: dict[str, int] = {}

        for dn in sorted(domains.keys()):
            dt = domains[dn]
            sources = {t["source"] for t in dt}
            src = "/".join(sorted(s[:3].upper() for s in sources))
            count = len(dt)
            covered = sum(1 for t in dt if t["name"] in coverage)
            uncov = count - covered

            total_fail = 0
            total_warn = 0
            for t in dt:
                checks = _check_frontend_tool(t) if t["source"] == "frontend" else _check_backend_tool(t)
                total_fail += sum(1 for s, _, _ in checks if s == FAIL)
                for s, _, cat in checks:
                    if s == WARN:
                        total_warn += 1
                        warn_by_cat[cat] = warn_by_cat.get(cat, 0) + 1
                if t["name"] not in coverage:
                    warn_by_cat[CAT_SKILL] = warn_by_cat.get(CAT_SKILL, 0) + 1

            if total_fail > 0:
                has_fails = True

            domain_stats.append({
                "name": dn, "src": src, "count": count,
                "covered": covered, "uncov": uncov,
                "fail": total_fail, "warn": total_warn,
                "tools": dt,
            })

        header = f"  {'域':<18} {'来源':>4} {'数量':>4} {'覆盖':>4} {'缺覆盖':>6} {'必填✗':>6} {'推荐⚠':>6}"
        self.stdout.write(self.style.MIGRATE_HEADING(header))
        self.stdout.write("  " + "─" * 64)

        for ds in domain_stats:
            line = (f"  {ds['name']:<18} {ds['src']:>4} {ds['count']:>4} "
                    f"{ds['covered']:>4} {ds['uncov']:>6} {ds['fail']:>6} {ds['warn']:>6}")
            if ds["fail"] > 0:
                self.stdout.write(self.style.ERROR(line))
            elif ds["uncov"] > 0 or ds["warn"] > 0:
                self.stdout.write(self.style.WARNING(line))
            else:
                self.stdout.write(line)

        self.stdout.write("  " + "─" * 64)
        total = len(tools)
        total_covered = sum(ds["covered"] for ds in domain_stats)
        total_uncov = total - total_covered
        total_f = sum(ds["fail"] for ds in domain_stats)
        total_w = sum(ds["warn"] for ds in domain_stats)
        self.stdout.write(f"  {'合计':<18} {'':>4} {total:>4} {total_covered:>4} {total_uncov:>6} {total_f:>6} {total_w:>6}")

        if total > 0:
            rate = total_covered / total * 100
            color = self.style.SUCCESS if rate >= 80 else self.style.WARNING
            self.stdout.write(color(f"\n  Skill 覆盖率: {rate:.1f}% ({total_covered}/{total})"))

        self.stdout.write(self.style.HTTP_INFO(
            f"  必填失败: {total_f} | 推荐缺失: {total_w}"
        ))

        if warn_by_cat:
            self.stdout.write(self.style.MIGRATE_HEADING("\n  推荐缺失分类:"))
            for cat in (CAT_SKILL, CAT_MODES, CAT_CLI, CAT_DESC, CAT_SCHEMA, CAT_PARAMS, CAT_CROSS, CAT_OTHER):
                n = warn_by_cat.get(cat, 0)
                if n > 0:
                    label = _CAT_LABELS.get(cat, cat)
                    self.stdout.write(self.style.WARNING(f"    {WARN} {label}: {n} 个"))

        # verbose
        if options.get("verbose"):
            self.stdout.write(self.style.HTTP_INFO(f"\n{'='*80}\n  详细列表\n{'='*80}"))
            for ds in domain_stats:
                self.stdout.write(self.style.MIGRATE_HEADING(f"\n  ── {ds['name']} ({ds['count']} 工具) ──"))
                for t in sorted(ds["tools"], key=lambda x: x["name"]):
                    name = t["name"]
                    risk = t.get("risk_level", "?")
                    cov_mark = PASS if name in coverage else WARN
                    checks = _check_frontend_tool(t) if t["source"] == "frontend" else _check_backend_tool(t)
                    n_fail = sum(1 for s, _, _ in checks if s == FAIL)
                    n_warn = sum(1 for s, _, _ in checks if s == WARN)
                    status = f"{FAIL}{n_fail}" if n_fail else (f"{WARN}{n_warn}" if n_warn else PASS)
                    skills_str = ", ".join(coverage.get(name, []))
                    line = f"    [{risk:<6}] {cov_mark} {name:<35} {status:<4}"
                    if skills_str:
                        line += f" → {skills_str}"
                    if n_fail:
                        self.stdout.write(self.style.ERROR(line))
                    elif n_warn:
                        self.stdout.write(self.style.WARNING(line))
                    else:
                        self.stdout.write(line)

        if options.get("uncovered"):
            self.stdout.write(self.style.MIGRATE_HEADING(f"\n  未覆盖工具清单:"))
            for t in sorted(tools, key=lambda x: (x["domain"], x["name"])):
                if t["name"] not in coverage:
                    risk = t.get("risk_level", "?")
                    self.stdout.write(f"    [{t['source'][:2]}] [{risk:<6}] {t['domain']:<18} {t['name']}")

        self.stdout.write("")
        return has_fails
