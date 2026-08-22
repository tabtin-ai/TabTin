"""
工具基类 — services 独立层

所有工具（Chat、Crawl 等）都应继承这些基类，直接兼容 LangChain BaseTool。

依赖注入点（均为模块级变量，由 orchestration 层启动时设置）：
- _permission_guard_check_fn: ToolPermissionGuard.check_tool 等价
- _execution_router_hybrid_fn: ExecutionRouter.execute_hybrid 等价

Migration note:
    从 orchestration.tools._base 迁移而来。
    原模块保留 re-export shim 以兼容 orchestration 内部引用。
"""

from abc import abstractmethod
from typing import Literal, Any, Callable, Dict, List, Optional, Tuple, Type

import json
import logging

from pydantic import Field, field_validator
from langchain_core.tools.base import create_schema_from_function, _prep_run_args

from contextvars import ContextVar

from apps.services.tools.traceable import TraceableBaseTool
from apps.services.tools.timeout import resolve_tool_timeout

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 工具权限 ContextVars（全局唯一实例，shim 层 re-export 同一对象）
# ---------------------------------------------------------------------------

_authorization_rules_ctx: ContextVar[Optional[Dict[str, Any]]] = ContextVar(
    "tool_authorization_rules", default=None,
)
_permission_decisions_ctx: ContextVar[Optional[Dict[str, str]]] = ContextVar(
    "tool_permission_decisions", default=None,
)
_subagent_deny_tools_ctx: ContextVar[Optional[frozenset]] = ContextVar(
    "subagent_deny_tools", default=None,
)


def set_tool_authorization_rules(rules: Optional[Dict[str, Any]]) -> None:
    """设置当前执行上下文的授权规则。"""
    _authorization_rules_ctx.set(rules)


def set_tool_permission_decisions(decisions: Optional[Dict[str, str]]) -> None:
    """设置当前执行上下文的权限决策缓存。

    包含 session/always 级别的用户决策，使 ToolPermissionGuard 层
    能感知 PermissionRuleEngine 已记录的 HITL 审批结果。
    """
    _permission_decisions_ctx.set(decisions)


def reset_tool_permission_context() -> None:
    """重置所有工具权限 ContextVar。

    必须在每次请求入口处调用，防止 Celery solo/threads 池或
    Gunicorn 线程复用时，上一请求遗留的 HITL 决策和授权规则
    泄露到新会话（M12-E2E-P2-30 fix）。
    """
    _authorization_rules_ctx.set(None)
    _permission_decisions_ctx.set(None)
    _subagent_deny_tools_ctx.set(None)


def set_subagent_deny_tools(tools: Optional[frozenset]) -> None:
    """设置当前执行上下文的子 Agent 工具黑名单。

    子 Agent 在独立线程中执行时，通过 ContextVar 传递 deny list，
    确保 BaseTool._run 层能拦截被禁止的工具调用。
    """
    _subagent_deny_tools_ctx.set(tools)


# ---------------------------------------------------------------------------
# 依赖注入点
# ---------------------------------------------------------------------------

# ToolPermissionGuard.check_tool 等价回调
# 签名: (tool: Any, params: dict) -> Optional[str]
# 返回 None = 放行; 返回 str = 拒绝原因
# 未注入时 fail-close: 始终拒绝（安全默认）
_permission_guard_check_fn: Optional[Callable[[Any, dict], Optional[str]]] = None

# ExecutionRouter.execute_hybrid 等价回调
# 签名: (tool: Any, params: dict) -> Any
# 未注入时: hybrid 工具回退到 self.run() 本地执行
_execution_router_hybrid_fn: Optional[Callable[[Any, dict], Any]] = None


def set_permission_guard(fn: Optional[Callable[[Any, dict], Optional[str]]]) -> None:
    """注入权限校验回调。由 orchestration 层在启动时调用。"""
    global _permission_guard_check_fn
    _permission_guard_check_fn = fn


def set_execution_router_hybrid(fn: Optional[Callable[[Any, dict], Any]]) -> None:
    """注入 hybrid 路由回调。由 orchestration 层在启动时调用。"""
    global _execution_router_hybrid_fn
    _execution_router_hybrid_fn = fn


# ---------------------------------------------------------------------------
# 授权规则检查（纯函数，依赖 services.common.authorization_policy）
# ---------------------------------------------------------------------------

def _check_authorization_rules(tool: "BaseTool") -> Optional[dict]:
    """P0-2: 协调 ToolPermissionGuard 与 PermissionRuleEngine。

    检查顺序：
    0. 子 Agent deny list — 绝对禁止的工具直接拒绝
    1. 用户 HITL 决策（session/always）— 有 allow 则放行，有 deny 则拒绝
    2. 授权规则 + risk_level — 需要确认时拒绝（防止绕过 HITL）

    返回 None 表示放行；返回 dict 表示拒绝（error payload）。
    """
    try:
        tool_name = getattr(tool, "name", "") or type(tool).__name__

        deny_tools = _subagent_deny_tools_ctx.get()
        if deny_tools and tool_name.strip().lower() in deny_tools:
            return {
                "success": False,
                "error": f"Permission denied: 工具 '{tool_name}' 在子 Agent 中被禁止使用。",
            }

        risk_level = getattr(tool, "risk_level", "safe")
        if risk_level == "safe":
            return None

        auth_rules = _authorization_rules_ctx.get()
        if not auth_rules:
            return None

        decisions = _permission_decisions_ctx.get()
        if isinstance(decisions, dict):
            decision = decisions.get(tool_name)
            if decision == "allow":
                return None
            if decision == "deny":
                return {
                    "success": False,
                    "error": f"Permission denied: 工具 '{tool_name}' 已被用户禁止执行。",
                }

    except Exception as exc:
        logger.error("[BaseTool] Authorization rule check failed (fail-close): %s", exc, exc_info=True)
        return {
            "success": False,
            "error": "系统安全检查暂时不可用，操作已被拒绝。请稍后重试或联系管理员。",
        }


class BaseTool(TraceableBaseTool):
    """
    工具基类（直接继承 LangChain BaseTool）

    所有工具都应继承此类，提供统一的接口。

    属性:
        name: 工具名称（LangChain 标准字段）
        description: 工具描述（LangChain 标准字段）
        execution_mode: 执行模式（server/client/hybrid）- 项目特有
        risk_level: 风险等级（safe/review/strict）- 驱动权限评估
        timeout: 超时时间（秒）- 项目特有

    使用示例:
        class MyTool(BaseTool):
            name: str = "my_tool"
            description: str = "我的工具"

            def run(self, param: str) -> str:
                return f"处理: {param}"
    """

    execution_mode: Literal["server", "client", "hybrid"] = Field(
        default="server",
        description="执行模式"
    )
    risk_level: Literal["safe", "review", "strict"] = Field(
        default="safe",
        description=(
            "工具风险等级，驱动 PermissionRuleEngine 的权限评估: "
            "safe=读操作(read类别); "
            "review=写操作(write/script/delete_system类别); "
            "strict=高风险操作，始终需审批"
        ),
    )
    required_permissions: List[str] = Field(
        default_factory=list,
        description="工具所需权限列表（如 filesystem/network/browser/table）"
    )
    optional: bool = Field(
        default=False,
        description="是否为可选工具（需 allowlist 才启用）"
    )
    available_modes: Optional[Tuple[str, ...]] = Field(
        default=None,
        description=(
            "该工具适用的 AgentMode 列表（ask/agent/plan/study）。"
            "None 表示所有模式均可用；"
            "显式列出则仅在指定模式下对 LLM 可见。"
        ),
    )
    timeout: int = Field(
        default=0,
        description="超时时间（秒）。0 表示使用 category 默认超时或全局默认 60s"
    )
    category: Optional[str] = Field(
        default=None,
        description="工具类别（terminal/browser/web/write_file/read_file/search/data_mutation），用于超时和并发策略",
    )

    # --- Phase 4: Tool 结果缓存 ---
    cacheable: bool = Field(
        default=False,
        description="工具结果是否可缓存（仅限无副作用的读操作）"
    )
    cache_ttl: int = Field(
        default=300,
        description="缓存 TTL（秒，默认 5 分钟）"
    )

    # --- S19: 延迟加载分类 ---
    defer_load: bool = Field(
        default=False,
        description=(
            "S19 延迟加载标记。True 时初始只在 system prompt 列出名字+描述，"
            "不注入完整 schema；Agent 通过 tool_search 按需激活。"
        ),
    )

    @property
    def tool_name(self) -> str:
        """兼容旧代码的 tool_name 属性"""
        return self.name

    @abstractmethod
    def run(self, **kwargs) -> Any:
        """
        执行工具（业务逻辑）

        Args:
            **kwargs: 工具参数

        Returns:
            工具执行结果
        """
        pass

    def cleanup(self, *, timed_out: bool = False) -> None:
        """工具执行后的资源清理钩子（可选覆盖）。

        由 ToolExecutor 在 _invoke_with_retry 的 finally 块中调用。

        线程安全约束：
        - timed_out=True 时，工具的 run() 可能仍在另一线程中执行。
          此时只允许做**信号性操作**（设置 flag、关闭 socket 触发异常），
          禁止释放 run() 可能正在使用的共享资源。
        - timed_out=False 时，run() 已返回，可安全释放资源。
        """
        pass

    def _get_injected_state_keys(self) -> frozenset:
        """缓存当前工具 args_schema 中声明的 InjectedState 字段名集合。

        使用 __dict__ 检查确保每个子类独立缓存，不继承父类的结果。
        """
        cls = type(self)
        cached = cls.__dict__.get("_cached_injected_state_keys")
        if cached is not None:
            return cached
        keys: set = set()
        try:
            schema_cls = self.args_schema
            if schema_cls and hasattr(schema_cls, "model_fields"):
                for field_name, field_info in schema_cls.model_fields.items():
                    for meta in (field_info.metadata or []):
                        meta_cls_name = type(meta).__name__
                        if "InjectedState" in meta_cls_name or "Injected" in meta_cls_name:
                            keys.add(field_name)
                            break
        except (AttributeError, TypeError):
            pass
        result = frozenset(keys)
        cls._cached_injected_state_keys = result
        return result

    def _get_run_accepted_injected_keys(self) -> frozenset:
        """缓存 run() 方法实际接受的 InjectedState 参数名集合。

        对比 args_schema 中声明的 InjectedState 字段与 run() 的函数签名，
        只保留 run() 能接受的字段（显式形参或 **kwargs）。
        """
        cls = type(self)
        cached = cls.__dict__.get("_cached_run_accepted_injected")
        if cached is not None:
            return cached

        import inspect
        injected = self._get_injected_state_keys()
        if not injected:
            result = frozenset()
            cls._cached_run_accepted_injected = result
            return result
        try:
            sig = inspect.signature(self.run)
            params = sig.parameters
            has_var_keyword = any(
                p.kind == inspect.Parameter.VAR_KEYWORD for p in params.values()
            )
            if has_var_keyword:
                result = injected
            else:
                result = injected & frozenset(params.keys())
        except (ValueError, TypeError):
            result = frozenset()
        cls._cached_run_accepted_injected = result
        return result

    def _run(self, *args: Any, **kwargs: Any) -> Any:
        """LangChain 内部调用接口（带 Trace 记录）

        权限检查已前置到 invoke() 层的 _run_entry_permission_checks (FP-012)，
        此处不再重复执行 ToolPermissionGuard / _check_authorization_rules。
        """
        _injected_keys = self._get_injected_state_keys()
        _run_accepted = self._get_run_accepted_injected_keys()
        _strip_keys = {'callbacks', 'run_manager'} | (_injected_keys - _run_accepted)
        filtered_kwargs = {k: v for k, v in kwargs.items() if k not in _strip_keys}
        if getattr(self, "execution_mode", None) == "hybrid":
            hybrid_fn = _execution_router_hybrid_fn
            if hybrid_fn is not None:
                try:
                    hybrid_kwargs = {k: v for k, v in filtered_kwargs.items() if v is not None}
                    for k in _injected_keys:
                        if k in kwargs:
                            hybrid_kwargs[k] = kwargs[k]
                    return hybrid_fn(self, hybrid_kwargs)
                except Exception as exc:
                    logger.debug("[%s] Hybrid routing failed: %s", self.__class__.__name__, exc)
        result = self.run(*args, **filtered_kwargs)
        return self._attach_usage_on_error(result, args=args, kwargs=filtered_kwargs)

    async def _arun(self, *args: Any, **kwargs: Any) -> Any:
        """LangChain 异步调用接口 — 委托给 _run 并通过 executor 避免阻塞事件循环。

        显式 copy_context() 以确保 Python 3.11 下 ContextVar（权限规则、
        cancel_event、thread_id 等）正确传播到 executor 线程。
        """
        import asyncio
        import contextvars
        loop = asyncio.get_running_loop()
        ctx = contextvars.copy_context()
        return await loop.run_in_executor(
            None, lambda: ctx.run(self._run, *args, **kwargs)
        )

    def _run_entry_permission_checks(self, tool_input: Any) -> Optional[str]:
        """入口级权限检查（FP-012），独立于 LangChain 内部调用链。

        在 invoke/ainvoke 入口处执行，确保即使 LangChain 实现变更
        导致 _run 不被调用，权限检查仍然生效。
        返回 None 表示放行；返回 JSON 字符串表示拒绝。
        """
        check_params = tool_input if isinstance(tool_input, dict) else {}

        guard_fn = _permission_guard_check_fn
        if guard_fn is not None:
            try:
                denied = guard_fn(self, check_params)
                if denied:
                    return json.dumps({"success": False, "error": denied})
            except Exception as exc:
                logger.error(
                    "[%s] Permission check failed at invoke: %s",
                    self.__class__.__name__, exc, exc_info=True,
                )
                return json.dumps({
                    "success": False,
                    "error": "系统安全检查暂时不可用，操作已被拒绝。请稍后重试或联系管理员。",
                })
        else:
            # fail-close: 未注入权限校验回调时，非 safe 工具一律拒绝
            risk_level = getattr(self, "risk_level", "safe")
            if risk_level != "safe":
                logger.warning(
                    "[%s] Permission guard not injected, fail-close for risk_level=%s",
                    self.__class__.__name__, risk_level,
                )
                return json.dumps({
                    "success": False,
                    "error": "权限校验模块未就绪，操作已被拒绝。请稍后重试或联系管理员。",
                })

        denied_by_rules = _check_authorization_rules(self)
        if denied_by_rules:
            return json.dumps(denied_by_rules)

        return None

    def invoke(self, input: Any, config: Optional[dict] = None, **kwargs: Any) -> Any:  # type: ignore[override]
        """
        覆盖 BaseTool.invoke，确保 1.x 工具输出被包装为 ToolMessage。

        LangChain 1.x 的 ToolNode 期望 ToolMessage 或 Command。
        使用父类 run() 的格式化逻辑来自动封装输出。
        FP-012: 入口处独立执行权限检查，不依赖 LangChain 内部 _run() 调用链。
        """
        tool_input, run_kwargs = _prep_run_args(input, config, **kwargs)

        denied = self._run_entry_permission_checks(tool_input)
        if denied:
            return denied

        return super().run(tool_input, **run_kwargs)

    async def ainvoke(self, input: Any, config: Optional[dict] = None, **kwargs: Any) -> Any:  # type: ignore[override]
        """异步版本，保持与 invoke 一致的输出格式。"""
        tool_input, run_kwargs = _prep_run_args(input, config, **kwargs)

        denied = self._run_entry_permission_checks(tool_input)
        if denied:
            return denied

        return await super().arun(tool_input, **run_kwargs)

    def _get_context(self) -> Dict[str, Any]:
        """返回当前线程绑定的统一运行时上下文。"""
        try:
            from apps.services.common.thread_context import (
                get_current_thread_id,
                get_current_workspace_root,
                get_current_space_id,
                get_current_execution_agent_id,
                get_current_identity_user_id,
                get_current_execution_context,
                get_current_user_id,
                get_current_organization_id,
                get_current_agent_workspace,
                get_current_sibling_agent_workspaces,
                get_owner_user_id_for_provider,
            )

            space_id = get_current_space_id()
            execution_agent_id = get_current_execution_agent_id()
            identity_user_id = get_current_identity_user_id() or get_current_user_id()
            execution_context = get_current_execution_context()

            return {
                "thread_id": get_current_thread_id() or "",
                "workspace_root": get_current_workspace_root() or "",
                "space_id": space_id or "",
                "current_space_id": space_id or "",
                "execution_agent_id": execution_agent_id or "",
                "_execution_agent_id": execution_agent_id or "",
                "identity_user_id": identity_user_id or "",
                "user_id": get_current_user_id() or "",
                "organization_id": get_current_organization_id() or "",
                "execution_context": execution_context,
                "_execution_context": execution_context,
                "agent_workspace": get_current_agent_workspace(),
                "sibling_agent_workspaces": get_current_sibling_agent_workspaces(),
                "owner_user_id_for_provider": get_owner_user_id_for_provider(),
            }
        except Exception as exc:
            logger.debug("[%s] _get_context fallback: %s", self.__class__.__name__, exc)
            return {}

    def validate_params(self, **kwargs) -> bool:
        """
        验证参数（可选重写）

        Args:
            **kwargs: 工具参数

        Returns:
            是否验证通过
        """
        return True

    def __str__(self):
        return f"<{self.__class__.__name__}: {self.name}>"

    def __repr__(self):
        return self.__str__()

    def model_post_init(self, __context: Any) -> None:
        """Pydantic v2 初始化后钩子"""
        super().model_post_init(__context)

        if self.args_schema is None:
            try:
                schema = create_schema_from_function(
                    model_name=self.name,
                    func=self.run,
                    filter_args=("self",),
                    parse_docstring=True,
                    error_on_invalid_docstring=False,
                )
                object.__setattr__(self, "args_schema", schema)
                logger.debug("[%s] Auto-generated args_schema", self.__class__.__name__)
            except Exception as e:
                logger.debug(
                    "[%s] args_schema auto-generation failed: %s",
                    self.__class__.__name__,
                    str(e)
                )

        if self.handle_validation_error is False:
            object.__setattr__(self, "handle_validation_error", self._format_validation_error_with_usage)
        if self.handle_tool_error is False:
            object.__setattr__(self, "handle_tool_error", self._format_tool_error_with_usage)

    def _format_validation_error_with_usage(self, error: Exception) -> str:
        payload = {
            "success": False,
            "error": "Parameter validation failed",
            "details": str(error),
            "usage": self._build_usage_hint(action=None),
        }
        return json.dumps(payload, ensure_ascii=False)

    def _format_tool_error_with_usage(self, error: Exception) -> str:
        payload = {
            "success": False,
            "error": "Tool execution failed",
            "details": str(error),
            "usage": self._build_usage_hint(action=None),
        }
        return json.dumps(payload, ensure_ascii=False)

    def _build_usage_hint(self, action: Optional[str] = None) -> Dict[str, Any]:
        """构建通用的正确调用提示。子类可覆盖以提供更具体示例。"""
        schema = None
        args_schema = getattr(self, "args_schema", None)
        if args_schema is not None:
            try:
                schema = args_schema.model_json_schema()
            except Exception:
                schema = None

        return {
            "tool": self.name,
            "description": self.description,
            "action": action,
            "args_schema": schema,
        }

    def _attach_usage_on_error(
        self,
        result: Any,
        *,
        args: tuple[Any, ...],
        kwargs: Dict[str, Any],
    ) -> Any:
        """当工具返回错误时，附带正确调用提示给 LLM。"""
        if not isinstance(result, dict):
            return result

        has_error = result.get("success") is False or bool(result.get("error"))
        if not has_error:
            return result

        if "usage" in result:
            return result

        action = None
        if args:
            action = args[0] if isinstance(args[0], str) else None
        if not action:
            action = kwargs.get("action")

        result["usage"] = self._build_usage_hint(action=action)
        return result


class ClientTool(BaseTool):
    """
    前端工具基类

    用于需要在前端（浏览器）执行的工具，如：
    - webcontentview（网页抓取）
    - screenshot（截图）
    - file_upload（文件上传）

    这些工具不在后端执行，而是：
    1. 后端发送 client_action 事件给前端
    2. 前端执行工具
    3. 前端回传结果
    """

    execution_mode: Literal["server", "client", "hybrid"] = Field(
        default="client",
        description="前端执行"
    )
    def run(self, **kwargs) -> Dict[str, Any]:
        """
        前端工具不在后端执行

        返回执行参数，由前端接收并执行

        Returns:
            {
                "execution_mode": "client",
                "params": {...}
            }
        """
        return {
            "execution_mode": "client",
            "tool_name": self.name,
            "params": kwargs,
            "timeout": resolve_tool_timeout(self),
        }


class HybridTool(BaseTool):
    """
    混合工具基类

    既可以在后端执行，也可以在前端执行
    根据具体情况动态选择

    执行路径说明：
    - 主路径：_run() 检测 execution_mode=="hybrid" →
      注入的 hybrid 路由回调 → 按 orchestration.strategy 路由。
      前端 dispatch 前会调用 prepare_frontend_params() 做参数校验和清洗。
    - 回退路径：hybrid 路由回调异常时 _run() 降级到 self.run()。
    - run_on_server() 在 fallback-to-server 策略降级时由 _run_backend() 调用。
    - run_on_client() 保留用于需要后端侧直接调度前端的场景。
    """

    execution_mode: Literal["server", "client", "hybrid"] = Field(
        default="hybrid",
        description="混合执行"
    )
    orchestration: Optional[Dict[str, Any]] = Field(
        default=None,
        description="混合执行编排策略配置，如 {'strategy': 'fallback-to-server'}",
    )

    @abstractmethod
    def run_on_server(self, **kwargs) -> Any:
        """后端执行逻辑"""
        pass

    @abstractmethod
    def run_on_client(self, **kwargs) -> Any:
        """前端执行逻辑"""
        pass

    def prepare_frontend_params(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """在 execute_hybrid dispatch 到前端之前校验/变换参数。

        子类可覆盖以：
        - 校验必填字段（校验失败 raise ValueError）
        - 过滤/重命名字段
        - 补充默认值

        约定：校验失败只应抛 ValueError 或 TypeError，
        execute_hybrid 仅捕获这两种异常并转为错误返回，
        其他异常会冒泡到 _run 的 hybrid fallback 路径。

        默认实现原样返回。
        """
        return params

    def run(self, use_client: bool = False, **kwargs) -> Any:
        """
        执行工具

        Args:
            use_client: 是否使用前端执行
            **kwargs: 工具参数

        Returns:
            工具执行结果
        """
        if use_client:
            return self.run_on_client(**kwargs)
        return self.run_on_server(**kwargs)


__all__ = [
    "BaseTool",
    "ClientTool",
    "HybridTool",
    "set_tool_authorization_rules",
    "set_tool_permission_decisions",
    "set_subagent_deny_tools",
    "reset_tool_permission_context",
    "set_permission_guard",
    "set_execution_router_hybrid",
]
