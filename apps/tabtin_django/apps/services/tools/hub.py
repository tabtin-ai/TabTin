"""
ToolHub - 工具中心 — services 独立层

W6 status (2026-05-04):
    The hub no longer holds any LLM-visible tool providers. All 25 historical
    ``ToolHub.register_provider(...)`` callsites in
    ``apps.services.tools.domains.registry`` were removed; the LLM tool SSoT
    now lives in the TS runtime (see ``packages/agent-runtime`` Capability +
    ToolProvider). This class is kept as a thin no-op container so that
    Extension authors and runtime-injected domains can still call
    ``register_provider`` if they really need a Python-side LLM tool source
    (rare; CLI / HTTP API bridges should be preferred).

Optional callback hooks (``_optional_tool_allowed_fn`` /
``_subagent_policy_filter_fn``) remain wired up but are no longer injected
by ``apps.services.agent_engine.apps.ready()``. They stay here as
extension points; with no providers registered, ``get_tools()`` short-
circuits to ``[]`` and the filters are never invoked.

Migration note:
    本模块原位于 ``apps.orchestration.tools._hub``，Wave 11（2026-04-17）整体
    迁入 ``apps.services.tools.hub``；orchestration 极简化后已彻底删除，
    历史快照见 ``legacy/orchestration/__init__.py`` 路径映射。
"""

import threading
from typing import Callable, Dict, List, Optional, Set, Any
import logging

from apps.services.tools.base import BaseTool

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 依赖注入点
# ---------------------------------------------------------------------------

# optional tool 检查回调
# 签名: (tool_name, app_id, allowlist=None, audit=True) -> bool
# 未注入时: 不允许 optional 工具（安全默认）
_optional_tool_allowed_fn: Optional[Callable[..., bool]] = None

# 子 Agent 策略过滤回调
# 签名: (tools: List[BaseTool]) -> List[BaseTool]
# 未注入时: 返回原始列表（不过滤）
_subagent_policy_filter_fn: Optional[Callable[[List[BaseTool]], List[BaseTool]]] = None


def set_optional_tool_allowed(fn: Optional[Callable[..., bool]]) -> None:
    """注入 optional tool 检查回调。"""
    global _optional_tool_allowed_fn
    _optional_tool_allowed_fn = fn


def set_subagent_policy_filter(fn: Optional[Callable[[List[BaseTool]], List[BaseTool]]]) -> None:
    """注入子 Agent 策略过滤回调。"""
    global _subagent_policy_filter_fn
    _subagent_policy_filter_fn = fn


# ---------------------------------------------------------------------------
# 内部工具函数
# ---------------------------------------------------------------------------

def _is_optional_tool_allowed_safe(
    tool_name: Optional[str],
    app_id: Optional[str],
    allowlist: Optional[Dict[str, Any]] = None,
) -> bool:
    """安全调用 optional tool 过滤"""
    fn = _optional_tool_allowed_fn
    if fn is not None:
        try:
            return fn(tool_name, app_id, allowlist=allowlist, audit=True)
        except Exception:
            return False
    return False


def _filter_optional(
    tools: List[BaseTool],
    allowlist: Optional[Dict[str, Any]] = None,
) -> List[BaseTool]:
    """过滤掉未授权的 optional 工具"""
    return [
        tool for tool in tools
        if not getattr(tool, "optional", False)
        or _is_optional_tool_allowed_safe(
            getattr(tool, "name", None),
            getattr(tool, "app_id", None),
            allowlist=allowlist,
        )
    ]


class ToolHub:
    """
    工具中心（轻量版）

    统一管理不同域的工具提供者（provider），用于多图共享工具能力。
    """

    _providers: Dict[str, Callable[[], List[BaseTool]]] = {}
    _cache: Dict[str, Dict[str, BaseTool]] = {}
    _domain_meta: Dict[str, Dict[str, str]] = {}
    _lock = threading.RLock()

    @classmethod
    def register_provider(
        cls,
        domain: str,
        provider: Callable[[], List[BaseTool]],
        app_id: Optional[str] = None,
        source: str = "builtin",
        namespace: Optional[str] = None,
        overwrite: bool = False,
        defer_load: bool = False,
    ):
        """
        注册工具提供者

        Args:
            domain: 工具域名（如 chat / browser / table）
            provider: 返回工具列表的可调用对象
            overwrite: 是否允许覆盖已有 provider
            defer_load: S19 — 域级延迟加载。True 时该域所有工具初始
                        只在 system prompt 列出名字，不注入完整 schema。
        """
        with cls._lock:
            if domain in cls._providers and not overwrite:
                logger.warning("[ToolHub] Domain already exists, skipping registration: %s", domain)
                return
            cls._providers[domain] = provider
            meta = {"source": source, "namespace": namespace or domain}
            if app_id:
                meta["app_id"] = app_id
            if defer_load:
                meta["defer_load"] = True
            cls._domain_meta[domain] = meta
            cls._cache.pop(domain, None)
            logger.debug("[ToolHub] Registered tool domain: %s%s", domain, " (deferred)" if defer_load else "")

    @classmethod
    def list_domains(cls) -> List[str]:
        with cls._lock:
            return list(cls._providers.keys())

    @classmethod
    def list_providers(cls) -> List[Dict[str, str]]:
        with cls._lock:
            return [
                {"domain": domain, **(cls._domain_meta.get(domain) or {})}
                for domain in cls._providers.keys()
            ]

    _VALID_RISKS = frozenset({"safe", "review", "strict"})

    @classmethod
    def _validate_tool_contract(cls, tool: BaseTool, domain: str) -> None:
        """注册即治理：加载时校验工具合约，不合规发 WARNING。"""
        name = getattr(tool, "name", "?")
        desc = getattr(tool, "description", "") or ""
        if len(desc) < 30:
            logger.warning(
                "[ToolHub] Contract warning [%s/%s]: description too short (%d chars), should be >= 30",
                domain, name, len(desc),
            )
        risk = getattr(tool, "risk_level", None)
        if risk and risk not in cls._VALID_RISKS:
            logger.warning(
                "[ToolHub] Contract warning [%s/%s]: risk_level=%r invalid (expected safe/review/strict)",
                domain, name, risk,
            )
        schema = getattr(tool, "args_schema", None)
        if schema is None:
            logger.warning(
                "[ToolHub] Contract warning [%s/%s]: args_schema not declared, Agent cannot understand params accurately",
                domain, name,
            )

    @classmethod
    def _load_domain(cls, domain: str) -> Dict[str, BaseTool]:
        if domain in cls._cache:
            return cls._cache[domain]
        with cls._lock:
            if domain in cls._cache:
                return cls._cache[domain]
            provider = cls._providers.get(domain)
            if not provider:
                return {}
            tools = provider() or []
            meta = cls._domain_meta.get(domain, {})
            app_id = meta.get("app_id")
            domain_deferred = meta.get("defer_load", False)
            if app_id:
                for tool in tools:
                    if getattr(tool, "app_id", None):
                        continue
                    try:
                        object.__setattr__(tool, "app_id", app_id)
                    except Exception:
                        setattr(tool, "app_id", app_id)
            if domain_deferred:
                for tool in tools:
                    if not getattr(tool, "defer_load", False):
                        try:
                            object.__setattr__(tool, "defer_load", True)
                        except Exception:
                            setattr(tool, "defer_load", True)
            registry: Dict[str, BaseTool] = {}
            for tool in tools:
                name = getattr(tool, "name", None)
                if not name:
                    continue
                if name in registry:
                    logger.warning("[ToolHub] Tool name collision, skipped: %s", name)
                    continue
                cls._validate_tool_contract(tool, domain)
                registry[name] = tool
            cls._cache[domain] = registry
            return registry

    @classmethod
    def get_tool_registry(cls) -> Dict[str, Dict[str, BaseTool]]:
        with cls._lock:
            domains = list(cls._providers.keys())
        return {domain: cls._load_domain(domain) for domain in domains}

    @classmethod
    def get_tools(
        cls,
        domain: Optional[str] = None,
        allowed_app_ids: Optional[List[str]] = None,
        known_app_ids: Optional[Set[str]] = None,
        optional_tool_allowlist: Optional[Dict[str, Any]] = None,
        _skip_policy: bool = False,
    ) -> List[BaseTool]:
        def apply_subagent_policy(tools: List[BaseTool]) -> List[BaseTool]:
            fn = _subagent_policy_filter_fn
            if fn is not None:
                try:
                    return fn(tools)
                except Exception as exc:
                    logger.error("subagent policy filter failed, returning empty tools: %s", exc, exc_info=True)
                    return []
            return tools

        if domain:
            tools = list(cls._load_domain(domain).values())
            if allowed_app_ids is not None:
                app_id = cls._domain_meta.get(domain, {}).get("app_id")
                if app_id and allowed_app_ids is not None and (known_app_ids is None or app_id in known_app_ids):
                    allowed_set = set(allowed_app_ids)
                    if app_id not in allowed_set:
                        return []
            tools = _filter_optional(tools, optional_tool_allowlist)
            return tools if _skip_policy else apply_subagent_policy(tools)
        tools: List[BaseTool] = []
        seen: set[str] = set()
        with cls._lock:
            all_domains = list(cls._providers.keys())
        for domain_name in all_domains:
            for tool in cls.get_tools(
                domain=domain_name,
                allowed_app_ids=allowed_app_ids,
                known_app_ids=known_app_ids,
                optional_tool_allowlist=optional_tool_allowlist,
                _skip_policy=True,
            ):
                name = getattr(tool, "name", None)
                if not name:
                    continue
                if name in seen:
                    logger.warning(
                        "[ToolHub] Cross-domain tool name duplicate, skipped: %s (domain=%s, "
                        "kept from earlier domain). This may cause unexpected tool unavailability.",
                        name, domain_name,
                    )
                    continue
                seen.add(name)
                tools.append(tool)
        return apply_subagent_policy(tools)

    @classmethod
    def get_registered_tools(cls, domain: Optional[str] = None):
        """
        获取已注册工具列表。

        与 get_tools() 等价；便于按 domain 取回工具实例。
        """
        return cls.get_tools(domain=domain)

    @classmethod
    def get_tool_by_name(cls, tool_name: str, domain: Optional[str] = None):
        if domain:
            return cls._load_domain(domain).get(tool_name)
        for domain_name in cls._providers:
            tool = cls._load_domain(domain_name).get(tool_name)
            if tool:
                return tool
        return None

    @classmethod
    def create_isolated(cls) -> "ToolHub":
        """创建测试用的隔离 ToolHub 实例，不影响全局状态。

        返回一个拥有独立 _providers / _cache / _domain_meta / _lock 的实例，
        所有操作都在实例属性上执行，不会污染类级共享状态。
        """
        instance = cls.__new__(cls)
        instance._providers = {}
        instance._cache = {}
        instance._domain_meta = {}
        instance._lock = threading.RLock()
        return instance

    @classmethod
    def reset_for_testing(cls) -> None:
        """清空所有类级状态。仅限测试使用，生产代码禁止调用。

        WARNING: 此方法会清空全局注册的 providers、缓存和域元信息，
        并发运行的代码可能受影响。请确保仅在测试 setUp/tearDown 中使用。
        """
        with cls._lock:
            cls._providers.clear()
            cls._cache.clear()
            cls._domain_meta.clear()

    @classmethod
    def clear_cache(cls):
        with cls._lock:
            cls._cache.clear()

    @classmethod
    def get_health_report(cls) -> Dict[str, Any]:
        """汇总工具注册健康状态。

        返回每个已注册域的工具数量统计和加载异常信息，
        结合 registry.get_registration_health() 的域级失败列表。
        """
        domain_stats: Dict[str, int] = {}
        load_errors: Dict[str, str] = {}
        total_tools = 0
        for domain in cls.list_domains():
            try:
                tools = cls._load_domain(domain)
                count = len(tools)
                domain_stats[domain] = count
                total_tools += count
            except Exception as exc:
                domain_stats[domain] = 0
                load_errors[domain] = str(exc)

        report: Dict[str, Any] = {
            "domains_registered": len(domain_stats),
            "total_tools": total_tools,
            "domain_stats": domain_stats,
        }
        if load_errors:
            report["load_errors"] = load_errors
        return report


__all__ = [
    "ToolHub",
    "set_optional_tool_allowed",
    "set_subagent_policy_filter",
]
