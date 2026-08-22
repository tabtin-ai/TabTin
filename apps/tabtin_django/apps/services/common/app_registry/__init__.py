"""
APP 静态定义（唯一声明源）

平台应用列表，分为两类：
- CORE_APPS：内置核心应用（distribution=builtin），自动安装，不可卸载
- MARKETPLACE_APPS：市场应用（distribution=marketplace），用户手动安装/卸载

所有应用均从 packages/apps/*/app.json manifest 扫描加载，
按 distribution 字段分流。作为后端唯一的"有哪些 APP"的权威来源，驱动：
- 前端 Context Space 的 UI 行为
- Agent 上下文字段列表（替代 6 处手动重复声明）
- Agent 工具域映射
- Oneshot API 白名单
- App Catalog 展示

用法：
    from apps.services.common.app_registry import (
        CORE_APPS, MARKETPLACE_APPS, list_apps, get_app,
        get_all_context_field_names, get_resource_field_map,
        get_tool_domains_map, get_valid_app_types,
    )
"""

import json
import logging
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Optional
from functools import lru_cache

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AppContextField:
    """App 贡献给 Agent state 的上下文字段。

    每个 App 可以声明它需要的上下文字段（如 current_doc_id），
    这些声明会被 agent_state、chat_service、conversation API 等自动消费，
    无需在多处手动重复维护。
    """
    name: str                        # state 中的字段名，如 "current_doc_id"
    label: str = ""                  # Agent 可读标签，如 "doc_id"（用于 context_message 格式化）
    is_resource_id: bool = False     # 标记为主资源 ID（用于 oneshot _RESOURCE_FIELD_MAP）


@dataclass(frozen=True)
class AppEventDefinition:
    """App 声明的业务事件（charter v1.8 §6.3 事件本体声明机制）。

    事件用于 event Tracker 触发：``packages/apps/<id>/app.json`` 的 ``events[]``
    字段是平台事件本体的唯一声明源；``tabtin event list`` 是唯一查询接口。

    本期只声明 schema，**不强制 app 实现**——各 app 按自己节奏接入 EventBus。
    Wave 7.1 加 schema 声明 + 后端 loader + CLI 查询；EventBus 接入推到 v3+。

    字段语义（charter §6.3）：
      - ``key`` — 业务事件 key，必须是 ``<app>.<entity>.<action>`` 三段式
        （如 ``tabmail.email.received``）。**禁止暴露原子事件 key**
        （如 ``tabdata.record.created`` 是底层实现细节，charter §8 拒绝清单 #9）
      - ``label`` — 用户可见的中文标签（"收到新邮件"），CLI / UI 展示用
      - ``description`` — 一句话说明触发场景，给 Agent / 用户理解
      - ``payload_schema`` — 事件载荷的 JSON Schema 描述（可选，便于 Agent
        构造 filter 表达式）
      - ``filterable_fields`` — 推荐用作过滤条件的字段名（charter §5.3
        "用户配 event Tracker 时可挑这些字段做 filter"）
      - ``ai_filterable`` — 是否允许 Agent 自动推断 filter 条件（默认 True）
    """
    key: str
    label: str = ""
    description: str = ""
    payload_schema: tuple = ()       # ((field_name, field_type, required), ...)
    filterable_fields: tuple[str, ...] = ()
    ai_filterable: bool = True


@dataclass(frozen=True)
class AppDefinition:
    """APP 定义（builtin 和 marketplace 共用）"""

    id: str                              # 唯一标识
    name: str                            # 显示名
    version: str = ''                    # manifest version，用于 marketplace release 展示/审计
    icon: str = ""                       # 图标标识（前端 lucide icon 名）
    # 包内 SVG 资源描述。后端透传元数据，客户端负责把相对路径解析为本地构建资源。
    icon_asset: Optional[dict] = None
    context_type: Optional[str] = None   # ContextItem.item_type 中的资源类型
    can_create: bool = True              # 用户能否在 Context Space 中新建
    searchable: bool = False             # 资源是否出现在全局搜索中
    is_default_enabled: bool = True      # 新项目中默认是否启用
    order: int = 0                       # UI 默认排序权重

    # Agent 上下文字段（唯一声明源，替代 agent_state / chat_service 等 6 处手动列表）
    context_fields: tuple[AppContextField, ...] = ()

    # Agent 工具域（替代 tin_agent.APP_TYPE_TOOL_DOMAINS + factory._BACKEND_APP_DOMAINS）
    tool_domains: tuple[str, ...] = ()

    # 是否有专属 prompt section（prompts/apps/ 下的策略文件）
    has_prompt_section: bool = False

    # 背景标签展示字段名（用于 context_message._format_background_tab）
    # 如 'url' / 'path' / 'session_id'。空字符串表示使用 resource_id 字段名。
    display_field: str = ''

    # workspace_root 来源字段（当此 App 聚焦时用哪个 context 字段填充 workspace_root）
    # 如 'current_code_project_path' / 'current_folder_path'。空字符串表示不提供。
    workspace_root_source: str = ''

    # 纯前端 App：依赖 terminal/browser/gui/file 能力，无可用后端工具。
    # Agent 在降级模式下排除这些 App 的 prompt section。
    is_frontend_dependent: bool = False

    # 类型别名（如 tabfolder 可别名 'folder'），用于后端各处归一化。
    type_aliases: tuple[str, ...] = ()

    # 业务事件声明（charter v1.8 §6.3）：本 App 能产生的业务事件清单。
    # 用于 event Tracker 配置、`tabtin event list` 查询。
    # 空 tuple 表示该 App 暂无事件声明（不阻断启动，符合"只声明不强制实现"约束）。
    events: tuple[AppEventDefinition, ...] = ()

    # 运行时支持声明：{ "electron": {"mode": "full"}, "daemon": {"mode": "headless", ...} }
    # None 表示未声明（等同于所有运行时 full）
    runtime_support: Optional[dict] = None

    # 应用市场展示字段
    description: str = ''              # 应用简短描述（应用市场卡片展示）
    category: str = ''                 # 分类 ID: data/creation/development/intelligence/tools
    desktop_group: str = ''            # Desktop 分组: cloudResources/localResources/capabilities/extensions

    # ── UI 呈现 ──
    ui_runtime: str = ''               # localBundle / embeddedWeb / iframe
    embedded_web_base_url: str = ''    # 仅 embeddedWeb 时有值
    embedded_web_url_patterns: tuple[str, ...] = ()  # URL 发现模式
    embedded_web_session_mode: str = '' # persistent / isolated / temporary

    # ── 开放 App 平台新增 ──

    # builtin = 内置核心应用（自动安装）；marketplace = 市场应用（用户手动安装）
    distribution: str = 'builtin'

    # device = 设备级安装（安装记录在客户端本地，跨 organization 可用）
    # organization = 团队级安装（安装记录在后端 DB，仅该 organization 可见）
    install_scope: str = 'organization'

    # 应用形态（surface）：三态分类的**唯一真源（SSOT）**。
    #   builtin        = 内置常驻核心能力（浏览器 / 终端 / 目录 / 代码 / 桌面 …）
    #   local          = 个人可自助安装的本地扩展（Personal Plugin / MCP）
    #   collaborative  = 需团队治理的协作应用（登录 + 租户数据）
    # None = 未声明 surface（如技能包——它是独立层，不是应用形态）。
    # 见 docs/agent/capability-taxonomy.md：分类真源落后端，前端只做派生展示。
    surface: Optional[str] = None

    # Official Plugin Release metadata（/#1378 seam）。从 manifest 透传到 catalog
    # 与安装记录，避免把 Cowart 之类官方包退化成无来源的普通 marketplace app。
    official_plugin_release: Optional[dict] = None
    prepared_runtime: Optional[dict] = None


# ─── Manifest 驱动加载 ──────────────────────────────────────────

from apps.services.repo_root import get_repo_root

_PROJECT_ROOT = get_repo_root()
_CRITICAL_APPS = ("tabdata", "tabdoc", "tabcode")


def _normalize_icon_asset(
    raw_icon_asset: object,
    *,
    manifest_path: Path,
    app_id: str,
) -> Optional[dict]:
    """校验并规范化 manifest 的 ``uiHints.iconAsset``。

    资源路径只能指向当前 App 包内的 SVG。后端不读取或返回 SVG 内容，只把经过
    校验的相对路径和呈现语义透传给客户端，避免 API 与前端各维护一套图标映射。
    """
    if raw_icon_asset is None:
        return None
    if not isinstance(raw_icon_asset, dict):
        logger.warning(
            "[AppRegistry] %s uiHints.iconAsset 非 object，忽略: %r",
            app_id, raw_icon_asset,
        )
        return None

    manifest_dir = manifest_path.parent.resolve()

    def normalize_path(value: object, field: str) -> Optional[str]:
        if not isinstance(value, str):
            logger.warning(
                "[AppRegistry] %s iconAsset.%s 非字符串，忽略: %r",
                app_id, field, value,
            )
            return None
        relative_path = value.strip()
        candidate = Path(relative_path)
        if (
            not relative_path
            or candidate.is_absolute()
            or ".." in candidate.parts
            or candidate.suffix.lower() != ".svg"
        ):
            logger.warning(
                "[AppRegistry] %s iconAsset.%s 不是安全的包内 SVG 路径，忽略: %r",
                app_id, field, value,
            )
            return None
        resolved_path = (manifest_dir / candidate).resolve()
        if not resolved_path.is_relative_to(manifest_dir) or not resolved_path.is_file():
            logger.warning(
                "[AppRegistry] %s iconAsset.%s 资源不存在或越过 App 包边界，忽略: %r",
                app_id, field, value,
            )
            return None
        return candidate.as_posix()

    default_path = normalize_path(raw_icon_asset.get("default"), "default")
    if not default_path:
        return None

    variants: dict[str, str] = {}
    variants_raw = raw_icon_asset.get("variants")
    if isinstance(variants_raw, dict):
        for variant, value in variants_raw.items():
            if not isinstance(variant, str) or not variant:
                continue
            path = normalize_path(value, f"variants.{variant}")
            if path:
                variants[variant] = path
    elif variants_raw is not None:
        logger.warning(
            "[AppRegistry] %s iconAsset.variants 非 object，忽略: %r",
            app_id, variants_raw,
        )

    presentation_raw = raw_icon_asset.get("presentation", "selfContained")
    presentation = (
        presentation_raw
        if presentation_raw in {"selfContained", "glyph"}
        else "selfContained"
    )
    if presentation != presentation_raw:
        logger.warning(
            "[AppRegistry] %s iconAsset.presentation 非法，按 selfContained 处理: %r",
            app_id, presentation_raw,
        )

    aliases_raw = raw_icon_asset.get("aliases", [])
    aliases = tuple(dict.fromkeys(
        alias.strip().lower()
        for alias in aliases_raw
        if isinstance(alias, str) and alias.strip()
    )) if isinstance(aliases_raw, list) else ()

    return {
        "default": default_path,
        **({"variants": variants} if variants else {}),
        "presentation": presentation,
        **({"aliases": list(aliases)} if aliases else {}),
    }


def _load_app_definition_from_manifest(manifest_path: Path) -> Optional[AppDefinition]:
    """从 packages/apps/<id>/app.json 解析出 AppDefinition。

    manifest 必须包含 agentIntegration 和 catalog 块；
    缺失时使用安全默认值（空 context_fields / 空 tool_domains 等）。
    """
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    app_id = data.get("id", "")
    if not app_id:
        return None

    name = data.get("name", "")
    icon = data.get("icon", "") or (data.get("uiHints") or {}).get("icon", "")
    ui_hints = data.get("uiHints")
    icon_asset = _normalize_icon_asset(
        ui_hints.get("iconAsset") if isinstance(ui_hints, dict) else None,
        manifest_path=manifest_path,
        app_id=app_id,
    )
    version = data.get("version", "")
    description = data.get("description", "")

    agent = data.get("agentIntegration")
    if agent is not None:
        context_type = agent.get("contextType")
        context_fields = tuple(
            AppContextField(
                name=f["name"],
                label=f.get("label", ""),
                is_resource_id=f.get("isResourceId", False),
            )
            for f in agent.get("contextFields", [])
        )
        tool_domains = tuple(agent.get("toolDomains", []))
        has_prompt_section = agent.get("hasPromptSection", False)
        display_field = agent.get("displayField", "")
        workspace_root_source = agent.get("workspaceRootSource", "")
        is_frontend_dependent = agent.get("isFrontendDependent", False)
        type_aliases = tuple(agent.get("typeAliases", []))
    else:
        logger.warning(
            "[AppRegistry] manifest 缺少 agentIntegration 块: %s，使用默认值",
            manifest_path,
        )
        context_type = None
        context_fields = ()
        tool_domains = ()
        has_prompt_section = False
        display_field = ""
        workspace_root_source = ""
        is_frontend_dependent = False
        type_aliases = ()

    runtime_support = data.get("runtimeSupport")

    catalog = data.get("catalog")
    if catalog is not None:
        can_create = catalog.get("canCreate", True)
        searchable = catalog.get("searchable", False)
        is_default_enabled = catalog.get("isDefaultEnabled", True)
        order = catalog.get("order", 0)
        category = catalog.get("category", "")
        desktop_group = catalog.get("desktopGroup", "")
    else:
        logger.warning(
            "[AppRegistry] manifest 缺少 catalog 块: %s，使用默认值",
            manifest_path,
        )
        can_create = True
        searchable = False
        is_default_enabled = True
        order = 0
        category = ""
        desktop_group = ""

    ui_runtime = data.get("uiRuntime", "")
    embedded_web = data.get("embeddedWeb")
    if isinstance(embedded_web, dict):
        embedded_web_base_url = embedded_web.get("baseUrl", "")
        embedded_web_url_patterns = tuple(embedded_web.get("urlPatterns", []))
        embedded_web_session_mode = embedded_web.get("sessionMode", "")
    else:
        embedded_web_base_url = ""
        embedded_web_url_patterns = ()
        embedded_web_session_mode = ""

    distribution = data.get("distribution", "builtin")
    install_scope = data.get("installScope", "organization")

    # surface：三态分类真源（SSOT）。可空——技能包不声明 surface。
    # 非字符串 / 空串一律降级为 None 并告警，不阻断 manifest 加载。
    surface_raw = data.get("surface")
    if surface_raw is None:
        surface = None
    elif isinstance(surface_raw, str) and surface_raw:
        surface = surface_raw
    else:
        logger.warning(
            "[AppRegistry] %s surface 字段非法（应为非空字符串），忽略: %r",
            app_id, surface_raw,
        )
        surface = None

    official_plugin_release = data.get("officialPluginRelease")
    prepared_runtime = data.get("preparedRuntime")

    # charter v1.8 §6.3 业务事件声明
    # 字段缺失 / 非 list / 单条非 dict → 静默跳过该条，logger.warning，
    # 不阻断启动（"只声明 schema 不强制实现"）。
    events_raw = data.get("events", []) or []
    events: tuple[AppEventDefinition, ...] = ()
    if isinstance(events_raw, list):
        parsed_events: list[AppEventDefinition] = []
        seen_keys: set[str] = set()
        for entry in events_raw:
            if not isinstance(entry, dict):
                logger.warning(
                    "[AppRegistry] %s events 中存在非 dict 条目，跳过: %r",
                    app_id, entry,
                )
                continue
            key = entry.get("key", "")
            if not isinstance(key, str) or not key:
                logger.warning(
                    "[AppRegistry] %s events 缺少 key 或非字符串，跳过: %r",
                    app_id, entry,
                )
                continue
            # charter §6.3 强约束：业务事件 key 必须三段式 <app>.<entity>.<action>
            # （charter §8 拒绝清单 #9：不让用户面对原始事件 key）。
            # 若不符合，logger.warning 但仍登记——避免阻断 manifest 加载。
            # **Wave 7 续作 P1-4 修复**：启动期 audit 第二层防线由
            # ``_validate_manifest_consistency`` 实现（_check_events_block）：
            # 同款规则在 startup check 里再 grep 一遍 manifest 文件，
            # 确保 loader 容错放行的违规 key 在 startup audit 报警里被看到。
            if key.count(".") < 2:
                logger.warning(
                    "[AppRegistry] %s event key %r 非三段式 <app>.<entity>.<action>"
                    "（charter §6.3）",
                    app_id, key,
                )
            if key in seen_keys:
                logger.warning(
                    "[AppRegistry] %s events 中存在重复 key，仅保留首次出现: %s",
                    app_id, key,
                )
                continue
            seen_keys.add(key)

            # payload_schema 用 tuple-of-tuples 实现 frozen dataclass 兼容
            # （AppDefinition 是 frozen=True 不可变）。每条 ((name, type, required), ...)。
            payload_raw = entry.get("payload_schema") or {}
            payload_tuple: tuple = ()
            if isinstance(payload_raw, dict):
                fields_block = payload_raw.get("fields") if isinstance(payload_raw.get("fields"), list) else None
                if fields_block:
                    payload_tuple = tuple(
                        (
                            f.get("name", ""),
                            f.get("type", "string"),
                            bool(f.get("required", False)),
                        )
                        for f in fields_block
                        if isinstance(f, dict) and f.get("name")
                    )

            filterable = entry.get("filterable_fields", [])
            if not isinstance(filterable, list):
                filterable = []

            parsed_events.append(AppEventDefinition(
                key=key,
                label=str(entry.get("label", "") or ""),
                description=str(entry.get("description", "") or ""),
                payload_schema=payload_tuple,
                filterable_fields=tuple(str(f) for f in filterable if isinstance(f, str)),
                ai_filterable=bool(entry.get("ai_filterable", True)),
            ))
        events = tuple(parsed_events)
    elif events_raw:
        logger.warning(
            "[AppRegistry] %s events 非 list（实际类型 %s），忽略",
            app_id, type(events_raw).__name__,
        )

    return AppDefinition(
        id=app_id,
        name=name,
        version=version,
        icon=icon,
        icon_asset=icon_asset,
        context_type=context_type,
        can_create=can_create,
        searchable=searchable,
        is_default_enabled=is_default_enabled,
        order=order,
        description=description,
        category=category,
        desktop_group=desktop_group,
        ui_runtime=ui_runtime,
        embedded_web_base_url=embedded_web_base_url,
        embedded_web_url_patterns=embedded_web_url_patterns,
        embedded_web_session_mode=embedded_web_session_mode,
        context_fields=context_fields,
        tool_domains=tool_domains,
        has_prompt_section=has_prompt_section,
        display_field=display_field,
        workspace_root_source=workspace_root_source,
        is_frontend_dependent=is_frontend_dependent,
        type_aliases=type_aliases,
        runtime_support=runtime_support,
        distribution=distribution,
        install_scope=install_scope,
        surface=surface,
        official_plugin_release=official_plugin_release if isinstance(official_plugin_release, dict) else None,
        prepared_runtime=prepared_runtime if isinstance(prepared_runtime, dict) else None,
        events=events,
    )


def _scan_all_app_manifests() -> tuple[dict[str, AppDefinition], dict[str, AppDefinition]]:
    """扫描 packages/apps/*/app.json，按 distribution 分流。

    返回 (builtin_apps, marketplace_apps) 两个 dict。
    单个 manifest 解析失败时跳过并告警；
    关键 App（tabdata/tabdoc/tabcode）缺失时发 CRITICAL 告警。
    """
    apps_dir = _PROJECT_ROOT / "packages" / "apps"
    builtin: dict[str, AppDefinition] = {}
    marketplace: dict[str, AppDefinition] = {}

    if not apps_dir.is_dir():
        logger.critical(
            "[AppRegistry] manifest 目录不存在: %s，CORE_APPS 将为空", apps_dir
        )
        return builtin, marketplace

    for manifest_path in sorted(apps_dir.glob("*/app.json")):
        try:
            app_def = _load_app_definition_from_manifest(manifest_path)
            if app_def:
                if app_def.distribution == 'marketplace':
                    marketplace[app_def.id] = app_def
                else:
                    builtin[app_def.id] = app_def
        except Exception:
            logger.warning(
                "[AppRegistry] manifest 解析失败，跳过: %s", manifest_path, exc_info=True
            )

    for critical_id in _CRITICAL_APPS:
        if critical_id not in builtin:
            logger.critical(
                "[AppRegistry] 关键 App '%s' 的 manifest 缺失或解析失败",
                critical_id,
            )

    if marketplace:
        logger.info(
            "[AppRegistry] 发现 %d 个市场应用: %s",
            len(marketplace), ", ".join(marketplace.keys()),
        )

    return builtin, marketplace


CORE_APPS: dict[str, AppDefinition]
MARKETPLACE_APPS: dict[str, AppDefinition]
CORE_APPS, MARKETPLACE_APPS = _scan_all_app_manifests()


def _all_registered_apps() -> tuple[AppDefinition, ...]:
    """返回当前已注册的全部 App（builtin + marketplace）。"""
    return tuple(CORE_APPS.values()) + tuple(MARKETPLACE_APPS.values())


# ─── 平台级工具域（不绑定具体 App，TinAgent 始终/默认加载）────────
#
# is_base: 始终加载，不需要 app_type 激活
# is_default: 无 focused/open app 时的额外域
PLATFORM_TOOL_DOMAINS: dict[str, dict] = {
    "common":       {"is_base": True},
    "rag":          {"is_base": True},
    "todo":         {"is_base": True},
    # terminal 也在 CORE_APPS["terminal"].tool_domains 中声明 —— 这是有意的：
    # TinAgent 始终需要终端能力（is_base），同时 Terminal App 聚焦时
    # 走正常 App 激活流程。运行时通过 set 去重，不会重复加载。
    "terminal":     {"is_base": True},
    "think":        {"is_base": True},
    # runtime 域：Monitor 进程监管工具（monitor_process / stop_monitor / list_monitors）
    # 始终可用，让 Agent 能启动长驻进程并实时接收 stdout
    "runtime":      {"is_base": True},
    "sql":          {"is_default": True},
}

# ─── 虚拟 App 类型（不在 CORE_APPS 中，但可作为 app_id 使用）─────
VIRTUAL_APP_TOOL_DOMAINS: dict[str, tuple[str, ...]] = {
    "rag":         ("rag",),
    "think":       ("think",),
    "tabmail":     ("tabmail",),
    # tabphone 已迁移至 CORE_APPS，此处保留为别名以防旧代码引用
    "phone":       ("tabphone",),
}

# ─── 平台工具 app_id（非 CORE_APPS，但由 ToolHub 注册的合法域 app_id）──
# 这些 app_id 用于 ToolHub 域注册时的 app_id 标注，不通过 Space 设置管理，
# 但需要通过 ToolPermissionGuard Layer 1 的合法性校验。
PLATFORM_TOOL_APP_IDS: frozenset[str] = frozenset({
    "web-scraper",  # web-scraper 域：HTTP 网页抓取
    "device",       # device 域：移动设备管理与屏幕自动化
    "credential",   # credential 域：凭据查询与自动填充（跨 TabWeb 和设备登录场景）
})


# ─── 查询函数 ────────────────────────────────────────────────

def get_app(app_id: str) -> Optional[AppDefinition]:
    """根据 ID 获取 APP 定义（builtin 和 marketplace 合并查询）"""
    return CORE_APPS.get(app_id) or MARKETPLACE_APPS.get(app_id)


def list_apps(distribution: Optional[str] = None) -> list[AppDefinition]:
    """获取 APP 列表，按 order 排序。

    Args:
        distribution: 过滤条件。None=全部, 'builtin'=仅内置, 'marketplace'=仅市场应用
    """
    if distribution == 'builtin':
        apps = CORE_APPS.values()
    elif distribution == 'marketplace':
        apps = MARKETPLACE_APPS.values()
    else:
        apps = list(CORE_APPS.values()) + list(MARKETPLACE_APPS.values())
    return sorted(apps, key=lambda a: a.order)


def get_searchable_types() -> list[str]:
    """全局搜索时应查找的 ContextItem.item_type 列表"""
    return [
        app.context_type
        for app in CORE_APPS.values()
        if app.searchable and app.context_type
    ]


def get_default_disabled_apps() -> list[str]:
    """新项目中默认禁用的 APP 列表"""
    return [app.id for app in CORE_APPS.values() if not app.is_default_enabled]


# ─── 派生函数（替代各模块中手动维护的重复列表）──────────────────

@lru_cache(maxsize=1)
def get_all_context_field_names() -> tuple[str, ...]:
    """所有已注册 App 的 context 字段名。

    替代 agent_state._CONTEXT_APP_FIELDS、chat_service key 列表、
    conversation/api._app_fields 中的手动列表。
    """
    fields: list[str] = []
    seen: set[str] = set()
    for app in _all_registered_apps():
        for f in app.context_fields:
            if f.name not in seen:
                fields.append(f.name)
                seen.add(f.name)
    return tuple(fields)


@lru_cache(maxsize=1)
def get_resource_field_map() -> MappingProxyType[str, str]:
    """app_id → 主资源 ID 字段名（builtin + marketplace）。

    替代 agent_api._RESOURCE_FIELD_MAP。
    返回不可变视图，防止缓存污染。
    """
    return MappingProxyType({
        app.id: f.name
        for app in _all_registered_apps()
        for f in app.context_fields
        if f.is_resource_id
    })


@lru_cache(maxsize=1)
def get_tool_domains_map() -> MappingProxyType[str, tuple[str, ...]]:
    """app_id → tool_domains 映射（仅 CORE_APPS，不含虚拟类型）。

    适用场景：Space 级别域解析（群聊 room_service / oneshot API），
    这些场景只应包含用户可在 Space 中启用/禁用的 CORE_APPS 域。
    虚拟类型（rag/think/tabmail）不在此映射中。

    若需要包含虚拟类型，请使用 get_app_type_tool_domains()。
    返回不可变视图，防止缓存污染。
    """
    return MappingProxyType({
        app.id: app.tool_domains
        for app in CORE_APPS.values()
        if app.tool_domains
    })


@lru_cache(maxsize=1)
def get_frontend_dependent_apps() -> frozenset[str]:
    """纯前端依赖的 App 集合（builtin + marketplace）。

    替代 tin_agent._FRONTEND_DEPENDENT_APPS。
    """
    return frozenset(
        app.id for app in _all_registered_apps()
        if app.is_frontend_dependent
    )


@lru_cache(maxsize=1)
def _build_alias_map() -> dict[str, str]:
    """构建 别名 → 正式 id 的映射表。"""
    m: dict[str, str] = {}
    for app in _all_registered_apps():
        for alias in app.type_aliases:
            m[alias] = app.id
    return m


def normalize_type(raw_type: str) -> str:
    """将可能的别名归一化为正式 app id。

    如 'folder' → 'tabfolder'。未知别名原样返回。
    """
    return _build_alias_map().get(raw_type, raw_type)


@lru_cache(maxsize=1)
def get_valid_app_types() -> frozenset[str]:
    """所有合法的 app_type（用于 oneshot API 校验，builtin + marketplace）。

    替代 agent_api._VALID_APP_TYPES。
    """
    return frozenset(
        app.id for app in _all_registered_apps()
        if app.context_type is not None or app.context_fields
    )


# ─── Agent 工具域解析函数 ─────────────────────────────────────

@lru_cache(maxsize=1)
def get_base_tool_domains() -> tuple[str, ...]:
    """Agent 始终加载的基础工具域。"""
    return tuple(k for k, v in PLATFORM_TOOL_DOMAINS.items() if v.get("is_base"))


@lru_cache(maxsize=1)
def get_default_tool_domains() -> tuple[str, ...]:
    """无 focused/open app 时加载的默认域集（base + default）。"""
    base = set(get_base_tool_domains())
    extra = tuple(k for k, v in PLATFORM_TOOL_DOMAINS.items() if v.get("is_default") and k not in base)
    return get_base_tool_domains() + extra


get_tin_agent_base_domains = get_base_tool_domains
get_tin_agent_default_domains = get_default_tool_domains


@lru_cache(maxsize=1)
def get_virtual_app_ids() -> frozenset[str]:
    """所有虚拟 App 类型 ID（不在 CORE_APPS 中，但可作为合法 app_id）。"""
    return frozenset(VIRTUAL_APP_TOOL_DOMAINS.keys())


@lru_cache(maxsize=1)
def get_app_type_tool_domains() -> MappingProxyType[str, tuple[str, ...]]:
    """合并 CORE_APPS + 虚拟类型的 app_id → tool_domains 映射。

    适用场景：Agent / 子 Agent 的域解析，需要包含虚拟类型
    （rag/think/tabmail）以支持全量 app_id。

    若仅需 CORE_APPS（Space 级控制场景），请使用 get_tool_domains_map()。
    返回不可变视图，防止缓存污染。
    """
    result: dict[str, tuple[str, ...]] = {}
    for app in CORE_APPS.values():
        if app.tool_domains:
            result[app.id] = app.tool_domains
    for vid, domains in VIRTUAL_APP_TOOL_DOMAINS.items():
        result[vid] = domains
    return MappingProxyType(result)


# ─── 业务事件查询（charter v1.8 §6.3）─────────────────────────────


@lru_cache(maxsize=1)
def get_all_app_events() -> tuple[tuple[str, AppEventDefinition], ...]:
    """聚合所有 App 声明的业务事件，返回 ``((app_id, event), ...)``。

    用于 ``tabtin event list`` 和 ``GET /api/registry/events/`` 聚合接口
    （charter §6.3：``tabtin event list`` 是平台事件本体的唯一查询接口；
    2026-05-28 URL 从 ``/api/scheduler/events`` 归位到 ``/api/registry/events``）。

    返回**有序**结果：先按 app order 排序，再按 event key 字母序——保证
    CLI 输出稳定可预期。
    """
    pairs: list[tuple[str, AppEventDefinition]] = []
    for app in sorted(_all_registered_apps(), key=lambda a: a.order):
        for ev in app.events:
            pairs.append((app.id, ev))
    return tuple(pairs)


def get_app_events(app_id: str) -> tuple[AppEventDefinition, ...]:
    """指定 App 声明的业务事件清单。"""
    app = get_app(app_id)
    if not app:
        return ()
    return app.events


def find_event(event_key: str) -> Optional[tuple[str, AppEventDefinition]]:
    """根据 ``event_key`` 反查归属 App + AppEventDefinition。

    用于 ``tabtin event show <event_key>`` 详情查询。
    返回 ``(app_id, event)`` 或 ``None``。
    """
    for app_id, ev in get_all_app_events():
        if ev.key == event_key:
            return (app_id, ev)
    return None


# ─── 运行时支持查询 ────────────────────────────────────────────

def get_available_apps_for_runtime(runtime_type: str, distribution: Optional[str] = None) -> list[str]:
    """返回指定运行时类型可用的应用 ID 列表（排除 mode=unavailable 的）。

    Args:
        distribution: 过滤条件。None=全部, 'builtin'=仅内置, 'marketplace'=仅市场应用
    """
    if distribution == 'builtin':
        source = CORE_APPS
    elif distribution == 'marketplace':
        source = MARKETPLACE_APPS
    else:
        source = {**CORE_APPS, **MARKETPLACE_APPS}

    result = []
    for app_id, app_def in source.items():
        support = (app_def.runtime_support or {}).get(runtime_type, {})
        mode = support.get('mode', 'full') if isinstance(support, dict) else 'full'
        if mode != 'unavailable':
            result.append(app_id)
    return result


def get_app_runtime_mode(app_id: str, runtime_type: str) -> str:
    """返回应用在指定运行时上的模式（full/headless/remote/unavailable）。

    未声明 runtimeSupport 的应用默认为 full。
    """
    app_def = get_app(app_id)
    if not app_def:
        return 'unavailable'
    support = (app_def.runtime_support or {}).get(runtime_type, {})
    return support.get('mode', 'full') if isinstance(support, dict) else 'full'


# ─── 从 app_sections 子模块重导出 APP_SECTIONS 相关符号 ─────────
# S2 里程碑：App 能力元数据从 prompts/ 独立到此包

from apps.services.common.app_registry.app_sections import (  # noqa: E402
    APP_SECTIONS,
    PromptSource,
    get_prompt_source,
    list_prompt_sources,
    reload_app_sections,
)

__all__ = [
    "CORE_APPS", "MARKETPLACE_APPS", "AppDefinition", "AppContextField",
    "AppEventDefinition",
    "list_apps", "get_app", "get_searchable_types", "get_default_disabled_apps",
    "get_all_context_field_names", "get_resource_field_map", "get_tool_domains_map",
    "get_valid_app_types", "get_frontend_dependent_apps", "normalize_type",
    "get_base_tool_domains", "get_default_tool_domains",
    "get_tin_agent_base_domains", "get_tin_agent_default_domains",
    "get_virtual_app_ids", "get_app_type_tool_domains",
    "get_available_apps_for_runtime", "get_app_runtime_mode",
    "get_all_app_events", "get_app_events", "find_event",
    "PLATFORM_TOOL_DOMAINS", "VIRTUAL_APP_TOOL_DOMAINS", "PLATFORM_TOOL_APP_IDS",
    "APP_SECTIONS", "PromptSource", "get_prompt_source", "list_prompt_sources",
    "reload_app_sections",
    "_PROJECT_ROOT",
]
