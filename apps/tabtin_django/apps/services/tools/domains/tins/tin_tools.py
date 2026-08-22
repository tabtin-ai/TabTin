"""Tins Agent 工具：AI 对话式创建/管理智能微应用。"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from apps.services.common.db_router import postgres_app_db_alias
from apps.services.tools import BaseTool
from apps.services.tools.error_envelope import json_tool_error

logger = logging.getLogger(__name__)


def _log_failure(
    operation: str,
    exc: Exception,
    *,
    resource_id: object | None = None,
) -> None:
    """Log only non-sensitive failure metadata; never attach traceback/message."""
    logger.error(
        "tin operation failed operation=%s resource_id=%s error_type=%s",
        operation,
        resource_id or "-",
        type(exc).__name__,
    )


def _err_missing_organization() -> str:
    return json_tool_error(
        "Missing organization_id",
        error_kind="runtime_misconfig",
        hint=(
            "Start the Agent in an authenticated Space so organization_id "
            "is injected, then retry."
        ),
        retryable=False,
    )


def _err_missing_organization_or_space() -> str:
    return json_tool_error(
        "Missing organization_id or space_id",
        error_kind="runtime_misconfig",
        hint=(
            "Start the Agent in an authenticated Space so organization_id "
            "and space_id are injected, then retry."
        ),
        retryable=False,
    )


def _err_invalid_tin_id() -> str:
    return json_tool_error(
        "Invalid tin_id format.",
        error_kind="invalid_param_format",
        hint="Pass a valid UUID tin_id, then retry.",
        retryable=False,
    )


def _err_tin_not_found() -> str:
    return json_tool_error(
        "Tin not found.",
        error_kind="resource_not_found",
        hint="Confirm the tin_id still exists in this organization, then retry.",
        retryable=False,
    )


def _err_invalid_param() -> str:
    return json_tool_error(
        "Invalid Tin parameter.",
        error_kind="invalid_param_format",
        hint=(
            "Correct the Tin input (for example file_type must be panel_html, "
            "content_script, background_script, or agent_instructions), then retry."
        ),
        retryable=False,
    )


def _err_internal(operation: str) -> str:
    return json_tool_error(
        f"Tin {operation} failed.",
        error_kind="internal_error",
        hint="Retry once. If it fails again, ask the user to retry from the Tins UI.",
        retryable=True,
    )


# ── Input Schemas ────────────────────────────────────────────


class ActivationRuleDef(BaseModel):
    type: Literal["url_pattern", "page_language", "page_content", "always"] = Field(
        default="url_pattern",
        description="规则类型：url_pattern / page_language / page_content / always",
    )
    patterns: List[str] = Field(
        default_factory=list,
        description="URL 匹配模式列表，如 ['*://*.medium.com/*']",
    )
    languages: List[str] = Field(
        default_factory=list,
        description="页面语言列表，如 ['en', 'en-US']",
    )
    keywords: List[str] = Field(
        default_factory=list,
        description="页面内容关键词列表，用于 page_content 规则",
    )


class VariableDef(BaseModel):
    type: Literal["text", "select", "number", "boolean"] = Field(default="text", description="变量类型：text / select / number / boolean")
    label: str = Field(default="", description="变量显示名称")
    default: Any = Field(default=None, description="默认值")
    options: List[str] = Field(default_factory=list, description="select 类型的选项列表")


class CreateTinInput(BaseModel):
    name: str = Field(description="Tin 名称，如「英文词频助手」")
    description: str = Field(default="", description="Tin 的功能描述")
    activation_mode: Literal["auto", "suggest", "manual"] = Field(
        default="auto",
        description="激活模式：auto（自动展开）/ suggest（提示激活）/ manual（仅手动）",
    )
    activation_rules: List[ActivationRuleDef] = Field(
        default_factory=list,
        description="激活规则列表",
    )
    activation_match: Literal["any", "all"] = Field(
        default="any",
        description="多规则匹配逻辑：any（任一匹配）/ all（全部匹配）",
    )
    variables_schema: Dict[str, VariableDef] = Field(
        default_factory=dict,
        description="用户可配置的变量 schema",
    )
    permissions: List[str] = Field(
        default_factory=list,
        description="权限声明：page_content / page_selection / page_inject / table_write / agent_invoke 等。"
        "需要注入 content_script 到页面时必须声明 page_inject",
    )
    panel_position: Literal["sidebar_right", "sidebar_left", "bottom_panel", "overlay"] = Field(
        default="sidebar_right",
        description="UI 面板位置：sidebar_right / sidebar_left / bottom_panel / overlay",
    )
    panel_width: int = Field(default=360, description="面板宽度（px）")
    panel_html: str = Field(
        description=(
            "UI 面板的完整 HTML 源码。这是 Tin 的核心界面，运行在沙箱 WebView 中。"
            "可以使用 CDN 库（如 Chart.js、D3.js），"
            "通过 window.tin API 与宿主通信。"
        ),
    )
    content_script: str = Field(
        default="",
        description="注入到浏览页面的 JavaScript 脚本（可选）",
    )
    background_script: str = Field(
        default="",
        description="在主进程沙箱中运行的后台脚本（可选）",
    )
    agent_instructions: str = Field(
        default="",
        description="Agent 可读的 Markdown 指令文档，描述 Tin 的用途和交互方式",
    )
    auto_activate: bool = Field(
        default=True,
        description="创建后自动激活并安装到当前 Space（推荐 True）",
    )


class UpdateTinFileInput(BaseModel):
    tin_id: str = Field(description="要更新的 Tin ID")
    file_type: Literal["panel_html", "content_script", "background_script", "agent_instructions"] = Field(
        description="文件类型：panel_html / content_script / background_script / agent_instructions",
    )
    content: str = Field(description="新的文件内容")


class ListTinsInput(BaseModel):
    status: Optional[str] = Field(
        None,
        description="按状态过滤：draft / active / disabled（空则返回全部）",
    )


class ActivateTinInput(BaseModel):
    tin_id: str = Field(description="要激活的 Tin ID")


class GetTinContextInput(BaseModel):
    """获取当前激活 Tin 上下文（用于 Agent 感知环境）。"""
    space_id: Optional[str] = Field(
        None,
        description="Space ID，为空时使用当前 context",
    )


# ── Tools ────────────────────────────────────────────────────


class CreateTinTool(BaseTool):
    """创建一个智能微应用（Tin）。

    Tin 是一个可在浏览器页面上下文中自动激活的微应用，
    包含 UI 面板、页面脚本和 Agent 指令。
    可以理解为 Agent 帮用户定制的浏览器插件。
    """

    name: str = "tin_create"
    description: str = (
        "Create a Tin (smart micro-app) that activates in specific browser contexts. "
        "A Tin includes an HTML UI panel rendered in a sandboxed WebView, "
        "optional page injection scripts, and Agent-readable instructions. "
        "The panel HTML can use CDN libraries and communicate with the host "
        "via window.tin API (getPageContent, getPageUrl, getVariable, etc). "
        "By default auto_activate=True: the Tin is created, activated, and installed to the current Space in one step."
    )
    args_schema: type[CreateTinInput] = CreateTinInput
    risk_level: str = "review"
    timeout: int = 30

    def run(self, **kwargs) -> str:
        from django.db import transaction
        from apps.tins.services.tin_service import TinService, TinInstanceService

        user_id = kwargs.pop("user_id", None)
        space_id = kwargs.pop("space_id", None)
        organization_id = kwargs.pop("organization_id", None)
        auto_activate = kwargs.pop("auto_activate", True)

        if not organization_id:
            return _err_missing_organization()

        data = {k: v for k, v in kwargs.items() if v is not None}
        data["source"] = "agent_generated"

        if "activation_rules" in data:
            data["activation_rules"] = [
                r.model_dump() if hasattr(r, "model_dump") else r
                for r in data["activation_rules"]
            ]
        if "variables_schema" in data:
            data["variables_schema"] = {
                k: (v.model_dump() if hasattr(v, "model_dump") else v)
                for k, v in data["variables_schema"].items()
            }

        try:
            with transaction.atomic(using=postgres_app_db_alias()):
                tin = TinService.create_tin(
                    organization_id=organization_id,
                    data=data,
                    space_id=space_id,
                    created_by=user_id,
                )

                if auto_activate:
                    TinService.activate_tin(tin)
                    if space_id:
                        TinInstanceService.install_tin(
                            tin=tin,
                            space_id=space_id,
                            organization_id=organization_id,
                        )

            return json.dumps({
                "success": True,
                "tin_id": str(tin.id),
                "name": tin.name,
                "status": tin.status,
                "message": (
                    f"Tin '{tin.name}' created and activated. "
                    f"It will appear in the user's Tins panel and auto-activate in matching contexts."
                ) if auto_activate else (
                    f"Tin '{tin.name}' created in draft status. "
                    f"Call tin_activate to enable it."
                ),
            })
        except Exception as exc:
            _log_failure("create", exc, resource_id=organization_id)
            return _err_internal("create")


class UpdateTinFileTool(BaseTool):
    """更新 Tin 的单个文件（如 UI 面板 HTML、脚本等）。"""

    name: str = "tin_update_file"
    description: str = (
        "Update a specific file of an existing Tin. "
        "Supported file_type values: panel_html, content_script, "
        "background_script, agent_instructions."
    )
    args_schema: type[UpdateTinFileInput] = UpdateTinFileInput
    risk_level: str = "review"
    timeout: int = 15

    def run(self, tin_id: str, file_type: str, content: str, **kwargs) -> str:
        from apps.tins.services.tin_service import TinService
        from uuid import UUID

        organization_id = kwargs.get("organization_id")
        if not organization_id:
            return _err_missing_organization()

        try:
            tin_uuid = UUID(tin_id)
        except (ValueError, AttributeError):
            return _err_invalid_tin_id()

        try:
            tin = TinService.get_tin(tin_uuid, organization_id)
            if not tin:
                return _err_tin_not_found()

            TinService.update_file(tin, file_type, content)
            return json.dumps({
                "success": True,
                "tin_id": tin_id,
                "file_type": file_type,
                "message": f"Updated {file_type} for Tin '{tin.name}'.",
            })
        except ValueError:
            return _err_invalid_param()
        except Exception as exc:
            _log_failure("update_file", exc, resource_id=tin_id)
            return _err_internal("update_file")


class ListTinsTool(BaseTool):
    """列出当前 Organization 中的 Tin 列表。"""

    name: str = "tin_list"
    description: str = (
        "List all Tins in the current organization. "
        "Returns name, status, activation rules, and description for each Tin."
    )
    args_schema: type[ListTinsInput] = ListTinsInput
    risk_level: str = "safe"
    timeout: int = 10

    def run(self, status: Optional[str] = None, **kwargs) -> str:
        from apps.tins.services.tin_service import TinService

        organization_id = kwargs.get("organization_id")
        if not organization_id:
            return _err_missing_organization()

        try:
            qs = TinService.list_tins_qs(organization_id, status=status)
            total = qs.count()

            tins = []
            for t in qs[:30]:
                tins.append({
                    "id": str(t.id),
                    "name": t.name,
                    "status": t.status,
                    "source": t.source,
                    "description": t.description[:200],
                    "activation_mode": t.activation_mode,
                    "activation_rules": t.activation_rules,
                    "panel_position": t.panel_position,
                })

            return json.dumps({"success": True, "tins": tins, "total": total})
        except Exception as exc:
            _log_failure("list", exc, resource_id=organization_id)
            return _err_internal("list")


class ActivateTinTool(BaseTool):
    """将 Tin 状态设为 active，使其可以在浏览器上下文中自动激活。"""

    name: str = "tin_activate"
    description: str = (
        "Activate a Tin so it can auto-activate in matching browser contexts. "
        "Also installs it in the current Space if not already installed."
    )
    args_schema: type[ActivateTinInput] = ActivateTinInput
    risk_level: str = "review"
    timeout: int = 10

    def run(self, tin_id: str, **kwargs) -> str:
        from django.db import transaction
        from apps.tins.services.tin_service import TinService, TinInstanceService
        from uuid import UUID

        organization_id = kwargs.get("organization_id")
        space_id = kwargs.get("space_id")
        if not organization_id:
            return _err_missing_organization()

        try:
            tin_uuid = UUID(tin_id)
        except (ValueError, AttributeError):
            return _err_invalid_tin_id()

        try:
            tin = TinService.get_tin(tin_uuid, organization_id)
            if not tin:
                return _err_tin_not_found()

            with transaction.atomic(using=postgres_app_db_alias()):
                TinService.activate_tin(tin)
                if space_id:
                    TinInstanceService.install_tin(
                        tin=tin,
                        space_id=space_id,
                        organization_id=organization_id,
                    )

            return json.dumps({
                "success": True,
                "tin_id": str(tin.id),
                "name": tin.name,
                "status": "active",
                "message": f"Tin '{tin.name}' is now active and will auto-activate in matching contexts.",
            })
        except Exception as exc:
            _log_failure("activate", exc, resource_id=tin_id)
            return _err_internal("activate")


class GetTinContextTool(BaseTool):
    """获取当前 Space 中激活的 Tin 列表及其上下文。"""

    name: str = "tin_get_context"
    description: str = (
        "Get the list of active Tins in the current Space, "
        "including their agent_instructions. "
        "Use this to understand what Tins are available and how to interact with them."
    )
    args_schema: type[GetTinContextInput] = GetTinContextInput
    risk_level: str = "safe"
    timeout: int = 10

    def run(self, space_id: Optional[str] = None, **kwargs) -> str:
        from apps.tins.models import TinInstance

        organization_id = kwargs.get("organization_id")
        if not organization_id or not space_id:
            return _err_missing_organization_or_space()

        try:
            instances = TinInstance.objects.filter(
                organization_id=organization_id,
                space_id=space_id,
                is_enabled=True,
                tin__status="active",
            ).select_related("tin")

            context = []
            for inst in instances:
                tin = inst.tin
                entry = {
                    "tin_id": str(tin.id),
                    "instance_id": str(inst.id),
                    "name": tin.name,
                    "description": tin.description,
                    "activation_mode": tin.activation_mode,
                    "activation_rules": tin.activation_rules,
                    "permissions": tin.permissions,
                }
                if tin.agent_instructions:
                    entry["agent_instructions"] = tin.agent_instructions
                context.append(entry)

            return json.dumps({"success": True, "active_tins": context, "total": len(context)})
        except Exception as exc:
            _log_failure("get_context", exc, resource_id=space_id)
            return _err_internal("get_context")


# ── 注册函数 ─────────────────────────────────────────────────


def get_tins_tools() -> list:
    """返回 Tins 相关的 Agent 工具列表。"""
    return [
        CreateTinTool(),
        UpdateTinFileTool(),
        ListTinsTool(),
        ActivateTinTool(),
        GetTinContextTool(),
    ]
