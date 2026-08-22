"""Extension 协议基类

每个 Extension（TabMail、Telegram、GitHub …）都实现此接口，
ExtensionRuntime 据此统一管理工具注册、事件发布和生命周期。

设计参考：
- ChannelAdapter（channel_gateway/adapters/base.py）的身份 + 配置 + 能力声明
- ToolHub 的 register_provider 机制
- AgentMail 的 Inbox/Message/Webhook 设计
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from apps.extensions.public_api import public_api

if TYPE_CHECKING:
    from apps.extensions.models import ExtensionConnection

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 能力与元数据声明
# ---------------------------------------------------------------------------

@public_api("Extension 能力矩阵声明")
@dataclass(frozen=True)
class ExtensionCapabilities:
    """Extension 能力矩阵 — Runtime 据此决定注册哪些工具/事件。"""

    has_tools: bool = False          # 是否向 ToolHub 注册 FC 工具
    has_cli: bool = False            # 是否注册 CLI 命令（管道组合能力）
    has_events: bool = False         # 是否能产生事件
    has_inbound_webhook: bool = False  # 是否接收外部 webhook
    has_ui: bool = False             # 是否有独立前端页面
    supports_oauth: bool = False     # 是否支持 OAuth 认证
    supports_polling: bool = False   # 是否支持轮询模式收取事件


@public_api("事件 payload 字段声明")
@dataclass(frozen=True)
class PayloadField:
    """事件 payload 中的单个字段声明，供模板编辑器展示可用变量。"""

    key: str                 # 变量名，模板中用 {key} 引用
    label: str               # 用户可见的名称
    type: str = "string"     # string / number / boolean / list / object
    example: str = ""        # 示例值，帮助用户理解变量含义


@public_api("Extension 事件类型声明")
@dataclass(frozen=True)
class EventDescriptor:
    """Extension 能产生的事件类型声明。"""

    event_type: str           # 如 "email.received", "telegram.message_received"
    description: str = ""
    payload_fields: List[PayloadField] = field(default_factory=list)
    payload_schema: Optional[Dict[str, Any]] = None


@public_api("Extension 配置字段声明")
@dataclass(frozen=True)
class ConfigField:
    """Extension 配置字段声明，用于前端表单渲染。"""

    key: str
    label: str
    field_type: str = "string"  # string / password / url / select / boolean
    required: bool = False
    default: Any = None
    options: Optional[List[Dict[str, str]]] = None  # field_type=select 时的选项
    help_text: str = ""


@public_api("CLI 命令参数选项声明")
@dataclass(frozen=True)
class CliOptionDescriptor:
    """CLI 命令的单个参数选项声明。"""

    flag: str               # 如 "--to <addr>" 或 "-f, --format <format>"
    description: str         # 参数描述（Agent 可见）


@public_api("Extension CLI 命令声明")
@dataclass(frozen=True)
class CliCommandDescriptor:
    """Extension CLI 命令声明。

    每个 descriptor 对应一个子命令：tabtin {extension_id} {name}。
    tabtin CLI 据此动态注册 Cobra 命令。
    """

    name: str               # 子命令名，如 "send"、"list"
    description: str         # 命令描述（Agent 可见）
    api_endpoint: str        # 后端 API 路径（CLI Server 会代理到此）
    method: str = "POST"     # HTTP 方法
    options: List[CliOptionDescriptor] = field(default_factory=list)


from apps.channel_gateway.adapters.base import ProbeResult  # noqa: F401 — re-export


# ---------------------------------------------------------------------------
# Extension 基类
# ---------------------------------------------------------------------------

@public_api("所有 Extension 必须实现的协议基类")
class BaseExtension(ABC):
    """所有 Extension 必须实现的协议。

    Extension 同时具备三面能力：
    1. 工具面（被动）：Agent 调用的工具，注册到 ToolHub
    2. 事件面（主动）：Extension 产生的事件，发布到 EventBus
    3. 配置面：连接认证、健康检查等生命周期管理

    生命周期：
    1. register()     — Django 启动时注册到 ExtensionRegistry
    2. validate_config() — 用户保存配置时校验
    3. probe()        — 验证连通性
    4. get_tools()    — 返回工具列表，注册到 ToolHub
    5. start_event_listener() — 启动事件监听（如果有事件面）
    6. shutdown()     — 清理资源
    """

    # ------------------------------------------------------------------
    # 身份声明（子类必须设置）
    # ------------------------------------------------------------------

    @property
    @abstractmethod
    def id(self) -> str:
        """全局唯一标识，如 "tabmail", "telegram" 等."""

    @property
    @abstractmethod
    def name(self) -> str:
        """用户可见名称，如 "TabMail", "Telegram Bot"."""

    @property
    def description(self) -> str:
        return ""

    @property
    def icon(self) -> str:
        """图标标识（前端使用）。"""
        return ""

    @property
    @abstractmethod
    def extension_type(self) -> str:
        """Extension 分类：channel / integration."""

    @property
    @abstractmethod
    def capabilities(self) -> ExtensionCapabilities:
        """能力声明。"""

    @property
    def is_builtin(self) -> bool:
        """是否为系统内置 Extension（默认安装、不可卸载）。"""
        return False

    # ------------------------------------------------------------------
    # 配置面
    # ------------------------------------------------------------------

    @public_api("返回 Extension 配置字段列表")
    @abstractmethod
    def get_config_fields(self) -> List[ConfigField]:
        """返回配置字段列表，用于前端表单渲染和校验。"""

    @public_api("校验 Extension 配置")
    def validate_config(self, config: Dict[str, Any]) -> List[str]:
        """校验配置，返回错误列表（空 = 合法）。

        默认实现：检查 required 字段是否存在。
        """
        errors = []
        for f in self.get_config_fields():
            if f.required and not config.get(f.key):
                errors.append(f"缺少必填配置: {f.label} ({f.key})")
        return errors

    def get_config_schema(self) -> Dict[str, Any]:
        """返回 JSON Schema（可选，用于前端动态表单）。

        每个 property 额外携带 ``x-field-type`` 扩展字段，
        值与 ConfigField.field_type 一致（string / password / url / select / boolean），
        方便前端精确判断输入控件类型，而无需基于 key 名称推测。
        """
        properties = {}
        required = []
        for f in self.get_config_fields():
            prop: Dict[str, Any] = {"title": f.label, "x-field-type": f.field_type}
            if f.field_type == "boolean":
                prop["type"] = "boolean"
            elif f.field_type == "select" and f.options:
                prop["type"] = "string"
                prop["enum"] = [o["value"] for o in f.options]
            else:
                prop["type"] = "string"
            if f.default is not None:
                prop["default"] = f.default
            if f.help_text:
                prop["description"] = f.help_text
            properties[f.key] = prop
            if f.required:
                required.append(f.key)

        return {
            "type": "object",
            "properties": properties,
            "required": required,
        }

    # ------------------------------------------------------------------
    # 连通性
    # ------------------------------------------------------------------

    async def probe(self, connection: "ExtensionConnection") -> ProbeResult:
        """验证凭证和连通性。"""
        return ProbeResult(ok=False, error="probe not implemented")

    # ------------------------------------------------------------------
    # 工具面
    # ------------------------------------------------------------------

    @public_api("返回注册到 ToolHub 的工具列表")
    def get_tools(self, connection: Optional["ExtensionConnection"] = None) -> list:
        """返回注册到 ToolHub 的工具列表。

        **规范**：工具声明与工具执行分离。

        - **无 connection**：必须返回完整的工具声明列表（name + description），
          用于索引展示、Skill 桥接和文档生成。不依赖用户是否配置了连接。
        - **有 connection**：返回基于连接配置的可用工具（可以增减参数默认值、
          隐藏不适用工具等），用于实际执行。

        子类实现时，确保无参调用不会抛异常且不返回空列表（除非确实没有工具）。
        """
        return []

    @public_api("返回 ToolHub 中的 domain 名称")
    def get_tool_domain(self) -> str:
        """ToolHub 中的 domain 名称，默认等于 extension id。"""
        return self.id

    # ------------------------------------------------------------------
    # CLI 面（管道组合能力）
    # ------------------------------------------------------------------

    @public_api("声明 Extension 提供的 CLI 命令")
    def get_cli_commands(self) -> List["CliCommandDescriptor"]:
        """声明 Extension 提供的 CLI 命令。

        tabtin CLI 启动时会从后端获取 Extension CLI 声明并动态注册。
        每个命令会被注册为 `tabtin {extension_id} {subcommand}` 的形式。

        返回空列表表示不提供 CLI 命令。
        """
        return []

    # ------------------------------------------------------------------
    # 事件面
    # ------------------------------------------------------------------

    @public_api("声明 Extension 能产生的事件类型")
    def get_event_types(self) -> List[EventDescriptor]:
        """声明 Extension 能产生的事件类型。"""
        return []

    async def start_event_listener(
        self, connection: "ExtensionConnection"
    ) -> None:
        """启动事件监听（IMAP IDLE、WebSocket 长连接、轮询等）。

        事件产生后应调用 EventBus.emit()。
        默认不做任何事，子类按需实现。
        """
        pass

    async def stop_event_listener(
        self, connection: "ExtensionConnection"
    ) -> None:
        """停止事件监听，释放连接资源。"""
        pass

    # ------------------------------------------------------------------
    # Webhook 入站（外部系统推送到我们）
    # ------------------------------------------------------------------

    def parse_inbound_webhook(
        self,
        request_body: bytes,
        headers: Dict[str, str],
        connection: "ExtensionConnection",
    ) -> Optional[Dict[str, Any]]:
        """解析外部 webhook payload，返回标准化事件数据。

        返回 None 表示忽略此请求。
        默认不处理，子类按需实现。
        """
        return None

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    async def on_connected(self, connection: "ExtensionConnection") -> None:
        """连接建立后的回调。"""
        pass

    async def on_disconnected(self, connection: "ExtensionConnection") -> None:
        """连接断开后的回调。"""
        pass

    async def shutdown(self) -> None:
        """Django 关闭时的清理逻辑。"""
        pass
