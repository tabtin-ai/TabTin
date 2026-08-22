"""
工具脚手架 — 覆盖 audit_tools 全部检查点。

支持三种工具类型（W6 后 Python BaseTool 已退役 LLM 注册路径）：
  - **frontend**：前端 Action Tool（TS Runtime FC，是 LLM 工具的唯一来源）
  - **cli**：tabtin CLI 命令（业务能力的入口；LLM 通过 run_terminal_command 调用）
  - **extension**：Extension（HTTP API + 可选 CLI 命令声明；走 ExtensionRegistry，
    不再向 LLM 暴露 FC 工具）

宪法不变量 1（W6 落地）：本地 TS Runtime 是 LLM 工具的唯一来源——
不要再用 `--type backend` 路径生成 BaseTool 期望它出现在 LLM 工具表里；
那条路径仅作为 Extension HTTP API 的内部依赖保留。

用法:
    # 前端 Action Tool（LLM 直接可见的 FC）
    python manage.py create_tool my_tool --type frontend --domain tabxxx --risk-level review --description "描述"

    # tabtin CLI 子命令（业务能力的标准入口）
    python manage.py create_tool tabxxx --type cli --description "CLI 描述"

    # Extension（HTTP API provider；可选 get_cli_commands 声明）
    python manage.py create_tool my_tool --type extension --domain tabxxx --risk-level safe --description "描述"

    # 同时生成 SKILL.md
    python manage.py create_tool my_tool --type frontend --domain tabxxx --with-skill --description "描述"

    # 预览
    python manage.py create_tool my_tool --type frontend --domain tabxxx --dry-run --description "描述"
"""

from __future__ import annotations

import re
from pathlib import Path

from django.core.management.base import BaseCommand

from apps.services.repo_root import get_repo_root

_ROOT = get_repo_root()
_DJ = _ROOT / "apps" / "tabtin_django"
_TOOLS = _DJ / "apps" / "services" / "tools" / "domains"

DONE = "✓"
SKIP = "⊘"
FAIL = "✗"
NEW = "+"

_VALID_RISKS = {"safe", "review", "strict"}


# ── File helpers (same as create_app) ──

def _read(p: Path) -> str:
    try:
        return p.read_text("utf-8", errors="ignore")
    except Exception:
        return ""


def _write_new(p: Path, content: str, dry: bool) -> str:
    if p.exists():
        return SKIP
    if not dry:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, "utf-8")
    return NEW


def _to_pascal(name: str) -> str:
    parts = [p for p in re.split(r"[._-]+", name) if p]
    if not parts:
        return "Generated"
    return "".join(p[:1].upper() + p[1:] for p in parts)


def _append_line_if_missing(p: Path, line: str, dry: bool) -> str:
    content = _read(p)
    if line in content:
        return SKIP
    suffix = "" if content.endswith("\n") or not content else "\n"
    new = content + suffix + line + "\n"
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_before(p: Path, marker: str, block: str, dry: bool) -> str:
    content = _read(p)
    check = block.strip()
    if check and check in content:
        return SKIP
    idx = content.find(marker)
    if idx == -1:
        return FAIL
    ls = content.rfind("\n", 0, idx)
    ls = ls + 1 if ls != -1 else 0
    new = content[:ls] + block + "\n" + content[ls:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_after(p: Path, marker: str, block: str, dry: bool) -> str:
    content = _read(p)
    check = block.strip()
    if check and check in content:
        return SKIP
    idx = content.find(marker)
    if idx == -1:
        return FAIL
    eol = content.find("\n", idx + len(marker))
    if eol == -1:
        eol = len(content)
    new = content[:eol] + "\n" + block + content[eol:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_into_python_return_list(
    p: Path,
    fn_name: str,
    item_line: str,
    dry: bool,
) -> str:
    content = _read(p)
    check = item_line.strip()
    if check and check in content:
        return SKIP

    fn_idx = content.find(f"def {fn_name}")
    if fn_idx == -1:
        return FAIL

    ret_idx = content.find("return [", fn_idx)
    if ret_idx == -1:
        return FAIL

    close_match = re.search(r"\n[ \t]*\]", content[ret_idx:])
    if not close_match:
        return FAIL
    close_idx = ret_idx + close_match.start()

    line_start = content.rfind("\n", 0, close_idx) + 1
    insert_text = item_line.rstrip() + "\n"
    new = content[:line_start] + insert_text + content[line_start:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


def _insert_into_ts_array(
    p: Path,
    array_name: str,
    entry_block: str,
    dry: bool,
) -> str:
    content = _read(p)
    check = entry_block.strip()
    if check and check in content:
        return SKIP

    match = re.search(rf"(?:export\s+)?const\s+{re.escape(array_name)}\b[^\n]*=\s*\[", content)
    if not match:
        return FAIL

    arr_start = match.end()
    close_match = re.search(r"\n[ \t]*\]", content[arr_start:])
    if not close_match:
        return FAIL
    close_idx = arr_start + close_match.start()

    line_start = content.rfind("\n", 0, close_idx) + 1
    insert_text = entry_block.rstrip() + "\n"
    new = content[:line_start] + insert_text + content[line_start:]
    if not dry:
        p.write_text(new, "utf-8")
    return DONE


# ── Templates ──

def T_BACKEND_TOOL(tool_full_name: str, class_seed: str, domain: str, desc: str, risk: str) -> str:
    cls = _to_pascal(class_seed) + "Tool"
    schema_cls = _to_pascal(class_seed) + "Input"
    modes_str = ""
    if risk in ("review", "strict"):
        modes_str = '    available_modes: tuple[str, ...] = ("agent",)\n'
    return f'''"""
HTTP API 服务实现: {tool_full_name}

【W6 后注意 — 本类作为 HTTP API provider，不再注册到 ToolHub】

宪法不变量 1（W6 落地）：本地 TS Runtime 是 LLM 工具的唯一来源——
本 BaseTool 子类**不会**出现在 LLM 工具表里。它的真实角色是：
  - 业务逻辑的服务层实现（被 HTTP API view 或 CLI route handler 调用）
  - Extension HTTP 桥接的内部依赖
LLM 通过 `tabtin <cmd>` CLI 或前端 Action Tool 间接触达这套实现。

1. args_schema 参数规范:
   - 入参字段保留 Pydantic 校验（HTTP view 侧仍用它做请求体反序列化）
   - InjectedState 注解在 HTTP 调用路径下不生效；如需 user_id / space_id 等，
     由 view / handler 从 request 显式解析后传入

2. run() 返回值规范:
   - 必须返回可 JSON 序列化的 dict
   - 成功: {{"status": "ok", ...业务数据...}}
   - 失败: 通过 build_tool_error(...) 返回标准失败 envelope
   - 上游 view / CLI route 直接序列化为 HTTP response body 返回给前端 / CLI

3. risk_level 判定（仍保留作为审计标注，HTTP 层依赖此字段决定审批策略）:
   - safe:   只读操作（查询、列举、读取）
   - review: 写操作（创建、更新）
   - strict: 不可逆操作（删除、DDL）
   - 当前设为 "{risk}"

4. 暴露给 LLM 的正确路径:
   - 走 tabtin CLI：`tabtin {domain} <verb>` → CLI Server → 本服务实现
   - 走前端 Action Tool：`packages/action-tools/src/tools/<domain>/<tool>.ts`
   - **不要**调用 ToolHub.register_provider —— 那是 W6 前的死路径
"""

import logging
from typing import Annotated, Any, Optional

from pydantic import BaseModel, Field

from apps.services.tools import BaseTool
from apps.services.common.state.injected_state import InjectedState
from apps.services.tools.error_envelope import build_tool_error


logger = logging.getLogger(__name__)


class {schema_cls}(BaseModel):
    # ── 自动注入参数（不暴露给 LLM，按需保留/删除） ──
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )

    # ── 用户可见参数（LLM 会看到这些参数的 description 来决定如何调用） ──
    query: str = Field(description="查询内容（请替换为实际参数，description 要对 LLM 友好）")


class {cls}(BaseTool):
    name: str = "{tool_full_name}"
    description: str = (
        "{desc}"
        # description 编写要求（写完后删除此注释）:
        # 1. 第一句说明「做什么」
        # 2. 第二句说明「什么时候用」（触发场景）
        # 3. 可选: 关键约束（如「只读」「需要用户确认」「最多返回 100 条」）
        # 示例: "查询表格数据并返回结构化结果。适用于需要筛选、统计、导出表格数据时。单次最多返回 1000 行。"
    )
    args_schema: type[BaseModel] = {schema_cls}
    risk_level: str = "{risk}"
    required_permissions: list[str] = ["{domain}"]
{modes_str}
    def run(self, query: str, **kwargs) -> dict[str, Any]:
        # ── 从 kwargs 获取注入参数 ──
        user_id = kwargs.get("user_id")
        space_id = kwargs.get("space_id")

        # ── 参数校验 ──
        if not query:
            return build_tool_error(
                "缺少必填参数 query",
                error_kind="missing_required_param",
                hint="请提供 query 参数后重新调用",
                retryable=False,
            )

        # ── 业务逻辑（替换为实际实现） ──
        try:
            # TODO: 实现工具逻辑
            # 示例: result = SomeService().do_something(query, user_id=user_id)
            result = []
            return {{
                "status": "ok",
                "data": result,
                "total": len(result),
            }}
        except PermissionError:
            return build_tool_error(
                "权限不足，无法完成操作",
                error_kind="permission_denied",
                hint="请告知用户需要对应权限后重试",
                retryable=False,
            )
        except Exception:
            logger.exception("工具执行发生未预期异常")
            return build_tool_error(
                "操作失败，请稍后重试",
                error_kind="internal_error",
                hint="请重试一次；若仍失败，请告知用户改用对应界面完成操作",
                retryable=True,
            )
'''


def T_TOOL_REGISTRY(domain: str, tool_name: str) -> str:
    cls = _to_pascal(tool_name) + "Tool"
    get_fn = f"get_{domain}_tools"
    return f'''"""工具域 {domain} 的工具注册。"""

from apps.services.tools import BaseTool
from .{tool_name} import {cls}


def {get_fn}() -> list[BaseTool]:
    return [{cls}()]
'''


def T_EXTENSION_TOOL(tool_full_name: str, class_seed: str, domain: str, desc: str, risk: str) -> str:
    """Extension FC 工具模板：合约与 builtin 完全一致，注册走 ExtensionRegistry。"""
    cls = _to_pascal(class_seed) + "Tool"
    schema_cls = _to_pascal(class_seed) + "Input"
    modes_str = ""
    if risk in ("review", "strict"):
        modes_str = '    available_modes: tuple[str, ...] = ("agent",)\n'
    return f'''"""
Extension FC 工具: {tool_full_name}

【开发指南 — Agent 请仔细阅读】

本工具通过 ExtensionRegistry 注册到 ToolHub (source="extension")。
FC 工具合约与 builtin 完全一致，必须满足以下所有要求：

1. args_schema: 每个用户可见参数必须有 Field(description="...")
2. InjectedState: 从 Agent 运行时自动注入上下文
3. run() 返回: 成功 {{"status":"ok",...}}，失败通过 build_tool_error(...) 返回标准 envelope
4. risk_level: safe(只读) / review(写操作) / strict(不可逆)
5. hint: 告诉 Agent 下一步该做什么，要具体可执行
"""

import logging
from typing import Annotated, Any, Optional

from pydantic import BaseModel, Field

from apps.services.tools import BaseTool
from apps.services.common.state.injected_state import InjectedState
from apps.services.tools.error_envelope import build_tool_error


logger = logging.getLogger(__name__)


class {schema_cls}(BaseModel):
    user_id: Annotated[Optional[str], InjectedState("user_id")] = Field(
        default=None, description="用户 ID（自动注入）",
    )
    organization_id: Annotated[Optional[str], InjectedState("organization_id")] = Field(
        default=None, description="工作区 ID（自动注入）",
    )
    space_id: Annotated[Optional[str], InjectedState("current_space_id")] = Field(
        default=None, description="Space ID（自动注入）",
    )

    query: str = Field(description="查询内容（请替换为实际参数）")


class {cls}(BaseTool):
    name: str = "{tool_full_name}"
    description: str = "{desc}"
    args_schema: type[BaseModel] = {schema_cls}
    risk_level: str = "{risk}"
    required_permissions: list[str] = ["{domain}"]
{modes_str}
    def run(self, query: str, **kwargs) -> dict[str, Any]:
        user_id = kwargs.get("user_id")

        if not query:
            return build_tool_error(
                "缺少必填参数 query",
                error_kind="missing_required_param",
                hint="请提供 query 参数后重新调用",
                retryable=False,
            )

        try:
            result = []
            return {{"status": "ok", "data": result, "total": len(result)}}
        except PermissionError:
            return build_tool_error(
                "权限不足，无法完成操作",
                error_kind="permission_denied",
                hint="请告知用户需要对应权限后重试",
                retryable=False,
            )
        except Exception:
            logger.exception("Extension 工具执行发生未预期异常")
            return build_tool_error(
                "操作失败，请稍后重试",
                error_kind="internal_error",
                hint="请重试一次；若仍失败，请告知用户改用对应界面完成操作",
                retryable=True,
            )
'''


def T_EXTENSION_TOOLS_PY(domain: str, tool_name: str) -> str:
    """Extension 的 tools.py 模板：在 get_tools() 中返回工具列表。"""
    cls = _to_pascal(tool_name) + "Tool"
    return f'''"""
Extension 工具注册 — 由 BaseExtension.get_tools() 调用。

所有工具必须满足统一合约（args_schema、risk_level、InjectedState、error+hint）。
"""

from apps.services.tools import BaseTool
from .{tool_name} import {cls}


def get_tools() -> list[BaseTool]:
    return [{cls}()]
'''


def T_EXTENSION_CLI_PY(domain: str, tool_name: str, desc: str) -> str:
    """Extension CLI 命令声明模板：返回 CliCommandDescriptor 列表。"""
    return f'''"""
Extension CLI 命令声明 — 由 BaseExtension.get_cli_commands() 调用。

CLI 命令让 Agent 能将 Extension 能力纳入管道组合：
  tabtin {domain} {tool_name} --param value | tabtin table import ...

每个命令必须声明：
  - name: 子命令名
  - description: Agent 可见描述
  - api_endpoint: 后端 API（CLI Server 会代理到此）
  - options: 参数列表，每个须有 flag + description
"""

from apps.extensions.base import CliCommandDescriptor, CliOptionDescriptor


def get_cli_commands() -> list[CliCommandDescriptor]:
    return [
        CliCommandDescriptor(
            name="{tool_name}",
            description="{desc}",
            api_endpoint="/api/extensions/{domain}/cli/{tool_name}/",
            method="POST",
            options=[
                CliOptionDescriptor(flag="--query <text>", description="查询内容（请替换为实际参数）"),
                CliOptionDescriptor(flag="-f, --format <format>", description="输出格式: json | table"),
            ],
        ),
    ]
'''


def T_EXTENSION_PY(domain: str, ext_name: str) -> str:
    """Extension 主类模板：继承 BaseExtension。"""
    cls = "".join(w.capitalize() for w in domain.split("_")) + "Extension"
    return f'''"""
{ext_name} Extension — 由 ExtensionRegistry 统一管理。

实现 BaseExtension 协议后在 apps.py 的 ready() 中注册即可：
  ExtensionRegistry.register({cls}())
"""

from typing import Any, Dict, List, Optional, TYPE_CHECKING

from apps.extensions.base import (
    BaseExtension, ExtensionCapabilities, ConfigField,
    CliCommandDescriptor,
)

if TYPE_CHECKING:
    from apps.extensions.models import ExtensionConnection


class {cls}(BaseExtension):
    @property
    def id(self) -> str:
        return "{domain}"

    @property
    def name(self) -> str:
        return "{ext_name}"

    @property
    def extension_type(self) -> str:
        return "integration"

    @property
    def capabilities(self) -> ExtensionCapabilities:
        return ExtensionCapabilities(has_tools=True, has_cli=True)

    @property
    def is_builtin(self) -> bool:
        return True

    def get_config_fields(self) -> List[ConfigField]:
        return []

    def get_tools(self, connection: Optional["ExtensionConnection"] = None) -> list:
        from .tools import get_tools
        return get_tools()

    def get_cli_commands(self) -> List[CliCommandDescriptor]:
        from .cli_commands import get_cli_commands
        return get_cli_commands()
'''


def T_EXTENSION_APPS_PY(domain: str, ext_name: str) -> str:
    """Extension 的 Django AppConfig 模板。"""
    cls = "".join(w.capitalize() for w in domain.split("_")) + "Config"
    ext_cls = "".join(w.capitalize() for w in domain.split("_")) + "Extension"
    return f'''"""Django AppConfig for {ext_name} Extension."""

from django.apps import AppConfig


class {cls}(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.{domain}"
    verbose_name = "{ext_name}"

    def ready(self):
        from apps.extensions.registry import ExtensionRegistry
        from .extension import {ext_cls}
        ExtensionRegistry.register({ext_cls}())
'''


def T_FRONTEND_TOOL(tool_name: str, domain: str, desc: str, risk: str) -> str:
    parts = tool_name.replace(".", "_").split("_")
    fn = parts[0] + "".join(w.capitalize() for w in parts[1:])
    input_cls = "".join(w.capitalize() for w in parts) + "Input"
    output_cls = "".join(w.capitalize() for w in parts) + "Output"
    return f'''/**
 * 前端 Action Tool: {tool_name}
 *
 * 【开发指南 — Agent 请仔细阅读】
 *
 * 1. parameters 规范:
 *    - type 必须是 'object'
 *    - 每个 property 必须有 description（LLM 靠这个理解参数含义）
 *    - required 数组列出所有必填参数
 *    - 参数名用 camelCase，description 用自然语言
 *
 * 2. execute() 返回值规范:
 *    - 成功: {{ status: 'ok', data: ... }}
 *    - 失败: {{ status: 'error', error: '发生了什么', hint: '该怎么做' }}
 *    - hint 是给 Agent 的行动指令，Agent 会据此决定下一步
 *
 * 3. riskLevel 判定:
 *    - 'safe':   只读，无副作用（读取、查询、获取状态）
 *    - 'review': 有副作用（写文件、打开页面、执行操作）
 *    - 'strict': 不可逆（删除文件、清空数据）
 *
 * 4. execute() 中可用的上下文:
 *    - 通过 Electron 主进程 API 获取（import 对应 service）
 *    - 如需当前 spaceId，从 input 参数传入或从 store 获取
 */

import type {{ AgentTool }} from '../../types'

export interface {input_cls} {{
  /** 请替换为实际参数（description 写在 parameters.properties 中） */
  query: string
}}

export interface {output_cls} {{
  status: 'ok' | 'error'
  /** 业务数据（替换为实际返回类型） */
  data?: unknown
  /** 失败时的错误描述 */
  error?: string
  /** 失败时告诉 Agent 该怎么做 */
  hint?: string
}}

export const {fn}Tool: AgentTool<{input_cls}, {output_cls}> = {{
  name: '{tool_name}',
  description:
    '{desc}',
    // description 编写要求（写完后删除此注释）:
    // 1. 第一句: 做什么
    // 2. 第二句: 什么时候用
    // 3. 可选: 关键约束
  riskLevel: '{risk}',
  parameters: {{
    type: 'object',
    properties: {{
      query: {{
        type: 'string',
        description: '查询内容（替换为实际参数名和描述）',
      }},
    }},
    required: ['query'],
  }},

  async execute(input: {input_cls}): Promise<{output_cls}> {{
    try {{
      // TODO: 实现工具逻辑
      // 示例: const result = await someService.doSomething(input.query)
      return {{ status: 'ok', data: null }}
    }} catch (err: unknown) {{
      const message = err instanceof Error ? err.message : String(err)
      return {{
        status: 'error',
        error: `操作失败: ${{message}}`,
        hint: '请检查参数是否正确后重试',
      }}
    }}
  }},
}}

export const {domain}Tools: AgentTool[] = [{fn}Tool]
'''


def T_FRONTEND_META(domain: str, risk: str, tool_name: str) -> str:
    parts = tool_name.replace(".", "_").split("_")
    fn = parts[0] + "".join(w.capitalize() for w in parts[1:])
    return f'''import type {{ AgentTool }} from '../../types'
import type {{ ToolDomain }} from '../../types/manifest'

import {{ {fn}Tool }} from './{tool_name.split(".")[-1] if "." in tool_name else tool_name}'

export const domain: ToolDomain<AgentTool> = {{
  meta: {{
    appId: '{domain}',
    capability: '{domain}',
    riskLevel: '{risk}',
  }},
  groups: [
    {{ tools: [{fn}Tool], riskLevel: '{risk}', tags: ['{domain}'] }},
  ],
}}
'''


def T_SKILL_MD(
    skill_name: str,
    domain: str,
    desc: str,
    tools: list[str],
    sections: list[str],
    *,
    tool_type: str = "backend",
) -> str:
    tools_yaml = "\n".join(f"  - {t}" for t in tools) if tools else "  # - tool_name  # 填入关联的 FC 工具名（与 ToolHub 注册名一致）"
    sections_yaml = "\n".join(f"  - {s}" for s in sections)

    if tool_type in ("backend", "extension"):
        failure_guidance = (
            '- BaseTool 成功保持 `{"status": "ok", ...}`\n'
            '- BaseTool 失败必须通过 `build_tool_error(...)` 返回 '
            '`{"success": false, "error": "描述", "error_kind": "稳定分类", "hint": "下一步建议"}`'
        )
    elif tool_type == "frontend":
        failure_guidance = (
            '- Action Tool 成功返回 `{"status": "ok", ...}`，'
            '失败返回 `{"status": "error", "error": "描述", "hint": "下一步建议"}`'
        )
    else:
        failure_guidance = "- CLI 失败通过非 2xx HTTP 响应呈现；按响应中的 error.hint 修正后重试"

    # @fc section
    fc_block = ""
    if "fc" in sections:
        fc_tools = []
        for t in tools:
            fc_tools.append(
                f"### {t}\n\n"
                f"一句话说明做什么、什么时候用。\n\n"
                f"```\n{t}(query=\"示例参数\")\n```\n\n"
                f"返回示例:\n"
                f"```json\n"
                f'{{\n  "status": "ok",\n  "data": [...],\n  "total": 10\n}}\n'
                f"```\n"
            )
        if not fc_tools:
            fc_tools.append(
                f"### tool_name\n\n"
                f"一句话说明做什么、什么时候用。\n\n"
                f"```\ntool_name(param1=\"值\", param2=\"值\")\n```\n\n"
                f"返回示例:\n"
                f"```json\n"
                f'{{\n  "status": "ok",\n  "data": [...],\n  "total": 10\n}}\n'
                f"```\n"
            )
        fc_content = "\n".join(fc_tools)
        fc_block = f"<!-- @fc -->\n\n## FC 工具\n\n{fc_content}"

    # @cli section
    cli_block = ""
    if "cli" in sections:
        cli_block = (
            f"<!-- @cli -->\n\n"
            f"## CLI 命令\n\n"
            f"### tabtin {domain} list\n\n"
            f"列出所有资源。\n\n"
            f"```bash\ntabtin {domain} list --format json\n```\n\n"
            f"### tabtin {domain} create\n\n"
            f"创建新资源。\n\n"
            f"```bash\ntabtin {domain} create \"标题\" --content \"内容\"\n```\n"
        )

    body = "\n\n".join(b for b in [fc_block, cli_block] if b)

    # 方法路由表
    routing_rows = []
    if "fc" in sections:
        for t in (tools or ["tool_name"]):
            routing_rows.append(f"| 结构化操作（查询/创建/修改） | FC: `{t}` |")
    if "cli" in sections:
        routing_rows.append(f"| 批量/脚本化操作 | CLI: `tabtin {domain} <action>` |")
    routing_table = "\n".join(routing_rows) if routing_rows else "| 操作类型 | 推荐方法 |"

    return f'''---
name: {skill_name}
description: >
  {desc}
  （编写要求: 1-2 句话，包含「做什么」+「什么时候用」的触发词。
  这是 Agent 决定是否读取此 Skill 的唯一依据。
  示例: "表格数据查询与导出。用户提到查询、筛选、SQL、导出、统计时使用。"）
version: 0.1.0
auto_activate_for: [{domain}]
tools:
{tools_yaml}
sections:
{sections_yaml}
---

<!-- @common -->

## 概述

{desc}

### 方法路由

| 场景 | 推荐方法 |
|------|---------|
{routing_table}

### 注意事项

{failure_guidance}
- 写操作（risk_level=review/strict）会触发用户审批确认

{body}
'''


def T_CLI_COMMAND(app_short: str, app_name: str) -> str:
    fn = "".join(w.capitalize() for w in app_short.split("_"))
    return f'''/**
 * tabtin {app_short} — {app_name} CLI commands.
 *
 * 【开发指南 — Agent 请仔细阅读】
 *
 * 1. 命令结构:
 *    tabtin {app_short} <subcommand> [options]
 *    每个 subcommand 对应一个 .command() 链式调用
 *
 * 2. transport.request(method, path):
 *    - method: HTTP 方法（'GET'|'POST'|'PUT'|'DELETE'）
 *    - path: CLI Server 路由路径，由 cli-server.ts 分发到对应 route handler
 *    - 路径不含 host，如 '/{app_short}/list'
 *
 * 3. 错误处理:
 *    - transport 可能返回非 200 状态，必须用 handleCommandError 处理
 *    - handleCommandError 会输出格式化错误信息并 process.exit(1)
 *    - 网络不可达等异常通过 try/catch 捕获
 *
 * 4. 新增子命令:
 *    - 复制 list 命令块，修改 command/description/action
 *    - 写操作用 POST/PUT/DELETE，读操作用 GET
 *    - 所有命令都加 --format 选项以支持 json/table/yaml 输出
 */

import {{ Command }} from 'commander'
import {{ getTransport }} from '../transport/index.js'
import {{ formatOutput, type OutputFormat }} from '../formatters/json.js'
import {{ handleCommandError }} from '../errors/index.js'

export function register{fn}Command(program: Command) {{
  const cmd = program.command('{app_short}').description('{app_name} operations')

  cmd
    .command('list')
    .description('List {app_name} resources')
    .option('-f, --format <format>', 'Output format', 'json')
    .action(async (opts) => {{
      try {{
        const transport = getTransport()
        const res = await transport.request('GET', '/{app_short}/list')
        if (res.status !== 200) {{
          handleCommandError(res, {{ context: '{app_short} list' }})
          return
        }}
        process.stdout.write(formatOutput(res.data?.data ?? [], opts.format as OutputFormat) + '\\n')
      }} catch (err: unknown) {{
        const message = err instanceof Error ? err.message : String(err)
        console.error(`Error: ${{message}}`)
        process.exit(1)
      }}
    }})

  // TODO: 按需添加更多子命令
  // cmd.command('create').description('Create ...').action(async (opts) => {{ ... }})
  // cmd.command('delete').description('Delete ...').argument('<id>').action(async (id, opts) => {{ ... }})
}}
'''


def T_CLI_ROUTE(app_short: str, app_name: str) -> str:
    fn = "".join(w.capitalize() for w in app_short.split("_"))
    return f'''/**
 * {app_name} CLI Server route handler.
 *
 * 【开发指南 — Agent 请仔细阅读】
 *
 * 1. 路由分发:
 *    - 此 handler 由 cli-server.ts 在 url.startsWith('/{app_short}/') 时调用
 *    - url 格式: /{app_short}/list、/{app_short}/123 等
 *    - 如需精细路由（不同 path 不同处理），在此文件内用 if/switch 分发
 *
 * 2. djangoRequest(url, method, body):
 *    - 将请求代理到 Django 后端 API
 *    - url 会被拼接到 Django API base URL 上
 *    - 返回 {{ status: number, data: any }}
 *
 * 3. 自定义路由（不经过 Django）:
 *    - 如果某些操作是 Electron 本地的（如文件操作），可以不调用 djangoRequest
 *    - 直接处理后调用 sendJSON(res, 200, {{ ...result }})
 *
 * 4. 错误处理:
 *    - djangoRequest 的网络错误/超时由 try/catch 捕获
 *    - Django 返回的业务错误（4xx）直接透传状态码和 data
 *    - 未知异常统一返回 500 + 错误描述
 */

import http from 'node:http'
import {{ djangoRequest, type SendJSON }} from './shared/error-handler'

export async function handle{fn}Route(
  url: string,
  method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
) {{
  try {{
    const result = await djangoRequest(method, url, body)
    sendJSON(res, result.status, result.data)
  }} catch (err: unknown) {{
    const message = err instanceof Error ? err.message : 'Internal server error'
    sendJSON(res, 500, {{ error: message }})
  }}
}}
'''


class Command(BaseCommand):
    help = "工具脚手架 — 覆盖 audit_tools 全部检查点"

    def add_arguments(self, p):
        p.add_argument("tool_name", help="工具名（如 my_tool 或 tabxxx.my_tool）")
        # W6 后默认走 frontend：FC 在 TS Runtime 注册才是 LLM 可见路径。
        # backend 仍保留作为 HTTP API 服务实现脚手架（不再向 LLM 暴露）。
        p.add_argument("--type", dest="tool_type", default="frontend",
                        choices=["backend", "frontend", "cli", "extension"],
                        help="工具类型（默认 frontend；backend 用于 HTTP API 服务实现，不再注册到 ToolHub）")
        p.add_argument("--domain", help="工具域（后端/前端必须）")
        p.add_argument("--risk-level", default="safe",
                        choices=["safe", "review", "strict"],
                        help="风险等级（默认 safe）")
        p.add_argument("--description", default="", help="工具描述（必填）")
        p.add_argument("--with-skill", action="store_true",
                        help="同时生成 SKILL.md")
        p.add_argument("--dry-run", action="store_true", help="仅预览")

    def handle(self, *args, **opts):
        tool_name = opts["tool_name"]
        tool_type = opts["tool_type"]
        domain = opts["domain"]
        risk = opts["risk_level"]
        desc = opts["description"]
        with_skill = opts["with_skill"]
        dry = opts["dry_run"]

        # 拆分 namespace.tool_name 格式
        base_name = tool_name
        if "." in tool_name:
            parts = tool_name.split(".", 1)
            if not domain:
                domain = parts[0]
            base_name = parts[1]

        if tool_type in ("backend", "frontend", "extension") and not domain:
            self.stderr.write(self.style.ERROR("后端/前端工具必须指定 --domain"))
            raise SystemExit(1)

        if not desc:
            self.stderr.write(self.style.ERROR("必须指定 --description"))
            raise SystemExit(1)

        if len(desc) < 20 and tool_type != "cli":
            self.stderr.write(self.style.WARNING(
                f"description 仅 {len(desc)} 字符，建议 ≥30 字符（包含功能+场景+约束）"))

        mode = "DRY-RUN" if dry else "执行"
        self.stdout.write(self.style.HTTP_INFO(
            f"\n{'='*70}\n  工具脚手架 [{mode}]: {tool_name} ({tool_type})\n{'='*70}\n"
        ))

        if tool_type == "backend":
            self._create_backend(tool_name, base_name, domain, desc, risk, with_skill, dry)
        elif tool_type == "extension":
            self._create_extension(tool_name, base_name, domain, desc, risk, with_skill, dry)
        elif tool_type == "frontend":
            self._create_frontend(tool_name, base_name, domain, desc, risk, with_skill, dry)
        elif tool_type == "cli":
            self._create_cli(tool_name, desc, with_skill, dry)

    def _create_backend(self, full_name: str, base_name: str, domain: str, desc: str,
                        risk: str, with_skill: bool, dry: bool):
        log: list[tuple[str, str]] = []
        tool_name = base_name

        self.stdout.write(self.style.MIGRATE_HEADING("  [1/4] 生成工具文件"))

        tool_dir = _TOOLS / domain
        get_fn = f"get_{domain}_tools"
        init_line = f"from .tool_registry import {get_fn}"
        s = _write_new(tool_dir / "__init__.py", init_line + "\n", dry)
        if s == SKIP:
            s = _append_line_if_missing(tool_dir / "__init__.py", init_line, dry)
        log.append((s, f"tools/{domain}/__init__.py"))

        s = _write_new(tool_dir / f"{tool_name}.py",
                       T_BACKEND_TOOL(full_name, tool_name, domain, desc, risk), dry)
        log.append((s, f"tools/{domain}/{tool_name}.py"))
        self.stdout.write(f"    {s} tools/{domain}/{tool_name}.py")

        # tool_registry
        registry_file = tool_dir / "tool_registry.py"
        if not registry_file.exists():
            s = _write_new(registry_file,
                           T_TOOL_REGISTRY(domain, tool_name), dry)
            log.append((s, f"tools/{domain}/tool_registry.py"))
            self.stdout.write(f"    {s} tools/{domain}/tool_registry.py（新建）")
        else:
            cls = _to_pascal(tool_name) + "Tool"
            import_line = f"from .{tool_name} import {cls}"
            s1 = _insert_after(registry_file, "from apps.services.tools import BaseTool",
                               import_line, dry)
            if s1 == FAIL:
                s1 = _insert_after(registry_file, "import", import_line, dry)
            s2 = _insert_into_python_return_list(
                registry_file,
                get_fn,
                f"    {cls}(),",
                dry,
            )
            if FAIL in (s1, s2):
                s = FAIL
            elif DONE in (s1, s2):
                s = DONE
            elif SKIP in (s1, s2):
                s = SKIP
            else:
                s = FAIL
            log.append((s, f"tools/{domain}/tool_registry.py（追加）"))
            self.stdout.write(f"    {s} tools/{domain}/tool_registry.py（追加工具）")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [2/4] HTTP API 暴露提示（W6 后不再走 ToolHub）"))
        self.stdout.write(
            f"    ℹ 已生成 BaseTool 子类骨架（HTTP API 服务实现）。\n"
            f"      LLM 不会自动看到此工具——请按以下任一方式暴露：\n"
            f"      1) Go CLI: 在 packages/tabtin-cli-go/cmd/ 加子命令 → CLI Server route → 调本类\n"
            f"      2) 前端 Action Tool: packages/action-tools/src/tools/{domain}/ 下声明 FC\n"
            f"      3) Extension: 在 BaseExtension.get_cli_commands() 声明 CliCommandDescriptor"
        )

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [3/4] Skill 覆盖"))

        if with_skill:
            skill_dir = (_ROOT / "packages" / "apps" / domain / "skills"
                         / f"{domain}-operator")
            if not skill_dir.exists():
                skill_dir = (_DJ / "apps" / "skills" / "bundled" / "platform"
                             / domain / "operations")
            s = _write_new(skill_dir / "SKILL.md",
                           T_SKILL_MD(f"{domain}-operator", domain, desc,
                                      [tool_name], ["fc"], tool_type="backend"), dry)
            log.append((s, "SKILL.md"))
            self.stdout.write(f"    {s} SKILL.md")
        else:
            self.stdout.write(f"    {SKIP} 未指定 --with-skill")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [4/4] 格式校验预检"))

        name_ok = re.match(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$", full_name) is not None
        checks = [
            (risk in _VALID_RISKS, f"risk_level='{risk}'"),
            (len(desc) >= 30, f"description 长度 {len(desc)} (建议≥30)"),
            (name_ok, f"name='{full_name}' 格式"),
        ]
        if risk in ("review", "strict"):
            checks.append((True, f"available_modes 已自动设置"))
        for ok, msg in checks:
            self.stdout.write(f"    {DONE if ok else FAIL} {msg}")

        self._summary(log, dry, full_name, tool_type="backend")

    def _create_extension(self, full_name: str, base_name: str, domain: str, desc: str,
                          risk: str, with_skill: bool, dry: bool):
        """Extension FC + CLI 工具：同时生成 FC 工具和 CLI 命令骨架。"""
        log: list[tuple[str, str]] = []
        tool_name = base_name

        self.stdout.write(self.style.MIGRATE_HEADING("  [1/4] 生成 Extension FC 工具文件"))

        ext_dir = _DJ / "apps" / domain
        s = _write_new(ext_dir / "__init__.py", "", dry)
        log.append((s, f"apps/{domain}/__init__.py"))

        s = _write_new(ext_dir / f"{tool_name}.py",
                       T_EXTENSION_TOOL(full_name, tool_name, domain, desc, risk), dry)
        log.append((s, f"apps/{domain}/{tool_name}.py"))
        self.stdout.write(f"    {s} apps/{domain}/{tool_name}.py")

        tools_py = ext_dir / "tools.py"
        if not tools_py.exists():
            s = _write_new(tools_py,
                           T_EXTENSION_TOOLS_PY(domain, tool_name), dry)
            log.append((s, f"apps/{domain}/tools.py"))
            self.stdout.write(f"    {s} apps/{domain}/tools.py（新建）")
        else:
            cls = _to_pascal(tool_name) + "Tool"
            import_line = f"from .{tool_name} import {cls}"
            s1 = _insert_after(tools_py, "import", import_line, dry)
            s2 = _insert_into_python_return_list(
                tools_py,
                "get_tools",
                f"    {cls}(),",
                dry,
            )
            if FAIL in (s1, s2):
                s = FAIL
            elif DONE in (s1, s2):
                s = DONE
            elif SKIP in (s1, s2):
                s = SKIP
            else:
                s = FAIL
            log.append((s, f"apps/{domain}/tools.py（追加）"))
            self.stdout.write(f"    {s} apps/{domain}/tools.py（追加工具）")

        ext_name = domain.replace("_", " ").title()
        ext_py = ext_dir / "extension.py"
        if not ext_py.exists():
            s = _write_new(ext_py, T_EXTENSION_PY(domain, ext_name), dry)
            log.append((s, f"apps/{domain}/extension.py"))
            self.stdout.write(f"    {s} apps/{domain}/extension.py（新建）")
        else:
            self.stdout.write(f"    {SKIP} apps/{domain}/extension.py 已存在")

        apps_py = ext_dir / "apps.py"
        if not apps_py.exists():
            s = _write_new(apps_py, T_EXTENSION_APPS_PY(domain, ext_name), dry)
            log.append((s, f"apps/{domain}/apps.py"))
            self.stdout.write(f"    {s} apps/{domain}/apps.py（新建）")
        else:
            self.stdout.write(f"    {SKIP} apps/{domain}/apps.py 已存在")

        settings = _DJ / "tabtin" / "settings.py"
        config_cls = _to_pascal(domain) + "Config"
        app_path = f"'apps.{domain}.apps.{config_cls}',"
        s = _insert_before(settings, "]  # end-creation-apps", f"    {app_path}", dry)
        if s == FAIL:
            s = _insert_before(settings, "'apps.tabchat.apps.TabchatConfig',", f"    {app_path}", dry)
        log.append((s, "tabtin/settings.py → INSTALLED_APPS"))
        self.stdout.write(f"    {s} tabtin/settings.py → INSTALLED_APPS")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [2/4] 生成 Extension CLI 命令声明"))

        cli_py = ext_dir / "cli_commands.py"
        if not cli_py.exists():
            s = _write_new(cli_py,
                           T_EXTENSION_CLI_PY(domain, tool_name, desc), dry)
            log.append((s, f"apps/{domain}/cli_commands.py"))
            self.stdout.write(f"    {s} apps/{domain}/cli_commands.py（新建）")
        else:
            self.stdout.write(f"    {SKIP} apps/{domain}/cli_commands.py 已存在（请手动追加命令）")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [3/4] Skill 覆盖"))

        if with_skill:
            skill_dir = (_ROOT / "packages" / "apps" / domain / "skills"
                         / f"{domain}-operator")
            if not skill_dir.exists():
                skill_dir = (_DJ / "apps" / "skills" / "bundled" / "platform"
                             / domain / "operations")
            s = _write_new(skill_dir / "SKILL.md",
                           T_SKILL_MD(f"{domain}-operator", domain, desc,
                                      [tool_name], ["fc", "cli"], tool_type="extension"), dry)
            log.append((s, "SKILL.md"))
            self.stdout.write(f"    {s} SKILL.md（含 @fc + @cli 分区）")
        else:
            self.stdout.write(f"    {SKIP} 未指定 --with-skill")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [4/4] 格式校验预检"))

        name_ok = re.match(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$", full_name) is not None
        checks = [
            (risk in _VALID_RISKS, f"risk_level='{risk}'"),
            (len(desc) >= 30, f"description 长度 {len(desc)} (建议≥30)"),
            (name_ok, f"name='{full_name}' 格式"),
        ]
        if risk in ("review", "strict"):
            checks.append((True, "available_modes 已自动设置"))
        for ok, msg in checks:
            self.stdout.write(f"    {DONE if ok else FAIL} {msg}")

        self.stdout.write(self.style.NOTICE(
            f"\n  提醒:\n"
            f"  1. Extension 的 get_tools() 需返回 FC 工具列表\n"
            f"  2. Extension 的 get_cli_commands() 需返回 CLI 命令声明\n"
            f"  3. ExtensionCapabilities 需设置 has_tools=True, has_cli=True\n"
            f"  4. 通过 ExtensionRegistry.register() 统一注册"))
        self._summary(log, dry, full_name, tool_type="extension")

    def _create_frontend(self, full_name: str, base_name: str, domain: str, desc: str,
                         risk: str, with_skill: bool, dry: bool):
        log: list[tuple[str, str]] = []
        tool_name = base_name

        self.stdout.write(self.style.MIGRATE_HEADING("  [1/3] 生成工具文件"))

        at_dir = _ROOT / "packages" / "action-tools" / "src" / "tools" / domain

        s = _write_new(at_dir / f"{tool_name}.ts",
                       T_FRONTEND_TOOL(full_name, domain, desc, risk), dry)
        log.append((s, f"action-tools/tools/{domain}/{tool_name}.ts"))
        self.stdout.write(f"    {s} action-tools/tools/{domain}/{tool_name}.ts")

        meta_file = at_dir / "_meta.ts"
        if not meta_file.exists():
            s = _write_new(meta_file,
                           T_FRONTEND_META(domain, risk, full_name), dry)
            log.append((s, f"_meta.ts"))
            self.stdout.write(f"    {s} _meta.ts（新建）")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [2/3] 域注册"))

        idx_ts = _ROOT / "packages" / "action-tools" / "src" / "tools" / "index.ts"
        if idx_ts.exists():
            import_line = f"import {{ domain as {domain}Domain }} from './{domain}/_meta'"
            s1 = _insert_after(idx_ts, "import { domain as", import_line, dry)
            if s1 == FAIL:
                s1 = _insert_after(idx_ts, "import type", import_line, dry)
            domain_var = f"  {domain}Domain,"
            s2 = _insert_into_ts_array(idx_ts, "allDomains", domain_var, dry)
            if FAIL in (s1, s2):
                s = FAIL
            elif DONE in (s1, s2):
                s = DONE
            elif SKIP in (s1, s2):
                s = SKIP
            else:
                s = FAIL
            log.append((s, "tools/index.ts"))
            self.stdout.write(f"    {s} tools/index.ts → import + allDomains")
        else:
            log.append((FAIL, "tools/index.ts"))
            self.stdout.write(f"    {FAIL} tools/index.ts 不存在")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [3/3] 格式校验预检"))

        name_ok = re.match(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$", full_name) is not None
        checks = [
            (risk in _VALID_RISKS, f"riskLevel='{risk}'"),
            (len(desc) >= 20, f"description 长度 {len(desc)} (建议≥20)"),
            (name_ok, f"name='{full_name}' 格式"),
        ]
        for ok, msg in checks:
            self.stdout.write(f"    {DONE if ok else FAIL} {msg}")

        self.stdout.write(self.style.NOTICE(
            f"\n  提醒: 构建前端工具 manifest 请执行: pnpm -C packages/action-tools build"))
        self._summary(log, dry, full_name, tool_type="frontend")

    def _create_cli(self, tool_name: str, desc: str, with_skill: bool, dry: bool):
        log: list[tuple[str, str]] = []
        app_short = tool_name[3:] if tool_name.startswith("tin") else tool_name

        self.stdout.write(self.style.MIGRATE_HEADING("  [1/3] 生成 CLI 命令"))

        cli_dir = _ROOT / "packages" / "tabtin-cli-go" / "cmd"
        s = _write_new(cli_dir / f"{app_short}.ts",
                       T_CLI_COMMAND(app_short, desc), dry)
        log.append((s, f"commands/{app_short}.ts"))
        self.stdout.write(f"    {s} commands/{app_short}.ts")

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [2/3] CLI 注册"))

        fn = "".join(w.capitalize() for w in app_short.split("_"))
        core_commands_file = _ROOT / "packages" / "tabtin-cli-go" / "cmd" / "apps.go"
        if core_commands_file.exists():
            import_line = f"import {{ register{fn}Command }} from './commands/{app_short}.js'"
            import_status = _insert_after(
                core_commands_file,
                "import { registerCapabilitiesCommand } from './commands/capabilities.js'",
                import_line,
                dry,
            )
            definition_entry = (
                f"  {{\n"
                f"    name: '{app_short}',\n"
                f"    register: register{fn}Command,\n"
                f"    uiVisible: true,\n"
                f"    requiresSkill: {'true' if with_skill else 'false'},\n"
                f"    routeMode: 'cli_server',\n"
                f"  }},"
            )
            definition_status = _insert_into_ts_array(core_commands_file, "CORE_COMMAND_DEFINITIONS", definition_entry, dry)
            if FAIL in (import_status, definition_status):
                s = FAIL
            elif DONE in (import_status, definition_status):
                s = DONE
            elif SKIP in (import_status, definition_status):
                s = SKIP
            else:
                s = FAIL
            log.append((s, "apps.go"))
            self.stdout.write(f"    {s} Go CLI apps.go → CommandDef 注册")
        else:
            self.stdout.write(f"    {FAIL} Go CLI apps.go 不存在")
            log.append((FAIL, "apps.go"))

        self.stdout.write(self.style.MIGRATE_HEADING("\n  [3/3] CLI Server 路由"))

        route_dir = _ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "routes"
        s = _write_new(route_dir / f"{app_short}.ts",
                       T_CLI_ROUTE(app_short, desc), dry)
        log.append((s, f"routes/{app_short}.ts"))
        self.stdout.write(f"    {s} routes/{app_short}.ts")

        cli_srv = _ROOT / "apps" / "tabtin-electron" / "src" / "main" / "cli" / "cli-server.ts"
        if cli_srv.exists():
            s1 = _insert_after(cli_srv, "from './routes/",
                f"import {{ handle{fn}Route }} from './routes/{app_short}'", dry)
            route_block = (
                f"    if (url.startsWith('/{app_short}/')) {{\n"
                f"      await handle{fn}Route(url, method, body, res, sendJSON)\n"
                f"      return\n"
                f"    }}"
            )
            s2 = _insert_before(
                cli_srv,
                "sendJSON(res, 404, { success: false, error: `Unknown route: ${url}` })",
                route_block,
                dry,
            )
            if FAIL in (s1, s2):
                s = FAIL
            elif DONE in (s1, s2):
                s = DONE
            elif SKIP in (s1, s2):
                s = SKIP
            else:
                s = FAIL
            log.append((s, "cli-server.ts"))
            self.stdout.write(f"    {s} cli-server.ts → 路由挂载")
        else:
            log.append((FAIL, "cli-server.ts"))
            self.stdout.write(f"    {FAIL} cli-server.ts 不存在")

        if with_skill:
            self.stdout.write(self.style.MIGRATE_HEADING("\n  [4/4] Skill 覆盖"))
            domain = app_short
            skill_dir = (_ROOT / "packages" / "apps" / app_short / "skills"
                         / f"{app_short}-operator")
            if not skill_dir.exists():
                skill_dir = (_DJ / "apps" / "skills" / "bundled" / "platform"
                             / app_short / "operations")
            s = _write_new(skill_dir / "SKILL.md",
                           T_SKILL_MD(f"{app_short}-operator", app_short, desc,
                                      [], ["fc", "cli"], tool_type="cli"), dry)
            log.append((s, "SKILL.md"))
            self.stdout.write(f"    {s} SKILL.md（含 @fc + @cli 分区）")

        self.stdout.write(self.style.NOTICE(
            f"\n  提醒: 构建 CLI 请执行: cd packages/tabtin-cli-go && go build ./..."))
        self._summary(log, dry, tool_name, tool_type="cli")

    def _summary(self, log: list, dry: bool, name: str, *, tool_type: str = "backend"):
        created = sum(1 for s, _ in log if s == NEW)
        modified = sum(1 for s, _ in log if s == DONE)
        skipped = sum(1 for s, _ in log if s == SKIP)
        failed = sum(1 for s, _ in log if s == FAIL)

        self.stdout.write(self.style.HTTP_INFO(
            f"\n  新建: {created} | 修改: {modified} | "
            f"已存在: {skipped} | 失败: {failed}"
        ))

        if failed > 0:
            self.stdout.write(self.style.WARNING("  部分操作失败："))
            for s, msg in log:
                if s == FAIL:
                    self.stdout.write(self.style.ERROR(f"    {FAIL} {msg}"))
            raise SystemExit(1)

        if not dry:
            if tool_type in ("backend", "extension"):
                error_guidance = (
                    "BaseTool 成功保持 {status: 'ok', ...}；失败通过 build_tool_error(...) "
                    "返回 {success: false, error: '...', error_kind: '...', hint: '...'}"
                )
            elif tool_type == "frontend":
                error_guidance = (
                    "Action Tool 成功返回 {status: 'ok', ...}；"
                    "失败返回 {status: 'error', error: '...', hint: '...'}"
                )
            else:
                error_guidance = "CLI 非 2xx 响应必须交给 handleCommandError 处理"

            self.stdout.write(self.style.MIGRATE_HEADING("\n  下一步（参考生成文件顶部的开发指南）:"))
            self.stdout.write(f"    1. 打开生成的工具文件，阅读顶部【开发指南】注释")
            self.stdout.write(f"    2. 修改 args_schema: 定义实际参数，每个参数必须有 Field(description=...)")
            self.stdout.write(f"    3. 修改 description: 对 LLM 友好的描述（做什么 + 什么时候用 + 约束）")
            self.stdout.write(f"    4. 实现 run()/execute() 业务逻辑")
            self.stdout.write(f"    5. 错误处理: {error_guidance}")
            self.stdout.write(f"    6. 验证: python manage.py audit_tools --tool {name}")
            self.stdout.write(f"       确认 name/description/risk_level/args_schema 均通过审计")
        else:
            self.stdout.write(self.style.NOTICE(
                "\n  DRY-RUN 预览，去掉 --dry-run 执行实际创建"))

        self.stdout.write("")
