import json
import logging
from typing import Any, Dict, List, Optional, Tuple

from apps.services.common.thread_context import (
    get_current_thread_id,
    get_current_execution_context,
    get_current_cancel_event,
)
from apps.services.common.device_capability_registry import get_tool_capability_map
from apps.services.tools.timeout import resolve_tool_timeout
from apps.services.common.dispatch.frontend_dispatcher import get_frontend_dispatcher

logger = logging.getLogger(__name__)


def _allows_capability_action(exec_ctx: Any, action_type: str) -> bool:
    """允许 device_runtime 专属 capability action 绕过普通 frontend_action 标志。"""
    required_capability = get_tool_capability_map().get(action_type)
    if not required_capability:
        return False
    if required_capability == "html_render":
        return bool(getattr(exec_ctx, "can_video_render_html", False))
    if required_capability == "video_export":
        return bool(getattr(exec_ctx, "can_video_export", False))
    attr_name = f"can_{required_capability}"
    return bool(getattr(exec_ctx, attr_name, False))


class ExecutionRouter:
    """执行分流路由（frontend/backend/hybrid）"""

    @staticmethod
    def _error_payload(
        message: str,
        code: str,
        *,
        action: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        degraded: bool = False,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "success": False,
            "error": message,
            "error_code": code,
        }
        if action:
            payload["action"] = action
        if details:
            payload["details"] = details
        if degraded:
            payload["degraded"] = True
        return payload

    @staticmethod
    def resolve_execution_target(tool: Any) -> str:
        execution_mode = getattr(tool, "execution_mode", None)
        if execution_mode == "client":
            return "frontend"
        if execution_mode == "server":
            return "backend"
        if execution_mode == "hybrid":
            return "hybrid"
        execution_target = getattr(tool, "execution_target", None) or getattr(tool, "executionTarget", None)
        if execution_target in {"frontend", "backend", "hybrid"}:
            return execution_target
        return "backend"

    @staticmethod
    def dispatch_frontend_action(
        thread_id: str,
        action_type: str,
        params: Dict[str, Any],
        timeout: int,
        cancel_event: Optional[Any] = None,
    ) -> Dict[str, Any]:
        exec_ctx = get_current_execution_context()
        allow_local_mcp = (
            exec_ctx is not None
            and action_type.startswith("mcp_")
            and getattr(exec_ctx, "can_mcp", False)
        )
        allow_capability_action = (
            exec_ctx is not None
            and _allows_capability_action(exec_ctx, action_type)
        )
        if (
            exec_ctx is not None
            and not getattr(exec_ctx, "can_frontend_action", True)
            and not allow_local_mcp
            and not allow_capability_action
        ):
            mode = getattr(exec_ctx, "mode", "unknown")
            hint = getattr(exec_ctx, "recovery_hint", "") or ""
            msg = f"Execution environment ({mode}) does not support frontend action '{action_type}'"
            if hint:
                msg += f". {hint}"
            logger.warning("[ExecutionRouter] Frontend action blocked by ExecutionContext guard: %s", msg)
            return {"success": False, "error": msg, "degraded": True}

        effective_cancel = cancel_event or get_current_cancel_event()

        dispatcher = get_frontend_dispatcher()
        return dispatcher.dispatch_action(
            thread_id=thread_id,
            action_type=action_type,
            params=params,
            timeout=timeout,
            execution_context=exec_ctx,
            cancel_event=effective_cancel,
        )

    @classmethod
    def _clean_params(cls, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            key: value
            for key, value in params.items()
            if key
            not in {
                "orchestration",
                "execution_target",
                "executionTarget",
                "use_client",
                "useClient",
            }
        }

    @classmethod
    def _normalize_orchestration(cls, raw: Any) -> Optional[Dict[str, Any]]:
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except Exception:
                return None
        if not isinstance(raw, dict):
            return None
        return raw

    @classmethod
    def _detect_frontend_error_code(cls, error: str) -> str:
        if "超时" in error or "timeout" in error.lower() or "timed out" in error.lower():
            return "frontend_action_timeout"
        if "未注册" in error or "not registered" in error.lower():
            return "frontend_action_missing"
        return "frontend_action_failed"

    @classmethod
    def _dispatch_frontend_actions(
        cls,
        *,
        thread_id: str,
        actions: List[str],
        params: Dict[str, Any],
        timeout: int,
        action_params: Optional[Dict[str, Any]] = None,
    ) -> Tuple[bool, List[Dict[str, Any]], Optional[Dict[str, Any]]]:
        results: List[Dict[str, Any]] = []
        merged_params = {**cls._clean_params(params)}
        if action_params:
            merged_params.update(action_params)
        for action in actions:
            result = cls.dispatch_frontend_action(
                thread_id=thread_id,
                action_type=action,
                params=merged_params,
                timeout=timeout,
            )
            results.append({"action": action, "result": result})
            if not result.get("success"):
                error = result.get("error") or "Frontend action execution failed"
                is_degraded = bool(result.get("degraded"))
                return False, results, cls._error_payload(
                    str(error),
                    cls._detect_frontend_error_code(str(error)),
                    action=action,
                    details={"frontend_results": results},
                    degraded=is_degraded,
                )
        return True, results, None

    @classmethod
    def _run_backend(cls, tool: Any, params: Dict[str, Any]) -> Any:
        if hasattr(tool, "run_on_server"):
            return tool.run_on_server(**params)
        return tool.run(**params)

    @classmethod
    def execute_hybrid(cls, tool: Any, params: Dict[str, Any]) -> Dict[str, Any]:
        orchestration = cls._normalize_orchestration(
            params.get("orchestration") or getattr(tool, "orchestration", None)
        )
        if orchestration:
            strategy = orchestration.get("strategy")
            actions = orchestration.get("frontendActions") or orchestration.get("frontend_actions") or []
            steps = orchestration.get("steps")
            action_params = orchestration.get("actionParams") or {}
            timeout = int(
                orchestration.get("timeoutSec") or params.get("timeout") or resolve_tool_timeout(tool)
            )
            if strategy == "fallback-to-server":
                thread_id = params.get("thread_id") or get_current_thread_id()
                if not thread_id:
                    logger.info("[ExecutionRouter] fallback-to-server: no thread_id, going straight to backend")
                    return cls._run_backend(tool, cls._clean_params(params))
                tool_name = getattr(tool, "name", "unknown")

                dispatch_params = params
                prepare_fn = getattr(tool, "prepare_frontend_params", None)
                if callable(prepare_fn):
                    try:
                        dispatch_params = prepare_fn(cls._clean_params(params))
                    except (ValueError, TypeError) as exc:
                        logger.warning(
                            "[ExecutionRouter] %s.prepare_frontend_params rejected: %s",
                            tool_name, exc,
                        )
                        return {"success": False, "error": str(exc)}

                ok, results, error_payload = cls._dispatch_frontend_actions(
                    thread_id=str(thread_id),
                    actions=[tool_name],
                    params=dispatch_params,
                    timeout=timeout,
                    action_params=action_params,
                )
                if ok:
                    last = results[-1]["result"] if results else {}
                    return last if isinstance(last, dict) else {"success": True, "data": last}
                if error_payload and error_payload.get("degraded"):
                    logger.info(
                        "[ExecutionRouter] Frontend degraded for %s, falling back to server",
                        tool_name,
                    )
                    return cls._run_backend(tool, cls._clean_params(params))
                client_result = results[-1]["result"] if results else {}
                if isinstance(client_result, dict) and client_result.get("degraded"):
                    logger.info(
                        "[ExecutionRouter] Client returned degraded for %s, falling back to server",
                        tool_name,
                    )
                    return cls._run_backend(tool, cls._clean_params(params))
                return error_payload or {"success": False, "error": "Frontend action execution failed"}
            if strategy == "pipeline" and isinstance(steps, list) and steps:
                pipeline_results: List[Dict[str, Any]] = []
                for index, step in enumerate(steps):
                    if not isinstance(step, dict):
                        continue
                    target = step.get("target") or step.get("executionTarget") or step.get("execution_target")
                    step_params = {**cls._clean_params(params), **(step.get("params") or {})}
                    if target in {"frontend", "client"}:
                        thread_id = params.get("thread_id") or get_current_thread_id()
                        if not thread_id:
                            return cls._error_payload(
                                "Missing thread_id, cannot execute frontend action",
                                "missing_thread_id",
                            )
                        action = step.get("action") or step.get("actionType") or getattr(tool, "name", "unknown")
                        ok, results, error_payload = cls._dispatch_frontend_actions(
                            thread_id=str(thread_id),
                            actions=[action],
                            params=step_params,
                            timeout=timeout,
                            action_params=action_params,
                        )
                        pipeline_results.append({
                            "index": index,
                            "target": "frontend",
                            "result": results[-1] if results else None,
                        })
                        if not ok:
                            return error_payload or {"success": False, "error": "Frontend action execution failed"}
                    else:
                        backend_result = cls._run_backend(tool, step_params)
                        pipeline_results.append({
                            "index": index,
                            "target": "backend",
                            "result": backend_result,
                        })
                return {"success": True, "pipeline": pipeline_results}
            if strategy == "frontend-first":
                thread_id = params.get("thread_id") or get_current_thread_id()
                if not thread_id:
                    return cls._error_payload(
                        "Missing thread_id, cannot execute frontend action",
                        "missing_thread_id",
                    )
                if not actions:
                    return cls._error_payload(
                        "Missing frontend actions config",
                        "invalid_orchestration",
                    )
                ok, results, error_payload = cls._dispatch_frontend_actions(
                    thread_id=str(thread_id),
                    actions=actions,
                    params=params,
                    timeout=timeout,
                    action_params=action_params,
                )
                if not ok:
                    return error_payload or {"success": False, "error": "Frontend action execution failed"}
                backend_params = {**cls._clean_params(params), "frontend_results": results}
                return cls._run_backend(tool, backend_params)
            if strategy == "backend-first":
                backend_result = cls._run_backend(tool, cls._clean_params(params))
                backend_actions = []
                if isinstance(backend_result, dict):
                    backend_actions = backend_result.get("frontend_actions") or backend_result.get("frontendActions") or []
                effective_actions = backend_actions or actions
                if not effective_actions:
                    return backend_result if isinstance(backend_result, dict) else {"success": True, "data": backend_result}
                thread_id = params.get("thread_id") or get_current_thread_id()
                if not thread_id:
                    return cls._error_payload(
                        "Missing thread_id, cannot execute frontend action",
                        "missing_thread_id",
                    )
                ok, results, error_payload = cls._dispatch_frontend_actions(
                    thread_id=str(thread_id),
                    actions=effective_actions,
                    params=params,
                    timeout=timeout,
                    action_params=action_params,
                )
                if not ok:
                    return error_payload or {"success": False, "error": "Frontend action execution failed"}
                return {
                    "success": True,
                    "backend": backend_result,
                    "frontend": results,
                }
        execution_target = params.get("execution_target") or params.get("executionTarget")
        use_client = params.get("use_client") or params.get("useClient")
        if execution_target in {"frontend", "client"} or use_client:
            thread_id = params.get("thread_id") or get_current_thread_id()
            if not thread_id:
                return cls._error_payload(
                    "Missing thread_id, cannot execute frontend action",
                    "missing_thread_id",
                )
            timeout = int(params.get("timeout") or resolve_tool_timeout(tool))
            result = cls.dispatch_frontend_action(
                thread_id=str(thread_id),
                action_type=getattr(tool, "name", "unknown"),
                params=params,
                timeout=timeout,
            )
            if not result.get("success"):
                error = result.get("error") or "Frontend action execution failed"
                return cls._error_payload(
                    str(error),
                    cls._detect_frontend_error_code(str(error)),
                    action=getattr(tool, "name", "unknown"),
                    details={"frontend_result": result},
                    degraded=bool(result.get("degraded")),
                )
            return result
        return cls._run_backend(tool, cls._clean_params(params))
