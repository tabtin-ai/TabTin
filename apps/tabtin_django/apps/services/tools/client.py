"""
Agent Client Tool Base — services 独立层

提供统一的前端工具抽象，简化新工具的开发。

依赖注入点（均为模块级变量，由 orchestration 层启动时设置）：
- _get_frontend_dispatcher_fn: 获取前端调度器实例
- _dispatch_frontend_action_fn: ExecutionRouter.dispatch_frontend_action 等价

Migration note:
    从 orchestration.tools._client 迁移而来。
    原模块保留 re-export shim 以兼容 orchestration 内部引用。

使用示例：
    ```python
    class MyFrontendTool(AgentClientTool):
        name: str = "my_action"
        description: str = "执行某个前端动作"
        timeout: int = 30

        def run(self, param: str) -> str:
            result = self.execute(param=param)

            if result['success']:
                return f"成功: {result['data']}"
            else:
                return f"失败: {result['error']}"
    ```

继承体系：
    BaseTool (apps.services.tools.base)
        ↓
    ClientTool (apps.services.tools.base)
        ↓
    AgentClientTool (当前文件)
        ↓
    具体工具（WebCaptureTool, ...）
"""

import logging
from typing import Any, Callable, Dict, Optional

from pydantic import Field, PrivateAttr

from apps.services.tools.base import ClientTool
from apps.services.tools.timeout import resolve_tool_timeout
from apps.services.common.thread_context import (
    get_current_thread_id,
    get_current_workspace_root,
    get_current_space_id,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 依赖注入点
# ---------------------------------------------------------------------------

# 获取前端调度器实例（单例）
# 签名: () -> dispatcher
# 未注入时: AgentClientTool.model_post_init 不设置 dispatcher
_get_frontend_dispatcher_fn: Optional[Callable[[], Any]] = None

# ExecutionRouter.dispatch_frontend_action 等价回调
# 签名: (thread_id, action_type, params, timeout, cancel_event=None) -> dict
# 未注入时: execute() 返回降级错误
_dispatch_frontend_action_fn: Optional[Callable[..., Dict[str, Any]]] = None


def set_frontend_dispatcher_getter(fn: Optional[Callable[[], Any]]) -> None:
    """注入前端调度器获取函数。由 orchestration 层在启动时调用。"""
    global _get_frontend_dispatcher_fn
    _get_frontend_dispatcher_fn = fn


def set_dispatch_frontend_action(fn: Optional[Callable[..., Dict[str, Any]]]) -> None:
    """注入前端 action 分发函数。由 orchestration 层在启动时调用。"""
    global _dispatch_frontend_action_fn
    _dispatch_frontend_action_fn = fn


class AgentClientTool(ClientTool):
    """
    Agent 前端工具基类

    继承自通用 ClientTool，添加 Agent 特定逻辑：
    - 自动从上下文获取 thread_id
    - 自动调用 FrontendActionDispatcher 处理通信
    - 统一的错误处理

    子类只需要：
    1. 定义 name, description, timeout
    2. 实现 run() 方法
    3. 调用 self.execute(**params) 执行前端动作

    属性：
        name (str): 工具名称，必须唯一
        description (str): 工具描述，给 LLM 看的
        timeout (int): 超时时间（秒），默认 60
        risk_level (str): 风险等级（safe/review/strict），默认 review
    """

    _dispatcher: Any = PrivateAttr()

    def model_post_init(self, __context: Any) -> None:
        """Pydantic v2 初始化后钩子"""
        super().model_post_init(__context)
        getter = _get_frontend_dispatcher_fn
        if getter is not None:
            self._dispatcher = getter()
        else:
            self._dispatcher = None
        logger.debug("[%s] Tool initialized", self.name)

    @property
    def dispatcher(self):
        """访问调度器（向后兼容，运行时惰性获取）"""
        d = self._dispatcher
        if d is None:
            getter = _get_frontend_dispatcher_fn
            if getter is not None:
                d = getter()
                self._dispatcher = d
        return d

    def execute(self, **kwargs) -> Dict[str, Any]:
        """
        执行前端工具

        自动处理：
        1. 从上下文获取 thread_id
        2. 调用调度器发送任务
        3. 等待前端结果
        4. 返回结果

        Args:
            **kwargs: 工具参数（将传递给前端）

        Returns:
            {
                "success": True/False,
                "data": {...},  # 成功时的数据（前端定义）
                "error": "..."  # 失败时的错误信息
            }

        Raises:
            RuntimeError: 如果无法获取 thread_id
        """
        thread_id = get_current_thread_id()

        if not thread_id:
            error_msg = (
                f"{self.name}: Failed to get thread_id. "
                "Ensure the tool is called within an Agent node "
                "with set_current_thread_id() set."
            )
            logger.error("[%s] %s", self.name, error_msg)
            raise RuntimeError(error_msg)

        ws_root = get_current_workspace_root()
        if ws_root and "_workspace_root" not in kwargs:
            kwargs["_workspace_root"] = ws_root

        space_id = get_current_space_id()
        if space_id and "_space_id" not in kwargs:
            kwargs["_space_id"] = space_id

        if "_thread_id" not in kwargs:
            kwargs["_thread_id"] = thread_id

        logger.info(
            "[%s] Executing  thread=%s  params_keys=%s",
            self.name, thread_id, list(kwargs.keys()),
        )

        _override = kwargs.pop("_timeout_override", None)
        effective_timeout = _override if _override is not None else resolve_tool_timeout(self)

        dispatch_fn = _dispatch_frontend_action_fn
        if dispatch_fn is None:
            logger.warning(
                "[%s] dispatch_frontend_action not injected, cannot execute frontend action",
                self.name,
            )
            # 运行时「能力不可用」统一走结构化降级：前端调度未装配
            # 不是「工具坏了」，而是当前运行时缺少前端能力。除保留 error / degraded
            # 兼容既有 caller 外，补稳定 error_kind + 可念给用户的 user_message +
            # remediation，让上层 / observability 能按稳定标识分流，而非 grep 报错文字。
            return {
                "success": False,
                "error": "Frontend action dispatch not available (orchestration not initialized)",
                "degraded": True,
                "error_kind": "capability_unavailable",
                "user_message": (
                    "这个操作需要 TabTin 桌面端的前端能力，当前运行环境暂时用不了，"
                    "所以我没法完成它。请在 TabTin 桌面端里重试。"
                ),
                "remediation": (
                    "Frontend action dispatcher is not injected (orchestration not "
                    "initialized). Run the tool from a device with the Electron/desktop "
                    "runtime, or ensure the host wired set_dispatch_frontend_action()."
                ),
            }

        result = dispatch_fn(
            thread_id=thread_id,
            action_type=self.name,
            params=kwargs,
            timeout=effective_timeout,
        )

        logger.info(
            "[%s] Execution completed  success=%s  error=%s",
            self.name, result.get('success'), result.get('error', 'None'),
        )

        # Phase C：前端工具成功 → 按 app_id 强证据升格任务脸（browser/doc/code）。
        if isinstance(result, dict) and result.get("success") is True:
            try:
                from apps.chat.conversation.services.session_surface_policy import (
                    promote_session_from_app_id,
                    session_id_from_thread_id,
                )
                promote_session_from_app_id(
                    session_id_from_thread_id(thread_id),
                    getattr(self, "app_id", None),
                )
            except Exception:
                logger.debug(
                    "[%s] primary_surface promote skipped",
                    self.name,
                    exc_info=True,
                )

        return result

    def run(self, **kwargs) -> Any:
        """
        执行工具（子类必须实现）

        子类应该：
        1. 调用 self.execute(**kwargs) 获取原始结果
        2. 格式化结果为友好的字符串或数据
        3. 返回给 LLM

        Args:
            **kwargs: 工具参数

        Returns:
            工具执行结果（通常是字符串，给 LLM 看的）
        """
        raise NotImplementedError(
            f"{self.__class__.__name__} 必须实现 run() 方法"
        )


FrontendActionTool = AgentClientTool

__all__ = [
    'AgentClientTool',
    'FrontendActionTool',
    'set_frontend_dispatcher_getter',
    'set_dispatch_frontend_action',
]
