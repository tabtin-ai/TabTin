"""
App / Channel / Entity 注册完整性校验

在 Django 启动时调用，检查 CORE_APPS / MARKETPLACE_APPS、ChannelAdapterRegistry、
EntityQueryService 中的声明与实际代码的一致性。发现不一致时打印 WARNING（不阻断启动）。

Wave D（2026-04-17）扩展：第 1 / 5 / 7 项把遍历范围从 CORE_APPS 扩展到
``CORE_APPS ∪ MARKETPLACE_APPS``，让 marketplace App 写错 manifest 时
启动期日志能 WARN；并对 marketplace prompt 双源（主仓 ``prompts/apps/<id>.py`` 与
``packages/apps/<id>/prompts/<lang>/system.md``）做兜底，使校验逻辑不依赖 B1 完成顺序。

输出格式：
  ✓  — 通过
  ✗  — 必修（阻断 infra-gate）
  ⚠  — 建议修复（WARNING 级别）
  ℹ  — 仅提示（INFO 级别）
"""

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


# 这些域不再对应 Python ToolHub provider，但仍是 runtime 策略/权限前缀的一等域。
# 例如 tabdata 的 BaseTool 已迁到 CLI-first 路径，manifest 仍需要保留
# ("sql", "tabdata") 供 disabled_tool_prefixes 等运行时策略使用。
_RUNTIME_POLICY_TOOL_DOMAINS = frozenset({"tabdata"})
_IGNORED_TOOL_DOMAIN_DIRS = frozenset({"__pycache__", "tests"})


def _known_tool_domains() -> set[str]:
    """汇总当前仍然有效的工具域名称。

    ToolHub 已退成扩展点，启动校验不能再只看 ``ToolHub.list_domains()``；
    否则所有 TS runtime / CLI-first / 平台策略域都会被误报为未注册。
    """
    known: set[str] = set(_RUNTIME_POLICY_TOOL_DOMAINS)

    try:
        from apps.services.tools import ToolHub

        known.update(ToolHub.list_domains())
    except ImportError:
        logger.debug(
            "[AppRegistryCheck] ToolHub 不可导入，跳过动态 provider 域", exc_info=True
        )

    try:
        from apps.services.common.app_registry import (
            PLATFORM_TOOL_DOMAINS,
            VIRTUAL_APP_TOOL_DOMAINS,
        )

        known.update(PLATFORM_TOOL_DOMAINS.keys())
        for domains in VIRTUAL_APP_TOOL_DOMAINS.values():
            known.update(domains)
    except ImportError:
        logger.debug(
            "[AppRegistryCheck] app_registry 不可导入，跳过平台/虚拟工具域",
            exc_info=True,
        )

    domains_dir = Path(__file__).resolve().parents[1] / "tools" / "domains"
    if domains_dir.is_dir():
        for child in domains_dir.iterdir():
            if (
                child.is_dir()
                and not child.name.startswith("_")
                and child.name not in _IGNORED_TOOL_DOMAIN_DIRS
            ):
                known.add(child.name)

    return known


def _marketplace_prompt_section_exists(app_id: str) -> bool:
    """检查 marketplace App 是否在 ``packages/apps/<id>/prompts/<lang>/system.md`` 提供 prompt section。

    用于 ``has_prompt_section`` 校验的双源兜底——B1（PRD §5.4）完成后 marketplace
    prompt 从主仓 ``apps/services/agent_engine/prompts/apps/<id>.py`` 迁出到该目录，
    pkgutil 扫描不再发现，校验需要双源识别。

    本函数只判断"能否发现"（按 markdown 文件布局），不负责注入；注入由 B1 的
    ``prompts/apps/__init__.py`` 扩展逻辑实现。匹配规则：``packages/apps/<id>/prompts/<lang>/system.md``
    任一存在即视为通过。
    """
    from apps.services.common.app_registry import _PROJECT_ROOT

    prompts_dir = _PROJECT_ROOT / "packages" / "apps" / app_id / "prompts"
    if not prompts_dir.is_dir():
        return False
    return any(prompts_dir.glob("*/system.md"))


def _report_warnings_to_sentry(warnings: list[str], category: str) -> None:
    """聚合 WARNING 上报 Sentry——单次 ``capture_message`` 携带条目清单作为额外上下文，
    避免每次 Django 启动产生 N 条独立事件刷屏（按三视角 Review 反馈：用 ``push_scope`` +
    ``set_extra`` 形态聚合）。

    按 N3 决议：marketplace 校验失败用 WARN + Sentry 而非 panic；
    ``sentry_sdk`` 未安装或未初始化时静默跳过，不影响校验本身。
    """
    if not warnings:
        return
    try:
        import sentry_sdk  # type: ignore[import-not-found]
    except ImportError:
        return
    try:
        with sentry_sdk.push_scope() as scope:
            scope.set_tag("registry_check_category", category)
            scope.set_extra("warning_count", len(warnings))
            scope.set_extra("warnings", warnings)
            preview = (
                warnings[0]
                if len(warnings) == 1
                else f"{warnings[0]} (+{len(warnings) - 1} more)"
            )
            sentry_sdk.capture_message(
                f"[{category}] {len(warnings)} warning(s): {preview}",
                level="warning",
            )
    except Exception:
        # Sentry 上报失败不应影响启动校验本身的可观测性
        logger.debug("[%s] Sentry 上报失败，已忽略", category, exc_info=True)


def validate_app_registry() -> list[str]:
    """检查 builtin + marketplace App 的注册完整性，返回警告列表。

    项 1/5/7（marketplace 影响面强相关）已扩展遍历 ``CORE_APPS ∪ MARKETPLACE_APPS``；
    其余项仍仅遍历 CORE_APPS，因为它们检查的是 builtin 主仓特有的双向一致性
    （manifest 双向核对由第 8 项独立校验）。
    """
    from apps.services.common.app_registry import CORE_APPS, MARKETPLACE_APPS

    warnings: list[str] = []
    all_apps = {**CORE_APPS, **MARKETPLACE_APPS}

    # 1. has_prompt_section 与 prompt 模块的一致性（仅 marketplace；builtin 已下放至客户端 runtime）
    #
    # W10 cleanup：M1 已把 builtin App 的 prompt section SSoT 迁到 ``@tabtin/agent-prompt``
    # （客户端 ``packages/agent-runtime`` 内嵌），主仓 ``prompts/apps/`` 已删除。
    # 所以 ``CORE_APPS`` 的 ``has_prompt_section`` 与 Django 侧 ``APP_SECTIONS`` 不再
    # 强制一一对应——builtin App 的 manifest 仍标记 ``hasPromptSection=true`` 是
    # 表达"客户端 runtime 提供该段"，与 Django ``APP_SECTIONS``（仅 marketplace 来源）
    # 解耦。下面的双向校验只对 marketplace App 仍有意义，因为 marketplace 的
    # prompt section 仍由 Django 端 ``packages/apps/<id>/prompts/<lang>/system.md``
    # 加载注入到 ``APP_SECTIONS``。
    try:
        from apps.services.common.app_registry import APP_SECTIONS

        # marketplace 双源兜底校验：
        #   ① 主仓 prompts/apps/<id>.py（W10 后通常缺席）
        #   ② packages/apps/<id>/prompts/<lang>/system.md（marketplace 当前唯一稳定源）
        for app_id, app_def in MARKETPLACE_APPS.items():
            if not app_def.has_prompt_section:
                continue
            in_pkgutil = app_id in APP_SECTIONS
            in_marketplace = _marketplace_prompt_section_exists(app_id)
            if not in_pkgutil and not in_marketplace:
                warnings.append(
                    f"{app_id}.hasPromptSection=true 但 prompts 模块未发现"
                    f"（既不在 prompts/apps/{app_id}.py 也不在 "
                    f"packages/apps/{app_id}/prompts/<lang>/system.md）"
                )
    except ImportError:
        warnings.append("无法导入 APP_SECTIONS，跳过 prompt section 校验")

    # 2. context_fields 中的字段名不应重复（仅 builtin；marketplace 由第 8 项 manifest 一致性兜底）
    seen_fields: dict[str, str] = {}
    for app_id, app_def in CORE_APPS.items():
        for f in app_def.context_fields:
            if f.name in seen_fields:
                other = seen_fields[f.name]
                if other != app_id:
                    warnings.append(
                        f"字段 '{f.name}' 同时出现在 {other} 和 {app_id} 的 context_fields 中"
                    )
            else:
                seen_fields[f.name] = app_id

    # 3. 有 context_type 且有 context_fields 的 App，至少有一个 is_resource_id
    for app_id, app_def in CORE_APPS.items():
        if app_def.context_type and app_def.context_fields:
            has_resource = any(f.is_resource_id for f in app_def.context_fields)
            if not has_resource:
                warnings.append(
                    f"{app_id}: 有 context_type='{app_def.context_type}' 和 context_fields，"
                    f"但没有字段标记 is_resource_id=True"
                )

    # 4. 有 context_type 但没有 context_fields 的 App（可能遗漏声明）
    for app_id, app_def in CORE_APPS.items():
        if app_def.context_type and not app_def.context_fields:
            warnings.append(
                f"{app_id}: 有 context_type='{app_def.context_type}' 但 context_fields 为空，"
                f"Agent 无法获取该 App 的资源上下文"
            )

    # 5. AgentState TypedDict 字段与 context_fields 的一致性（含 marketplace）
    try:
        from apps.services.agent_engine.state.agent_state import AgentState

        state_keys = set(AgentState.__annotations__.keys())
        for app_id, app_def in all_apps.items():
            for f in app_def.context_fields:
                if f.name not in state_keys:
                    warnings.append(
                        f"{app_id}.context_fields '{f.name}' 不在 AgentState TypedDict 中"
                    )
    except ImportError:
        warnings.append("无法导入 AgentState，跳过 TypedDict 校验")

    # 6. UpdateContextRequest Schema 与 context_fields 的一致性（仅 builtin；
    # marketplace 的 contextFields 由 manifest → AgentState 路径覆盖，
    # 不强制要求出现在 chat 模块的请求 Schema 中）
    try:
        from apps.chat.conversation.schemas import UpdateContextRequest

        schema_fields = set(UpdateContextRequest.model_fields.keys())
        for app_id, app_def in CORE_APPS.items():
            for f in app_def.context_fields:
                if f.name not in schema_fields:
                    warnings.append(
                        f"{app_id}.context_fields '{f.name}' 不在 UpdateContextRequest Schema 中"
                    )
    except ImportError:
        warnings.append("无法导入 UpdateContextRequest，跳过 Schema 校验")

    # 7. 有 tool_domains 的 App，检查当前 runtime 策略可识别该域（含 marketplace；
    # 空 tool_domains 自然跳过——纯 CLI-first 模式的 marketplace App 本就空）。
    # ToolHub 已退成扩展点，不能再把 ToolHub provider 当成唯一注册源。
    known_domains = _known_tool_domains()
    for app_id, app_def in all_apps.items():
        for domain in app_def.tool_domains:
            if domain not in known_domains:
                warnings.append(
                    f"{app_id}.tool_domains contains undefined domain '{domain}'"
                )

    # 8. manifest ↔ 注册表（CORE_APPS ∪ MARKETPLACE_APPS）一致性校验
    warnings.extend(_validate_manifest_consistency())

    for w in warnings:
        logger.warning("[AppRegistryCheck] %s", w)

    _report_warnings_to_sentry(warnings, "AppRegistryCheck")

    return warnings


def _validate_manifest_consistency() -> list[str]:
    """检查 packages/apps/ 下的 manifest 与已注册 App（builtin + marketplace）的一致性。"""
    import json

    from apps.services.common.app_registry import (
        CORE_APPS,
        MARKETPLACE_APPS,
        _PROJECT_ROOT,
    )

    warnings: list[str] = []
    apps_dir = _PROJECT_ROOT / "packages" / "apps"

    if not apps_dir.is_dir():
        warnings.append("manifest 目录不存在，跳过一致性校验")
        return warnings

    registered_ids = set(CORE_APPS.keys()) | set(MARKETPLACE_APPS.keys())

    manifest_ids: set[str] = set()
    for manifest_path in sorted(apps_dir.glob("*/app.json")):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
            app_id = data.get("id", "")
            if not app_id:
                continue
            manifest_ids.add(app_id)
        except Exception:
            warnings.append(f"manifest 解析失败: {manifest_path}")
            continue

        app_def = CORE_APPS.get(app_id) or MARKETPLACE_APPS.get(app_id)
        if not app_def:
            warnings.append(
                f"manifest '{app_id}' 在注册表中无对应条目（既非 builtin/CORE_APPS 亦非 marketplace）"
            )
            continue

        # **Wave 7 续作 P1-4 修复**：events[] 第二层 audit 防线。
        # 必须**先于** agentIntegration 检查，因为：
        #   - events 与 agentIntegration 是两个独立的 manifest 块
        #   - 即便 manifest 缺 agentIntegration（启动会用默认值），events
        #     违规仍应被 audit 报警，不能因为 agentIntegration 缺失就吞掉
        #     events 警告（loader / app_registry 是 1+1 双层防线设计）
        _check_events_block(warnings, app_id, data.get("events", []) or [])

        agent = data.get("agentIntegration")
        if agent is None:
            warnings.append(
                f"✗ {app_id}: manifest 缺少 agentIntegration 块，"
                f"Agent 上下文字段将使用默认空值"
            )
            continue

        _check_agent_integration(warnings, app_id, agent, app_def)

        catalog = data.get("catalog")
        if catalog is not None:
            _check_catalog(warnings, app_id, catalog, app_def)

    if len(manifest_ids) != len(registered_ids):
        warnings.append(
            f"manifest 数量 ({len(manifest_ids)}) ≠ 已注册应用数量 ({len(registered_ids)})"
            f"（builtin {len(CORE_APPS)} + marketplace {len(MARKETPLACE_APPS)}）"
        )

    missing_from_manifest = registered_ids - manifest_ids
    if missing_from_manifest:
        warnings.append(
            f"注册表中存在但无 manifest 文件的 App: {sorted(missing_from_manifest)}"
        )

    return warnings


def _check_agent_integration(
    warnings: list[str], app_id: str, agent: dict, app_def
) -> None:
    manifest_ctx_type = agent.get("contextType")
    if manifest_ctx_type != app_def.context_type:
        warnings.append(
            f"{app_id}: contextType 不一致 — manifest={manifest_ctx_type!r}, "
            f"registry={app_def.context_type!r}"
        )

    manifest_fields = tuple(
        (f["name"], f.get("label", ""), f.get("isResourceId", False))
        for f in agent.get("contextFields", [])
    )
    core_fields = tuple(
        (f.name, f.label, f.is_resource_id) for f in app_def.context_fields
    )
    if manifest_fields != core_fields:
        warnings.append(
            f"{app_id}: contextFields 不一致 — manifest={manifest_fields}, "
            f"registry={core_fields}"
        )

    manifest_domains = tuple(agent.get("toolDomains", []))
    if manifest_domains != app_def.tool_domains:
        warnings.append(
            f"{app_id}: toolDomains 不一致 — manifest={manifest_domains}, "
            f"registry={app_def.tool_domains}"
        )

    for field_name, manifest_key in [
        ("has_prompt_section", "hasPromptSection"),
        ("display_field", "displayField"),
        ("workspace_root_source", "workspaceRootSource"),
        ("is_frontend_dependent", "isFrontendDependent"),
    ]:
        manifest_val = agent.get(manifest_key, type(getattr(app_def, field_name))())
        core_val = getattr(app_def, field_name)
        if manifest_val != core_val:
            warnings.append(
                f"{app_id}: {field_name} 不一致 — manifest={manifest_val!r}, "
                f"registry={core_val!r}"
            )

    manifest_aliases = tuple(agent.get("typeAliases", []))
    if manifest_aliases != app_def.type_aliases:
        warnings.append(
            f"{app_id}: typeAliases 不一致 — manifest={manifest_aliases}, "
            f"registry={app_def.type_aliases}"
        )


def _check_events_block(warnings: list[str], app_id: str, events_raw) -> None:
    """**Wave 7 续作 P1-4**：events[] 字段三段式 key + 唯一性 audit。

    与 ``_load_app_definition_from_manifest`` 内 logger.warning 形成 1+1 防线 —
    loader 容错放行后，本函数在 startup audit 阶段把同款问题再列入
    ``[AppRegistryCheck]`` 警告，避免 reviewer 漏看 logger.warning。

    检查项（与 charter v1.8 §6.3 + §8 拒绝清单 #9 对齐）：
      1. events 整体非 list → 单条 audit warning
      2. 单条非 dict / key 缺失 / key 非字符串 / 空 key → 单独 warning
      3. key 不是三段式 ``<app>.<entity>.<action>`` → audit warning（不阻断启动）
      4. key 第一段不等于 app_id → audit warning（一致性约束）
      5. events 中 key 重复 → audit warning（loader 仅保留首次出现，但要让用户看到）

    设计：所有 warnings 都用 ``✗`` / ``⚠`` 前缀让运维一眼分级。
    """
    if not isinstance(events_raw, list):
        warnings.append(
            f"⚠ {app_id}: events 字段非 list（实际类型 {type(events_raw).__name__}），"
            f"loader 已忽略整个 events 块"
        )
        return

    seen_keys: set[str] = set()
    for idx, entry in enumerate(events_raw):
        if not isinstance(entry, dict):
            warnings.append(f"⚠ {app_id}: events[{idx}] 非 dict 条目，loader 已跳过")
            continue
        key = entry.get("key", "")
        if not isinstance(key, str) or not key:
            warnings.append(
                f"⚠ {app_id}: events[{idx}] 缺少 key 或非字符串 (charter §6.3)"
            )
            continue
        # 三段式 <app>.<entity>.<action>
        segments = key.split(".")
        if len(segments) < 3:
            warnings.append(
                f"⚠ {app_id}: events[{idx}] key={key!r} 非三段式 "
                f"<app>.<entity>.<action> (charter §6.3 + §8 拒绝清单 #9)"
            )
        elif segments[0] != app_id:
            warnings.append(
                f"⚠ {app_id}: events[{idx}] key={key!r} 第一段 {segments[0]!r} "
                f"≠ app_id {app_id!r}（事件归属一致性，charter §6.3）"
            )
        if key in seen_keys:
            warnings.append(
                f"⚠ {app_id}: events[{idx}] key={key!r} 重复，loader 仅保留首次出现"
            )
            continue
        seen_keys.add(key)


def _check_catalog(warnings: list[str], app_id: str, catalog: dict, app_def) -> None:
    for field_name, manifest_key in [
        ("can_create", "canCreate"),
        ("searchable", "searchable"),
        ("is_default_enabled", "isDefaultEnabled"),
        ("order", "order"),
        ("category", "category"),
    ]:
        manifest_val = catalog.get(manifest_key)
        core_val = getattr(app_def, field_name)
        if manifest_val is not None and manifest_val != core_val:
            warnings.append(
                f"{app_id}: {field_name} 不一致 — manifest={manifest_val!r}, "
                f"registry={core_val!r}"
            )


def validate_channel_registry() -> list[str]:
    """检查所有已注册 ChannelAdapter 的元数据完整性，
    并与 ``packages/apps/<id>/app.json`` 的 ``channelGateway`` 声明做配对。

    返回格式：⚠ 前缀表示 WARNING，ℹ 前缀表示 INFO。

    Wave D'（2026-04-17）扩展：补 PRD §5.2 第 2 项 + §4.1 N-3 ④ 的 manifest 配对校验。
    当 marketplace App 在 manifest 写 ``channelGateway.enabled=true type=<X>`` 但
    ChannelAdapterRegistry 中没有 id=<X> 的 adapter 时，启动期 WARN（不阻断启动，
    符合 N3 决议）。WARN 文本以 ``[validate_channel_registry]`` 子标记开头，便于
    `rg "WARNING.*\\[validate_channel_registry\\]"` 抓取（PRD §4.1 N-3 ④ 要求口径）。
    """
    warnings: list[str] = []

    try:
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        adapters = ChannelAdapterRegistry.list_all()

        if not adapters:
            warnings.append("⚠ ChannelAdapterRegistry 为空，无已注册渠道")
        else:
            for adapter in adapters:
                adapter_id = adapter.id

                if not getattr(adapter, "description", ""):
                    warnings.append(
                        f"⚠ Channel '{adapter_id}': 缺少 description（建议补充渠道说明）"
                    )
                if not getattr(adapter, "icon", ""):
                    warnings.append(
                        f"⚠ Channel '{adapter_id}': 缺少 icon（建议补充渠道图标）"
                    )

                try:
                    config_fields = adapter.get_config_fields()
                    config_schema = adapter.get_config_schema()
                    if config_fields and not config_schema:
                        warnings.append(
                            f"ℹ Channel '{adapter_id}': "
                            f"get_config_fields() 返回 {len(config_fields)} 个字段，"
                            f"但 get_config_schema() 为空"
                        )
                    elif config_schema and not config_fields:
                        warnings.append(
                            f"ℹ Channel '{adapter_id}': "
                            f"get_config_schema() 有内容但 get_config_fields() 为空"
                        )
                except Exception as exc:
                    warnings.append(
                        f"⚠ Channel '{adapter_id}': " f"config 方法调用异常 — {exc}"
                    )

    except ImportError:
        warnings.append("⚠ 无法导入 ChannelAdapterRegistry，跳过渠道校验")

    warnings.extend(_validate_marketplace_channel_gateway_pairings())

    for w in warnings:
        logger.warning("[ChannelRegistryCheck] %s", w)

    _report_warnings_to_sentry(warnings, "ChannelRegistryCheck")

    return warnings


def _validate_marketplace_channel_gateway_pairings() -> list[str]:
    """检查 ``packages/apps/<id>/app.json`` 的 ``channelGateway`` 字段是否与
    ChannelAdapterRegistry 配对。

    匹配规则：manifest ``channelGateway.type`` 必须等于某个已注册 adapter 的
    ``adapter.id``（如 manifest 写 ``type=<channel_id>``，registry 必须有
    id=<channel_id> 的 adapter）。三种情况会产生 WARN：

    - ``enabled=true`` 但 ``type`` 缺失 / 非字符串 / 空字符串 → 配置不完整
    - ``enabled=true`` 且 type 合法但 registry 未注册对应 adapter → 配对失败
    - ChannelAdapterRegistry 不可导入 → 无法校验，给出说明性 WARN

    本期主要影响声明了 channelGateway 的 marketplace App，其余 builtin App 默认
    manifest 无 ``channelGateway`` 字段 → 不报警。``enabled=false`` / 字段不存在 /
    字段类型非 dict → 静默跳过，不引入误伤。
    """
    import json

    from apps.services.common.app_registry import _PROJECT_ROOT

    warnings: list[str] = []
    apps_dir = _PROJECT_ROOT / "packages" / "apps"
    if not apps_dir.is_dir():
        return warnings

    try:
        from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

        registered_ids = set(ChannelAdapterRegistry.list_ids())
    except ImportError:
        warnings.append(
            "⚠ [validate_channel_registry] 无法导入 ChannelAdapterRegistry，"
            "跳过 manifest channelGateway 配对校验"
        )
        return warnings

    for manifest_path in sorted(apps_dir.glob("*/app.json")):
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except Exception:
            # manifest 解析失败由 _validate_manifest_consistency 单独报警，这里不重复
            continue

        gateway_block = data.get("channelGateway")
        if not isinstance(gateway_block, dict):
            continue
        if not gateway_block.get("enabled"):
            continue

        app_id = data.get("id") or manifest_path.parent.name
        gateway_type = gateway_block.get("type")
        if not isinstance(gateway_type, str) or not gateway_type:
            warnings.append(
                f"⚠ [validate_channel_registry] {app_id}: "
                f"channelGateway.enabled=true 但缺少有效的 type 字段（"
                f"manifest=packages/apps/{manifest_path.parent.name}/app.json）"
            )
            continue

        if gateway_type not in registered_ids:
            warnings.append(
                f"⚠ [validate_channel_registry] {app_id}: "
                f"声明 channelGateway type={gateway_type} 但 ChannelAdapterRegistry "
                f"未注册对应 adapter（manifest=packages/apps/"
                f"{manifest_path.parent.name}/app.json）"
            )

    return warnings


def validate_entity_completeness() -> list[str]:
    """校验 EntityQueryService 聚合结果的完整性。

    确保所有 CORE_APPS 和 Channel 都出现在统一实体列表中。
    """
    warnings: list[str] = []

    try:
        from apps.services.common.app_registry import CORE_APPS
        from apps.services.common.entity_query_service import EntityQueryService

        all_entities = EntityQueryService.list_all()
        entity_ids = {e.id for e in all_entities}

        # 所有 CORE_APPS 都应出现在 EntityQueryService 结果中
        for app_id in CORE_APPS:
            if app_id not in entity_ids:
                warnings.append(
                    f"✗ CORE_APP '{app_id}' 未出现在 EntityQueryService.list_all() 结果中"
                )

        # 所有 Channel 都应出现在 EntityQueryService 结果中
        try:
            from apps.channel_gateway.adapters.registry import ChannelAdapterRegistry

            channel_ids = ChannelAdapterRegistry.list_ids()
            channel_count = len(channel_ids)
            for ch_id in channel_ids:
                if ch_id not in entity_ids:
                    warnings.append(
                        f"✗ Channel '{ch_id}' 未出现在 EntityQueryService.list_all() 结果中"
                    )

            # 总量下限校验
            expected_min = len(CORE_APPS) + channel_count
            actual = len(all_entities)
            if actual < expected_min:
                warnings.append(
                    f"⚠ EntityQueryService.list_all() 返回 {actual} 个实体，"
                    f"预期至少 {expected_min}（{len(CORE_APPS)} CORE_APPS + "
                    f"{channel_count} Channels）"
                )
            else:
                logger.info(
                    "[EntityCheck] OK EntityQueryService 返回 %d 个实体"
                    "（>= %d CORE_APPS + %d Channels）",
                    actual,
                    len(CORE_APPS),
                    channel_count,
                )

        except ImportError:
            warnings.append(
                "⚠ 无法导入 ChannelAdapterRegistry，跳过 Channel→Entity 交叉校验"
            )

    except ImportError as exc:
        warnings.append(f"⚠ 无法导入依赖模块 ({exc})，跳过 Entity 完整性校验")

    # Wave D（2026-04-17）按 N3 决议统一为 WARNING：marketplace 校验全链路
    # 不应出现 ERROR 级别（避免被监控误报为"启动崩溃"）。即便是 ✗ 必修级，
    # 也通过 WARNING + Sentry 上报留痕，不阻断启动。
    for w in warnings:
        logger.warning("[EntityCheck] %s", w)

    _report_warnings_to_sentry(warnings, "EntityCheck")

    return warnings


def validate_all() -> list[str]:
    """运行全部校验，返回合并的警告列表。"""
    results: list[str] = []
    results.extend(validate_app_registry())
    results.extend(validate_channel_registry())
    results.extend(validate_entity_completeness())
    return results
